/**
 * P6-04b 正式 live/mock/random 对照的纯分析层（07 §11）。
 *
 * 输入是每个 run 的 w1 窗口指标与质量字段；本模块只做配对差、区间、
 * 方向一致率、baseline 波动带与多重比较校正，不读文件、不发请求。
 *
 * 统计口径（预注册冻结，见 `out/p6-04b-formal-prereg.json`）：
 * - 主指标 `TV(P)`：非负距离，用 10,000 次配对 bootstrap 中位数 95% 区间
 *   与预注册门槛 0.10 判定；**不对 TV 做符号翻转置换检验**（TV 非负，
 *   零分布不以 0 为中心，符号翻转会把“有差异”机械地算成极端）。
 * - 方向指标 `ΔG = G_live - G_baseline`：有符号，用 100,000 次配对符号翻转
 *   置换检验；方向一致率 >= 0.90 才满足 07 §8 第 2 条。
 * - baseline 波动带：同配置、不同 seed 的两两 D 的 95 分位；候选-基线 D
 *   必须超出该分位（预注册按 07 §8 采用 100% 严格口径）。
 * - 质量闸门：回退率 > 0.20、responseModels > 1（模型漂移）、extinct、
 *   窗口不完整、missing usage、cancelled 的 run 不进入合并。
 */
import {
  bootstrapMedianCi,
  dScore,
  pairedDiff,
  signFlipPermutationP,
  type P6WindowMetrics,
} from './p6-analysis.js';

export type LivePromptStyle = 'neutral' | 'survival_hint';

export interface LiveRunRecord {
  readonly runKey: string;
  readonly seed: string;
  readonly policyVersion: string;
  /** mock/random 不消费 prompt，记为 null。 */
  readonly promptStyle: LivePromptStyle | null;
  readonly window: P6WindowMetrics;
  readonly extinct: boolean;
  readonly endReason: string | null;
  readonly cancelled: boolean;
  readonly fallbackRate: number | null;
  readonly responseModels: readonly string[];
  readonly missingUsage: number;
}

export const LIVE_FALLBACK_RATE_LIMIT = 0.2;
export const LIVE_DIRECTION_MIN_RATE = 0.9;
export const LIVE_BASELINE_BAND_RATE = 1;
export const LIVE_PRIMARY_THRESHOLD = 0.1;

/** 返回非空数组即表示该 run 不进入正式合并；原因可审计。 */
export function liveRunExclusionReasons(run: LiveRunRecord): readonly string[] {
  const reasons: string[] = [];
  if (run.cancelled) reasons.push('cancelled');
  if (run.extinct) reasons.push('extinct');
  if (run.endReason !== null && run.endReason !== 'scheduled') {
    reasons.push(`endReason:${run.endReason}`);
  }
  if (
    run.window.tickCount !== undefined &&
    run.window.observedTicks !== undefined &&
    run.window.observedTicks < run.window.tickCount
  ) {
    reasons.push('window-incomplete');
  }
  if (run.fallbackRate !== null && run.fallbackRate > LIVE_FALLBACK_RATE_LIMIT) {
    reasons.push('fallback-rate>0.20');
  }
  const models = run.responseModels.filter((model) => model.length > 0);
  if (models.length > 1) reasons.push('model-drift');
  if (run.missingUsage > 0) reasons.push('missing-usage');
  return reasons;
}

export interface LivePairedDifference {
  readonly seed: string;
  readonly tv: number;
  readonly d: number;
  readonly gini: number;
  readonly mUp: number;
  readonly mDown: number;
  readonly segregation: number | null;
  readonly openness: number;
}

/** 同一 seed 的候选与基线配对；D 按 07 §8 公式。 */
export function pairLiveRuns(
  candidate: LiveRunRecord,
  baseline: LiveRunRecord,
): LivePairedDifference {
  const diff = pairedDiff(candidate.window, baseline.window);
  return {
    seed: candidate.seed,
    tv: diff.tv,
    d: dScore(diff),
    gini: diff.gini,
    mUp: diff.mUp,
    mDown: diff.mDown,
    segregation: diff.segregation,
    openness: diff.openness,
  };
}

