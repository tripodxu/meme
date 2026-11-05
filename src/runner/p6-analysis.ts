/**
 * P6-01 Stage B 判读（07 §8/§9）纯函数。
 *
 * 与旧 `scripts/p6-stage-b.mjs` 内联判读的区别（changes/0042）：
 * - 只认预注册的 `primaryMetric` 与 `differenceThresholds`，不得用任意次要指标顶替；
 * - 判定窗口固定为 w2b；w3 仅作相邻窗口描述，不参与确认（07 §8 第 4 条）；
 * - 95% 区间为固定分析 seed 的 10,000 次配对 bootstrap（07 §9），不是 [min,max]；
 * - 完整性（60/60、30 对、0 灭绝/回退/缺窗口）是确认的前置条件；
 * - 预注册 hypothesis 与 07 冲突时（如“或其他预注册指标超门槛”）标记 `protocolConflict`，
 *   仍按 07 的主指标口径判定，不静默选择有利口径。
 *
 * 模块只做纯计算：不读文件、不写文件、不依赖 Node/DOM/时钟。
 */

export type MetricKey = 'tv' | 'gini' | 'mUp' | 'mDown' | 'segregation' | 'openness';

/** 窗口汇总（`RunWindowReport` 与 slim 产物的公共子集）。 */
export interface P6WindowMetrics {
  readonly classShares: readonly number[];
  readonly gini: number;
  readonly mUp: number;
  readonly mDown: number;
  readonly segregation: number | null;
  readonly openness: number;
  readonly fallbackRate?: number | null;
  readonly missingTicks?: number;
  readonly observedTicks?: number;
  readonly tickCount?: number;
}

export interface P6AnalysisRun {
  readonly cellKey: string;
  readonly seed: string;
  readonly extinct: boolean;
  readonly w2b?: P6WindowMetrics;
  readonly w3?: P6WindowMetrics;
}

export interface P6Prereg {
  readonly primaryMetric: string;
  readonly seeds: readonly string[];
  readonly differenceThresholds: Readonly<Record<string, number>>;
  readonly hypothesis?: string;
}

export interface P6MetricResult {
  readonly median: number;
  readonly ci95: readonly [number, number];
  readonly ciCrossesZero: boolean;
  readonly directionAgree: number;
  readonly threshold: number | null;
  readonly overThreshold: boolean;
  readonly paired: number;
  readonly permutationP?: number;
}

export interface P6Completeness {
  readonly ok: boolean;
  readonly expectedRuns: number;
  readonly actualRuns: number;
  readonly expectedPairs: number;
  readonly paired: number;
  readonly baselineRuns: number;
  readonly candidateRuns: number;
  readonly extinct: number;
  readonly fallback: number;
  readonly missingWindow: number;
  readonly nonFinite: number;
  readonly totalsOk: boolean;
}

export interface P6Criteria {
  readonly complete: boolean;
  readonly artifactFree: boolean;
  readonly primaryPresent: boolean;
  readonly primaryOverThreshold: boolean;
  readonly primaryCiNotCrossingZero: boolean;
  readonly primaryDirectionOk: boolean;
  readonly beyondBaselineBand: boolean;
  readonly beyondBandMinRate: number;
}

export interface P6Evaluation {
  readonly schemaVersion: 'p6-stageB-analysis-v2';
  readonly cellKey: string;
  readonly targetCellKey: string;
  readonly primaryMetric: string;
  readonly primaryMetricKey: MetricKey;
  readonly protocolConflict: boolean;
  readonly completeness: P6Completeness;
  readonly baselineD95: number | null;
  readonly beyondBandRate: number;
  readonly metrics: Partial<Record<MetricKey, P6MetricResult>>;
  /** w3 相邻窗口描述；不参与确认。 */
  readonly adjacentWindow: Partial<Record<MetricKey, P6MetricResult>>;
  readonly primary: P6MetricResult | null;
  readonly criteria: P6Criteria;
  readonly confirmed: boolean;
  readonly claim: string;
  readonly stageClaim: string;
}

const PRIMARY_METRIC_KEYS: Readonly<Record<string, MetricKey>> = {
  'TV(P)': 'tv',
  G: 'gini',
  Mup: 'mUp',
  Mdown: 'mDown',
  S: 'segregation',
  O: 'openness',
};

/** manifest.differenceThresholds 的键；`Mdown` 未预注册门槛，返回 null。 */
const THRESHOLD_KEYS: Readonly<Record<MetricKey, string | null>> = {
  tv: 'tv',
  gini: 'gini',
  mUp: 'mUp',
  mDown: null,
  segregation: 'segregation',
  openness: 'openness',
};

