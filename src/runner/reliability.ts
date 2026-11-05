/**
 * P6-04b 前置：Jev 重测信度（07 §11、08 §质量门禁）。
 *
 * 纯分析层：输入 20 次同一 state 的决策记录，输出选项分布、top-1 一致率、
 * 概率向量 ICC(2,1) 与重复间平均 TV 距离，并按 07 §11 给出 verdict。
 * 不读文件、不发请求、不依赖时钟。
 */

export interface ReliabilityRecord {
  readonly selectedAction: string;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly probabilitySource: 'exact' | 'derived' | 'none';
  readonly source: string;
  readonly fallbackReason: string | null;
  readonly responseModel: string | null;
}

export interface ReliabilityThresholds {
  readonly top1Agreement: 0.7;
  readonly icc21: 0.5;
  readonly meanTv: 0.15;
  readonly minRepeats: 20;
}

export const RELIABILITY_THRESHOLDS: ReliabilityThresholds = {
  top1Agreement: 0.7,
  icc21: 0.5,
  meanTv: 0.15,
  minRepeats: 20,
};

export type ReliabilityVerdict = 'reliable' | 'model_unstable' | 'exploratory';

export interface ReliabilitySummary {
  readonly schemaVersion: 'jev-reliability-v1';
  readonly repeats: number;
  readonly validRepeats: number;
  readonly fallbacks: number;
  readonly fallbackReasons: Readonly<Record<string, number>>;
  readonly probabilitySources: Readonly<Record<'exact' | 'derived' | 'none', number>>;
  readonly optionDistribution: Readonly<Record<string, number>>;
  readonly top1Agreement: number | null;
  readonly meanTv: number | null;
  readonly icc21: number | null;
  readonly responseModels: readonly string[];
  readonly thresholds: ReliabilityThresholds;
  readonly verdict: ReliabilityVerdict;
  readonly passed: boolean;
  readonly detail: string;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * ICC(2,1)：双向随机效应、绝对一致、单评分者。
 * 行 = 选项（targets），列 = 重复（raters）；要求完整矩形且每维 >=2。
 */
export function icc21(matrix: readonly (readonly number[])[]): number | null {
  const n = matrix.length;
  if (n < 2) {
    return null;
  }
  const k = matrix[0]?.length ?? 0;
  if (k < 2 || matrix.some((row) => row.length !== k)) {
    return null;
  }
  const grand = mean(matrix.flat());
  const rowMeans = matrix.map((row) => mean(row));
  const colMeans = Array.from({ length: k }, (_, col) =>
    mean(matrix.map((row) => row[col] as number)),
  );
  let sse = 0;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < k; col += 1) {
      const residual =
        (matrix[row]?.[col] as number) -
        (rowMeans[row] as number) -
        (colMeans[col] as number) +
        grand;
      sse += residual * residual;
    }
  }
  const msb = (k * rowMeans.reduce((sum, value) => sum + (value - grand) ** 2, 0)) / (n - 1);
  const msj = (n * colMeans.reduce((sum, value) => sum + (value - grand) ** 2, 0)) / (k - 1);
  const mse = sse / ((n - 1) * (k - 1));
  const denominator = msb + (k - 1) * mse + (k * (msj - mse)) / n;
  if (!(denominator > 0)) {
    return null;
  }
  const value = (msb - mse) / denominator;
  return Number.isFinite(value) ? value : null;
}

/** 重复间平均 TV 距离：所有重复两两的 0.5×Σ|p−q| 的均值。 */
export function meanPairwiseTv(vectors: readonly (readonly number[])[]): number | null {
  if (vectors.length < 2) {
    return null;
  }
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      const first = vectors[left] as readonly number[];
      const second = vectors[right] as readonly number[];
      let distance = 0;
      for (let index = 0; index < first.length; index += 1) {
        distance += Math.abs((first[index] as number) - (second[index] as number));
      }
      total += 0.5 * distance;
      pairs += 1;
    }
  }
  return pairs === 0 ? null : total / pairs;
}

function isUsable(record: ReliabilityRecord): boolean {
  return (
    record.source === 'jev_live' &&
    record.fallbackReason === null &&
    record.probabilitySource === 'exact' &&
    record.probabilities !== null
  );
}

export function summarizeReliability(
  records: readonly ReliabilityRecord[],
  legalActions: readonly string[],
): ReliabilitySummary {
  const valid = records.filter(isUsable);
  const fallbackReasons: Record<string, number> = {};
  for (const record of records) {
    if (record.fallbackReason !== null) {
      fallbackReasons[record.fallbackReason] = (fallbackReasons[record.fallbackReason] ?? 0) + 1;
    }
  }
  const probabilitySources = { exact: 0, derived: 0, none: 0 };
  for (const record of records) {
    probabilitySources[record.probabilitySource] += 1;
  }
  const optionDistribution: Record<string, number> = {};
  for (const record of valid) {
    optionDistribution[record.selectedAction] =
      (optionDistribution[record.selectedAction] ?? 0) + 1;
  }
  const topCount = Math.max(0, ...Object.values(optionDistribution));
  const top1Agreement = valid.length === 0 ? null : topCount / valid.length;
  const vectors = valid.map((record) =>
    legalActions.map((action) => record.probabilities?.[action] ?? 0),
  );
  // ICC 的行是 target（选项）、列是 rater（重复）；vectors 是「重复 × 选项」，需转置。
  const iccMatrix = legalActions.map((_, optionIndex) =>
    vectors.map((vector) => vector[optionIndex] as number),
  );
  const icc = icc21(iccMatrix);
  const tv = meanPairwiseTv(vectors);
  const responseModels = [
    ...new Set(
      records
        .map((record) => record.responseModel)
        .filter((model): model is string => model !== null && model.length > 0),
    ),
  ].sort();

  let verdict: ReliabilityVerdict;
  if (records.length < RELIABILITY_THRESHOLDS.minRepeats) {
    verdict = 'exploratory';
  } else if (
    valid.length < RELIABILITY_THRESHOLDS.minRepeats ||
    Object.keys(fallbackReasons).length > 0 ||
    top1Agreement === null ||
    icc === null ||
    tv === null ||
    top1Agreement < RELIABILITY_THRESHOLDS.top1Agreement ||
    icc < RELIABILITY_THRESHOLDS.icc21 ||
    tv > RELIABILITY_THRESHOLDS.meanTv
  ) {
    verdict = 'model_unstable';
  } else {
    verdict = 'reliable';
  }
  const detail =
    verdict === 'reliable'
      ? '重测信度通过：top-1、ICC(2,1) 与平均 TV 均达 07 §11 门槛。'
      : verdict === 'exploratory'
        ? `重复次数 ${records.length} < ${RELIABILITY_THRESHOLDS.minRepeats}，只能标 exploratory。`
        : '重测信度未达门槛：模型在本 state 上不稳定，live 只能作描述性案例。';

  return {
    schemaVersion: 'jev-reliability-v1',
    repeats: records.length,
    validRepeats: valid.length,
    fallbacks: records.length - valid.length,
    fallbackReasons,
    probabilitySources,
    optionDistribution,
    top1Agreement,
    meanTv: tv,
    icc21: icc,
    responseModels,
    thresholds: RELIABILITY_THRESHOLDS,
    verdict,
    passed: verdict === 'reliable',
    detail,
  };
}