/** 最近秩分位（与 p6-perturbation 的 baseline D95 口径一致）。 */
export function percentileNearestRank(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new RangeError('fraction 必须在 (0,1]');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] as number;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('medianOf 需要至少一个值');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** 同策略、不同 seed 的两两 D 的 95 分位；少于 2 个 run 时为 null。 */
export function baselinePairwiseD95(runs: readonly LiveRunRecord[]): number | null {
  const usable = runs.filter((run) => liveRunExclusionReasons(run).length === 0);
  const distances: number[] = [];
  for (let left = 0; left < usable.length; left += 1) {
    for (let right = left + 1; right < usable.length; right += 1) {
      distances.push(dScore(pairedDiff(usable[left]!.window, usable[right]!.window)));
    }
  }
  return percentileNearestRank(distances, 0.95);
}

/**
 * 有符号配对差的方向一致率：与中位数同号的比例。
 * 中位数为 0 时只统计恰好为 0 的比例（不把两侧都算作“一致”）。
 */
export function directionAgreement(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 0;
  const center = medianOf(finite);
  const sign = Math.sign(center);
  if (sign === 0) {
    return finite.filter((value) => value === 0).length / finite.length;
  }
  return finite.filter((value) => Math.sign(value) === sign).length / finite.length;
}

/** Benjamini–Hochberg 校正；返回值与输入同序。 */
export function bhAdjust(pValues: readonly number[]): readonly number[] {
  const count = pValues.length;
  if (count === 0) return [];
  const order = pValues
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const adjusted = new Array<number>(count).fill(1);
  let previous = 1;
  for (let rank = count; rank >= 1; rank -= 1) {
    const entry = order[rank - 1]!;
    const value = Math.min(previous, (entry.value * count) / rank);
    adjusted[entry.index] = value;
    previous = value;
  }
  return adjusted;
}

export interface LiveComparisonPasses {
  readonly sampleSize: boolean;
  readonly primaryThreshold: boolean;
  readonly ciNotCrossingZero: boolean;
  readonly direction: boolean;
  readonly baselineBand: boolean;
  readonly quality: boolean;
}

export interface LiveComparisonResult {
  readonly name: string;
  readonly candidatePolicy: string;
  readonly baselinePolicy: string;
  readonly promptStyle: LivePromptStyle | null;
  readonly n: number;
  readonly nRequired: number;
  readonly tvMedian: number;
  readonly tvCi95: readonly [number, number];
  readonly deltaGMedian: number;
  readonly deltaGCi95: readonly [number, number];
  readonly deltaGPermutationP: number;
  readonly directionAgreement: number;
  readonly dMedian: number;
  readonly baselineD95: number | null;
  readonly dBeyondBaselineRate: number;
  readonly passes: LiveComparisonPasses;
  readonly meetsStructuralCriteria: boolean;
}

export interface FormalLiveSummary {
  readonly mergeableRunKeys: readonly string[];
  readonly excluded: readonly { readonly runKey: string; readonly reasons: readonly string[] }[];
  readonly baselineD95: { readonly mock: number | null; readonly random: number | null };
  readonly comparisons: readonly LiveComparisonResult[];
  readonly family: {
    readonly q: number;
    readonly pValues: readonly number[];
    readonly bhAdjusted: readonly number[];
    readonly names: readonly string[];
  };
  readonly verdict: 'no-structural-evidence' | 'descriptive-structural-candidate';
  readonly confirmationStatus: 'not-confirmatory-single-seed-set';
  readonly notes: readonly string[];
}

export interface FormalLiveOptions {
  readonly nRequired?: number;
  readonly bootstrapIterations?: number;
  readonly permutationIterations?: number;
  readonly analysisSeed?: number;
}

