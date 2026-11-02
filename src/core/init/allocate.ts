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
  const entries = shares.map((share, classIndex) => {
    if (!Number.isFinite(share) || share < 0) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        `阶级比例必须有限且 >=0: ${String(share)}`,
      );
    }
    const exact = share * population;
    return { classIndex, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let floorSum = 0;
  for (const entry of entries) {
    floorSum += entry.count;
  }
  let remaining = population - floorSum;
  if (remaining < 0) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '最大余数法出现负余数，比例或人口非法');
  }
  const order = [...entries].sort(
    (a, b) => b.remainder - a.remainder || a.classIndex - b.classIndex,
  );
  for (const entry of order) {
    if (remaining <= 0) {
      break;
    }
    entry.count += 1;
    remaining -= 1;
  }
  let total = 0;
  for (const entry of entries) {
    total += entry.count;
  }
  if (total !== population) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `最大余数法分配总数 ${total} 与人口 ${population} 不一致`,
    );
  }
  const counts = new Array<number>(entries.length).fill(0);
  for (const entry of entries) {
    counts[entry.classIndex] = entry.count;
  }
  return counts;
}
