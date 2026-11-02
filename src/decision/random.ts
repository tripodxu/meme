import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { Seed, AgentId } from '../core/control/ids.js';
import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';
import type { LegalActionSet } from '../core/legal-actions.js';
import type { SimState } from '../core/model/state.js';
import { rngUnit } from '../core/rng/rng.js';
import { uniformIndex } from '../core/rng/sampling.js';
import { RNG_EVENT_TAGS } from '../core/rng/tags.js';
import type { DecisionRecord } from './types.js';

export const POLICY_VERSION_RANDOM = 'random-uniform-v1';

export interface RandomDecisionInput {
  readonly runId: string;
  readonly seed: Seed;
  readonly state: SimState;
  readonly agentId: AgentId;
  readonly stateHash: string;
  readonly actionSetHash: string;
  readonly legal: LegalActionSet;
}

/**
 * `random-uniform-v1`（04 §2.1）：对全部 legalActions 等概率均匀选择；
 * 概率 `1/n`、probabilitySource=derived，不使用 topK。
 * 非法/空合法集属于核心错误，不由 random 猜测。
 */
export function decideRandomUniform(input: RandomDecisionInput): DecisionRecord {
  const actions = input.legal.actions;
  if (actions.length === 0) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '合法行动集为空，random 策略拒绝猜测');
  }
  const r = rngUnit(
    input.seed,
    input.state.society.tick,
    input.agentId,
    RNG_EVENT_TAGS.randomAction,
    0,
  );
  const index = uniformIndex(r, actions.length);
  const selected = actions[index];
  if (selected === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'random 均匀抽样越界');
  }
  const probability = 1 / actions.length;
  const probabilities: Record<string, number> = {};
  for (const action of actions) {
    probabilities[action] = probability;
  }
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    runId: input.runId,
    tick: input.state.society.tick,
    agentId: input.agentId,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    legalActions: [...actions],
    policyVersion: POLICY_VERSION_RANDOM,
    promptVersion: null,
    promptStyle: null,
    requestedAction: null,
    selectedAction: selected,
    source: 'random',
    probabilitySource: 'derived',
    requestedModel: 'random',
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