interface ComparisonSpec {
  readonly name: string;
  readonly candidate: readonly LiveRunRecord[];
  readonly baseline: readonly LiveRunRecord[];
  readonly candidatePolicy: string;
  readonly baselinePolicy: string;
  readonly promptStyle: LivePromptStyle | null;
}

function comparePair(
  pairs: readonly LivePairedDifference[],
  spec: ComparisonSpec,
  baselineD95: number | null,
  nRequired: number,
  options: Required<FormalLiveOptions>,
): LiveComparisonResult {
  const tvValues = pairs.map((pair) => pair.tv);
  const gValues = pairs.map((pair) => pair.gini);
  if (pairs.length === 0) {
    return {
      name: spec.name,
      candidatePolicy: spec.candidatePolicy,
      baselinePolicy: spec.baselinePolicy,
      promptStyle: spec.promptStyle,
      n: 0,
      nRequired,
      tvMedian: 0,
      tvCi95: [0, 0],
      deltaGMedian: 0,
      deltaGCi95: [0, 0],
      deltaGPermutationP: 1,
      directionAgreement: 0,
      dMedian: 0,
      baselineD95,
      dBeyondBaselineRate: 0,
      passes: {
        sampleSize: false,
        primaryThreshold: false,
        ciNotCrossingZero: false,
        direction: false,
        baselineBand: false,
        quality: false,
      },
      meetsStructuralCriteria: false,
    };
  }
  const tvMedian = medianOf(tvValues);
  const tvCi = bootstrapMedianCi(tvValues, {
    iterations: options.bootstrapIterations,
    seed: options.analysisSeed,
  });
  const deltaGMedian = medianOf(gValues);
  const deltaGCi = bootstrapMedianCi(gValues, {
    iterations: options.bootstrapIterations,
    seed: options.analysisSeed,
  });
  const deltaGP = signFlipPermutationP(gValues, {
    iterations: options.permutationIterations,
    seed: options.analysisSeed,
  });
  const direction = directionAgreement(gValues);
  const dValues = pairs.map((pair) => pair.d);
  const dMedian = medianOf(dValues);
  const beyond =
    baselineD95 === null
      ? 0
      : dValues.filter((value) => value > baselineD95).length / dValues.length;
  const passes: LiveComparisonPasses = {
    sampleSize: pairs.length >= nRequired,
    primaryThreshold: tvMedian >= LIVE_PRIMARY_THRESHOLD,
    ciNotCrossingZero: tvCi[0] > 0,
    direction: direction >= LIVE_DIRECTION_MIN_RATE,
    baselineBand: baselineD95 !== null && beyond >= LIVE_BASELINE_BAND_RATE,
    quality: pairs.length > 0,
  };
  return {
    name: spec.name,
    candidatePolicy: spec.candidatePolicy,
    baselinePolicy: spec.baselinePolicy,
    promptStyle: spec.promptStyle,
    n: pairs.length,
    nRequired,
    tvMedian,
    tvCi95: tvCi,
    deltaGMedian,
    deltaGCi95: deltaGCi,
    deltaGPermutationP: deltaGP,
    directionAgreement: direction,
    dMedian,
    baselineD95,
    dBeyondBaselineRate: beyond,
    passes,
    meetsStructuralCriteria:
      passes.sampleSize &&
      passes.primaryThreshold &&
      passes.ciNotCrossingZero &&
      passes.direction &&
      passes.baselineBand &&
      passes.quality,
  };
}

function pairSeeds(
  candidate: readonly LiveRunRecord[],
  baseline: readonly LiveRunRecord[],
): LivePairedDifference[] {
  const bySeed = new Map(baseline.map((run) => [run.seed, run]));
  const pairs: LivePairedDifference[] = [];
  for (const run of candidate) {
    const match = bySeed.get(run.seed);
    if (match !== undefined) pairs.push(pairLiveRuns(run, match));
  }
  return pairs.sort((left, right) => left.seed.localeCompare(right.seed));
}

