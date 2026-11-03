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
 * 阶级环境持有人乘子 `ψ_env[c] = (env0[c]/env0[0])^φ`（rules-v4）。
 * `φ=0` 时不做 pow，与 v3 语义逐位一致；锚定结构性 env0 比例，
 * 对运行期 Congestion 均衡化免疫（changes/0004 勘误）。
 */
function envHolderMultiplier(config: RunConfig, classIndex: number): number {
  const phi = config.need.envExponent;
  if (phi === 0) {
    return 1;
  }
  const own = config.opportunity.env0[classIndex];
  const bottom = config.opportunity.env0[0];
  if (own === undefined || bottom === undefined || !(bottom > 0)) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `env0 缺少阶级或 env0[0] 非正: ${String(own)}/${String(bottom)}`,
    );
  }
  return Math.pow(own / bottom, phi);
}

/**
 * `own` 模式需求线（v5 语义，`need.referenceMode='own'`，G-D 硬门禁）：
 * `need = buffer(classAge)×baselineSum×ψ[class]×(env0[class]/env0[0])^φ`。
 * 实现与 rules-v5 的 `computeNeed` 逐位一致（changes/0008）。
 */
export function computeNeedOwn(
  config: RunConfig,
  classAge: number,
  baselineSum: number,
  classIndex: number,
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
  return base * envHolderMultiplier(config, classIndex);
}

/**
 * `class` 模式需求线（rules-v6，D-06 选项 A′）：
 * `need = refIncome[class] × bufferDays × ψ_eff[class]`，
 * `ψ_eff = needMultiplier[c] × (env0[c]/env0[0])^φ`。
 * 参照量为**上期**各阶级人均收入的 EMA（society.refIncome），
 * 不乘 `buffer(classAge)`、不累加个体 `baselineSum`——持有标尺由个体计时器
 * 改为阶级标准（`2026-11-03-p15-w0-w1-handoff.md` §3.1 唯一权威定义）。
 */
export function computeNeedClass(
  config: RunConfig,
  refIncomeC: number,
  classIndex: number,
): number {
  const psi = config.need.needMultiplier[classIndex];
  if (psi === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `needMultiplier 缺少阶级 ${classIndex}`);
  }
  if (!Number.isFinite(refIncomeC) || refIncomeC <= 0) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `refIncome 非法: class=${classIndex} value=${String(refIncomeC)}`,
    );
  }
  const psiEff = psi * envHolderMultiplier(config, classIndex);
  return refIncomeC * config.need.bufferDays * psiEff;
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
  // 乘子进入 log 域，必须严格为正：0 会让 Math.log 得到 -Infinity，
  // 二者同时为 0 时 -Infinity-(-Infinity)=NaN，使 pInitiator 变成 NaN
  //（`r < NaN` 恒 false ⇒ 发起方恒败），NaN 还会流入事件与指标。
  const initiatorMultiplier = config.competition.crossClassInitiatorMultiplier;
  const targetMultiplier = config.competition.crossClassTargetMultiplier;
  if (crossClass && (!(initiatorMultiplier > 0) || !(targetMultiplier > 0))) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `跨层竞争乘子必须为正: initiator=${String(initiatorMultiplier)}, target=${String(targetMultiplier)}`,
    );
  }
  const adjustedInitiator = crossClass
    ? logPowerInitiator + Math.log(initiatorMultiplier)
    : logPowerInitiator;
  const adjustedTarget = crossClass ? logPowerTarget + Math.log(targetMultiplier) : logPowerTarget;
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
