import type { AgentId } from './control/ids.js';

/** 事件 schema 版本（03 §9）；字段增删或含义变化必须升级。 */
export const EVENT_SCHEMA_VERSION = 'stratify-event-v1' as const;

/** Value 变化原因。 */
export type WealthCause =
  'accumulate' | 'ascend_cost' | 'descend_cost' | 'competition_loss' | 'competition_gain';

/** 竞争方向（按原发起方冻结）。 */
export type CompetitionDirection = 'same_class' | 'high_to_low' | 'low_to_high';

interface EventBase {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly runId: string;
  readonly tick: number;
  /** tick 内按固定管线递增的事件序号；与 tick 组成全局排序键。 */
  readonly seq: number;
  readonly type: string;
}

export interface WealthChangedEvent extends EventBase {
  readonly type: 'wealth_changed';
  readonly agentId: AgentId;
  readonly before: number;
  readonly delta: number;
  readonly after: number;
  readonly cause: WealthCause;
  /** 竞争对手 id；其他原因为 null。 */
  readonly referenceId: AgentId | null;
}

export interface ClassAscendedEvent extends EventBase {
  readonly type: 'class_ascended';
  readonly agentId: AgentId;
  readonly from: number;
  readonly to: number;
  readonly cost: number;
  readonly reason: 'active';
}

export interface ClassDescendedEvent extends EventBase {
  readonly type: 'class_descended';
  readonly agentId: AgentId;
  readonly from: number;
  readonly to: number;
  /** 被动跌落无费用，为 null。 */
  readonly cost: number | null;
  readonly reason: 'active' | 'passive';
}

export interface CompetitionResolvedEvent extends EventBase {
  readonly type: 'competition_resolved';
  readonly initiatorId: AgentId;
  readonly targetId: AgentId;
  /** power 在 log 空间记录，避免极大 Value 产生非 JSON 安全的 Infinity。 */
  readonly logPowerInitiator: number;
  readonly logPowerTarget: number;
  readonly pInitiator: number;
  readonly winner: 'initiator' | 'target';
  readonly direction: CompetitionDirection;
  readonly directionMultiplier: number;
  readonly loss: number;
  readonly gain: number;
}

export interface AgentDiedEvent extends EventBase {
  readonly type: 'agent_died';
  readonly agentId: AgentId;
  readonly cause: 'age';
}

/** 决策失效（stale_invalid 等）；含原行动与稳定原因码（03 §9 / 04 §2.2）。 */
export interface ActionInvalidEvent extends EventBase {
  readonly type: 'action_invalid';
  readonly agentId: AgentId;
  readonly action: string;
  readonly reason: string;
}

/** 网络重构结果；一次最多替换一条边。 */
export interface NetworkRewiredEvent extends EventBase {
  readonly type: 'network_rewired';
  readonly agentId: AgentId;
  readonly removedNeighbor: AgentId | null;
  readonly addedNeighbor: AgentId | null;
  /** 无新候选恢复旧边时为 true。 */
  readonly restored: boolean;
}

export type TickEvent =
  | WealthChangedEvent
  | ClassAscendedEvent
  | ClassDescendedEvent
  | CompetitionResolvedEvent
  | AgentDiedEvent
  | ActionInvalidEvent
  | NetworkRewiredEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 发事件时由 EventSequence 补齐的字段。 */
export type TickEventPayload = DistributiveOmit<
  TickEvent,
  'schemaVersion' | 'runId' | 'tick' | 'seq'
>;

/** 事件序列生成器：tick 内从 0 递增，跟随管线顺序（03 §9），并收集已发事件。 */
export class EventSequence {
  private next = 0;
  private readonly collected: TickEvent[] = [];

  constructor(
    private readonly runId: string,
    private readonly tick: number,
  ) {}

  emit(event: TickEventPayload): TickEvent {
    const full = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      runId: this.runId,
      tick: this.tick,
      seq: this.next,
      ...event,
    } as TickEvent;
    this.next += 1;
    this.collected.push(full);
    return full;
  }

  /** 本 tick 已发出的全部事件（按 seq 升序）。 */
  all(): readonly TickEvent[] {
    return this.collected;
  }
}
