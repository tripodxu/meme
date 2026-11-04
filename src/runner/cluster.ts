import { errorCodes, StratifyError } from '../core/control/errors.js';

/**
 * 结构指纹聚类协议（07 §8.1）。
 *
 * 默认实现（W0 已按 07 §8.1 冻结，D-03 关闭证据 = 预注册 manifest）：
 * - 特征：窗口均值 P[c]、G、top10、Mup、Mdown、S、O（`featureVector`）；
 * - 标准化：z-score，均值/方差来自本次预注册特征矩阵（不得按结果挑特征）；
 * - 距离/算法：Euclidean + Ward 层次聚合，实现标识 `'ward-lw-v1'`（Lance–Williams 递推）；
 *   更换实现＝分析管线变更＝新 `experimentId`（07 §8.1 实现敏感性约束）；
 * - k：`k∈[2,5]`，按轮廓系数选择；
 * - 稳定性：种子集随机二分重聚类 20 次（`clustering.stabilityShuffles`），判定量 = median，
 *   产物必须同时报告 min（07 §8.1 W0-3 冻结口径）；
 * - 每个聚类至少 5 个 run（或预注册最小值）。
 */

/** Euclidean 距离。 */
export function euclidean(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** 可复用的 z-score 标尺（均值/总体标准差，方差为 0 的维度输出 0）。 */
export interface Standardizer {
  readonly means: readonly number[];
  readonly sigmas: readonly number[];
  readonly standardize: (vector: readonly number[]) => number[];
}

/**
 * 仅在 `trainMatrix` 上拟合均值/标准差，返回标尺。
 * 其余向量（如 w2b）必须用同一标尺标准化，禁止各自重算或混用原始值。
 */
export function fitStandardizer(trainMatrix: readonly (readonly number[])[]): Standardizer {
  if (trainMatrix.length === 0) {
    return { means: [], sigmas: [], standardize: (vector) => [...vector] };
  }
  const dims = trainMatrix[0]?.length ?? 0;
  const means = new Array<number>(dims).fill(0);
  for (const row of trainMatrix) {
    for (let j = 0; j < dims; j += 1) {
      means[j] = (means[j] as number) + (row[j] ?? 0);
    }
  }
  for (let j = 0; j < dims; j += 1) {
    means[j] = (means[j] as number) / trainMatrix.length;
  }
  const variances = new Array<number>(dims).fill(0);
  for (const row of trainMatrix) {
    for (let j = 0; j < dims; j += 1) {
      const d = (row[j] ?? 0) - (means[j] as number);
      variances[j] = (variances[j] as number) + d * d;
    }
  }
  const sigmas = variances.map((sum) => Math.sqrt(sum / trainMatrix.length));
  return {
    means,
    sigmas,
    standardize: (vector) =>
      Array.from({ length: dims }, (_, j) => {
        const sigma = sigmas[j] as number;
        return sigma > 0 ? ((vector[j] ?? 0) - (means[j] as number)) / sigma : 0;
      }),
  };
}

/** 用 `trainMatrix` 拟合的标尺标准化单个向量（如 w2b）。 */
export function standardizeWith(
  trainMatrix: readonly (readonly number[])[],
  vector: readonly number[],
): number[] {
  return fitStandardizer(trainMatrix).standardize(vector);
}

/** 最小簇规模（空分配返回 0）。 */
export function minClusterSize(assignment: readonly number[]): number {
  if (assignment.length === 0) {
    return 0;
  }
  const sizes = new Map<number, number>();
  for (const cluster of assignment) {
    sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
  }
  let smallest = Number.POSITIVE_INFINITY;
  for (const size of sizes.values()) {
    if (size < smallest) {
      smallest = size;
    }
  }
  return smallest;
}

/**
 * 是否每个簇的**特征点数**均 >= `minPoints`。
 * 预注册的 `minClusterRuns` 按 run 计，必须用 `minClusterRunCount`，不要用本函数。
 */
export function meetsMinClusterSize(assignment: readonly number[], minPoints: number): boolean {
  return minClusterSize(assignment) >= minPoints;
}

/**
 * 每个簇包含的不同 run 数的最小值（07 §8.1 的 `minClusterRuns` 按 run 计）。
 *
 * 同一 run 的 `w2b`/`w3` 是两个特征点；直接把特征点数与 `minClusterRuns` 比较
 * 会把门槛放松一倍。`runKeys[i]` 标识第 i 个点所属 run；同一 run 的窗口若落入
 * 不同簇，则分别计入各自簇（宽松口径，时间一致性另由 `temporalConsistency` 门禁约束）。
 */
export function minClusterRunCount(
  assignment: readonly number[],
  runKeys: readonly string[],
): number {
  if (assignment.length !== runKeys.length) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '聚类分配与 runKeys 长度不一致');
  }
  if (assignment.length === 0) {
    return 0;
  }
  const runsByCluster = new Map<number, Set<string>>();
  for (let index = 0; index < assignment.length; index += 1) {
    const cluster = assignment[index] as number;
    const runKey = runKeys[index] as string;
    let runs = runsByCluster.get(cluster);
    if (runs === undefined) {
      runs = new Set<string>();
      runsByCluster.set(cluster, runs);
    }
    runs.add(runKey);
  }
  let smallest = Number.POSITIVE_INFINITY;
  for (const runs of runsByCluster.values()) {
    smallest = Math.min(smallest, runs.size);
  }
  return smallest;
}

