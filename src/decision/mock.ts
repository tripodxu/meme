import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';
import type { Seed } from '../core/control/ids.js';
import type { SimState } from '../core/model/state.js';
import type { AgentId } from '../core/control/ids.js';
import { rngUnit } from '../core/rng/rng.js';
import { RNG_EVENT_TAGS } from '../core/rng/tags.js';
import { weightedSampleIndex } from '../core/rng/sampling.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { ActionKey, LegalActionSet } from '../core/legal-actions.js';
import { agentIndexFromId } from '../core/model/agent.js';
import type { DecisionRecord } from './types.js';

/**
 * `mock-weighted-v1` 策略常数（04 §2.1）。
 * 由 `policyVersion` 冻结：任何权重、阈值或采样地址变化都必须升级版本。
 */
export const MOCK_WEIGHTED_V1_CONSTANTS = Object.freeze({
  accumulateWeight: 1,
  competeWeight: 0.1,
  ascendWeight: 0.8,
  /** `Value >= 1.5×ascendCost` 才给 ascend 正权重。 */
  ascendAffordabilityFactor: 1.5,
  descendWeight: 1.2,
  /** `belowNeedStreak >= 7` 才给 descend 正权重。 */
  descendStreakThreshold: 7,
});

export const POLICY_VERSION_MOCK = 'mock-weighted-v1';
export const POLICY_VERSION_MOCK_V2 = 'mock-weighted-v2';

export interface MockDecisionInput {
  readonly runId: string;
  readonly seed: Seed;
  readonly state: SimState;
  readonly agentId: AgentId;
  readonly stateHash: string;
  readonly actionSetHash: string;
  readonly legal: LegalActionSet;
}

function mockWeights(
  agent: { value: number; belowNeedStreak: number },
  legal: LegalActionSet,
): number[] {
  const constants = MOCK_WEIGHTED_V1_CONSTANTS;
  const weights: number[] = [];
  for (const action of legal.actions) {
    if (action === 'accumulate') {
      weights.push(constants.accumulateWeight);
    } else if (action === 'ascend') {
      const cost = legal.ascendCost;
      weights.push(
        cost !== null && agent.value >= constants.ascendAffordabilityFactor * cost
          ? constants.ascendWeight
          : 0,
      );
    } else if (action === 'descend') {
      weights.push(
        agent.belowNeedStreak >= constants.descendStreakThreshold ? constants.descendWeight : 0,
      );
    } else {
      weights.push(constants.competeWeight);
    }
  }
  return weights;
}

/**
 * `mock-weighted-v1`（04 §2.1）：按 legalActions 请求顺序构造权重并加权抽样；
 * 概率为归一化权重（probabilitySource=derived）；不读取 Jev、不使用 topK。
 */
export function decideMockWeighted(input: MockDecisionInput): DecisionRecord {
  // agents 恒按 id 升序且 id 为顺序分配：用序号 O(1) 定位，避免每次决策 O(N) 扫描
  //（P1.5 每 tick 对全部存活个体调用，O(N²) 会主导运行时间）。
  const agent = input.state.society.agents[agentIndexFromId(input.agentId)];
  if (agent === undefined || agent.id !== input.agentId || !agent.alive) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `mock 决策个体不存在或已死亡: ${input.agentId}`,
    );
  }
  const weights = mockWeights(agent, input.legal);
  // 先校验权重，再抽样：空合法行动集或全部权重为 0 时给出明确原因，
  // 而不是让加权抽样返回 -1 后再报「未产生合法行动」。
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(totalWeight > 0)) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      'mock 权重总和必须为正（accumulate 恒有权重，出现 0 说明合法行动集被破坏）',
    );
  }
  const r = rngUnit(
    input.seed,
    input.state.society.tick,
    input.agentId,
    RNG_EVENT_TAGS.mockAction,
    0,
  );
  // accumulate 恒有正权重，加权抽样必然命中合法行动；
  // ascend/descend 权重为 0 时自动不可被选中（04 §2.1 规则 2）。
  const sampledIndex = weightedSampleIndex(weights, r);
  const selected = input.legal.actions[sampledIndex];
  if (selected === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'mock 加权抽样未产生合法行动');
  }
  const probabilities: Record<string, number> = {};
  input.legal.actions.forEach((action, actionIndex) => {
    probabilities[action] = (weights[actionIndex] ?? 0) / totalWeight;
  });
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    runId: input.runId,
    tick: input.state.society.tick,
    agentId: input.agentId,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    legalActions: [...input.legal.actions],
    policyVersion: POLICY_VERSION_MOCK,
    promptVersion: null,
    promptStyle: null,
    requestedAction: null,
    selectedAction: selected as ActionKey,
    source: 'mock',
    probabilitySource: 'derived',
    requestedModel: 'mock',
    responseModel: null,
    probabilities,
    confidence: null,
    topK: 1,
    usage: {},
    latencyMs: 0,
    attempts: 1,
    fallbackReason: null,
    rawResponse: null,
  };
}

