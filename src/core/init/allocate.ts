import { errorCodes, StratifyError } from '../control/errors.js';

/**
 * 最大余数法（03 §4.3）：把理想比例转为精确人数。
 * `counts[c]=floor(share×N)`，余数按小数部分降序逐个 +1；余数并列时优先较小 classIndex。
 * 返回的数组总人数严格等于 `population`，某些阶级可以为 0。
 */
export function allocateClassCounts(
  shares: readonly number[],
  population: number,
): readonly number[] {
  if (!Number.isInteger(population) || population < 0) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `人口必须为非负整数: ${String(population)}`,
    );
  }
  const counts = shares.map((share) => {
    if (!Number.isFinite(share) || share < 0) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        `阶级比例必须有限且 >=0: ${String(share)}`,
      );
    }
    return Math.floor(share * population);
  });
  const floorSum = counts.reduce((sum, count) => sum + count, 0);
  let remaining = population - floorSum;
  if (remaining < 0) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '最大余数法出现负余数，比例或人口非法');
  }
  const order = shares
    .map((share, classIndex) => ({
      classIndex,
      remainder: share * population - Math.floor(share * population),
    }))
    .sort((a, b) => b.remainder - a.remainder || a.classIndex - b.classIndex);
  for (const entry of order) {
    if (remaining <= 0) {
      break;
    }
    const target = entry.classIndex;
    counts[target] = (counts[target] ?? 0) + 1;
    remaining -= 1;
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total !== population) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `最大余数法分配总数 ${total} 与人口 ${population} 不一致`,
    );
  }
  return counts;
}
