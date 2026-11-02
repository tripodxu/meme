import type { AgentId } from '../control/ids.js';

/** 死亡原因枚举（03 §2.1）；新增原因必须升级 rulesVersion。 */
export const DEATH_REASONS = ['age'] as const;
export type DeathReason = (typeof DEATH_REASONS)[number];

/**
 * 个体权威状态（03 §2.1）。
 *
 * 引擎内部允许原地修改工作副本；跨边界的 `SimState` 由 `step` 返回新对象，
 * 输入快照不被修改（02 §4）。
 */
export interface AgentState {
  /** 初始化后不变；死亡者 ID 永不复用。 */
  readonly id: AgentId;
  /** 死亡后不可逆。 */
  alive: boolean;
  /** 当前阶级，`[0,C-1]`。 */
  classIndex: number;
  /** 历史最高阶级，初始等于初始阶级，只升不降。 */
  maxClassIndex: number;
  /** 当前财富，`>=0` 且有限。 */
  value: number;
  /** 天赋，运行期不变，`>0`。 */
  readonly ge: number;
  /** 努力，运行期不变，`>0`。 */
  readonly hard: number;
  /** 初始寿命预算（日）。 */
  readonly initialLife: number;
  /** 剩余寿命（日），`>=0`。 */
  remainingLife: number;
  /** 当前阶级已完成停留日数。 */
  classAge: number;
  /** 当前阶级历史基准积累积分。 */
  baselineSum: number;
  /** 连续低于需求线的天数。 */
  belowNeedStreak: number;
  /** 最近一次上升 tick；死亡后保留审计值。 */
  lastAscentTick: number | null;
  /** 最近一次下降（含被动跌落与主动降阶）tick。 */
  lastDescentTick: number | null;
  /** 无向关系；始终保持按 agentId 升序，无自连/重边，度 <= maxDegree。 */
  ties: AgentId[];
  deathTick: number | null;
  deathReason: DeathReason | null;
}

const DIGITS = 4;

/** 规范 agentId：`a-` + 至少 4 位十进制（`a-0000` 起，顺序分配不复用）。 */
export function agentIdFromIndex(index: number): AgentId {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`agent 序号必须为非负整数: ${String(index)}`);
  }
  return `a-${String(index).padStart(DIGITS, '0')}` as AgentId;
}

/** 从规范 agentId 还原初始化序号；仅对 `a-<数字>` 形态有效。 */
export function agentIndexFromId(id: AgentId): number {
  return Number.parseInt(id.slice(2), 10);
}