/** z-score 标准化；方差为 0 的维度保持 0（避免除零，且该维度无判别力）。 */
export function zScoreMatrix(matrix: readonly (readonly number[])[]): number[][] {
  const { standardize } = fitStandardizer(matrix);
  return matrix.map((row) => standardize(row));
}

/** Ward 聚类完整结果：最终分配 + 每次合并的 SSE 增量序列（W0-1 等价性验收用）。 */
export interface WardClustering {
  /** 长度 n 的簇号数组；簇号只保证「同簇同号」，不同实现/调用间不保证标签一致。 */
  readonly assignment: number[];
  /** 合并代价（SSE 增量）序列，长度 n-k，按合并先后排列。 */
  readonly mergeCosts: number[];
}

/**
 * Ward 层次聚合（最小化全离差平方和增量），返回 cut 后的分配与合并代价序列。
 *
 * 实现（W0-1）：Lance–Williams 递推——
 * `d(k,i∪j) = ((n_i+n_k)·d(k,i) + (n_j+n_k)·d(k,j) − n_k·d(i,j)) / (n_i+n_j+n_k)`，
 * 其中 `d` 为合并的 SSE 增量（初始单点簇 `d(i,j)=‖p_i−p_j‖²/2`）。
 * 每次合并的代价更新为 O(active)，最小对扫描 O(active²)；内存 O(n²)（Float64Array）。
 * 朴素参考实现保留在 `wardClusterReference`（成员遍历重算 SSE，O(n³) 大常数），
 * 两者数学等价但**并列或近并列（1 ulp 级）的合并取舍可能不同**（07 §8.1 实现敏感性），
 * 等价性验收是「无并列数据 ARI=1.0 + 代价序列逐项相对误差 ≤1e-12」，不是划分逐位一致。
 */
export function wardClusterWithCosts(
  points: readonly (readonly number[])[],
  k: number,
): WardClustering {
  const n = points.length;
  if (k < 1 || k > n) {
    throw new Error(`k 必须位于 [1, n]: k=${k}, n=${n}`);
  }
  // 距离矩阵（全对称写入，行主序）；size/active 按初始点索引编号，合并保留较小索引。
  const distance = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = euclidean(points[i] ?? [], points[j] ?? []);
      const cost = (d * d) / 2; // 单点簇合并的 SSE 增量 = ‖p_i−p_j‖²×(1·1)/(1+1)
      distance[i * n + j] = cost;
      distance[j * n + i] = cost;
    }
  }
  const size = new Float64Array(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  // 簇成员（按合并保留的簇索引记录），用于最终分配。
  const members: number[][] = Array.from({ length: n }, (_, index) => [index]);
  const mergeCosts: number[] = [];
  let activeCount = n;
  while (activeCount > k) {
    // 最小对扫描：按 (i,j) 升序，严格小于取首个最小值（确定性并列取舍）。
    let bestI = -1;
    let bestJ = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (!active[i]) {
        continue;
      }
      const rowOffset = i * n;
      for (let j = i + 1; j < n; j += 1) {
        if (!active[j]) {
          continue;
        }
        const cost = distance[rowOffset + j] as number;
        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0 || bestJ < 0) {
      break;
    }
    mergeCosts.push(bestCost);
    // 合并 (bestI, bestJ)：保留 bestI，按 Lance–Williams 更新其对其余活跃簇的距离。
    const sizeI = size[bestI] as number;
    const sizeJ = size[bestJ] as number;
    for (let c = 0; c < n; c += 1) {
      if (!active[c] || c === bestI || c === bestJ) {
        continue;
      }
      const sizeC = size[c] as number;
      const denominator = sizeI + sizeJ + sizeC;
      const updated =
        ((sizeI + sizeC) * (distance[bestI * n + c] as number) +
          (sizeJ + sizeC) * (distance[bestJ * n + c] as number) -
          sizeC * bestCost) /
        denominator;
      distance[bestI * n + c] = updated;
      distance[c * n + bestI] = updated;
    }
    size[bestI] = sizeI + sizeJ;
    members[bestI] = [...(members[bestI] ?? []), ...(members[bestJ] ?? [])];
    members[bestJ] = [];
    active[bestJ] = false;
    activeCount -= 1;
  }
  // 活跃簇按索引升序重编号（标签不含信息，ARI 等比较对重标号不变）。
  const assignment = new Array<number>(n).fill(-1);
  let clusterIndex = 0;
  for (let i = 0; i < n; i += 1) {
    if (!active[i]) {
      continue;
    }
    for (const member of members[i] ?? []) {
      assignment[member] = clusterIndex;
    }
    clusterIndex += 1;
  }
  return { assignment, mergeCosts };
}

