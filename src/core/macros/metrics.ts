import { errorCodes, StratifyError } from '../control/errors.js';

/**
 * 基尼系数（03 §6 阶段 G）：存活者 Value 升序 `x[i]`，
 * `G=Σ(2i-n-1)x[i]/(nΣx)`，i 从 1 开始；总和为 0 时 G=0；n=0 时返回 0。
 */
export function computeGini(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const value of sorted) {
    if (!Number.isFinite(value) || value < 0) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        `基尼输入必须有限且 >=0: ${String(value)}`,
      );
    }
    sum += value;
  }
  if (sum === 0) {
    return 0;
  }
  const n = sorted.length;
  let weighted = 0;
  let rank = 0;
  for (const value of sorted) {
    rank += 1;
    weighted += (2 * rank - n - 1) * value;
  }
  const gini = weighted / (n * sum);
  if (!Number.isFinite(gini) || gini < 0 || gini > 1) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `基尼系数越界: ${String(gini)}`);
  }
  return gini;
}

/**
 * 调整后网络隔离度 S（03 §6 阶段 G，双侧归一化，恒在 `[-1,1]`）。
 * `edgeCount==0` 时 S=0（调用方必须同时输出 `edgeCount=0`）。
 */
export function computeSegregation(
  sameClassEdges: number,
  edgeCount: number,
  aliveClassCounts: readonly number[],
): number {
  if (
    !Number.isInteger(sameClassEdges) ||
    sameClassEdges < 0 ||
    !Number.isInteger(edgeCount) ||
    edgeCount < 0
  ) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '边数必须为非负整数');
  }
  if (edgeCount === 0) {
    return 0;
  }
  if (sameClassEdges > edgeCount) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '同层边数不得超过总边数');
  }
  let expectedShare = 0;
  let total = 0;
  for (const count of aliveClassCounts) {
    total += count;
  }
  if (total === 0) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '空人口不计算隔离度');
  }
  for (const count of aliveClassCounts) {
    expectedShare += (count / total) ** 2;
  }
  const sameShare = sameClassEdges / edgeCount;
  let segregation: number;
  if (expectedShare >= 1) {
    segregation = 1;
  } else if (sameShare >= expectedShare) {
    segregation = (sameShare - expectedShare) / (1 - expectedShare);
  } else {
    segregation = (sameShare - expectedShare) / expectedShare;
  }
  if (!Number.isFinite(segregation) || segregation < -1 || segregation > 1) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `隔离度越界: ${String(segregation)}`);
  }
  return segregation;
}
