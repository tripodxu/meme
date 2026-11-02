import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import type { SimState } from '../../../src/core/model/state.js';
import {
  decideMockWeighted,
  MOCK_WEIGHTED_V1_CONSTANTS,
  POLICY_VERSION_MOCK,
} from '../../../src/decision/mock.js';
import { decideRandomUniform, POLICY_VERSION_RANDOM } from '../../../src/decision/random.js';

const SEED = asSeed('policy-seed');

function makeState(): SimState {
  const config = createDemoConfig({
    population: { initialPopulation: 12 },
    competition: { candidateCount: 3 },
  });
  return createSimulation(config, SEED);
}

function legalOf(state: SimState, agentIndex: number) {
  const agent = state.society.agents[agentIndex];
  if (agent === undefined) throw new Error('roster 过小');
  return { agent, legal: enumerateLegalActions(state, agent.id) };
}

function mockDecide(state: SimState, agentIndex: number) {
  const { agent, legal } = legalOf(state, agentIndex);
  return decideMockWeighted({
    runId: 'local-test',
    seed: SEED,
    state,
    agentId: agent.id,
    stateHash: 'sha256:aa',
    actionSetHash: 'sha256:bb',
    legal,
  });
}

describe('mock-weighted-v1（04 §2.1）', () => {
  function makeSoloState(): SimState {
    // candidateCount=0：无 compete 行动，便于隔离 ascend/descend 权重规则。
    const config = createDemoConfig({
      population: { initialPopulation: 4 },
      competition: { candidateCount: 0 },
    });
    return createSimulation(config, SEED);
  }

  it('无正权重非 accumulate 行动时只选 accumulate', () => {
    const state = makeSoloState();
    const { agent } = legalOf(state, 0);
    agent.classIndex = 1;
    agent.maxClassIndex = 1;
    // 重新枚举（阶级变化后费用不同），再设定 Value 恰可负担 ascend。
    const fresh = enumerateLegalActions(state, agent.id);
    agent.value = fresh.ascendCost ?? 0; // 恰可负担但 < 1.5×cost
    agent.belowNeedStreak = 0;
    const decision = mockDecide(state, 0);
    expect(decision.selectedAction).toBe('accumulate');
    expect(decision.probabilities?.['accumulate']).toBe(1);
    expect(decision.probabilities?.['ascend']).toBe(0);
    // descend 合法（classIndex>0）但 streak<7 → 权重 0
    expect(decision.probabilities?.['descend']).toBe(0);
  });

  it('ascend 满足 1.5 倍费用时权重 0.8，概率归一化', () => {
    const state = makeSoloState();
    const { agent } = legalOf(state, 0);
    agent.classIndex = 1;
    agent.maxClassIndex = 1;
    const fresh = enumerateLegalActions(state, agent.id);
    const ascendCost = fresh.ascendCost;
    if (ascendCost === null) throw new Error('ascend 应合法');
    agent.value = MOCK_WEIGHTED_V1_CONSTANTS.ascendAffordabilityFactor * ascendCost;
    agent.belowNeedStreak = 0;
    const decision = mockDecide(state, 0);
    expect(decision.probabilities?.['ascend']).toBeCloseTo(0.8 / 1.8, 12);
    const sum = Object.values(decision.probabilities ?? {}).reduce(
      (a: number, b: number) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1, 12);
  });

  it('descend 在 belowNeedStreak>=7 时权重 1.2', () => {
    const state = makeState();
    const { agent } = legalOf(state, 0);
    agent.classIndex = 2;
    agent.maxClassIndex = 2;
    agent.value = 0; // 仍够 descend？descend cost = 7*B*E[2] = 30.8 > 0 → 不合法
    agent.belowNeedStreak = 7;
    // 让 descend 合法：value 覆盖费用但 < 1.5×ascendCost
    agent.value = 100;
    const decision = mockDecide(state, 0);
    expect(decision.probabilities?.['descend']).toBeGreaterThan(0);
  });

  it('compete 每个目标权重 0.10 且确定性可复现', () => {
    const state = makeState();
    const first = mockDecide(state, 1);
    const second = mockDecide(state, 1);
    expect(first.selectedAction).toBe(second.selectedAction);
    expect(first.probabilities).toEqual(second.probabilities);
    const competeProbs = Object.entries(first.probabilities ?? {}).filter(([action]) =>
      action.startsWith('compete:'),
    );
    const legal = legalOf(state, 1).legal;
    if (legal.targets.length > 0) {
      expect(competeProbs.length).toBeGreaterThan(0);
      for (const [, probability] of competeProbs) {
        expect(probability).toBeCloseTo(
          MOCK_WEIGHTED_V1_CONSTANTS.competeWeight /
            (MOCK_WEIGHTED_V1_CONSTANTS.accumulateWeight +
              legal.targets.length * MOCK_WEIGHTED_V1_CONSTANTS.competeWeight),
          12,
        );
      }
    }
  });

  it('决策记录字段符合 04 §2', () => {
    const state = makeState();
    const decision = mockDecide(state, 2);
    expect(decision.schemaVersion).toBe('stratify-decision-v1');
    expect(decision.policyVersion).toBe(POLICY_VERSION_MOCK);
    expect(decision.source).toBe('mock');
    expect(decision.probabilitySource).toBe('derived');
    expect(decision.requestedAction).toBeNull();
    expect(decision.requestedModel).toBe('mock');
    expect(decision.promptVersion).toBeNull();
    expect(decision.promptStyle).toBeNull();
    expect(decision.topK).toBe(1);
    expect(decision.fallbackReason).toBeNull();
    expect(decision.rawResponse).toBeNull();
    expect(decision.stateHash).toBe('sha256:aa');
    expect(decision.legalActions.length).toBeGreaterThan(0);
  });

  it('不同 seed 选择可区分（统计性）', () => {
    const state = makeState();
    const { agent, legal } = legalOf(state, 1);
    const picks = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6'] as const) {
      const decision = decideMockWeighted({
        runId: 'local-test',
        seed: asSeed(seed),
        state,
        agentId: agent.id,
        stateHash: 'sha256:aa',
        actionSetHash: 'sha256:bb',
        legal,
      });
      picks.add(decision.selectedAction);
    }
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('random-uniform-v1（04 §2.1）', () => {
  it('等概率 1/n 且确定性', () => {
    const state = makeState();
    const { agent, legal } = legalOf(state, 1);
    const input = {
      runId: 'local-test',
      seed: SEED,
      state,
      agentId: agent.id,
      stateHash: 'sha256:aa',
      actionSetHash: 'sha256:bb',
      legal,
    };
    const first = decideRandomUniform(input);
    const second = decideRandomUniform(input);
    expect(first.selectedAction).toBe(second.selectedAction);
    const n = legal.actions.length;
    for (const probability of Object.values(first.probabilities ?? {})) {
      expect(probability).toBeCloseTo(1 / n, 15);
    }
    expect(first.policyVersion).toBe(POLICY_VERSION_RANDOM);
    expect(first.source).toBe('random');
    expect(first.probabilitySource).toBe('derived');
    expect(first.topK).toBe(1);
  });

  it('空合法集属于核心错误，拒绝猜测', () => {
    const state = makeState();
    const { agent } = legalOf(state, 1);
    expect(() =>
      decideRandomUniform({
        runId: 'local-test',
        seed: SEED,
        state,
        agentId: agent.id,
        stateHash: 'sha256:aa',
        actionSetHash: 'sha256:bb',
        legal: { actions: [], ascendCost: null, descendCost: null, targets: [] },
      }),
    ).toThrowError(/拒绝猜测/);
  });
});
