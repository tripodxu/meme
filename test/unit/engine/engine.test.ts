import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import { step, type StepDecisions } from '../../../src/core/engine/engine.js';
import { mobilityRate } from '../../../src/core/macros/tick-metrics.js';
import type { AgentId } from '../../../src/core/control/ids.js';
import type { SimState } from '../../../src/core/model/state.js';
import { computeAuthoritativeStateHash } from '../../../src/core/hash/state-hash.js';
import { decideMockWeighted } from '../../../src/decision/mock.js';

const SEED = asSeed('engine-seed');

function makeConfig(overrides: Parameters<typeof createDemoConfig>[0] = {}) {
  return createDemoConfig({ population: { initialPopulation: 8 }, ...overrides });
}

/** 为当前 state 的所有到期个体生成 mock 决策。 */
function mockDecisions(state: SimState): StepDecisions {
  const map = new Map<AgentId, { selectedAction: string; isFallback?: boolean }>();
  if (state.society.tick % state.config.decision.interval !== 0) {
    return map;
  }
  for (const agent of state.society.agents) {
    if (!agent.alive) continue;
    const legal = enumerateLegalActions(state, agent.id);
    const decision = decideMockWeighted({
      runId: 'local-engine-test',
      seed: state.seed,
      state,
      agentId: agent.id,
      stateHash: 'sha256:00',
      actionSetHash: 'sha256:00',
      legal,
    });
    map.set(agent.id, { selectedAction: decision.selectedAction });
  }
  return map;
}

function runTicks(config0: ReturnType<typeof makeConfig>, ticks: number): SimState {
  let state = createSimulation(config0, SEED);
  for (let i = 0; i < ticks; i += 1) {
    const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
    state = result.state;
    if (result.endReason !== null) break;
  }
  return state;
}