/** Ward 聚类（Lance–Williams 实现，W0-1）：只返回分配。 */
export function wardCluster(points: readonly (readonly number[])[], k: number): number[] {
  return wardClusterWithCosts(points, k).assignment;
}

/**
 * 朴素参考实现（07 §8.1 实现敏感性的对照锚点）：每轮重算簇内 SSE 找最小增量对，
 * O(n³) 大常数。保留原因：Lance–Williams 实现的等价性验收需要它作对照
 * （无并列数据 ARI=1.0、合并代价序列逐项相对误差 ≤1e-12）。
 */
export function wardClusterReferenceWithCosts(
  points: readonly (readonly number[])[],
  k: number,
): WardClustering {
  const n = points.length;
  if (k < 1 || k > n) {
    throw new Error(`k 必须位于 [1, n]: k=${k}, n=${n}`);
  }
  const clusters: number[][] = points.map((_, index) => [index]);
  const centroidOf = (members: readonly number[]): number[] => {
    const dims = points[0]?.length ?? 0;
    const c = new Array<number>(dims).fill(0);
    for (const i of members) {
      for (let j = 0; j < dims; j += 1) {
        c[j] = (c[j] as number) + (points[i]?.[j] ?? 0);
      }
    }
    return c.map((value) => value / members.length);
  };
  const sse = (members: readonly number[], centroid: readonly number[]): number => {
    let sum = 0;
    for (const i of members) {
      sum += euclidean(points[i] ?? [], centroid) ** 2;
    }
    return sum;
  };
  const mergeCosts: number[] = [];
  while (clusters.length > k) {
    let bestPair: [number, number] | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        const ca = clusters[a];
        const cb = clusters[b];
        if (ca === undefined || cb === undefined) {
          continue;
        }
        const merged = [...ca, ...cb];
        const mergedCentroid = centroidOf(merged);
        const cost =
          sse(merged, mergedCentroid) - sse(ca, centroidOf(ca)) - sse(cb, centroidOf(cb));
        if (cost < bestCost) {
          bestCost = cost;
          bestPair = [a, b];
        }
      }
    }
    if (bestPair === null) {
      break;
    }
    const [a, b] = bestPair;
    const ca = clusters[a];
    const cb = clusters[b];
    if (ca === undefined || cb === undefined) {
      break;
    }
    mergeCosts.push(bestCost);
    clusters[a] = [...ca, ...cb];
    clusters.splice(b, 1);
  }
  const assignment = new Array<number>(n).fill(-1);
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    for (const i of clusters[clusterIndex] ?? []) {
      assignment[i] = clusterIndex;
    }
  }
  return { assignment, mergeCosts };
}

/** 朴素参考实现：只返回分配。 */
export function wardClusterReference(points: readonly (readonly number[])[], k: number): number[] {
  return wardClusterReferenceWithCosts(points, k).assignment;
}

/** 轮廓系数（Euclidean）；单簇返回 0。 */
export function silhouetteScore(
  points: readonly (readonly number[])[],
  assignment: readonly number[],
): number {
  const n = points.length;
  if (n <= 1) {
    return 0;
  }
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const cluster = assignment[i] as number;
    const bucket = clusters.get(cluster) ?? [];
    bucket.push(i);
    clusters.set(cluster, bucket);
  }
  if (clusters.size <= 1) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const own = clusters.get(assignment[i] as number) ?? [];
    const a =
      own.length <= 1
        ? 0
        : own.reduce(
            (sum, j) => (j === i ? sum : sum + euclidean(points[i] ?? [], points[j] ?? [])),
            0,
          ) /
          (own.length - 1);
    let b = Number.POSITIVE_INFINITY;
    for (const [cluster, members] of clusters) {
      if (cluster === assignment[i]) {
        continue;
      }
      const meanDistance =
        members.reduce((sum, j) => sum + euclidean(points[i] ?? [], points[j] ?? []), 0) /
        members.length;
      b = Math.min(b, meanDistance);
    }
    if (!Number.isFinite(b)) {
      continue;
    }
    total += own.length <= 1 ? 0 : (b - a) / Math.max(a, b);
  }
  return total / n;
}