export function metricKeyForPrimary(primaryMetric: string): MetricKey {
  const key = PRIMARY_METRIC_KEYS[primaryMetric];
  if (key === undefined) {
    throw new TypeError(`未知的 primaryMetric: ${primaryMetric}`);
  }
  return key;
}

/** 可复现 PRNG（mulberry32）；分析 seed 固定，不使用 Math.random。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new TypeError('median 需要至少一个值');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** 配对差的中位数 bootstrap 95% 区间（07 §9：至少 10,000 次，分析 seed 固定）。 */
export function bootstrapMedianCi(
  values: readonly number[],
  options: { readonly iterations?: number; readonly seed?: number } = {},
): readonly [number, number] {
  if (values.length === 0) {
    throw new TypeError('bootstrapMedianCi 需要至少一个值');
  }
  const iterations = options.iterations ?? 10_000;
  const random = mulberry32(options.seed ?? 20261105);
  const medians = new Array<number>(iterations);
  const sample = new Array<number>(values.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = 0; index < values.length; index += 1) {
      sample[index] = values[Math.floor(random() * values.length)] as number;
    }
    medians[iteration] = median(sample);
  }
  medians.sort((a, b) => a - b);
  const lo = medians[Math.floor(0.025 * iterations)] as number;
  const hi = medians[Math.ceil(0.975 * iterations) - 1] as number;
  return [lo, hi];
}

/** 双侧配对符号翻转置换检验（07 §9：至少 100,000 次，分析 seed 固定）。 */
export function signFlipPermutationP(
  values: readonly number[],
  options: { readonly iterations?: number; readonly seed?: number } = {},
): number {
  if (values.length === 0) {
    throw new TypeError('signFlipPermutationP 需要至少一个值');
  }
  const iterations = options.iterations ?? 100_000;
  const random = mulberry32(options.seed ?? 20261105);
  const observed = Math.abs(median(values));
  const flipped = new Array<number>(values.length);
  let extreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = 0; index < values.length; index += 1) {
      const sign = random() < 0.5 ? -1 : 1;
      flipped[index] = (values[index] as number) * sign;
    }
    if (Math.abs(median(flipped)) >= observed) {
      extreme += 1;
    }
  }
  return (1 + extreme) / (1 + iterations);
}

export interface P6PairedDiff {
  readonly tv: number;
  readonly gini: number;
  readonly mUp: number;
  readonly mDown: number;
  readonly segregation: number | null;
  readonly openness: number;
}

export function pairedDiff(candidate: P6WindowMetrics, baseline: P6WindowMetrics): P6PairedDiff {
  if (candidate.classShares.length !== baseline.classShares.length) {
    throw new TypeError('配对窗口的 classShares 长度不一致');
  }
  let tv = 0;
  for (let index = 0; index < candidate.classShares.length; index += 1) {
    tv += Math.abs(
      (candidate.classShares[index] as number) - (baseline.classShares[index] as number),
    );
  }
  return {
    tv: 0.5 * tv,
    gini: candidate.gini - baseline.gini,
    mUp: candidate.mUp - baseline.mUp,
    mDown: candidate.mDown - baseline.mDown,
    segregation:
      candidate.segregation === null || baseline.segregation === null
        ? null
        : candidate.segregation - baseline.segregation,
    openness: candidate.openness - baseline.openness,
  };
}

/** rule.md 第 51 条 / 07 §8 的 D（仅用于波动带参考与外部分析，不作主指标）。 */
export function dScore(diff: P6PairedDiff): number {
  const abs = (value: number | null): number => (value === null ? 0 : Math.abs(value));
  return (
    0.3 * abs(diff.gini) +
    0.25 * diff.tv +
    0.2 * abs(diff.mUp) +
    0.15 * abs(diff.segregation) +
    0.1 * abs(diff.openness)
  );
}

function windowIsFinite(window: P6WindowMetrics): boolean {
  if (window.classShares.some((value) => !Number.isFinite(value))) {
    return false;
  }
  const fields = [window.gini, window.mUp, window.mDown, window.openness];
  if (fields.some((value) => !Number.isFinite(value))) {
    return false;
  }
  return window.segregation === null || Number.isFinite(window.segregation);
}

function metricValues(diffs: readonly P6PairedDiff[], key: MetricKey): number[] {
  return diffs
    .map((diff) => diff[key])
    .filter((value): value is number => value !== null && Number.isFinite(value));
}