describe('单 tick 管线（03 §6）', () => {
  it('同输入最终哈希一致（确定性）', () => {
    const config = makeConfig({
      schedule: { totalTicks: 40, statsStride: 10, snapshotStride: 100 },
    });
    const a = runTicks(config, 40);
    const b = runTicks(config, 40);
    expect(computeAuthoritativeStateHash(a)).toBe(computeAuthoritativeStateHash(b));
  });

  it('step 不修改输入状态（快照隔离）', () => {
    const config = makeConfig({
      schedule: { totalTicks: 12, statsStride: 10, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    const before = computeAuthoritativeStateHash(state);
    step(state, mockDecisions(state), { runId: 'local-engine-test' });
    expect(computeAuthoritativeStateHash(state)).toBe(before);
  });

  it('每个 Value 变化可追溯到事件且 before+delta=after', () => {
    const config = makeConfig({
      schedule: { totalTicks: 12, statsStride: 10, snapshotStride: 100 },
    });
    let state = createSimulation(config, SEED);
    for (let i = 0; i < 12; i += 1) {
      const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
      for (const event of result.events) {
        if (event.type === 'wealth_changed') {
          expect(event.before + event.delta).toBeCloseTo(event.after, 12);
          expect(event.after).toBeGreaterThanOrEqual(0);
        }
      }
      state = result.state;
      if (result.endReason !== null) break;
    }
  });

  it('到期个体缺少决策抛不变量错误', () => {
    const config = makeConfig({
      schedule: { totalTicks: 12, statsStride: 10, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    expect(() => step(state, new Map(), { runId: 'local-engine-test' })).toThrowError(/缺少决策/);
  });

  it('非决策 tick 不需要决策也不执行主动行动', () => {
    const config = makeConfig({
      schedule: { totalTicks: 12, statsStride: 10, snapshotStride: 100 },
    });
    let state = createSimulation(config, SEED);
    // tick 0 是决策周期；先走一步到 tick 1（非决策周期）
    const first = step(state, mockDecisions(state), { runId: 'local-engine-test' });
    state = first.state;
    expect(state.society.tick).toBe(1);
    const result = step(state, new Map(), { runId: 'local-engine-test' });
    expect(result.executions).toEqual([]);
    expect(result.events.every((event) => event.type !== 'competition_resolved')).toBe(true);
  });

  it('超出计划 tick 拒绝 step', () => {
    const config = makeConfig({ schedule: { totalTicks: 2, statsStride: 1, snapshotStride: 1 } });
    let state = createSimulation(config, SEED);
    state = step(state, mockDecisions(state), { runId: 'local-engine-test' }).state;
    state = step(state, mockDecisions(state), { runId: 'local-engine-test' }).state;
    expect(state.society.tick).toBe(2);
    expect(() => step(state, mockDecisions(state), { runId: 'local-engine-test' })).toThrowError(
      /超出计划/,
    );
  });
});

describe('主动行动与失效（03 §5/§6 阶段 B）', () => {
  it('费用不足的 ascend 记 stale_invalid 且仍进入积累', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 1;
    agent.maxClassIndex = 1;
    agent.value = 0; // 无法负担任何 ascend/descend
    const decisions = new Map<AgentId, { selectedAction: string }>([
      [agent.id, { selectedAction: 'ascend' }],
    ]);
    // 其余到期个体全部 accumulate
    for (const other of state.society.agents) {
      if (other.alive && other.id !== agent.id) {
        decisions.set(other.id, { selectedAction: 'accumulate' });
      }
    }
    const result = step(state, decisions, { runId: 'local-engine-test' });
    const execution = result.executions.find((entry) => entry.agentId === agent.id);
    expect(execution?.status).toBe('stale_invalid');
    expect(execution?.executedAction).toBeNull();
    expect(execution?.reason).toBe('insufficient_cushion');
    // 仍进入积累：wealth_changed(accumulate) 存在
    const gained = result.events.find(
      (event) =>
        event.type === 'wealth_changed' &&
        event.agentId === agent.id &&
        event.cause === 'accumulate',
    );
    expect(gained).toBeDefined();
    // 阶级不变
    const after = result.state.society.agents.find((entry) => entry.id === agent.id);
    expect(after?.classIndex).toBe(1);
  });

  it('A→B 后 B→C 合法（作为发起方不占用目标名额）', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    const a = state.society.agents[0];
    const b = state.society.agents[1];
    const c = state.society.agents[2];
    if (a === undefined || b === undefined || c === undefined) throw new Error('roster 过小');
    for (const agent of [a, b, c]) {
      agent.value = 1000;
      agent.belowNeedStreak = 0;
    }
    // 无论行动顺序如何：a→b 与 b→c 均应执行（目标互不相同）。
    const decisions = new Map<AgentId, { selectedAction: string }>([
      [a.id, { selectedAction: `compete:${b.id}` as string }],
      [b.id, { selectedAction: `compete:${c.id}` as string }],
    ]);
    for (const other of state.society.agents) {
      if (other.alive && !decisions.has(other.id)) {
        decisions.set(other.id, { selectedAction: 'accumulate' });
      }
    }
    const result = step(state, decisions, { runId: 'local-engine-test' });
    const byAgent = new Map(result.executions.map((entry) => [entry.agentId, entry]));
    expect(byAgent.get(a.id)?.status).toBe('executed');
    expect(byAgent.get(b.id)?.status).toBe('executed');
  });

  it('同一目标每 tick 最多一场竞争：后到者记 target_taken', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    const a = state.society.agents[0];
    const b = state.society.agents[1];
    const c = state.society.agents[2];
    if (a === undefined || b === undefined || c === undefined) throw new Error('roster 过小');
    for (const agent of [a, b, c]) {
      agent.value = 1000;
      agent.belowNeedStreak = 0;
    }
    // a 与 c 都以 b 为目标：先执行者占用 b 的名额，后执行者 stale_invalid（顺序无关）。
    const decisions = new Map<AgentId, { selectedAction: string }>([
      [a.id, { selectedAction: `compete:${b.id}` as string }],
      [c.id, { selectedAction: `compete:${b.id}` as string }],
    ]);
    for (const other of state.society.agents) {
      if (other.alive && !decisions.has(other.id)) {
        decisions.set(other.id, { selectedAction: 'accumulate' });
      }
    }
    const result = step(state, decisions, { runId: 'local-engine-test' });
    const statuses = result.executions
      .filter((entry) => entry.agentId === a.id || entry.agentId === c.id)
      .map((entry) => entry.status);
    expect(statuses).toContain('executed');
    expect(statuses).toContain('stale_invalid');
    const staleEntry = result.executions.find(
      (entry) =>
        (entry.agentId === a.id || entry.agentId === c.id) && entry.status === 'stale_invalid',
    );
    expect(staleEntry?.reason).toBe('target_taken');
    // b 只参与一场竞争
    const bAsTarget = result.events.filter(
      (event) => event.type === 'competition_resolved' && event.targetId === b.id,
    );
    expect(bAsTarget).toHaveLength(1);
  });

  it('自竞争按 stale_invalid 处理，不产生净损失', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    const a = state.society.agents[0];
    if (a === undefined) throw new Error('roster 过小');
    a.value = 1000;
    a.belowNeedStreak = 0;
    const before = a.value;
    const decisions = new Map<AgentId, { selectedAction: string }>([
      [a.id, { selectedAction: `compete:${a.id}` as string }],
    ]);
    for (const other of state.society.agents) {
      if (other.alive && !decisions.has(other.id)) {
        decisions.set(other.id, { selectedAction: 'accumulate' });
      }
    }
    const result = step(state, decisions, { runId: 'local-engine-test' });
    const entry = result.executions.find((record) => record.agentId === a.id);
    expect(entry?.status).toBe('stale_invalid');
    expect(entry?.reason).toBe('self_target');
    // 不得出现「先扣后加」造成的净损失：Value 只受当日积累影响，不出现竞争转移。
    const competitionEvents = result.events.filter(
      (event) => event.type === 'competition_resolved' && event.initiatorId === a.id,
    );
    expect(competitionEvents).toHaveLength(0);
    expect(a.value).toBeGreaterThanOrEqual(before);
  });

  it('Value=0 竞争转移为 0 且无负数', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    const a = state.society.agents[0];
    const b = state.society.agents[1];
    if (a === undefined || b === undefined) throw new Error('roster 过小');
    a.value = 0;
    b.value = 0;
    const decisions = new Map<AgentId, { selectedAction: string }>();
    decisions.set(a.id, { selectedAction: `compete:${b.id}` });
    for (const other of state.society.agents) {
      if (other.alive && !decisions.has(other.id)) {
        decisions.set(other.id, { selectedAction: 'accumulate' });
      }
    }
    const result = step(state, decisions, { runId: 'local-engine-test' });
    for (const event of result.events) {
      if (event.type === 'wealth_changed') {
        expect(event.after).toBeGreaterThanOrEqual(0);
      }
    }
    const competition = result.events.find((event) => event.type === 'competition_resolved');
    expect(competition?.type === 'competition_resolved' && competition.loss).toBe(0);
    expect(competition?.type === 'competition_resolved' && competition.gain).toBe(0);
  });
});

describe('被动跌落与需求（03 §6 阶段 D）', () => {
  it('连续 belowNeedLimit 日低于需求线触发跌落一层；最低层钳制 streak', () => {
    const config = makeConfig({
      schedule: { totalTicks: 60, statsStride: 1, snapshotStride: 100 },
      need: {
        threshold: 0.5,
        belowNeedLimit: 3,
        bufferDays: 2,
        needMultiplier: [1, 1.3, 1.8, 2.5, 3.5],
      },
      decision: { interval: 60, topK: 1, policy: 'mock-weighted-v1' }, // 无主动行动干扰
    });
    let state = createSimulation(config, SEED);
    const agent = state.society.agents.find((entry) => entry.classIndex === 1);
    if (agent === undefined) throw new Error('无 class-1 个体');
    (agent as { ge: number }).ge = 0.2;
    (agent as { hard: number }).hard = 0.2;
    agent.remainingLife = 100000;
    const startClass = agent.classIndex;
    let descended = false;
    for (let i = 0; i < 20; i += 1) {
      const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
      const after = result.state.society.agents.find((entry) => entry.id === agent.id);
      if (after !== undefined && after.classIndex < startClass) {
        descended = true;
        break;
      }
      state = result.state;
      if (result.endReason !== null) break;
    }
    expect(descended).toBe(true);
  });

  it('成功主动升降当日跳过被动跌落', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
      need: {
        threshold: 0.5,
        belowNeedLimit: 2,
        bufferDays: 2,
        needMultiplier: [1, 1.3, 1.8, 2.5, 3.5],
      },
      decision: { interval: 10, topK: 1, policy: 'mock-weighted-v1' },
    });
    const state = createSimulation(config, SEED);
    const agent = state.society.agents.find(
      (entry) => entry.classIndex >= 1 && entry.classIndex <= 3,
    );
    if (agent === undefined) throw new Error('无中层个体');
    agent.classIndex = 1;
    agent.maxClassIndex = 1;
    agent.value = 1e12; // 足够 ascend 且满足 mock 的 1.5×cost 条件
    agent.belowNeedStreak = 5;
    const decisions = new Map<AgentId, { selectedAction: string }>([
      [agent.id, { selectedAction: 'ascend' }],
    ]);
    for (const other of state.society.agents) {
      if (other.alive && !decisions.has(other.id)) {
        decisions.set(other.id, { selectedAction: 'accumulate' });
      }
    }
    const result = step(state, decisions, { runId: 'local-engine-test' });
    const after = result.state.society.agents.find((entry) => entry.id === agent.id);
    expect(after?.classIndex).toBe(2);
    expect(after?.belowNeedStreak).toBe(0); // 重置，且当日跳过被动跌落
    expect(after?.lastAscentTick).toBe(0);
  });
});

