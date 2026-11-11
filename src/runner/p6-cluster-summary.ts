/**
 * P6-05 结构指纹聚类的纯汇总逻辑（07 §8.1）。
 *
 * 只处理已经算好的窗口指标与聚类分配：特征向量、簇组成、质心、时序一致性
 * 与验收判据；不读文件、不跑模拟。
 */
import type { WindowSummary } from './window-stats.js';

/** 07 §8.1 全特征向量：P0..P4、G、top10、Mup、Mdown、S、O。 */
export function structuralFeatureVector(window: WindowSummary): number[] {
  return [
    ...window.classShares,
    window.gini,
    window.topWealthShare,
    window.mUp,
    window.mDown,
    window.segregation,
    window.openness,
  ];
}

export interface ClusterComposition {
  readonly cluster: number;
  readonly total: number;
  readonly cells: Readonly<Record<string, number>>;
}

/** 每个簇包含哪些 cell 的 run；用于检验“不是三组预设”这一条。 */
export function clusterComposition(
  assignments: readonly number[],
  cellKeys: readonly string[],
  k: number,
): readonly ClusterComposition[] {
  if (assignments.length !== cellKeys.length) {
    throw new TypeError('assignments 与 cellKeys 长度不一致');
  }
  const result: ClusterComposition[] = [];
  for (let cluster = 0; cluster < k; cluster += 1) {
    const cells: Record<string, number> = {};
    let total = 0;
    for (let index = 0; index < assignments.length; index += 1) {
      if (assignments[index] !== cluster) continue;
      const cell = cellKeys[index] as string;
      cells[cell] = (cells[cell] ?? 0) + 1;
      total += 1;
    }
    result.push({ cluster, total, cells });
  }
  return result;
}

export function clusterSizes(assignments: readonly number[], k: number): readonly number[] {
  const sizes = new Array<number>(k).fill(0);
  for (const cluster of assignments) {
    if (cluster >= 0 && cluster < k) sizes[cluster] = (sizes[cluster] as number) + 1;
  }
  return sizes;
}

/** 原始特征空间的簇质心（未标准化，便于报告 P/G/M/S/O 的量纲）。 */
export function clusterCentroids(
  points: readonly (readonly number[])[],
  assignments: readonly number[],
  k: number,
): readonly (readonly number[])[] {
  if (points.length !== assignments.length) {
    throw new TypeError('points 与 assignments 长度不一致');
  }
  const dimensions = points[0]?.length ?? 0;
  const sums = Array.from({ length: k }, () => new Array<number>(dimensions).fill(0));
  const counts = new Array<number>(k).fill(0);
  for (let index = 0; index < points.length; index += 1) {
    const cluster = assignments[index] as number;
    if (cluster < 0 || cluster >= k) continue;
    const point = points[index] as readonly number[];
    const sum = sums[cluster] as number[];
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      sum[dimension] = (sum[dimension] as number) + (point[dimension] ?? 0);
    }
    counts[cluster] = (counts[cluster] as number) + 1;
  }
  return sums.map((sum, cluster) =>
    sum.map((value) => (counts[cluster] === 0 ? 0 : value / (counts[cluster] as number))),
  );
}

export function euclideanDistance(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new TypeError('向量维度不一致');
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] as number) - (right[index] as number);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

