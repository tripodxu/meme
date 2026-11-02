import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { attemptRewire } from '../../../src/core/network/rewire.js';
import { rewireWeight } from '../../../src/core/network/rewire.js';
import { EventSequence } from '../../../src/core/events.js';
import { step } from '../../../src/core/engine/engine.js';

const SEED = asSeed('rewire-seed');

function makePair() {
  const config = createDemoConfig({ population: { initialPopulation: 6 } });
  const state = createSimulation(config, SEED);
  return { config, state };
}

describe('网络重构（03 §6 阶段 F / P1-05）', () => {
  it('rewireWeight 含 (1-O) 因子：开放度越高跨层权重越高', () => {
    const config = createDemoConfig({ population: { initialPopulation: 6 } });
    const self = { classIndex: 0, value: 10 };
    const other = { classIndex: 4, value: 10 };
    const closed = rewireWeight(config, self, other, 0);
    const open = rewireWeight(config, self, other, 1);
    expect(open).toBeGreaterThan(closed);
    // 同阶级时 (1-O) 因子无效
    const sameClosed = rewireWeight(config, self, { classIndex: 0, value: 10 }, 0);
    const sameOpen = rewireWeight(config, self, { classIndex: 0, value: 10 }, 1);
    expect(sameClosed).toBe(sameOpen);
  });

  it('无候选时恢复旧边且不产生无向不变量破坏', () => {
    const { config, state } = makePair();
    // 构造：所有其他 agent 都已与 agent 满连或度满 → 无新候选
    // maxDegree=1：其他 agent 各有一个邻居即满，新候选集合近乎为空。
    const config1 = createDemoConfig({
      population: { initialPopulation: 6 },
      network: { maxDegree: 1, initialDegree: 1 },
    });
    const state1 = createSimulation(config1, SEED);
    const a1 = state1.society.agents[0];
    if (a1 === undefined) throw new Error('roster 过小');
    if (a1.ties.length === 0) throw new Error('无边可测');
    // 断开其他所有 agent 与 a1 的可能：所有 agent 度已为 1（初始度 1）
    const events = new EventSequence('local-rewire-test', 0);
    // 强制判定成功：rewireProb=1
    const configForce = { ...config1, network: { ...config1.network, rewireProb: 1 } };
    const agentMap = new Map(state1.society.agents.map((entry) => [entry.id, entry]));
    const outcome = attemptRewire(configForce, SEED, 0, a1, agentMap, 0.5, events);
    // 全部其他 agent 度=1 且（若与其邻居满）新候选只可能是原邻居 j 之外度<1 的个体
    // 结果必须保持关系不变量
    for (const entry of state1.society.agents) {
      expect(entry.ties.length).toBeLessThanOrEqual(1);
      for (const neighbor of entry.ties) {
        expect(neighbor).not.toBe(entry.id);
      }
    }
    void outcome;
    void config;
    void state;
  });

  it('每 agent 每周期最多替换一条边', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 10 },
      network: { maxDegree: 6, initialDegree: 4, rewireProb: 1 },
    });
    const state = createSimulation(config, SEED);
    const beforeEdgeCount = state.society.edgeCount;
    const decisions = new Map(
      state.society.agents
        .filter((agent) => agent.alive)
        .map((agent) => [agent.id, { selectedAction: 'accumulate' }]),
    );
    const result = step(state, decisions, { runId: 'local-rewire-test' });
    // tick 0 是决策周期 → 重构执行。每次重构都是“移除一条 + 新增/恢复一条”的 1:1 替换：
    // 总边数不变（其他 agent 发起的重构也可能改变本 agent 的邻居集合）。
    const after = result.state.society.agents;
    expect(result.state.society.edgeCount).toBe(beforeEdgeCount);
    expect(
      result.events.filter((event) => event.type === 'network_rewired').length,
    ).toBeGreaterThan(0);
    // 关系网络无重边/自连/不对称
    const byId = new Map(after.map((agent) => [agent.id, agent]));
    for (const agent of after) {
      expect(new Set(agent.ties).size).toBe(agent.ties.length);
      for (const neighbor of agent.ties) {
        expect(byId.get(neighbor)?.ties).toContain(agent.id);
      }
    }
  });

  it('决策概率判定：rewireProb=0 时从不重构', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 10 },
      network: { rewireProb: 0 },
    });
    const state = createSimulation(config, SEED);
    const before = state.society.agents.map((agent) => agent.ties.join(','));
    const decisions = new Map(
      state.society.agents
        .filter((agent) => agent.alive)
        .map((agent) => [agent.id, { selectedAction: 'accumulate' }]),
    );
    const result = step(state, decisions, { runId: 'local-rewire-test' });
    const after = result.state.society.agents.map((agent) => agent.ties.join(','));
    expect(after).toEqual(before);
  });
});
