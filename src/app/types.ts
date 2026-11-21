import type { RunConfig } from '../core/config/types.js';
import type { AgentId } from '../core/control/ids.js';
import type { TickEvent } from '../core/events.js';
import type { LegalActionSet } from '../core/legal-actions.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import type { Snapshot } from '../core/replay/snapshot.js';
import type { DecisionRecord, ExecutionRecord, PromptStyle } from '../decision/types.js';

/** 浏览器端 RunController 状态（02 §5 / 06 §4）。 */
export type RunStatus =
  | 'idle'
  | 'validating'
  | 'invalid'
  | 'ready'
  | 'running'
  | 'awaiting_decision'
  | 'settling_tick'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'replaying';

/**
 * 浏览器可选策略。`jev_live` 只经同源 `/api/jev` 代理，Key 仅存内存；
 * mock/random 为确定性离线策略。
 */
export type OfflinePolicyId =
  'mock-weighted-v1' | 'mock-weighted-v2' | 'random-uniform-v1' | 'jev_live';

export interface RunIssue {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly phase: RunStatus;
  /** 可下载诊断；不含 Key/token。 */
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

export interface ReplayInfo {
  readonly source: 'bundle' | 'memory';
  readonly policyVersion: string;
  readonly fromTick: number;
  readonly mode: 'mock_replay' | 'random_replay' | 'jev_replay';
  readonly replayInvalid: number;
}

/** 沙盒化身手动抉择提示：仅从核心枚举的合法行动集中选择，不修改任何结算公式。 */
export interface AvatarDecisionPrompt {
  readonly tick: number;
  readonly agentId: AgentId;
  readonly classIndex: number;
  readonly value: number;
  readonly need: number | null;
  readonly needRatio: number | null;
  readonly belowNeedStreak: number;
  readonly remainingLife: number;
  readonly initialLife: number;
  readonly legal: LegalActionSet;
  /** 离线先验策略给出的参考权重分布（仅作辅助提示，非胜率承诺）。 */
  readonly advisorProbabilities: Readonly<Record<string, number>>;
  readonly targets: readonly {
    readonly id: AgentId;
    readonly classIndex: number;
    readonly value: number;
    readonly isNeighbor: boolean;
  }[];
}

/** 平行宇宙分叉基准记录（06 §6 & §7：记录克隆检查点 hash 与变更字段）。 */
export interface ForkProvenance {
  readonly parentRunId: string;
  readonly forkTick: number;
  readonly checkpointStateHash: string;
  readonly changedField: string;
  readonly description: string;
}

/** 控制器对外只读快照；数组与 state 由调用方只读使用，不得修改。 */
export interface ControllerSnapshot {
  readonly status: RunStatus;
  readonly generation: number;
  readonly runId: string | null;
  readonly seed: string | null;
  readonly policy: OfflinePolicyId;
  readonly promptStyle: PromptStyle;
  readonly config: RunConfig | null;
  readonly tick: number;
  readonly totalTicks: number;
  readonly aliveCount: number;
  readonly cumulativeDeaths: number;
  readonly configHash: string | null;
  readonly paramsHash: string | null;
  readonly initialPopulationHash: string | null;
  readonly latestStats: TickStats | null;
  readonly stats: readonly TickStats[];
  readonly events: readonly TickEvent[];
  readonly decisions: readonly DecisionRecord[];
  readonly executions: readonly ExecutionRecord[];
  readonly endReason: 'scheduled' | 'extinct' | null;
  readonly failure: RunFailure | null;
  readonly issues: readonly RunIssue[];
  readonly snapshotTick: number | null;
  /** 可供时间穿梭回跳的内存周期快照 tick 列表（06 §4）。 */
  readonly availableSnapshotTicks: readonly number[];
  readonly replay: ReplayInfo | null;
  readonly decisionsTruncated: boolean;
  /** Live / 异步决策周期的在途进度（06 §4）。 */
  readonly decisionProgress: {
    readonly total: number;
    readonly completed: number;
    readonly fallbacks: number;
  } | null;
  /** 沙盒化身状态与当前挂起的玩家抉择。 */
  readonly avatarId: AgentId | null;
  readonly avatarInteractive: boolean;
  readonly pendingAvatarPrompt: AvatarDecisionPrompt | null;
  /** 若当前世界由微扰分叉产生，携带分叉溯源元数据。 */
  readonly forkProvenance: ForkProvenance | null;
}

/** 本地导出的完整离线 run（P3-05）。 */
export interface WebRunBundle {
  readonly schemaVersion: 'stratify-web-run-v1';
  readonly exportedAt: string;
  readonly runId: string;
  readonly seed: string;
  readonly policy: OfflinePolicyId;
  readonly status: RunStatus;
  readonly endReason: 'scheduled' | 'extinct' | null;
  readonly config: RunConfig;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly initialPopulationHash: string;
  readonly initialSnapshot: Snapshot | null;
  readonly latestSnapshot: Snapshot | null;
  /** 可选周期快照列表，向后兼容旧版 bundle。 */
  readonly periodicSnapshots?: readonly Snapshot[];
  readonly stats: readonly TickStats[];
  readonly events: readonly TickEvent[];
  readonly decisions: readonly DecisionRecord[];
  readonly decisionsTruncated: boolean;
}