/** 质心两两最小距离；用于说明三个簇不是重合点。 */
export function minimumCentroidDistance(centroids: readonly (readonly number[])[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let left = 0; left < centroids.length; left += 1) {
    for (let right = left + 1; right < centroids.length; right += 1) {
      minimum = Math.min(
        minimum,
        euclideanDistance(
          centroids[left] as readonly number[],
          centroids[right] as readonly number[],
        ),
      );
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

/** 14600 点按 10950 簇质心分配后，与 10950 原分配的同簇率。 */
export function temporalSameClusterRate(
  baseAssignments: readonly number[],
  followupAssignments: readonly number[],
): number {
  if (baseAssignments.length !== followupAssignments.length) {
    throw new TypeError('base 与 followup 分配长度不一致');
  }
  if (baseAssignments.length === 0) return 0;
  let same = 0;
  for (let index = 0; index < baseAssignments.length; index += 1) {
    if (baseAssignments[index] === followupAssignments[index]) same += 1;
  }
  return same / baseAssignments.length;
}

export interface P6ClusterVerdictInput {
  readonly k: number;
  readonly ariMedian: number;
  readonly ariMin: number;
  readonly silhouette: number;
  readonly sizes: readonly number[];
  readonly composition: readonly ClusterComposition[];
  readonly temporalRate: number;
  readonly extinctRate: number;
  readonly minClusterRuns: number;
  readonly minAri: number;
  readonly minSilhouette: number;
  readonly minTemporalRate: number;
}

export interface P6ClusterVerdict {
  readonly passes: boolean;
  readonly antiPreset: boolean;
  readonly reasons: readonly string[];
}

/**
 * P6-05 验收（07 §8.1 + rule 57）：
 * - k=3 且每簇 >= minClusterRuns；
 * - 稳定性 ARI 中位数 >= minAri（同时报告 min）；
 * - 轮廓系数 >= minSilhouette；
 * - 时序同簇率 >= minTemporalRate；
 * - extinct 率 <= 10%；
 * - 不是三组预设：至少一个簇包含 >=2 个 cell。
 */
export function evaluateP6ClusterVerdict(input: P6ClusterVerdictInput): P6ClusterVerdict {
  const reasons: string[] = [];
  if (input.k !== 3) reasons.push(`k=${input.k}，P6-05 预注册要求 k=3`);
  if (input.sizes.length !== 3 || input.sizes.some((size) => size < input.minClusterRuns)) {
    reasons.push(`簇大小 ${input.sizes.join('/')} 未全部达到 ${input.minClusterRuns}`);
  }
  if (input.ariMedian < input.minAri) {
    reasons.push(`ARI median ${input.ariMedian.toFixed(3)} < ${input.minAri}`);
  }
  if (input.silhouette < input.minSilhouette) {
    reasons.push(`silhouette ${input.silhouette.toFixed(3)} < ${input.minSilhouette}`);
  }
  if (input.temporalRate < input.minTemporalRate) {
    reasons.push(
      `temporal same-cluster ${input.temporalRate.toFixed(3)} < ${input.minTemporalRate}`,
    );
  }
  if (input.extinctRate > 0.1) {
    reasons.push(`extinct rate ${input.extinctRate.toFixed(3)} > 0.10`);
  }
  const antiPreset = input.composition.some((cluster) => Object.keys(cluster.cells).length >= 2);
  if (!antiPreset) reasons.push('三个簇与三个 cell 一一对应，无法排除“三组预设”');
  return { passes: reasons.length === 0, antiPreset, reasons };
}

export interface P6TwoRegimeVerdictInput {
  readonly ariMedian: number;
  readonly silhouette: number;
  readonly sizes: readonly number[];
  readonly composition: readonly ClusterComposition[];
  readonly temporalRate: number;
  readonly extinctRate: number;
  readonly minClusterRuns: number;
  readonly minAri: number;
  readonly minSilhouette: number;
  readonly minTemporalRate: number;
  /** 两簇在 |ΔO|、|ΔS|、TV(P) 上的最大差异。 */
  readonly regimeDifference: number;
  readonly k3: {
    readonly sizes: readonly number[];
    readonly ariMedian: number;
    readonly temporalRate: number;
  };
  readonly k3MinAri: number;
  readonly k3MinTemporalRate: number;
}

/**
 * P6-06 验收（07 §8.2 + rule 57 v14，ADR 0006）：
 * - k=2 且两簇均 >= minClusterRuns；
 * - 稳定性 ARI 中位数、轮廓系数、时序同簇率均达门槛；
 * - extinct 率 <= 10%；
 * - 不是两组预设：至少一个簇包含 >=2 个 cell；
 * - 两簇在 |ΔO|/|ΔS|/TV(P) 上至少一项 >= 0.10；
 * - k=3 不得同时满足“所有簇 >= minClusterRuns、ARI median >= k3MinAri、
 *   同簇率 >= k3MinTemporalRate”，否则存在稳定第三簇。
 */
export function evaluateP6TwoRegimeVerdict(input: P6TwoRegimeVerdictInput): P6ClusterVerdict {
  const reasons: string[] = [];
  if (input.sizes.length !== 2 || input.sizes.some((size) => size < input.minClusterRuns)) {
    reasons.push(`簇大小 ${input.sizes.join('/')} 未全部达到 ${input.minClusterRuns}`);
  }
  if (input.ariMedian < input.minAri) {
    reasons.push(`ARI median ${input.ariMedian.toFixed(3)} < ${input.minAri}`);
  }
  if (input.silhouette < input.minSilhouette) {
    reasons.push(`silhouette ${input.silhouette.toFixed(3)} < ${input.minSilhouette}`);
  }
  if (input.temporalRate < input.minTemporalRate) {
    reasons.push(
      `temporal same-cluster ${input.temporalRate.toFixed(3)} < ${input.minTemporalRate}`,
    );
  }
  if (input.extinctRate > 0.1) {
    reasons.push(`extinct rate ${input.extinctRate.toFixed(3)} > 0.10`);
  }
  const antiPreset = input.composition.some((cluster) => Object.keys(cluster.cells).length >= 2);
  if (!antiPreset) reasons.push('两个簇与两个 cell 一一对应，无法排除“两组预设”');
  if (input.regimeDifference < 0.1) {
    reasons.push(`regime difference ${input.regimeDifference.toFixed(3)} < 0.10`);
  }
  const stableThird =
    input.k3.sizes.length === 3 &&
    input.k3.sizes.every((size) => size >= input.minClusterRuns) &&
    input.k3.ariMedian >= input.k3MinAri &&
    input.k3.temporalRate >= input.k3MinTemporalRate;
  if (stableThird) {
    reasons.push(
      `k=3 仍形成稳定第三簇（ARI ${input.k3.ariMedian.toFixed(3)}、` +
        `同簇率 ${input.k3.temporalRate.toFixed(3)}）`,
    );
  }
  return { passes: reasons.length === 0, antiPreset, reasons };
}
