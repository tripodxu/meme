import type { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';

/** 决策来源（04 §2）。重放按原始策略区分，不得统一冒充 `jev_replay`。 */
export type DecisionSource =
  'mock' | 'random' | 'jev_live' | 'jev_replay' | 'mock_replay' | 'random_replay' | 'fallback';

/** 回退原因稳定枚举（04 §5）；当前至少覆盖契约列出的全部值。 */
export const FALLBACK_REASONS = [
  'timeout',
  'network_error',
  'http_401',
  'http_403',
  'http_429',
  'upstream_5xx',
  'http_client_error',
  'invalid_json',
  'invalid_schema',
  'no_legal_option',
  'empty_legal_probability',
  'non_finite_probability',
  'stale_state',
  'stale_action_set',
  'budget_exhausted',
  'usage_missing',
  'retry_after_exceeded',
  'retry_after_invalid',
  'cancelled',
  'replay_invalid',
  'stale_invalid',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export type PromptStyle = 'neutral' | 'survival_hint';

/**
 * 决策层统一输出（04 §2）。
 * 模型未返回概率时不得编造均匀概率并标为 exact；mock/random 使用 derived。
 * 核心实际执行结果写 `ExecutionRecord`，不回写本记录的 requested/selected。
 */
export interface DecisionRecord {
  readonly schemaVersion: typeof DECISION_SCHEMA_VERSION;
  /** 服务器 run 或 `local-<ulid>`；离线 run 不得伪装 server run。 */
  readonly runId: string;
  readonly tick: number;
  readonly agentId: string;
  readonly stateHash: string;
  readonly actionSetHash: string;
  readonly legalActions: readonly string[];
  readonly policyVersion: string;
  readonly promptVersion: string | null;
  readonly promptStyle: PromptStyle | null;
  /** 模型原始首选；mock/random 为 null。 */
  readonly requestedAction: string | null;
  /** 决策层校验/topK/回退后的最终选择；核心仍可能 stale_invalid。 */
  readonly selectedAction: string;
  readonly source: DecisionSource;
  readonly probabilitySource: 'exact' | 'derived' | 'none';
  readonly requestedModel: string | null;
  readonly responseModel: string | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly confidence: number | null;
  readonly topK: number;
  readonly usage: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly latencyMs: number;
  readonly attempts: number;
  readonly fallbackReason: FallbackReason | null;
  /** live artifact；mock 可为 null。 */
  readonly rawResponse: unknown | null;
}

/** 核心执行记录（04 §2.2）；决策层输出与实际结算结果分离保存。 */
export interface ExecutionRecord {
  readonly schemaVersion: 'execution-v1';
  readonly runId: string;
  readonly tick: number;
  readonly agentId: string;
  readonly selectedAction: string;
  /** 实际生效行动；未执行为 null。 */
  readonly executedAction: string | null;
  readonly status: 'executed' | 'stale_invalid' | 'replay_invalid' | 'skipped_dead';
  /** 稳定码，如 target_taken/insufficient_value。 */
  readonly reason: string | null;
  /** 对应核心事件序号。 */
  readonly eventSeq: number | null;
}
