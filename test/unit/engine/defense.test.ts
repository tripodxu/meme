import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import { step } from '../../../src/core/engine/engine.js';
import {
  computeNeed,
  computeOpportunityFromMedians,
  effortFunction,
  lifeLoss,
  median,
  computeOpportunity,
} from '../../../src/core/engine/settlement.js';
import {
  polarizationZ,
  updateClassEnvironment,
} from '../../../src/core/feedback/slow-variables.js';
import { restoreSnapshot, captureSnapshot } from '../../../src/core/replay/snapshot.js';
import {
  edgeStatistics,
  mobilityRate,
  topWealthShare,
} from '../../../src/core/macros/tick-metrics.js';

const SEED = asSeed('defense-seed');

function makeState() {
  const config = createDemoConfig({ population: { initialPopulation: 8 } });
  return createSimulation(config, SEED);
}

function accumulateDecisions(state: ReturnType<typeof makeState>) {
  const decisions = new Map();
  for (const agent of state.society.agents) {
    if (agent.alive) decisions.set(agent.id, { selectedAction: 'accumulate' });
  }
  return decisions;
}

describe('引擎防御路径（内部不变量即停）', () => {
  it('E 长度被破坏时立即抛错', () => {
    const state = makeState();
    (state.society.eByClass as number[]).pop();
    expect(() => step(state, accumulateDecisions(state), { runId: 'x' })).toThrowError(
      /E 缺少阶级/,
    );
  });

  it('死亡个体引用不存在的邻居时立即抛错', () => {
    const state = makeState();
    const victim = state.society.agents.find((agent) => agent.alive);
    if (victim === undefined) throw new Error('roster 过小');
    victim.remainingLife = 0.5;
    victim.ties = ['a-9999' as never]; // 指向不存在个体的悬空关系
    expect(() => step(state, accumulateDecisions(state), { runId: 'x' })).toThrowError(/邻居缺失/);
  });

  it('全员死于最后一个计划 tick 记 scheduled', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 4 },
      schedule: { totalTicks: 1, statsStride: 1, snapshotStride: 1 },
      lifespan: {
        decay: [3, 3, 3, 3, 3],
        initialLife: { mean: 1, sigma: 0, min: 1, max: 43800 },
        hardLifeFactor: 0.15,
        hardLifeFloor: 0.5,
      },
    });
    const state = createSimulation(config, SEED);
    const result = step(state, accumulateDecisions(state), { runId: 'x' });
    expect(result.endReason).toBe('scheduled');
    expect(result.state.society.agents.every((agent) => !agent.alive)).toBe(true);
    expect(result.stats.aliveCount).toBe(0);
  });

  it('isFallback 标记进入 fallbackRate', () => {
    const state = makeState();
    const decisions = accumulateDecisions(state);
    const first = state.society.agents.find((agent) => agent.alive);
    if (first === undefined) throw new Error('roster 过小');
    decisions.set(first.id, { selectedAction: 'accumulate', isFallback: true });
    const result = step(state, decisions, { runId: 'x' });
    expect(result.stats.fallbackRate).toBeCloseTo(1 / decisions.size, 12);
  });

  it('非决策 tick fallbackRate 为 null', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 4 },
      schedule: { totalTicks: 2, statsStride: 1, snapshotStride: 1 },
      decision: { interval: 100, topK: 1, policy: 'mock-weighted-v1' },
    });
    let state = createSimulation(config, SEED);
    // tick 0 是决策周期
    state = step(state, accumulateDecisions(state), { runId: 'x' }).state;
    // tick 1 不是决策周期
    const result = step(state, accumulateDecisions(state), { runId: 'x' });
    expect(result.stats.fallbackRate).toBeNull();
  });
});

