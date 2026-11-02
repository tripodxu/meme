import type { RunConfig } from '../config/types.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import type { AgentId } from '../control/ids.js';
import type { AgentState } from '../model/agent.js';
import { agentIndexFromId } from '../model/agent.js';
import { clamp } from './arith.js';

/**
 * 努力函数（03 §6 阶段 C）：必须用 `expm1` 的稳定形式，
 * 否则 `FShape` 接近 0 时分子分母同时下溢为 0。
 */
export function effortFunction(shape: number, hard: number): number {
  return Math.expm1(-shape * hard) / Math.expm1(-shape);
}

/**
 * 阶级时间缓冲（03 §3）：`buffer(age)=clamp((age-1)/(bufferDays-1),0,1)`；
 * 首日 classAge=1 → buffer=0，第 bufferDays 日起为 1。
 */
export function classBuffer(classAge: number, bufferDays: number): number {
  return clamp((classAge - 1) / (bufferDays - 1), 0, 1);
}

/**
 * 需求线（03 §6 阶段 C，rules-v4）：
 * `need = buffer(classAge)×baselineSum×ψ[class]×(E[t,class]/E[t,0])^φ`。
 * `φ=0` 时不做 pow，与 v3 公式逐位一致。
 */
export function computeNeed(
  config: RunConfig,
  classAge: number,
  baselineSum: number,
  classIndex: number,
  eByClass: readonly number[],
): number {
  const psi = config.need.needMultiplier[classIndex];
  if (psi === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `needMultiplier 缺少阶级 ${classIndex}`);
  }
  const base = classBuffer(classAge, config.need.bufferDays) * baselineSum * psi;
  const phi = config.need.envExponent;
  if (phi === 0) {
    return base;
  }
  const own = eByClass[classIndex];
  const bottom = eByClass[0];
  if (own === undefined || bottom === undefined || !(bottom > 0)) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `E 缺少阶级或 E[0] 非正: ${String(own)}/${String(bottom)}`,
    );
  }
  return base * Math.pow(own / bottom, phi);
}

/** 数值稳定 sigmoid；用于 pA 与 Otarget。 */
export function stableSigmoid(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const expX = Math.exp(x);
  return expX / (1 + expX);
}

/**
 * 竞争能力（03 §6 阶段 B）：`(1+Value)^a×ge^b×hard^c`，以 log 空间返回，
 * 避免极大 Value 下 `Infinity/Infinity`。任一输入非有限属于不变量失败。
 */
export function logPower(
  config: RunConfig,
  agent: Pick<AgentState, 'value' | 'ge' | 'hard'>,
): number {
  if (
    !Number.isFinite(agent.value) ||
    agent.value < 0 ||
    !Number.isFinite(agent.ge) ||
    agent.ge <= 0 ||
    !Number.isFinite(agent.hard) ||
    agent.hard <= 0
  ) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `power 输入非法: ${JSON.stringify({
        value: agent.value,
        ge: agent.ge,
        hard: agent.hard,
      })}`,
    );
  }
  return (
    config.competition.powerValueExponent * Math.log1p(agent.value) +
    config.competition.powerGeExponent * Math.log(agent.ge) +
    config.competition.powerHardExponent * Math.log(agent.hard)
  );
}

/**
 * 竞争结算（03 §6 阶段 B）。返回败者损失与胜者收益；`gain<=loss` 由
 * `baseTransferEfficiency×directionMultiplier<=1` 的配置约束保证。
 */
