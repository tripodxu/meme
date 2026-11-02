import type { TruncatedLognormalSpec, TruncatedNormalSpec } from '../config/types.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import { readNumericConstant } from '../params.js';

/** Box–Muller 的角度参数与截断抽样的尝试上限均为实现常量（03 §4.2）。 */
const TWO_PI = readNumericConstant('TWO_PI');
const REJECTION_ATTEMPT_LIMIT = readNumericConstant('REJECTION_ATTEMPT_LIMIT');

/** RNG 归一化下界；Box–Muller 中作为 u1 的下限避免 log(0)。 */
const TWO_POW_NEG_53 = readNumericConstant('TWO_POW_NEG_53');

function assertUnitInterval(r: number, source: string): void {
  if (!Number.isFinite(r) || r < 0 || r >= 1) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `${source} 抽样输入必须位于 [0,1): ${String(r)}`,
    );
  }
}

/**
 * 均匀索引（03 §4.2）：候选已按约定键升序，`j=floor(R×length)`。
 * `length=0` 表示无候选，返回 -1 且不消费随机数由调用方保证。
 */
export function uniformIndex(r: number, length: number): number {
  assertUnitInterval(r, 'uniformIndex');
  if (!Number.isInteger(length) || length < 0) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `length 必须为非负整数: ${String(length)}`,
    );
  }
  if (length === 0) {
    return -1;
  }
  return Math.floor(r * length);
}

/**
 * Fisher–Yates（03 §4.2）：调用方先提供升序数组；i 从 n-1 降到 1，
 * counter 从 0 递增，`j=floor(R(counter)×(i+1))` 并交换。返回新数组。
 */
export function fisherYatesShuffle<T>(items: readonly T[], draw: (counter: number) => number): T[] {
  const result = [...items];
  let counter = 0;
  for (let i = result.length - 1; i >= 1; i -= 1) {
    const r = draw(counter);
    assertUnitInterval(r, 'fisherYatesShuffle');
    counter += 1;
    const j = Math.floor(r * (i + 1));
    const current = result[i];
    const swapWith = result[j];
    if (current === undefined || swapWith === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'Fisher–Yates 索引越界');
    }
    result[i] = swapWith;
    result[j] = current;
  }
  return result;
}
/**
 * 加权抽样索引（03 §4.2）：候选保持调用方给定的稳定顺序，
 * `target=R×sumWeight`，选择首个 `target<cumulativeWeight` 的候选。
 * 权重必须有限且 >=0；sum=0 视为无候选返回 -1。
 * 唯一的浮点兜底：`target` 因末位舍入与总和相等时选最后一个正权重候选，行为确定。
 */
export function weightedSampleIndex(weights: readonly number[], r: number): number {
  assertUnitInterval(r, 'weightedSampleIndex');
  let total = 0;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        `权重必须有限且 >=0: ${String(weight)}`,
      );
    }
    total += weight;
  }
  if (total <= 0) {
    return -1;
  }
  const target = r * total;
  let cumulative = 0;
  let index = 0;
  let lastPositive = -1;
  for (const weight of weights) {
    if (weight > 0) {
      lastPositive = index;
    }
    cumulative += weight;
    if (target < cumulative) {
      return index;
    }
    index += 1;
  }
  // 浮点末位兜底：target 因舍入与总和相等时选最后一个正权重候选（确定性）。
  return lastPositive;
}

/**
 * Box–Muller 标准正态（03 §4.2）：`z=sqrt(-2ln(max(u1,2^-53)))×cos(2πu2)`。
 * 不缓存第二个样本。
 */
export function standardNormalFromPair(u1: number, u2: number): number {
  assertUnitInterval(u1, 'standardNormalFromPair.u1');
  assertUnitInterval(u2, 'standardNormalFromPair.u2');
  return Math.sqrt(-2 * Math.log(Math.max(u1, TWO_POW_NEG_53))) * Math.cos(TWO_PI * u2);
}

function assertTruncatedSpec(spec: TruncatedLognormalSpec | TruncatedNormalSpec): void {
  if (
    !Number.isFinite(spec.sigma) ||
    spec.sigma < 0 ||
    !Number.isFinite(spec.min) ||
    !(spec.min > 0) ||
    !(spec.max >= spec.min) ||
    !Number.isFinite(spec.max)
  ) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '截断分布先验非法');
  }
}

/**
 * 截断对数正态（03 §4.2）：第 a 次尝试消费 `draw(2a)/draw(2a+1)`，
 * 样本 `median×exp(sigma×z)`，落入 `[min,max]` 才接受；sigma=0 直接取中位数。
 * 超过注册的尝试上限立即抛 `invariant_violated`，不得 clamp 伪造样本。
 */
export function sampleTruncatedLognormal(
  spec: TruncatedLognormalSpec,
  draw: (counter: number) => number,
): number {
  assertTruncatedSpec(spec);
  if (
    !Number.isFinite(spec.median) ||
    spec.median <= 0 ||
    spec.median < spec.min ||
    spec.median > spec.max
  ) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '对数正态中位数必须位于截断区间内');
  }
  if (spec.sigma === 0) {
    return spec.median;
  }
  for (let attempt = 0; attempt < REJECTION_ATTEMPT_LIMIT; attempt += 1) {
    const u1 = draw(2 * attempt);
    const u2 = draw(2 * attempt + 1);
    const sample = spec.median * Math.exp(spec.sigma * standardNormalFromPair(u1, u2));
    if (sample >= spec.min && sample <= spec.max) {
      return sample;
    }
  }
  throw new StratifyError(
    errorCodes.INVARIANT_VIOLATED,
    `截断对数正态抽样超过尝试上限 ${REJECTION_ATTEMPT_LIMIT}`,
  );
}

/**
 * 截断正态（03 §4.2）：样本 `mean+sigma×z`，落入 `[min,max]` 才接受；
 * sigma=0 直接取均值且不消费随机数。
 */
export function sampleTruncatedNormal(
  spec: TruncatedNormalSpec,
  draw: (counter: number) => number,
): number {
  assertTruncatedSpec(spec);
  if (!Number.isFinite(spec.mean) || spec.mean < spec.min || spec.mean > spec.max) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '正态均值必须位于截断区间内');
  }
  if (spec.sigma === 0) {
    return spec.mean;
  }
  for (let attempt = 0; attempt < REJECTION_ATTEMPT_LIMIT; attempt += 1) {
    const u1 = draw(2 * attempt);
    const u2 = draw(2 * attempt + 1);
    const sample = spec.mean + spec.sigma * standardNormalFromPair(u1, u2);
    if (sample >= spec.min && sample <= spec.max) {
      return sample;
    }
  }
  throw new StratifyError(
    errorCodes.INVARIANT_VIOLATED,
    `截断正态抽样超过尝试上限 ${REJECTION_ATTEMPT_LIMIT}`,
  );
}
