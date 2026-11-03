import type { AgentId } from '../control/ids.js';
import type { AgentState } from './agent.js';

/**
 * 一个 tick 内发生的阶级转移计数（`metrics.flowWindowDays` 滚动窗口的成员）。
 * `counts[from][to]`；对角线恒为 0（同阶级停留不是转移）。
 */
export interface FlowWindowEntry {
  readonly tick: number;
  readonly counts: readonly (readonly number[])[];
}

/**
 * 社会级权威状态（03 §2.2）。
 *
 * `tick` 是下一个待结算 tick；`agents` 含死亡者且始终按 id 升序。
 * 完整不可变输入（config/seed/hash）位于 `SimState` 顶层，见 `state.ts` 的映射说明。
 */
export interface SocietyState {
  /** 下一个待结算 tick。 */
  tick: number;
  /** 全部个体（含死亡者），按 id 升序。 */
  readonly agents: AgentState[];
  /** 当前 tick 使用的有效阶级机会系数 E[C]，恒 >0。 */
  readonly eByClass: number[];
  /**
   * 需求参照系（rules-v6）：上期各阶级人均收入的 EMA `refIncome[C]`，恒 >0。
   * 初始值 `dailyBase × env0[c]`，由 `(config, seed)` 纯函数派生；
   * 更新发生在阶段 C 全部 gain 算完之后（先算后用，为下一 tick 服务；
   * 空阶级保持上期值）。`need.referenceMode='own'` 时**不读取也不更新**
   * （保持初始值），保证与 v5 逐位一致（G-D）。
   */
  readonly refIncome: number[];
  /** 社会开放度，`[0,1]`。 */
  openness: number;
  /** 初始人口占比 P0[C]，按实际人数计算（非配置理想比例）。 */
  readonly initialClassShares: number[];
  /** 最近完成 tick 的基尼系数。 */
  gini: number;
  /** 调整后同层边占比 S，`[-1,1]`。 */
  segregation: number;
  /** 365 日（metrics.mobilityWindowDays）上升流动参与率。 */
  mUp: number;
  /** 365 日下降流动参与率（含被动跌落与主动降阶）。 */
  mDown: number;
  /** 最近完成 tick 的存活网络无向边数。 */
  edgeCount: number;
  /** 流动窗口内按 tick 的阶级转移计数；仅保留最近 `metrics.flowWindowDays` 日。 */
  readonly flowWindow: FlowWindowEntry[];
  /** 上次开放度更新的 tick，用于计算 Δt（tick 0 的 Δt=0）。 */
  lastOpennessUpdateTick: number;
}

/** 无向边；规范化为 `a < b`。 */
export interface Edge {
  readonly a: AgentId;
  readonly b: AgentId;
}

/** 比较 agentId 的 UTF-8 字节序升序（JS 字符串比较对 ASCII 与之一致）。 */
export function compareAgentId(a: AgentId, b: AgentId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
