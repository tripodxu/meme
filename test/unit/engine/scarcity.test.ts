import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../../../src/core/config/defaults.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { asAgentId, asSeed, type AgentId } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { step, type StepDecisions } from '../../../src/core/engine/engine.js';
import {
  computeAscendBarrier,
  computeAscendCost,
  computeAscendCrossBase,
  computeAscendCushion,
  enumerateLegalActions,
  occupancyPressureFromShares,
  scarcityTargetShares,
  updateOccupancyPressure,
} from '../../../src/core/legal-actions.js';
import type { SimState } from '../../../src/core/model/state.js';

/**
 * rules-v10 占用锚定（changes/0013）：目标阶级占比高于机会隐含参照份额时，
 * 上升余额门槛增加 `scarcityWeight × crossBase × pressure`。
 * `scarcityWeight=0` 必须与 v9 逐位一致；>0 时枚举侧与引擎复核侧同时拒绝。
 */

const SEED = asSeed('scarcity-seed');
const AGENT = asAgentId('a-0000');

function config(scarcityWeight: number, occupancyMemoryDays = 0) {
  const result = validateRunConfig(
    mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 3, classCount: 2, classShares: [1 / 3, 2 / 3] },
      opportunity: { env0: [1, 1.5] },
      lifespan: { decay: [1.3, 1.15] },
      need: { needMultiplier: [1, 1.3] },
      ascent: { crossDays: [30], scarcityWeight, occupancyMemoryDays },
      network: { maxDegree: 0, initialDegree: 0 },
      decision: { interval: 10_000 },
      schedule: { totalTicks: 5, statsStride: 1, snapshotStride: 100 },
    } as DeepPartialConfig),
  );
  if (!result.ok) {
    throw new Error(`配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/** 3 人 roster：a-0000 在底层、其余两人在目标阶级（P1=2/3 > target 0.4）。 */
function setup(scarcityWeight: number): SimState {
  const state = createSimulation(config(scarcityWeight), SEED);
  const agents = state.society.agents;
  const a = agents[0];
  if (a === undefined || agents.length < 3) throw new Error('roster 过小');
  a.classIndex = 0;
  a.maxClassIndex = 0;
  a.value = 300; // 足以支付 cost+cushion（≈265.5），不足以支付 barrier（≈120）
  a.remainingLife = 100_000;
  for (const incumbent of agents.slice(1)) {
    incumbent.classIndex = 1;
    incumbent.maxClassIndex = 1;
    incumbent.value = 10;
    incumbent.remainingLife = 100_000;
  }
  return state;
}

function decideAscend(state: SimState): StepDecisions {
  const map = new Map<AgentId, { selectedAction: string }>();
  for (const agent of state.society.agents) {
    if (agent.alive) {
      map.set(agent.id, { selectedAction: agent.id === 'a-0000' ? 'ascend' : 'accumulate' });
    }
  }
  return map;
}

describe('占用锚定与压力记忆：参照份额与壁垒（rules-v10/v11）', () => {
  it('参照份额按 1/env0 归一化；env0 越高目标占比越小', () => {
    const targets = scarcityTargetShares(config(0));
    expect(targets[0]).toBeCloseTo(0.6, 12);
    expect(targets[1]).toBeCloseTo(0.4, 12);
  });

  it('scarcityWeight=0 → 壁垒恒为 0（与 v9 逐位一致）', () => {
    const pressure = occupancyPressureFromShares(config(0), [1 / 3, 2 / 3]);
    expect(computeAscendBarrier(config(0), 0, 100, pressure)).toBe(0);
  });

  it('目标阶级超占比 → 壁垒 = w × crossBase × (P/target − 1)', () => {
    const overfull = occupancyPressureFromShares(config(2), [1 / 3, 2 / 3]);
    const barrier = computeAscendBarrier(config(2), 0, 100, overfull);
    expect(barrier).toBeCloseTo(2 * 100 * (2 / 3 / 0.4 - 1), 10);
    // 目标阶级未超占比时瞬时压力为 0，壁垒为 0
    const sparse = occupancyPressureFromShares(config(2), [0.9, 0.1]);
    expect(sparse[1]).toBe(0);
    expect(computeAscendBarrier(config(2), 0, 100, sparse)).toBe(0);
  });

  it('H=0 不读取记忆，m_c 等于瞬时压力（逐位退回 v10）', () => {
    const shares = [1 / 3, 2 / 3];
    const pressure = occupancyPressureFromShares(config(2, 0), shares);
    const memory = updateOccupancyPressure(config(2, 0), shares, [0.5, 99]);
    expect(memory).toEqual(pressure);
    expect(computeAscendBarrier(config(2, 0), 0, 100, memory)).toBe(
      computeAscendBarrier(config(2, 0), 0, 100, pressure),
    );
  });

  it('H>0 时占用压力按 e^{-1/H} 衰减，但不会被瞬时零压力立刻清零', () => {
    const cfg = config(2, 4);
    const previous = occupancyPressureFromShares(cfg, [1 / 3, 2 / 3]);
    const sparse = [0.9, 0.1];
    const memory = updateOccupancyPressure(cfg, sparse, previous);
    const decay = Math.exp(-1 / 4);
    expect(memory[1]).toBeCloseTo(decay * previous[1]!, 12);
    expect(memory[1]).toBeGreaterThan(0);
    // 同一稀疏占比：H=0 壁垒为 0；H=4 因记忆仍保留正壁垒。
    expect(computeAscendBarrier(cfg, 0, 100, occupancyPressureFromShares(cfg, sparse))).toBe(0);
    expect(computeAscendBarrier(cfg, 0, 100, memory)).toBeGreaterThan(0);
  });

  it('记忆取 max：占比继续超载时不会低于上一期衰减值', () => {
    const cfg = config(2, 10);
    const previous = [0, 5];
    const shares = [1 / 3, 2 / 3]; // 瞬时压力约 0.667
    const memory = updateOccupancyPressure(cfg, shares, previous);
    expect(memory[1]).toBeCloseTo(Math.max(2 / 3 / 0.4 - 1, Math.exp(-0.1) * 5), 12);
  });

  it('壁垒进入合法行动枚举：同余额在 w=0 时可上升、w=2 时被排除', () => {
    const open = enumerateLegalActions(setup(0), AGENT);
    const anchored = enumerateLegalActions(setup(2), AGENT);
    expect(open.actions).toContain('ascend');
    expect(anchored.actions).not.toContain('ascend');
  });

  it('引擎复核侧拒绝：w=2 时 ascend 记 insufficient_cushion，阶级不变', () => {
    const state = setup(2);
    const result = step(state, decideAscend(state), { runId: 'scarcity' });
    expect(result.state.society.agents[0]?.classIndex).toBe(0);
    const invalid = result.events.find((event) => event.type === 'action_invalid');
    expect(invalid?.type === 'action_invalid' && invalid.reason).toBe('insufficient_cushion');
    const record = result.executions.find((entry) => entry.agentId === 'a-0000');
    expect(record?.status).toBe('stale_invalid');
  });

  it('w=0 时同一余额可正常升阶', () => {
    const state = setup(0);
    const result = step(state, decideAscend(state), { runId: 'scarcity-open' });
    expect(result.state.society.agents[0]?.classIndex).toBe(1);
  });

  it('H>0：目标阶级占比回落后，记忆使下一 tick 的 ascend 仍被拒绝', () => {
    const setupHysteresis = (memoryDays: number): SimState => {
      const state = createSimulation(config(2, memoryDays), SEED);
      const [bottom, descender, incumbent] = state.society.agents;
      if (bottom === undefined || descender === undefined || incumbent === undefined) {
        throw new Error('roster 过小');
      }
      bottom.classIndex = 0;
      bottom.maxClassIndex = 0;
      bottom.value = 300; // 不足以支付含当前壁垒的上升
      bottom.remainingLife = 100_000;
      for (const top of [descender, incumbent]) {
        top.classIndex = 1;
        top.maxClassIndex = 1;
        top.value = 1_000; // 足以主动降阶
        top.remainingLife = 100_000;
      }
      return state;
    };
    const decisions = (state: SimState): StepDecisions => {
      const map = new Map<AgentId, { selectedAction: string }>();
      for (const agent of state.society.agents) {
        map.set(agent.id, {
          selectedAction: agent.id === 'a-0001' ? 'descend' : 'accumulate',
        });
      }
      return map;
    };

    const noMemory = step(setupHysteresis(0), decisions(setupHysteresis(0)), {
      runId: 'hysteresis-0',
    }).state;
    const withMemory = step(setupHysteresis(10), decisions(setupHysteresis(10)), {
      runId: 'hysteresis-10',
    }).state;

    // 降阶后目标阶级占比从 2/3 降到 1/3，瞬时压力回到 0。
    expect(
      noMemory.society.agents.filter((agent) => agent.alive && agent.classIndex === 1),
    ).toHaveLength(1);
    expect(noMemory.society.occupancyPressure[1]).toBe(0);
    expect(withMemory.society.occupancyPressure[1]).toBeGreaterThan(0);

    // 同一余额恰好在“无壁垒”门槛上：H=0 可 ascend，H>0 被记忆壁垒挡住。
    for (const state of [noMemory, withMemory]) {
      const bottom = state.society.agents[0];
      if (bottom === undefined) throw new Error('roster 过小');
      const cost = computeAscendCost(
        state.config,
        bottom,
        state.society.eByClass,
        state.society.openness,
        state.society.refIncome,
      );
      const cushion = computeAscendCushion(
        state.config,
        bottom.classIndex + 1,
        state.society.eByClass,
        state.society.refIncome,
      );
      const crossBase = computeAscendCrossBase(
        state.config,
        bottom,
        state.society.eByClass,
        state.society.refIncome,
      );
      if (cost === null || crossBase === null) throw new Error('费用计算异常');
      bottom.value = cost + cushion;
    }
    const noMemoryBottom = noMemory.society.agents[0];
    const withMemoryBottom = withMemory.society.agents[0];
    if (noMemoryBottom === undefined || withMemoryBottom === undefined) {
      throw new Error('roster 过小');
    }
    expect(enumerateLegalActions(noMemory, noMemoryBottom.id).actions).toContain('ascend');
    expect(enumerateLegalActions(withMemory, withMemoryBottom.id).actions).not.toContain('ascend');
  });
});