describe('寿命与死亡（03 §6 阶段 E）', () => {
  it('remainingLife 归零当天死亡并从所有邻居移除', () => {
    const config = makeConfig({
      schedule: { totalTicks: 11, statsStride: 1, snapshotStride: 100 },
    });
    const state = createSimulation(config, SEED);
    // 选取初始网络中已互为邻居的一对，保持关系对称性。
    const victim = state.society.agents.find((entry) => entry.alive && entry.ties.length > 0);
    if (victim === undefined) throw new Error('无边可测');
    const neighborId = victim.ties[0];
    const neighbor = state.society.agents.find((entry) => entry.id === neighborId);
    if (neighbor === undefined) throw new Error('邻居缺失');
    victim.remainingLife = 0.5;
    const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
    const after = result.state.society.agents.find((entry) => entry.id === victim.id);
    expect(after?.alive).toBe(false);
    expect(after?.deathTick).toBe(0);
    expect(after?.deathReason).toBe('age');
    expect(after?.ties).toEqual([]);
    const neighborAfter = result.state.society.agents.find((entry) => entry.id === neighbor.id);
    expect(neighborAfter?.ties).not.toContain(victim.id);
    expect(
      result.events.some((event) => event.type === 'agent_died' && event.agentId === victim.id),
    ).toBe(true);
  });

  it('全死亡以 extinct 技术完成且再次 step 报终态错误', () => {
    const config = makeConfig({
      population: { initialPopulation: 4 },
      schedule: { totalTicks: 100, statsStride: 1, snapshotStride: 100 },
      lifespan: {
        decay: [3, 3, 3, 3, 3],
        initialLife: { mean: 1, sigma: 0, min: 1, max: 43800 },
        hardLifeFactor: 0.15,
        hardLifeFloor: 0.5,
      },
    });
    let state = createSimulation(config, SEED);
    let endReason: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
      state = result.state;
      endReason = result.endReason;
      if (endReason !== null) break;
    }
    expect(endReason).toBe('extinct');
    expect(state.society.agents.every((agent) => !agent.alive)).toBe(true);
    expect(() => step(state, new Map(), { runId: 'local-engine-test' })).toThrowError(/全死亡/);
  });
});

