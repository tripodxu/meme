import type { RunConfig } from '../core/config/types.js';
import type { TickEvent } from '../core/events.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import type { Snapshot } from '../core/replay/snapshot.js';
import type { DecisionRecord, ExecutionRecord } from '../decision/types.js';

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

/** 离线浏览器只允许确定性策略；live/replay 通过注入实现接入。 */
export type OfflinePolicyId = 'mock-weighted-v1' | 'mock-weighted-v2' | 'random-uniform-v1';

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

/** 控制器对外只读快照；数组与 state 由调用方只读使用，不得修改。 */
export interface ControllerSnapshot {
  readonly status: RunStatus;
  readonly generation: number;
  readonly runId: string | null;
  readonly seed: string | null;
  readonly policy: OfflinePolicyId;
  readonly config: RunConfig | null;
  readonly tick: number;
  readonly totalTicks: number;
  readonly aliveCount: number;
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
  readonly replay: ReplayInfo | null;
  readonly decisionsTruncated: boolean;
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
  readonly stats: readonly TickStats[];
  readonly events: readonly TickEvent[];
  readonly decisions: readonly DecisionRecord[];
  readonly decisionsTruncated: boolean;
}
