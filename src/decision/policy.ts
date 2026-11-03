import type { RunConfig } from '../core/config/types.js';
import type { AgentId, Seed } from '../core/control/ids.js';
import type { LegalActionSet } from '../core/legal-actions.js';
import type { DecisionRecord } from './types.js';

/**
 * P2-01：决策策略统一接口（02 §4 / 04 §2）。
 *
 * - 核心不感知 HTTP：live 策略通过实现本接口注入；
 * - mock/live/replay 可替换；`decide` 返回完整 DecisionRecord；
 * - `signal` 取消时实现应尽快返回 `cancelled` 回退（04 §6）。
 */

/** 发给策略的输入；`state` 由 P2-02 的序列化器产出（紧凑英文 JSON）。 */
export interface DecisionInput {
  readonly runId: string;
  readonly seed: Seed;
  readonly config: RunConfig;
  readonly tick: number;
  readonly agentId: AgentId;
  readonly stateHash: string;
  readonly actionSetHash: string;
  readonly legal: LegalActionSet;
  /** 04 §3.2 的完整 state 对象（已按固定构造顺序构建）。 */
  readonly state: unknown;
  readonly topK: number;
  readonly requestedModel: string;
  readonly promptVersion: string | null;
  readonly promptStyle: 'neutral' | 'survival_hint';
  /** 最近事件（04 §3.2 recentEvents，最多 5 条）；live 策略用于 prompt，mock 忽略。 */
  readonly recentEvents: readonly unknown[];
}

export interface DecisionPolicy {
  readonly policyVersion: string;
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord>;
}