describe('慢变量更新（03 §6 阶段 H）', () => {
  it('E 每 tick 只更新一次；O 仅决策周期按 Δt 更新', () => {
    const config = makeConfig({
      schedule: { totalTicks: 22, statsStride: 1, snapshotStride: 100 },
    });
    let state = createSimulation(config, SEED);
    const e0 = [...state.society.eByClass];
    const o0 = state.society.openness;
    // tick 0（决策周期）：Δt=0，O 不变
    const r0 = step(state, mockDecisions(state), { runId: 'local-engine-test' });
    expect(r0.state.society.openness).toBeCloseTo(o0, 12);
    expect(r0.state.society.lastOpennessUpdateTick).toBe(0);
    // E 在 tick 0 已更新
    expect(r0.state.society.eByClass).not.toEqual(e0);
    state = r0.state;
    // tick 1..9（非决策周期）：O 不变、lastOpennessUpdateTick 不变
    for (let i = 1; i <= 9; i += 1) {
      const r = step(state, new Map(), { runId: 'local-engine-test' });
      expect(r.state.society.openness).toBeCloseTo(o0, 12);
      expect(r.state.society.lastOpennessUpdateTick).toBe(0);
      state = r.state;
    }
    // tick 10（决策周期）：Δt=10 → O 变化
    const r10 = step(state, mockDecisions(state), { runId: 'local-engine-test' });
    expect(r10.state.society.lastOpennessUpdateTick).toBe(10);
    expect(r10.state.society.openness).not.toBeCloseTo(o0, 9);
  });

  it('openness.updateMode=fixed 时 O 恒等于 initial（P1-10）', () => {
    const config = makeConfig({
      schedule: { totalTicks: 21, statsStride: 1, snapshotStride: 100 },
      openness: {
        initial: 0.5,
        updateMode: 'fixed',
        timeConstantDays: 60,
        intercept: 0,
        mobilityWeight: 8,
        mobilityReference: 0.1,
        giniWeight: 6,
        segregationWeight: 4,
        segregationReference: 0.3,
        ascentCostWeight: 2,
        multiplierMin: 0.5,
        multiplierMax: 2.5,
      },
    });
    let state = createSimulation(config, SEED);
    for (let i = 0; i < 21; i += 1) {
      const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
      expect(result.state.society.openness).toBe(0.5);
      state = result.state;
      if (result.endReason !== null) break;
    }
  });
});