function evaluateMetrics(
  diffs: readonly P6PairedDiff[],
  prereg: P6Prereg,
  options: { readonly permutation: boolean; readonly iterations: number; readonly seed: number },
): Partial<Record<MetricKey, P6MetricResult>> {
  const result: Partial<Record<MetricKey, P6MetricResult>> = {};
  const keys: readonly MetricKey[] = ['tv', 'gini', 'mUp', 'mDown', 'segregation', 'openness'];
  for (const key of keys) {
    const values = metricValues(diffs, key);
    if (values.length === 0) {
      continue;
    }
    const center = median(values);
    const ci = bootstrapMedianCi(values, { seed: options.seed });
    const thresholdKey = THRESHOLD_KEYS[key];
    const threshold =
      thresholdKey === null ? null : (prereg.differenceThresholds[thresholdKey] ?? null);
    const sign = Math.sign(center);
    const directionAgree =
      sign === 0 ? 0 : values.filter((value) => Math.sign(value) === sign).length / values.length;
    result[key] = {
      median: center,
      ci95: ci,
      ciCrossesZero: ci[0] <= 0 && ci[1] >= 0,
      directionAgree,
      threshold,
      overThreshold: threshold !== null && Math.abs(center) >= threshold,
      paired: values.length,
      ...(options.permutation
        ? {
            permutationP: signFlipPermutationP(values, {
              iterations: options.iterations,
              seed: options.seed,
            }),
          }
        : {}),
    };
  }
  return result;
}

export interface P6EvaluationOptions {
  readonly bootstrapIterations?: number;
  readonly bootstrapSeed?: number;
  readonly permutationIterations?: number;
  /** 07 §8 第 3 条未给比例；默认按报告宣称的 100% 严格口径。 */
  readonly beyondBandMinRate?: number;
}

/**
 * 按 07 §8 判定一个 Stage B 单元。
 *
 * 确认条件（全部满足）：
 * 1. 预注册 primary metric 的 |配对中位数| 达到其预注册门槛；
 * 2. 该主指标的配对 bootstrap 95% 区间不跨 0；
 * 3. 该主指标的方向一致率 >= 0.90；
 * 4. 每个确认 seed 的候选-vs-baseline D 都超出 baseline 两两 D 的 95 分位
 *    （默认 100%；07 未给比例，采用报告宣称的最严口径）；
 * 5. 完整性：60/60、30 对、0 灭绝/回退/缺窗口/非有限值。
 *
 * w3 只作为相邻窗口描述返回，不参与任何确认条件（07 §8 第 4 条）。
 */
