import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import {
  computeActionSetHash,
  computeAscendCost,
  computeAscendCushion,
  computeDescendCost,
  enumerateLegalActions,
  parseActionKey,
} from '../../../src/core/legal-actions.js';
import type { SimState } from '../../../src/core/model/state.js';

const SEED = asSeed('legal-actions-seed');

function makeState(): SimState {
  const config = createDemoConfig({
    population: { initialPopulation: 12 },
    decision: { interval: 10, topK: 1, policy: 'mock-weighted-v1' },
  });
  return createSimulation(config, SEED);
}

describe('合法行动枚举（03 §5）', () => {
  it('行动顺序固定：accumulate<ascend<descend<compete，同类按 id 升序', () => {
    const state = makeState();
    const agent = state.society.agents[2];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 1;
    agent.maxClassIndex = 3;
    agent.value = 1_000_000;
    const legal = enumerateLegalActions(state, agent.id);
    expect(legal.actions[0]).toBe('accumulate');
    expect(legal.actions).toContain('ascend');
    expect(legal.actions).toContain('descend');
    const competeKeys = legal.actions.filter((action) => action.startsWith('compete:'));
    expect(competeKeys).toEqual([...competeKeys].sort());
    const competeIndex = legal.actions.findIndex((action) => action.startsWith('compete:'));
    const descendIndex = legal.actions.indexOf('descend');
    const ascendIndex = legal.actions.indexOf('ascend');
    expect(ascendIndex).toBeLessThan(descendIndex);
    expect(descendIndex).toBeLessThan(competeIndex);
  });

  it('最高层不可 ascend，最低层不可 descend', () => {
    const state = makeState();
    const top = state.society.agents[0];
    const bottom = state.society.agents[1];
    if (top === undefined || bottom === undefined) throw new Error('roster 过小');
    top.classIndex = 4;
    top.maxClassIndex = 4;
    top.value = 1_000_000;
    bottom.classIndex = 0;
    bottom.maxClassIndex = 0;
    bottom.value = 1_000_000;
    expect(enumerateLegalActions(state, top.id).actions).not.toContain('ascend');
    expect(enumerateLegalActions(state, bottom.id).actions).not.toContain('descend');
  });

  it('Value 恰好等于费用可行动；略低则不可', () => {
    const state = makeState();
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 1;
    agent.maxClassIndex = 1; // d=0 → 无减免
    const cost = computeAscendCost(
      state.config,
      agent,
      state.society.eByClass,
      state.society.openness,
    );
    if (cost === null || !Number.isFinite(cost) || cost <= 0) throw new Error('费用计算异常');
    const cushion = computeAscendCushion(state.config, 2, state.society.eByClass);
    agent.value = cost + cushion;
    expect(enumerateLegalActions(state, agent.id).actions).toContain('ascend');
    const epsilon = Math.max(cost, cushion, 1) * 1e-9;
    agent.value = cost + cushion - epsilon;
    expect(enumerateLegalActions(state, agent.id).actions).not.toContain('ascend');
  });

  it('重返减免按 d=1/2/>=3 档位读取 returnDiscount', () => {
    const state = makeState();
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 1;
    const costAt = (maxClass: number): number => {
      agent.maxClassIndex = maxClass;
      const cost = computeAscendCost(
        state.config,
        agent,
        state.society.eByClass,
        state.society.openness,
      );
      if (cost === null) throw new Error('不应为最高层');
      return cost;
    };
    const base = 40 * 2 * 2.2; // crossDays[1]×B×E[2]
    expect(costAt(1)).toBeCloseTo(base, 9); // d=0 无减免
    expect(costAt(2)).toBeCloseTo(base, 9); // d=1 → returnDiscount[0]=0（最近一层默认不减免）
    expect(costAt(3)).toBeCloseTo(base * 0.8, 9); // d=2 → returnDiscount[1]=0.20
    expect(costAt(4)).toBeCloseTo(base * 0.6, 9); // d=3 → returnDiscount[2]=0.40
  });

  it('非零 returnDiscount[0] 覆盖下 d=1 档位可观测', () => {
    const state = makeState();
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 1;
    agent.maxClassIndex = 2;
    // 用带非零 returnDiscount[0] 的配置单独计算
    const config = createDemoConfig({
      population: { initialPopulation: 12 },
      ascent: { returnDiscount: [0.1, 0.2, 0.4] },
    });
    const cost = computeAscendCost(config, agent, state.society.eByClass, state.society.openness);
    const base = 40 * 2 * 2.2;
    expect(cost).toBeCloseTo(base * 0.9, 9);
  });

  it('竞争目标无重复、无自身、仅存活者且数量受限', () => {
    const state = makeState();
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 2;
    const legal = enumerateLegalActions(state, agent.id);
    const targets = legal.targets;
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).not.toContain(agent.id);
    expect(targets.length).toBeLessThanOrEqual(state.config.competition.candidateCount);
    for (const target of targets) {
      const targetAgent = state.society.agents.find((candidate) => candidate.id === target);
      expect(targetAgent?.alive).toBe(true);
    }
    // actions 中的 compete 键与 targets 一一对应
    const keys = legal.actions.filter((action) => action.startsWith('compete:'));
    expect(keys).toEqual(targets.map((target) => `compete:${target}`));
  });

  it('全局候选耗尽即停止且不为空槽继续消费', () => {
    const config = createDemoConfig({ population: { initialPopulation: 2 } });
    const state = createSimulation(config, SEED);
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    const legal = enumerateLegalActions(state, agent.id);
    expect(legal.targets).toHaveLength(1); // 唯一存活他人，第二个槽位无剩余目标
  });

  it('candidateCount=0 时无竞争目标', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 8 },
      competition: { candidateCount: 0 },
    });
    const state = createSimulation(config, SEED);
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    const legal = enumerateLegalActions(state, agent.id);
    expect(legal.targets).toEqual([]);
    expect(legal.actions.every((action) => !action.startsWith('compete:'))).toBe(true);
  });

  it('死亡个体与非到期个体不可枚举', () => {
    const state = makeState();
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.alive = false;
    expect(() => enumerateLegalActions(state, agent.id)).toThrowError(/已死亡/);
  });

  it('相同输入确定性；actionSetHash 与行动集合一致', () => {
    const state = makeState();
    const agent = state.society.agents[3];
    if (agent === undefined) throw new Error('roster 过小');
    const first = enumerateLegalActions(state, agent.id);
    const second = enumerateLegalActions(state, agent.id);
    expect(first.actions).toEqual(second.actions);
    expect(first.targets).toEqual(second.targets);
    expect(computeActionSetHash(first.actions)).toBe(computeActionSetHash(second.actions));
    const other = enumerateLegalActions(state, state.society.agents[4]!.id);
    expect(computeActionSetHash(first.actions)).not.toBe(computeActionSetHash(other.actions));
  });

  it('parseActionKey 只接受精确行动键', () => {
    expect(parseActionKey('accumulate')).toEqual({ type: 'accumulate', target: null });
    expect(parseActionKey('ascend')).toEqual({ type: 'ascend', target: null });
    expect(parseActionKey('descend')).toEqual({ type: 'descend', target: null });
    expect(parseActionKey('compete:a-0007')).toEqual({ type: 'compete', target: 'a-0007' });
    expect(() => parseActionKey('compete:')).toThrowError(/非法竞争行动键/);
    expect(() => parseActionKey('competeX:a-0007')).toThrowError(/未知行动键/);
    expect(() => parseActionKey('attack:a-0007')).toThrowError(/未知行动键/);
  });

  it('descend 费用为 descendDays×B×E[t,current]', () => {
    const state = makeState();
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 2;
    const cost = computeDescendCost(state.config, agent, state.society.eByClass);
    expect(cost).toBeCloseTo(7 * 2 * 2.2, 9);
    agent.classIndex = 0;
    expect(computeDescendCost(state.config, agent, state.society.eByClass)).toBeNull();
  });
});
