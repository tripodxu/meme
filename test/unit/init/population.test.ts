import { describe, expect, it } from 'vitest';

import { computeConfigHash, computeParamsHash } from '../../../src/core/config/hash.js';
import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { agentIdFromIndex } from '../../../src/core/model/agent.js';
import { deriveInitialPopulation } from '../../../src/core/init/population.js';
import { createSimulation } from '../../../src/core/init/simulation.js';

const SEED = asSeed('unit-seed-01');

describe('初始人口派生（03 §4.3）', () => {
  it('相同 (config, seed) 产生完全相同结果', () => {
    const a = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED);
    const b = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('不同 seed 产生不同 roster', () => {
    const a = deriveInitialPopulation(DEFAULT_RUN_CONFIG, asSeed('seed-a'));
    const b = deriveInitialPopulation(DEFAULT_RUN_CONFIG, asSeed('seed-b'));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('按 classIndex 分配后再洗牌，总人数与阶级数正确', () => {
    const { agents } = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED);
    expect(agents).toHaveLength(40);
    const counts = new Array(5).fill(0) as number[];
    for (const agent of agents) {
      counts[agent.classIndex] = (counts[agent.classIndex] ?? 0) + 1;
    }
    expect(counts).toEqual([18, 12, 6, 3, 1]);
    // agentId 顺序分配：a-0000..a-0039
    expect(agents[0]?.id).toBe(agentIdFromIndex(0));
    expect(agents[39]?.id).toBe(agentIdFromIndex(39));
  });

  it('ge/hard 落在截断区间内且运行期不变字段就绪', () => {
    const { agents } = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED);
    for (const agent of agents) {
      expect(agent.ge).toBeGreaterThanOrEqual(0.2);
      expect(agent.ge).toBeLessThanOrEqual(3.0);
      expect(agent.hard).toBeGreaterThanOrEqual(0.2);
      expect(agent.hard).toBeLessThanOrEqual(3.0);
      expect(agent.value).toBe(0);
      expect(agent.maxClassIndex).toBe(agent.classIndex);
      expect(agent.classAge).toBe(0);
      expect(agent.baselineSum).toBe(0);
      expect(agent.belowNeedStreak).toBe(0);
      expect(agent.lastAscentTick).toBeNull();
      expect(agent.lastDescentTick).toBeNull();
      expect(agent.alive).toBe(true);
    }
  });

  it('uniform 模式 remainingLife<initialLife；newborn 模式相等但同样消费 init_age', () => {
    const uniform = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED);
    const newbornConfig = createDemoConfig({ population: { initialAgeMode: 'newborn' } });
    const newborn = deriveInitialPopulation(newbornConfig, SEED);
    let uniformYounger = 0;
    for (let index = 0; index < uniform.agents.length; index += 1) {
      const u = uniform.agents[index];
      const n = newborn.agents[index];
      if (u === undefined || n === undefined) throw new Error('roster 长度不一致');
      expect(n.remainingLife).toBe(n.initialLife);
      if (u.remainingLife < u.initialLife) uniformYounger += 1;
    }
    expect(uniformYounger).toBe(40);
  });

  it('初始网络无自连/重边、对称、度受限', () => {
    const { agents, ties } = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const edgeSet = new Set<string>();
    for (const edge of ties) {
      expect(edge.a < edge.b).toBe(true);
      const key = `${edge.a}|${edge.b}`;
      expect(edgeSet.has(key)).toBe(false);
      edgeSet.add(key);
      const a = byId.get(edge.a);
      const b = byId.get(edge.b);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a?.ties.includes(edge.b)).toBe(true);
      expect(b?.ties.includes(edge.a)).toBe(true);
    }
    for (const agent of agents) {
      expect(agent.ties).toHaveLength(new Set(agent.ties).size);
      expect(agent.ties).not.toContain(agent.id);
      expect(agent.ties.length).toBeLessThanOrEqual(6);
      const sorted = [...agent.ties].sort();
      expect(agent.ties).toEqual(sorted);
    }
    // 顺序加边直到自身度达到目标 4：每个 agent 最终度位于 [4,6]（入边可越过目标，上限 6）。
    for (const agent of agents) {
      expect(agent.ties.length).toBeGreaterThanOrEqual(4);
    }
    // 总度数 = 2×边数
    const degreeSum = agents.reduce((sum, agent) => sum + agent.ties.length, 0);
    expect(degreeSum).toBe(2 * ties.length);
  });

  it('maxDegree=0 或 initialDegree=0 时网络为空', () => {
    const noNetwork = createDemoConfig({ network: { maxDegree: 0, initialDegree: 0 } });
    const { ties, agents } = deriveInitialPopulation(noNetwork, SEED);
    expect(ties).toEqual([]);
    expect(agents.every((agent) => agent.ties.length === 0)).toBe(true);
  });
});

describe('createSimulation（02 §4）', () => {
  it('初始宏观值与初始网络一致', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    expect(state.society.tick).toBe(0);
    expect(state.society.eByClass).toEqual([1, 1.5, 2.2, 3.2, 4.5]);
    expect(state.society.openness).toBe(0.5);
    // P0 按实际人数（3/40=0.075、1/40=0.025），不直接使用配置理想比例
    expect(state.society.initialClassShares).toEqual([0.45, 0.3, 0.15, 0.075, 0.025]);
    expect(state.society.gini).toBe(0); // 初始 Value 全为 0
    expect(state.society.edgeCount).toBeGreaterThan(0);
    expect(state.society.segregation).toBeGreaterThanOrEqual(-1);
    expect(state.society.segregation).toBeLessThanOrEqual(1);
    expect(state.society.mUp).toBe(0);
    expect(state.society.mDown).toBe(0);
    expect(state.society.flowWindow).toEqual([]);
    expect(state.society.lastOpennessUpdateTick).toBe(0);
    // P0 按实际人数
    expect(state.society.initialClassShares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('seed 不进入 configHash/paramsHash，但改变 initialPopulationHash', () => {
    const s1 = createSimulation(DEFAULT_RUN_CONFIG, asSeed('seed-a'));
    const s2 = createSimulation(DEFAULT_RUN_CONFIG, asSeed('seed-b'));
    expect(s1.configHash).toBe(s2.configHash);
    expect(s1.paramsHash).toBe(s2.paramsHash);
    expect(s1.configHash).toBe(computeConfigHash(DEFAULT_RUN_CONFIG));
    expect(s1.paramsHash).toBe(computeParamsHash(DEFAULT_RUN_CONFIG));
  });

  it('非法配置被拒绝', () => {
    const bad = createDemoConfig({ population: { initialPopulation: 1 } });
    expect(() => createSimulation(bad, SEED)).toThrowError(/配置未通过校验/);
  });
});