describe('枚举/结算模块防御路径', () => {
  it('enumerateLegalActions 拒绝未知 agentId', () => {
    const state = makeState();
    expect(() => enumerateLegalActions(state, 'a-9999' as never)).toThrowError(/不存在或已死亡/);
  });

  it('median 拒绝空输入', () => {
    expect(() => median([])).toThrowError(/中位数输入为空/);
  });

  it('computeNeed/lifeLoss 拒绝缺少阶级参数的配置', () => {
    const badConfig = {
      ...DEFAULT_RUN_CONFIG,
      need: { ...DEFAULT_RUN_CONFIG.need, needMultiplier: [1, 1.3] },
    } as typeof DEFAULT_RUN_CONFIG;
    expect(() => computeNeed(badConfig, 5, 10, 3)).toThrowError(/needMultiplier 缺少阶级/);
    const badDecay = {
      ...DEFAULT_RUN_CONFIG,
      lifespan: { ...DEFAULT_RUN_CONFIG.lifespan, decay: [1.3] },
    } as typeof DEFAULT_RUN_CONFIG;
    expect(() => lifeLoss(badDecay, { classIndex: 2, hard: 1 })).toThrowError(/decay 缺少阶级/);
  });

  it('computeOpportunity 包装器与预计算形式一致', () => {
    const config = createDemoConfig({ population: { initialPopulation: 4 } });
    const neighbors = [10, 20, 30];
    const all = [1, 10, 20, 30, 40];
    const wrapper = computeOpportunity(config, neighbors, all);
    const precomputed = computeOpportunityFromMediansForTest(config, neighbors, all);
    expect(wrapper).toBe(precomputed);
  });

  it('effortFunction 稳定且单调（补充分支）', () => {
    expect(effortFunction(1.2, 0.4)).toBeLessThan(effortFunction(1.2, 0.8));
  });
});

describe('慢变量模块防御路径', () => {
  it('polarizationZ 拒绝 C<2', () => {
    expect(() => polarizationZ(0, 1)).toThrowError(/阶级数必须 >=2/);
    expect(polarizationZ(0, 2)).toBe(-1);
    expect(polarizationZ(1, 2)).toBe(1);
  });

  it('classShares/env0 长度破坏时抛错', () => {
    const config = createDemoConfig({ population: { initialPopulation: 4 } });
    expect(() =>
      updateClassEnvironment(config, [1, 1.5, 2.2, 3.2, 4.5], [0.5, 0.5], [1, 0, 0, 0, 0], 0.3),
    ).toThrowError(/阶级占比缺失/);
    expect(() =>
      updateClassEnvironment(config, [1, 1.5], [0.5, 0.5, 0, 0, 0], [1, 0, 0, 0, 0], 0.3),
    ).toThrowError(/E 缺少阶级/);
  });
});

describe('tick-metrics 防御路径', () => {
  it('edgeStatistics 拒绝端点已死亡的边', () => {
    const state = makeState();
    const withTie = state.society.agents.find((agent) => agent.alive && agent.ties.length > 0);
    if (withTie === undefined) throw new Error('无边可测');
    const partnerId = withTie.ties[0];
    const partner = state.society.agents.find((agent) => agent.id === partnerId);
    if (partner === undefined) throw new Error('邻居缺失');
    partner.alive = false; // 死亡但 ties 未清理的破坏性状态
    partner.deathTick = 0;
    partner.deathReason = 'age';
    expect(() => edgeStatistics(state.society.agents)).toThrowError(/边端点缺失或已死亡/);
  });

  it('topWealthShare 空人口/零和为 0', () => {
    expect(topWealthShare([], 0.1)).toBe(0);
    expect(topWealthShare([0, 0, 0], 0.1)).toBe(0);
    expect(topWealthShare([1, 2, 3, 4], 0.5)).toBeCloseTo(7 / 10, 12); // ceil(0.5×4)=2 → 4+3
  });

  it('mobilityRate 空存活人口为 0', () => {
    expect(mobilityRate([], 'lastDescentTick', 10, 365)).toBe(0);
  });
});

describe('快照模块防御路径', () => {
  it('非对象与缺失 stateHash 拒绝', () => {
    expect(() => restoreSnapshot(null)).toThrowError(/快照必须是对象/);
    expect(() => restoreSnapshot([1])).toThrowError(/快照必须是对象/);
    const snapshot = JSON.parse(JSON.stringify(captureSnapshot(makeState()))) as Record<
      string,
      unknown
    >;
    delete snapshot['stateHash'];
    expect(() => restoreSnapshot(snapshot)).toThrowError(/缺少 stateHash/);
  });
});

function computeOpportunityFromMediansForTest(
  config: ReturnType<typeof createDemoConfig>,
  neighbors: number[],
  all: number[],
): number {
  return computeOpportunityFromMedians(config, neighbors.length, median(neighbors), median(all));
}