describe('宏观指标与流动（03 §6 阶段 G）', () => {
  it('全零财富 G=0；Mup/Mdown 位于 [0,1]；S 与 edgeCount 一致', () => {
    const config = makeConfig({
      schedule: { totalTicks: 12, statsStride: 1, snapshotStride: 100 },
    });
    let state = createSimulation(config, SEED);
    for (let i = 0; i < 12; i += 1) {
      const result = step(state, mockDecisions(state), { runId: 'local-engine-test' });
      const stats = result.stats;
      expect(stats.gini).toBeGreaterThanOrEqual(0);
      expect(stats.gini).toBeLessThanOrEqual(1);
      expect(stats.mUp).toBeGreaterThanOrEqual(0);
      expect(stats.mUp).toBeLessThanOrEqual(1);
      expect(stats.mDown).toBeGreaterThanOrEqual(0);
      expect(stats.mDown).toBeLessThanOrEqual(1);
      if (stats.edgeCount === 0) {
        expect(stats.segregation).toBe(0);
      }
      state = result.state;
      if (result.endReason !== null) break;
    }
  });

  it('mobilityRate 窗口边界：lower = tick-windowDays+1（03 §6 阶段 G）', () => {
    const a = { lastAscentTick: 5 as number | null, lastDescentTick: null };
    const b = { lastAscentTick: null, lastDescentTick: null };
    const alive = [
      { id: 'a-0000', ...a },
      { id: 'a-0001', ...b },
    ] as unknown as Parameters<typeof mobilityRate>[0];
    // windowDays=5：tick=9 → lower=5 → 计入；tick=10 → lower=6 → 5 不计入
    expect(mobilityRate(alive, 'lastAscentTick', 9, 5)).toBeCloseTo(0.5, 12);
    expect(mobilityRate(alive, 'lastAscentTick', 10, 5)).toBe(0);
    // 空存活人口 → 0
    expect(mobilityRate([], 'lastAscentTick', 9, 5)).toBe(0);
  });
});