/**
 * 正式 live 对照：两个 promptStyle 各自 vs mock/random，再加 neutral vs
 * survival_hint 的提示处理对比。所有不满足质量闸门的 run 先剔除并逐条报告。
 */
export function summarizeFormalLive(
  runs: readonly LiveRunRecord[],
  options: FormalLiveOptions = {},
): FormalLiveSummary {
  const resolved: Required<FormalLiveOptions> = {
    nRequired: options.nRequired ?? 10,
    bootstrapIterations: options.bootstrapIterations ?? 10_000,
    permutationIterations: options.permutationIterations ?? 100_000,
    analysisSeed: options.analysisSeed ?? 20261105,
  };
  const excluded: { runKey: string; reasons: readonly string[] }[] = [];
  const usable: LiveRunRecord[] = [];
  for (const run of runs) {
    const reasons = liveRunExclusionReasons(run);
    if (reasons.length === 0) usable.push(run);
    else excluded.push({ runKey: run.runKey, reasons });
  }
  const policyRuns = (policyVersion: string): LiveRunRecord[] =>
    usable.filter((run) => run.policyVersion === policyVersion);
  const styleRuns = (style: LivePromptStyle): LiveRunRecord[] =>
    policyRuns('jev_live').filter((run) => run.promptStyle === style);

  const baselineD95 = {
    mock: baselinePairwiseD95(policyRuns('mock-weighted-v1')),
    random: baselinePairwiseD95(policyRuns('random-uniform-v1')),
  };

  const specs: ComparisonSpec[] = [];
  for (const style of ['neutral', 'survival_hint'] as const) {
    specs.push({
      name: `live(${style}) vs mock`,
      candidate: styleRuns(style),
      baseline: policyRuns('mock-weighted-v1'),
      candidatePolicy: 'jev_live',
      baselinePolicy: 'mock-weighted-v1',
      promptStyle: style,
    });
    specs.push({
      name: `live(${style}) vs random`,
      candidate: styleRuns(style),
      baseline: policyRuns('random-uniform-v1'),
      candidatePolicy: 'jev_live',
      baselinePolicy: 'random-uniform-v1',
      promptStyle: style,
    });
  }
  specs.push({
    name: 'live(survival_hint) vs live(neutral)',
    candidate: styleRuns('survival_hint'),
    baseline: styleRuns('neutral'),
    candidatePolicy: 'jev_live',
    baselinePolicy: 'jev_live',
    promptStyle: 'survival_hint',
  });

  const comparisons = specs.map((spec) => {
    const referenceD95 =
      spec.baselinePolicy === 'mock-weighted-v1'
        ? baselineD95.mock
        : spec.baselinePolicy === 'random-uniform-v1'
          ? baselineD95.random
          : baselineD95.mock;
    return comparePair(
      pairSeeds(spec.candidate, spec.baseline),
      spec,
      referenceD95,
      resolved.nRequired,
      resolved,
    );
  });
  const pValues = comparisons.map((comparison) => comparison.deltaGPermutationP);
  const family = {
    q: 0.05,
    pValues,
    bhAdjusted: bhAdjust(pValues),
    names: comparisons.map((comparison) => comparison.name),
  };
  return {
    mergeableRunKeys: usable.map((run) => run.runKey).sort(),
    excluded,
    baselineD95,
    comparisons,
    family,
    verdict: comparisons.some((comparison) => comparison.meetsStructuralCriteria)
      ? 'descriptive-structural-candidate'
      : 'no-structural-evidence',
    confirmationStatus: 'not-confirmatory-single-seed-set',
    notes: [
      '单个 10-seed 集合不足以满足 07 §8 第 4 条“独立确认种子集复现”；结果最高只能标 descriptive-structural-candidate。',
      'TV(P) 非负，未做符号翻转置换检验；置换 p 值只对应有符号 ΔG，BH 族按 5 个比较校正。',
      'baseline D95 来自同策略不同 seed 的两两 D；候选-基线 D 需 100% 超出该分位（07 §8 严格口径）。',
    ],
  };
}