export function evaluateStageB(
  input: {
    readonly cellKey: string;
    readonly targetCellKey: string;
    readonly prereg: P6Prereg;
    readonly runs: readonly P6AnalysisRun[];
    readonly totals?: {
      readonly due: number;
      readonly ok: number;
      readonly failed: number;
      readonly resumed: number;
    };
  },
  options: P6EvaluationOptions = {},
): P6Evaluation {
  const primaryKey = metricKeyForPrimary(input.prereg.primaryMetric);
  const expectedRuns = input.prereg.seeds.length * 2;
  const baseline = input.runs.filter((run) => run.cellKey === 'baseline');
  const candidate = input.runs.filter((run) => run.cellKey === input.targetCellKey);
  const baselineBySeed = new Map(baseline.map((run) => [run.seed, run]));
  const candidateBySeed = new Map(candidate.map((run) => [run.seed, run]));
  const pairedSeeds = input.prereg.seeds.filter(
    (seed) => baselineBySeed.has(seed) && candidateBySeed.has(seed),
  );

  const selected = pairedSeeds.map((seed) => ({
    seed,
    baseline: baselineBySeed.get(seed) as P6AnalysisRun,
    candidate: candidateBySeed.get(seed) as P6AnalysisRun,
  }));

  const extinct = input.runs.filter((run) => run.extinct).length;
  const fallback = input.runs.filter(
    (run) => (run.w2b?.fallbackRate ?? 0) > 0 || (run.w3?.fallbackRate ?? 0) > 0,
  ).length;
  const missingWindow = selected.filter(
    (entry) => entry.baseline.w2b === undefined || entry.candidate.w2b === undefined,
  ).length;
  const nonFinite = selected.filter(
    (entry) =>
      entry.baseline.w2b === undefined ||
      entry.candidate.w2b === undefined ||
      !windowIsFinite(entry.baseline.w2b) ||
      !windowIsFinite(entry.candidate.w2b),
  ).length;
  const totalsOk =
    input.totals === undefined
      ? true
      : input.totals.due === expectedRuns &&
        input.totals.ok === expectedRuns &&
        input.totals.failed === 0;

  const completeness: P6Completeness = {
    ok:
      input.runs.length === expectedRuns &&
      baseline.length === input.prereg.seeds.length &&
      candidate.length === input.prereg.seeds.length &&
      pairedSeeds.length === input.prereg.seeds.length &&
      extinct === 0 &&
      fallback === 0 &&
      missingWindow === 0 &&
      nonFinite === 0 &&
      totalsOk,
    expectedRuns,
    actualRuns: input.runs.length,
    expectedPairs: input.prereg.seeds.length,
    paired: pairedSeeds.length,
    baselineRuns: baseline.length,
    candidateRuns: candidate.length,
    extinct,
    fallback,
    missingWindow,
    nonFinite,
    totalsOk,
  };

  const usable = selected.filter(
    (entry) => entry.baseline.w2b !== undefined && entry.candidate.w2b !== undefined,
  );
  const diffs = usable.map((entry) =>
    pairedDiff(entry.candidate.w2b as P6WindowMetrics, entry.baseline.w2b as P6WindowMetrics),
  );
  const adjacentDiffs = selected
    .filter((entry) => entry.baseline.w3 !== undefined && entry.candidate.w3 !== undefined)
    .map((entry) =>
      pairedDiff(entry.candidate.w3 as P6WindowMetrics, entry.baseline.w3 as P6WindowMetrics),
    );

  const bootstrapSeed = options.bootstrapSeed ?? 20261105;
  const metrics = evaluateMetrics(diffs, input.prereg, {
    permutation: true,
    iterations: options.permutationIterations ?? 100_000,
    seed: bootstrapSeed,
  });
  const adjacentWindow = evaluateMetrics(adjacentDiffs, input.prereg, {
    permutation: false,
    iterations: 0,
    seed: bootstrapSeed,
  });

  const baselinePairwiseD: number[] = [];
  for (let left = 0; left < baseline.length; left += 1) {
    for (let right = left + 1; right < baseline.length; right += 1) {
      const leftRun = baseline[left] as P6AnalysisRun;
      const rightRun = baseline[right] as P6AnalysisRun;
      if (leftRun.w2b !== undefined && rightRun.w2b !== undefined) {
        baselinePairwiseD.push(dScore(pairedDiff(leftRun.w2b, rightRun.w2b)));
      }
    }
  }
  baselinePairwiseD.sort((a, b) => a - b);
  const baselineD95 =
    baselinePairwiseD.length === 0
      ? null
      : (baselinePairwiseD[
          Math.min(baselinePairwiseD.length - 1, Math.floor(0.95 * baselinePairwiseD.length))
        ] as number);
  const beyondBandRate =
    baselineD95 === null || diffs.length === 0
      ? 0
      : diffs.filter((diff) => dScore(diff) > baselineD95).length / diffs.length;

  const primary = metrics[primaryKey] ?? null;
  const beyondBandMinRate = options.beyondBandMinRate ?? 1;
  const criteria: P6Criteria = {
    complete: completeness.ok,
    artifactFree: extinct === 0 && fallback === 0 && missingWindow === 0 && nonFinite === 0,
    primaryPresent: primary !== null,
    primaryOverThreshold: primary?.overThreshold ?? false,
    primaryCiNotCrossingZero: primary !== null && !primary.ciCrossesZero,
    primaryDirectionOk: primary !== null && primary.directionAgree >= 0.9,
    beyondBaselineBand: beyondBandRate >= beyondBandMinRate,
    beyondBandMinRate,
  };
  const confirmed =
    criteria.complete &&
    criteria.artifactFree &&
    criteria.primaryPresent &&
    criteria.primaryOverThreshold &&
    criteria.primaryCiNotCrossingZero &&
    criteria.primaryDirectionOk &&
    criteria.beyondBaselineBand;

  const protocolConflict =
    input.prereg.hypothesis !== undefined && input.prereg.hypothesis.includes('或其他预注册指标');

  const claim = confirmed
    ? `Stage B 确认：主指标 ${input.prereg.primaryMetric} 在 w2b 达到预注册门槛，且区间、方向、波动带与完整性条件全部满足（07 §8）。`
    : `Stage B 未确认：主指标 ${input.prereg.primaryMetric} 未达预注册门槛，或区间/方向/波动带/完整性条件不满足（07 §8）。`;

  return {
    schemaVersion: 'p6-stageB-analysis-v2',
    cellKey: input.cellKey,
    targetCellKey: input.targetCellKey,
    primaryMetric: input.prereg.primaryMetric,
    primaryMetricKey: primaryKey,
    protocolConflict,
    completeness,
    baselineD95,
    beyondBandRate,
    metrics,
    adjacentWindow,
    primary,
    criteria,
    confirmed,
    claim,
    stageClaim:
      '确认轮效应判定；不构成三类结构结论或校准（P6-05 另有验收，AGENTS #9）。w3 仅作相邻窗口描述，不参与确认。',
  };
}