export function resolveCompetition(
  config: RunConfig,
  initiator: AgentState,
  target: AgentState,
  r: number,
): {
  winner: 'initiator' | 'target';
  loss: number;
  gain: number;
  directionMultiplier: number;
  direction: 'same_class' | 'high_to_low' | 'low_to_high';
  pInitiator: number;
} {
  const crossClass = initiator.classIndex !== target.classIndex;
  const logPowerInitiator = logPower(config, initiator);
  const logPowerTarget = logPower(config, target);
  // 跨层发起 ×initiatorMultiplier、被竞争 ×targetMultiplier；同层均 ×1（log 加法）。
  const adjustedInitiator = crossClass
    ? logPowerInitiator + Math.log(config.competition.crossClassInitiatorMultiplier)
    : logPowerInitiator;
  const adjustedTarget = crossClass
    ? logPowerTarget + Math.log(config.competition.crossClassTargetMultiplier)
    : logPowerTarget;
  const pInitiator = stableSigmoid(adjustedInitiator - adjustedTarget);
  const initiatorWins = r < pInitiator;
  const direction: 'same_class' | 'high_to_low' | 'low_to_high' = !crossClass
    ? 'same_class'
    : initiator.classIndex > target.classIndex
      ? 'high_to_low'
      : 'low_to_high';
  // 方向乘子仅按原发起方是否获胜与原方向确定；防守方获胜恒为 1。
  let directionMultiplier = 1;
  if (initiatorWins) {
    if (direction === 'high_to_low') {
      directionMultiplier = config.competition.highToLowWinMultiplier;
    } else if (direction === 'low_to_high') {
      directionMultiplier = config.competition.lowToHighWinMultiplier;
    }
  }
  const loser = initiatorWins ? target : initiator;
  const loss = Math.min(loser.value, config.competition.lossRate * loser.value);
  const gain = loss * config.competition.baseTransferEfficiency * directionMultiplier;
  if (!(gain <= loss + Number.EPSILON * Math.max(1, loss))) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `竞争收益超过损失: ${String(gain)} > ${String(loss)}`,
    );
  }
  return {
    winner: initiatorWins ? 'initiator' : 'target',
    loss,
    gain,
    directionMultiplier,
    direction,
    pInitiator,
  };
}

/** 寿命损耗（03 §6 阶段 E）：`decay[c]×max(1+hardLifeFactor×(hard-1), hardLifeFloor)`。 */
export function lifeLoss(
  config: RunConfig,
  agent: Pick<AgentState, 'classIndex' | 'hard'>,
): number {
  const decay = config.lifespan.decay[agent.classIndex];
  if (decay === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `decay 缺少阶级 ${agent.classIndex}`);
  }
  const hardFactor = Math.max(
    1 + config.lifespan.hardLifeFactor * (agent.hard - 1),
    config.lifespan.hardLifeFloor,
  );
  return decay * hardFactor;
}

/** 机会乘子（03 §6 阶段 C）：无邻居为 1；偶数中位数取中间两数均值。 */
export function computeOpportunity(
  config: RunConfig,
  neighborValues: readonly number[],
  allAliveValues: readonly number[],
): number {
  const medianNeighbor = neighborValues.length === 0 ? 0 : median(neighborValues);
  const medianAll = median(allAliveValues);
  return computeOpportunityFromMedians(config, neighborValues.length, medianNeighbor, medianAll);
}

/**
 * 机会乘子的预计算形式：全体中位数每个 tick 只需计算一次（O(N²) 防护），
 * 邻居中位数由调用方按 agent 计算（邻居数 <= maxDegree）。
 */
export function computeOpportunityFromMedians(
  config: RunConfig,
  neighborCount: number,
  medianNeighbor: number,
  medianAll: number,
): number {
  if (neighborCount === 0) {
    return 1;
  }
  const raw = Math.exp(
    config.networkOpportunity.beta * (Math.log1p(medianNeighbor) - Math.log1p(medianAll)),
  );
  return clamp(raw, config.networkOpportunity.min, config.networkOpportunity.max);
}

/** 偶数长度取中间两数均值（03 §6 阶段 C）。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '中位数输入为空');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1] as number;
  return (lower + upper) / 2;
}

/** 初始化序号转换；仅供引擎内部用 O(1) 定位 agent。 */
export function agentSlot(id: AgentId, agentCount: number): number {
  const index = agentIndexFromId(id);
  if (!Number.isInteger(index) || index < 0 || index >= agentCount) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `agentId 越界: ${id}`);
  }
  return index;
}
