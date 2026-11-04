import { errorCodes, StratifyError } from '../core/control/errors.js';
import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';
import type { DecisionInput, DecisionPolicy } from './policy.js';
import type { DecisionRecord, DecisionSource } from './types.js';

/**
 * P2-06：决策回放（04 §9）。
 *
 * - 按 `(tick, agentId)` 取原始 DecisionRecord，只使用 `selectedAction`；
 * - `requestedAction` 不参与回放，避免被回退的非法模型回答在新世界「复活」；
 * - 当前合法行动集不含 `selectedAction` 时记 `replay_invalid` 并回退 accumulate；
 * - 回放不调用 Jev、不消耗预算；来源按原始策略区分（mock/random/jev）。
 */

export const POLICY_VERSION_REPLAY = 'replay-v1';
export const POLICY_VERSION_MOCK_REPLAY = 'mock-replay-v1';
export const POLICY_VERSION_RANDOM_REPLAY = 'random-replay-v1';
export const POLICY_VERSION_JEV_REPLAY = 'jev-replay-v1';

export function replayKey(tick: number, agentId: string): string {
  return `${tick}:${agentId}`;
}

/** 建索引；同一 `(tick, agentId)` 出现两次属于日志损坏，必须显式失败。 */
export function buildReplayIndex(
  records: readonly DecisionRecord[],
): ReadonlyMap<string, DecisionRecord> {
  const index = new Map<string, DecisionRecord>();
  for (const record of records) {
    const key = replayKey(record.tick, record.agentId);
    if (index.has(key)) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `回放记录重复：${key}`);
    }
    index.set(key, record);
  }
  return index;
}

/** 原始来源→回放来源（04 §2.2/§9.5）；fallback 保持 fallback，不冒充模型判断。 */
const REPLAY_SOURCE: Partial<Record<DecisionSource, DecisionSource>> = {
  mock: 'mock_replay',
  random: 'random_replay',
  jev_live: 'jev_replay',
};

const REPLAY_POLICY_VERSION: Partial<Record<DecisionSource, string>> = {
  mock: POLICY_VERSION_MOCK_REPLAY,
  random: POLICY_VERSION_RANDOM_REPLAY,
  jev_live: POLICY_VERSION_JEV_REPLAY,
};

export class ReplayPolicy implements DecisionPolicy {
  /** run 级策略版本；逐记录再按原始来源细化（04 §2）。 */
  readonly policyVersion = POLICY_VERSION_REPLAY;

  constructor(private readonly index: ReadonlyMap<string, DecisionRecord>) {}

  decide(input: DecisionInput): DecisionRecord {
    const original = this.index.get(replayKey(input.tick, input.agentId));
    if (original === undefined) {
      return this.invalidReplay(input);
    }
    if (!input.legal.actions.includes(original.selectedAction)) {
      return this.invalidReplay(input);
    }
    return {
      ...original,
      runId: input.runId,
      stateHash: input.stateHash,
      actionSetHash: input.actionSetHash,
      legalActions: [...input.legal.actions],
      policyVersion: REPLAY_POLICY_VERSION[original.source] ?? POLICY_VERSION_REPLAY,
      // 回放没有模型调用：原始 requestedAction 只留在旧日志中，不复制到新记录。
      requestedAction: null,
      selectedAction: original.selectedAction,
      source: REPLAY_SOURCE[original.source] ?? original.source,
      // 本次回放没有上游调用，usage/latency/attempts 不得沿用旧值。
      usage: {},
      latencyMs: 0,
      attempts: 0,
      topK: original.topK,
    };
  }

  private invalidReplay(input: DecisionInput): DecisionRecord {
    return {
      schemaVersion: DECISION_SCHEMA_VERSION,
      runId: input.runId,
      tick: input.tick,
      agentId: input.agentId,
      stateHash: input.stateHash,
      actionSetHash: input.actionSetHash,
      legalActions: [...input.legal.actions],
      policyVersion: POLICY_VERSION_REPLAY,
      promptVersion: null,
      promptStyle: null,
      requestedAction: null,
      selectedAction: 'accumulate',
      source: 'fallback',
      probabilitySource: 'none',
      requestedModel: null,
      responseModel: null,
      probabilities: null,
      confidence: null,
      topK: input.topK,
      usage: {},
      latencyMs: 0,
      attempts: 0,
      fallbackReason: 'replay_invalid',
      rawResponse: null,
    };
  }
}