/** 按 k∈[2,5] 的轮廓系数选择 k；返回 {k, assignment, score}。 */
export function chooseKBySilhouette(
  points: readonly (readonly number[])[],
  kMin = 2,
  kMax = 5,
): { readonly k: number; readonly assignment: readonly number[]; readonly score: number } {
  let best: { k: number; assignment: number[]; score: number } | null = null;
  for (let k = kMin; k <= Math.min(kMax, points.length); k += 1) {
    const assignment = wardCluster(points, k);
    const score = silhouetteScore(points, assignment);
    if (best === null || score > best.score) {
      best = { k, assignment, score };
    }
  }
  if (best === null) {
    throw new Error('聚类点不足');
  }
  return best;
}

/** 调整 Rand 指数（Hubert & Arabie）。 */
export function adjustedRandIndex(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error('ARI 输入长度不一致或为空');
  }
  const n = a.length;
  const mapA = new Map<number, number>();
  const mapB = new Map<number, number>();
  for (const label of a) mapA.set(label, (mapA.get(label) ?? 0) + 1);
  for (const label of b) mapB.set(label, (mapB.get(label) ?? 0) + 1);
  const contingency = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const key = `${a[i]}|${b[i]}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
  }
  const comb2 = (x: number): number => (x * (x - 1)) / 2;
  let sumIJ = 0;
  for (const count of contingency.values()) {
    sumIJ += comb2(count);
  }
  let sumA = 0;
  for (const count of mapA.values()) sumA += comb2(count);
  let sumB = 0;
  for (const count of mapB.values()) sumB += comb2(count);
  const total = comb2(n);
  const expected = (sumA * sumB) / total;
  const maxIndex = (sumA + sumB) / 2;
  if (maxIndex === expected) {
    return 1;
  }
  return (sumIJ - expected) / (maxIndex - expected);
}

export interface StabilityResult {
  readonly ari: number;
  readonly stable: boolean;
}

/**
 * 稳定性（07 §8.1）：种子集随机二分重聚类。
 * 把 run 集合随机分成两半：A 半独立 Ward 聚类得 k 个质心；B 半独立 Ward 聚类；
 * 再把 B 半各点按最近 A 质心分配；对 B 半的两种分配计算调整 Rand 指数。
 * ARI >= 0.70 视为稳定（阈值可预注册覆盖）。
 */
export function bisectStability(
  points: readonly (readonly number[])[],
  k: number,
  seedShuffles: readonly number[][],
  ariThreshold = 0.7,
): StabilityResult {
  const n = points.length;
  if (n < 4 || k < 2) {
    return { ari: 0, stable: false };
  }
  const order = seedShuffles[0];
  if (order === undefined || order.length !== n) {
    throw new Error('稳定性检验需要与点数一致的洗牌顺序');
  }
  const half = Math.floor(n / 2);
  const partA = order.slice(0, half);
  const partB = order.slice(half);
  if (partA.length < k || partB.length < k) {
    return { ari: 0, stable: false };
  }
  const pointsA = partA.map((index) => points[index] ?? []);
  const pointsB = partB.map((index) => points[index] ?? []);
  const assignmentA = wardCluster(pointsA, k);
  const assignmentB = wardCluster(pointsB, k);
  // A 半质心。
  const dims = points[0]?.length ?? 0;
  const centroids: number[][] = [];
  for (let cluster = 0; cluster < k; cluster += 1) {
    const members = partA.filter((_, position) => assignmentA[position] === cluster);
    const centroid = new Array<number>(dims).fill(0);
    for (const i of members) {
      const row = points[i] ?? [];
      for (let j = 0; j < dims; j += 1) {
        centroid[j] = (centroid[j] as number) + (row[j] ?? 0);
      }
    }
    centroids.push(
      members.length === 0 ? centroid : centroid.map((value) => value / members.length),
    );
  }
  // B 半按最近 A 质心分配。
  const assignmentBtoA = pointsB.map((row) => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const distance = euclidean(row, centroids[cluster] ?? []);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cluster;
      }
    }
    return best;
  });
  const ari = adjustedRandIndex(assignmentB, assignmentBtoA);
  return { ari, stable: ari >= ariThreshold };
}

/** 确定性洗牌（runner 级 bootstrap 随机数，不消耗模拟 RNG）。 */
export function seededShuffle(n: number, seed: number): number[] {
  // mulberry32：确定性、无外部依赖。
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: n }, (_, index) => index);
  for (let i = n - 1; i >= 1; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const temp = order[i] ?? 0;
    order[i] = order[j] ?? 0;
    order[j] = temp;
  }
  return order;
}