/**
 * `mock-weighted-v2`（rules-v15 / D2，ADR 0007）：在 v1 权重上按个体行为特质
 * 调整 `compete` 权重：
 *
 * `w = w_v1 × exp(θrisk×(riskTolerance−0.5) + θcross×(crossClassOpenness−0.5)×跨层)`
 *
 * θ 全部来自 `config.behavior`；两者为 0 时 `exp(0)=1`，权重与 v1 逐位一致，
 * 抽样地址仍是 `mock_action`，因此默认配置下轨迹与 v1 相同。
 */
export function decideMockWeightedV2(input: MockDecisionInput): DecisionRecord {
  const agent = input.state.society.agents[agentIndexFromId(input.agentId)];
  if (agent === undefined || agent.id !== input.agentId || !agent.alive) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `mock-v2 决策个体不存在或已死亡: ${input.agentId}`,
    );
  }
  const behavior = input.state.config.behavior;
  const weights = mockWeights(agent, input.legal);
  input.legal.actions.forEach((action, index) => {
    if (!action.startsWith('compete:')) return;
    const targetId = action.slice('compete:'.length);
    const target = input.state.society.agents[agentIndexFromId(targetId as AgentId)];
    if (target === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `mock-v2 竞争目标缺失: ${targetId}`);
    }
    const crossClass = target.classIndex !== agent.classIndex ? 1 : 0;
    const multiplier = Math.exp(
      behavior.riskCompeteSensitivity * (agent.riskTolerance - 0.5) +
        behavior.crossClassCompeteSensitivity * (agent.crossClassOpenness - 0.5) * crossClass,
    );
    weights[index] = (weights[index] ?? 0) * multiplier;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(totalWeight > 0)) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      'mock 权重总和必须为正（accumulate 恒有权重，出现 0 说明合法行动集被破坏）',
    );
  }
  const r = rngUnit(
    input.seed,
    input.state.society.tick,
    input.agentId,
    RNG_EVENT_TAGS.mockAction,
    0,
  );
  const sampledIndex = weightedSampleIndex(weights, r);
  const selected = input.legal.actions[sampledIndex];
  if (selected === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'mock-v2 加权抽样未产生合法行动');
  }
  const probabilities: Record<string, number> = {};
  input.legal.actions.forEach((action, actionIndex) => {
    probabilities[action] = (weights[actionIndex] ?? 0) / totalWeight;
  });
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    runId: input.runId,
    tick: input.state.society.tick,
    agentId: input.agentId,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    legalActions: [...input.legal.actions],
    policyVersion: POLICY_VERSION_MOCK_V2,
    promptVersion: null,
    promptStyle: null,
    requestedAction: null,
    selectedAction: selected as ActionKey,
    source: 'mock',
    probabilitySource: 'derived',
    requestedModel: 'mock',
    responseModel: null,
    probabilities,
    confidence: null,
    topK: 1,
    usage: {},
    latencyMs: 0,
    attempts: 1,
    fallbackReason: null,
    rawResponse: null,
  };
}
