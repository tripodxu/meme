import { diffConfigPaths } from '../core/config/diff.js';
import { computeConfigHash } from '../core/config/hash.js';
import type { DeepPartialConfig } from '../core/config/defaults.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
  type EngineVersion,
  type RulesVersion,
} from '../core/control/versions.js';
import { hashValue } from '../core/hash/hash.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import { computeLabelThresholdsHash, LABEL_THRESHOLDS_VERSION } from '../core/labels/thresholds.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import {
  bootstrapMedianCi,
  dScore,
  median,
  pairedDiff,
  type P6WindowMetrics,
} from './p6-analysis.js';
import {
  assertCellDesign,
  buildBaseConfig,
  buildCellConfig,
  PREREG_PROMPT_STYLE,
  PREREG_PROMPT_VERSION,
} from './preregistration.js';

/**
 * P6-03：微扰克隆与正常波动区间（01 §9、07 §7；changes/0050）。
 *
 * 本文件是**预注册口径**，不是通用模拟代码：
 * - 两个体制（stable / critical）各自从同一检查点克隆；
 * - 每个体制跑同一组扰动 cell：control（δ=0）、wealth_absolute 三档、两个模型参数的
 *   相对扰动各三档；所有 cell 共用 30 个配对种子；
 * - 结论只回答「轨迹不同还是结构不同」，并给出 baseline 跨种子正常波动区间；
 *   不构成确认、校准或 P6-05 的三类结构验收（AGENTS #9）。
 *
 * 事件级翻转的「事件签名」固定为每 tick 的死亡数 + 阶级转移矩阵计数；
 * 连续量（competitionLoss/Gain 等）的差异计入轨迹偏离，不计入事件翻转。
 */

/** D-07 纪律：P6-03 使用独立种子集，不与 Stage A/B、P6-02 或 p15 轮次重叠。 */
export const P6_PERTURBATION_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p6-perturb-seed-${String(index + 1).padStart(3, '0')}`,
);

export const P6_PERTURBATION_TICKS = 730 as const;
export const P6_PERTURBATION_WARMUP = 365 as const;
export const P6_PERTURBATION_CHECKPOINT = 365 as const;
export const P6_PERTURBATION_POPULATION = 200 as const;

/**
 * 预注册诊断文本（进 `preregistrationHash`）。
 * 与 `WARMUP_DIAGNOSTICS` 同样收紧为字面量联合：新增实验档位必须先登记新文本，
 * 不让诊断字段退化成任意字符串（changes/0049 的口径）。
 */
export const P6_PERTURBATION_WARMUP_DIAGNOSTIC =
  'P6-03 微扰：warmup=365 后从检查点克隆并续跑 [365,729]；幅度阶梯与事件翻转按 07 §7 预注册' as const;

/** 60 个 (regime, seed) 任务 ×（检查点 + baseline + 10 个 cell）= 720 run。 */
export const P6_PERTURBATION_BUDGET = {
  maxRuns: 800,
  maxWallMinutes: 90,
  maxStorageBytes: 128 * 1024 * 1024,
} as const;

export type PerturbationKind = 'control' | 'wealth_absolute' | 'param_relative';

export interface P6PerturbationCell {
  readonly cellKey: string;
  readonly kind: PerturbationKind;
  /** wealth_absolute / control 为 null；param_relative 为 RunConfig 叶子路径。 */
  readonly field: string | null;
  /** param_relative 为相对 δ；wealth_absolute 为绝对 ΔValue；control 为 0。 */
  readonly delta: number;
  readonly hypothesis: string;
}

export interface P6PerturbationRegime {
  readonly regimeKey: string;
  readonly design: 'baseline' | 'interaction';
  readonly overrides: DeepPartialConfig;
  readonly changedPaths: readonly string[];
  readonly fullConfigHash: string;
  readonly hypothesis: string;
}

export interface P6PerturbationManifest {
  readonly schemaVersion: 'p6-perturbation-v1';
  readonly hypothesis: string;
  readonly primaryMetric: 'TV(P)';
  readonly experimentType: 'perturbation';
  readonly rulesVersion: RulesVersion;
  readonly engineVersion: EngineVersion;
  readonly decisionSchemaVersion: typeof DECISION_SCHEMA_VERSION;
  readonly policyVersion: 'mock-weighted-v1';
  readonly promptVersion: typeof PREREG_PROMPT_VERSION;
  readonly promptStyle: typeof PREREG_PROMPT_STYLE;
  readonly populationSize: number;
  readonly totalTicks: number;
  readonly checkpointTick: number;
  readonly baseConfigHash: string;
  readonly artifactProfile: 'metrics-only';
  readonly regimes: readonly P6PerturbationRegime[];
  readonly cells: readonly P6PerturbationCell[];
  readonly seeds: readonly string[];
  readonly pairing: 'same-seed-derived-initial-population-and-addressed-random';
  readonly warmupTicks: typeof P6_PERTURBATION_WARMUP;
  readonly warmupDiagnostic: typeof P6_PERTURBATION_WARMUP_DIAGNOSTIC;
  readonly windows: readonly {
    readonly label: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly labelThresholdVersion: typeof LABEL_THRESHOLDS_VERSION;
  readonly labelThresholdsHash: string;
  readonly clustering: {
    readonly distance: 'euclidean';
    readonly algorithm: 'ward-lw-v1';
    readonly standardization: 'z-score(pooled)';
    readonly featureWindows: readonly string[];
    readonly kRange: readonly [2, 5];
    readonly stabilityMinAri: 0.7;
    readonly stabilityShuffles: 20;
    readonly minClusterRuns: number;
    readonly temporalConsistencyMinRate: number;
    readonly d03Note: string;
  };
  readonly differenceThresholds: {
    readonly gini: 0.03;
    readonly tv: 0.1;
    readonly mUp: 0.05;
    readonly segregation: 0.05;
    readonly openness: 0.05;
  };
  readonly budgets: {
    readonly maxRuns: number;
    readonly maxWallMinutes: number;
    readonly maxStorageBytes: number;
  };
  readonly exclusionRules: {
    readonly excludeExtinctRuns: boolean;
    readonly excludeUnavailableWindows: boolean;
    readonly excludeNetworkEmptyFromSegregation: boolean;
    readonly maxTechnicalRetries: number;
  };
}

/**
 * P6-02 中结构变化最大的联合条件（changes/0046）：threshold=0.9 + ψ=flat +
 * env0=expanded + crossDays=half。P6-03 把它作为「临界区」体制；
 * 默认配置作为「稳定区」体制。两者使用同一组扰动幅度，便于比较吸收/放大。
 */
const STABLE_REGIME: Omit<P6PerturbationRegime, 'changedPaths' | 'fullConfigHash'> = {
  regimeKey: 'stable',
  design: 'baseline',
  overrides: {},
  hypothesis: '稳定区：默认配置；预注册预期小扰动主要被离散阈值或负反馈吸收。',
};

const CRITICAL_REGIME: Omit<P6PerturbationRegime, 'changedPaths' | 'fullConfigHash'> = {
  regimeKey: 'critical',
  design: 'interaction',
  overrides: {
    need: { threshold: 0.9, needMultiplier: [1, 1.5, 1.5, 1.5, 1.5] },
    opportunity: { env0: [1, 2, 3.5, 5, 7] },
    ascent: { crossDays: [15, 20, 25, 30] },
  },
  hypothesis:
    '临界区：P6-02 中 TV(P) 最大的联合条件；预注册预期同一幅度扰动更易被放大。' +
    '该体制是 interaction，差异不得归因到单一参数（07 §6.3）。',
};

/** 幅度阶梯（07 §7.3/§7.5）：相对 1e-6 起，财富绝对从 1e-4 起，均含 1e-6/1e-4/1e-2。 */
const DELTAS = [1e-6, 1e-4, 1e-2] as const;

function formatDelta(delta: number): string {
  return delta.toExponential(0);
}

export function buildP6PerturbationCells(): readonly P6PerturbationCell[] {
  return [
    {
      cellKey: 'control=0',
      kind: 'control',
      field: null,
      delta: 0,
      hypothesis: '克隆对照：δ=0 时两侧应逐位一致（检查点克隆与续跑确定性）。',
    },
    ...DELTAS.map((delta) => ({
      cellKey: `wealth_absolute=${formatDelta(delta)}`,
      kind: 'wealth_absolute' as const,
      field: null,
      delta,
      hypothesis: `财富绝对扰动 ΔValue=${formatDelta(delta)}：每个存活者在检查点加同一绝对量（07 §7.3）。`,
    })),
    ...DELTAS.map((delta) => ({
      cellKey: `param:need.threshold×${formatDelta(delta)}`,
      kind: 'param_relative' as const,
      field: 'need.threshold',
      delta,
      hypothesis: `需求线阈值相对扰动 ${formatDelta(delta)}：检验连续阈值附近的事件翻转与结构偏离。`,
    })),
    ...DELTAS.map((delta) => ({
      cellKey: `param:need.needMultiplier[1]×${formatDelta(delta)}`,
      kind: 'param_relative' as const,
      field: 'need.needMultiplier[1]',
      delta,
      hypothesis: `第二阶级持有乘子相对扰动 ${formatDelta(delta)}：检验主导阶级参数的传播。`,
    })),
  ];
}

/** 两个体制的完整配置、差异路径与 configHash（07 §3：进预注册哈希）。 */
export function buildP6PerturbationRegimes(): readonly P6PerturbationRegime[] {
  const base = buildBaseConfig(P6_PERTURBATION_POPULATION, P6_PERTURBATION_TICKS);
  return [STABLE_REGIME, CRITICAL_REGIME].map((definition) => {
    const config = buildCellConfig(
      { cellKey: definition.regimeKey, overrides: definition.overrides },
      P6_PERTURBATION_POPULATION,
      P6_PERTURBATION_TICKS,
    );
    const changedPaths = diffConfigPaths(base, config);
    assertCellDesign(definition.regimeKey, definition.design, changedPaths);
    return {
      ...definition,
      changedPaths,
      fullConfigHash: computeConfigHash(config),
    };
  });
}

export function buildP6PerturbationManifest(): P6PerturbationManifest {
  const baseConfig = buildBaseConfig(P6_PERTURBATION_POPULATION, P6_PERTURBATION_TICKS);
  return {
    schemaVersion: 'p6-perturbation-v1',
    hypothesis:
      'P6-03 微扰克隆：在同一检查点对 stable（默认）与 critical（P6-02 最大联合条件）两个体制施加' +
      '财富绝对扰动与两个模型参数的相对扰动（幅度 1e-6/1e-4/1e-2），用 30 个新配对种子回答：' +
      '小扰动是只改变轨迹，还是越过离散阈值改变窗口结构（TV(P)≥0.10 且超出 baseline 跨种子 D95）；' +
      '同时报告 baseline 正常波动区间与首次事件翻转/结构偏离 tick。结果仅 exploratory，不构成确认或校准。',
    primaryMetric: 'TV(P)',
    experimentType: 'perturbation',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    promptVersion: PREREG_PROMPT_VERSION,
    promptStyle: PREREG_PROMPT_STYLE,
    populationSize: P6_PERTURBATION_POPULATION,
    totalTicks: P6_PERTURBATION_TICKS,
    checkpointTick: P6_PERTURBATION_CHECKPOINT,
    baseConfigHash: computeConfigHash(baseConfig),
    artifactProfile: 'metrics-only',
    regimes: buildP6PerturbationRegimes(),
    cells: buildP6PerturbationCells(),
    seeds: P6_PERTURBATION_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    warmupTicks: P6_PERTURBATION_WARMUP,
    warmupDiagnostic: P6_PERTURBATION_WARMUP_DIAGNOSTIC,
    windows: [{ label: 'w1', start: 365, end: 1094 }],
    labelThresholdVersion: LABEL_THRESHOLDS_VERSION,
    labelThresholdsHash: computeLabelThresholdsHash(),
    clustering: {
      distance: 'euclidean',
      algorithm: 'ward-lw-v1',
      standardization: 'z-score(pooled)',
      featureWindows: ['w1'],
      kRange: [2, 5],
      stabilityMinAri: 0.7,
      stabilityShuffles: 20,
      minClusterRuns: 5,
      temporalConsistencyMinRate: 0.8,
      d03Note:
        'P6-03 为微扰实验，不执行聚类判定；聚类块按 07 §3 权威字段清单保留并进哈希，口径与 D-03 冻结一致',
    },
    differenceThresholds: {
      gini: 0.03,
      tv: 0.1,
      mUp: 0.05,
      segregation: 0.05,
      openness: 0.05,
    },
    budgets: { ...P6_PERTURBATION_BUDGET },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
  };
}

/** 预注册哈希预像：显式列出 07 §3 的权威字段，防止漏字段后哈希静默不变。 */
export function buildP6PerturbationHashInput(manifest: P6PerturbationManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    hypothesis: manifest.hypothesis,
    primaryMetric: manifest.primaryMetric,
    experimentType: manifest.experimentType,
    rulesVersion: manifest.rulesVersion,
    engineVersion: manifest.engineVersion,
    decisionSchemaVersion: manifest.decisionSchemaVersion,
    policyVersion: manifest.policyVersion,
    promptVersion: manifest.promptVersion,
    promptStyle: manifest.promptStyle,
    populationSize: manifest.populationSize,
    totalTicks: manifest.totalTicks,
    checkpointTick: manifest.checkpointTick,
    baseConfigHash: manifest.baseConfigHash,
    artifactProfile: manifest.artifactProfile,
    regimes: manifest.regimes,
    cells: manifest.cells,
    seeds: manifest.seeds,
    pairing: manifest.pairing,
    warmupTicks: manifest.warmupTicks,
    warmupDiagnostic: manifest.warmupDiagnostic,
    windows: manifest.windows,
    labelThresholdVersion: manifest.labelThresholdVersion,
    labelThresholdsHash: manifest.labelThresholdsHash,
    clustering: manifest.clustering,
    differenceThresholds: manifest.differenceThresholds,
    budgets: manifest.budgets,
    exclusionRules: manifest.exclusionRules,
  } as const;
}

export function computeP6PerturbationHash(): string {
  return hashValue(
    HASH_DOMAINS.preregistration,
    buildP6PerturbationHashInput(buildP6PerturbationManifest()),
  );
}

// ---------------------------------------------------------------------------
// 纯分析层：事件翻转、逐 tick 结构偏离、配对分类与聚合。
// ---------------------------------------------------------------------------

export interface PerturbationTickShare {
  readonly tick: number;
  readonly shares: readonly number[];
}

/** 逐 tick 阶级占比；全死亡行返回 null（不把 P=0 当作结构）。 */
export function tickClassShares(stats: readonly TickStats[]): (PerturbationTickShare | null)[] {
  return stats.map((row) => {
    if (row.aliveCount <= 0) {
      return null;
    }
    return {
      tick: row.tick,
      shares: row.classCounts.map((count) => count / row.aliveCount),
    };
  });
}

export function tickTv(
  left: readonly number[] | null,
  right: readonly number[] | null,
): number | null {
  if (left === null || right === null || left.length !== right.length) {
    return null;
  }
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs((left[index] as number) - (right[index] as number));
  }
  return 0.5 * total;
}

export interface PerturbationEventSummary {
  readonly firstEventFlipTick: number | null;
  readonly eventFlipTicks: number;
  readonly flippedEventCount: number;
}

function flowSignature(
  flows: ReadonlyMap<number, readonly (readonly number[])[]> | undefined,
  tick: number,
): number[] {
  const matrix = flows?.get(tick);
  if (matrix === undefined) {
    return [];
  }
  return matrix.flatMap((row) => row);
}

function sumAbsoluteDiff(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return total;
}

/**
 * 事件级翻转（07 §7.5）：事件签名 = 死亡数 + 阶级转移矩阵计数。
 * 任一侧缺少该 tick 行时按一次翻转计（run 提前结束本身是结构事件）。
 */
export function summarizeEventFlips(
  baselineStats: readonly TickStats[],
  baselineFlows: ReadonlyMap<number, readonly (readonly number[])[]> | undefined,
  treatmentStats: readonly TickStats[],
  treatmentFlows: ReadonlyMap<number, readonly (readonly number[])[]> | undefined,
): PerturbationEventSummary {
  const baselineByTick = new Map(baselineStats.map((row) => [row.tick, row]));
  const treatmentByTick = new Map(treatmentStats.map((row) => [row.tick, row]));
  const ticks = [...new Set([...baselineByTick.keys(), ...treatmentByTick.keys()])].sort(
    (left, right) => left - right,
  );
  let firstEventFlipTick: number | null = null;
  let eventFlipTicks = 0;
  let flippedEventCount = 0;
  for (const tick of ticks) {
    const baselineRow = baselineByTick.get(tick);
    const treatmentRow = treatmentByTick.get(tick);
    let difference: number;
    if (baselineRow === undefined || treatmentRow === undefined) {
      difference = 1;
    } else {
      difference =
        Math.abs(baselineRow.deathCount - treatmentRow.deathCount) +
        sumAbsoluteDiff(flowSignature(baselineFlows, tick), flowSignature(treatmentFlows, tick));
    }
    if (difference > 0) {
      if (firstEventFlipTick === null) {
        firstEventFlipTick = tick;
      }
      eventFlipTicks += 1;
      flippedEventCount += difference;
    }
  }
  return { firstEventFlipTick, eventFlipTicks, flippedEventCount };
}

/** 逐 tick TV(P) 序列（只保留两侧都存在的 tick）。 */
export function perTickTvSeries(
  baselineStats: readonly TickStats[],
  treatmentStats: readonly TickStats[],
): { readonly tick: number; readonly tv: number }[] {
  const treatmentByTick = new Map(treatmentStats.map((row) => [row.tick, row]));
  const series: { tick: number; tv: number }[] = [];
  for (const baselineRow of baselineStats) {
    const treatmentRow = treatmentByTick.get(baselineRow.tick);
    if (treatmentRow === undefined) {
      continue;
    }
    const tv = tickTv(
      baselineRow.aliveCount > 0
        ? baselineRow.classCounts.map((count) => count / baselineRow.aliveCount)
        : null,
      treatmentRow.aliveCount > 0
        ? treatmentRow.classCounts.map((count) => count / treatmentRow.aliveCount)
        : null,
    );
    if (tv !== null) {
      series.push({ tick: baselineRow.tick, tv });
    }
  }
  return series;
}

/**
 * 首次「结构指纹偏离」：30 tick 尾随块均值的 TV(P) 首次 >= 预注册门槛（07 §5 的
 * 30 日块口径，避免把单日噪声当成结构）。不足 30 tick 时不判。
 */
export function firstTrailingMeanDeviationTick(
  series: readonly { readonly tick: number; readonly tv: number }[],
  threshold: number,
  block = 30,
): number | null {
  if (series.length < block) {
    return null;
  }
  let sum = 0;
  for (let index = 0; index < series.length; index += 1) {
    sum += series[index]?.tv as number;
    if (index >= block) {
      sum -= series[index - block]?.tv as number;
    }
    if (index >= block - 1 && sum / block >= threshold) {
      return series[index]?.tick ?? null;
    }
  }
  return null;
}

export type PerturbationClassification =
  'identical' | 'absorbed' | 'trajectory-only' | 'structural';

export interface PerturbationPairView {
  readonly baselineFinalStateHash: string;
  readonly treatmentFinalStateHash: string | null;
  readonly eventFlipTicks: number;
  readonly windowTv: number;
  readonly windowD: number;
  readonly baselineD95: number | null;
  readonly tvThreshold: number;
}

/**
 * 区分「轨迹不同」与「结构不同」：
 * - `identical`：完整权威哈希一致（含 config），只有 δ=0 对照应如此；
 * - `absorbed`：730 天内零事件翻转（07 §7.5：只能判「被离散阈值吸收」，
 *   不能判「负反馈稳定」）；连续量差异或 config 变化不算结构变化；
 * - `structural`：窗口 TV 过门槛且超出 baseline 跨种子 D95；
 * - 其余为 `trajectory-only`。
 *
 * 注意：param 扰动会改变 state.config，因此即使行为逐位不变，权威哈希也不同；
 * 这正是不能用哈希是否相等来判定「结构是否改变」的原因。
 */
export function classifyPerturbationPair(view: PerturbationPairView): PerturbationClassification {
  if (
    view.treatmentFinalStateHash !== null &&
    view.treatmentFinalStateHash === view.baselineFinalStateHash
  ) {
    return 'identical';
  }
  if (view.eventFlipTicks === 0) {
    return 'absorbed';
  }
  if (
    view.baselineD95 !== null &&
    view.windowTv >= view.tvThreshold &&
    view.windowD > view.baselineD95
  ) {
    return 'structural';
  }
  return 'trajectory-only';
}

export interface PerturbationPairRecord {
  readonly regimeKey: string;
  readonly seed: string;
  readonly cellKey: string;
  readonly kind: PerturbationKind;
  readonly field: string | null;
  readonly delta: number;
  readonly applied: boolean;
  readonly invalidReason: string | null;
  readonly checkpointStateHash: string;
  readonly baselineFinalStateHash: string;
  readonly treatmentFinalStateHash: string | null;
  readonly firstDivergenceTick: number | null;
  readonly firstEventFlipTick: number | null;
  readonly eventFlipTicks: number;
  readonly flippedEventCount: number;
  readonly firstStructuralDeviationTick: number | null;
  readonly windowTv: number;
  readonly windowD: number;
  readonly window: P6WindowMetrics;
  readonly extinct: boolean;
  readonly fallbackRate: number | null;
  readonly aliveAtEnd: number;
}

export interface PerturbationBaselineRecord {
  readonly regimeKey: string;
  readonly seed: string;
  readonly window: P6WindowMetrics;
  /** baseline 逐 tick 阶级占比：正常波动区间的分位由跨种子配对计算。 */
  readonly tickShares: readonly (PerturbationTickShare | null)[];
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] as number;
}

export interface PerturbationNormalFluctuation {
  readonly regimeKey: string;
  readonly baselinePairs: number;
  readonly windowTvMedian: number | null;
  readonly windowTvP95: number | null;
  readonly tickTvP95: number | null;
  readonly windowD95: number | null;
}

/** baseline 跨种子正常波动区间：窗口 TV/D 的两两分布 + 逐 tick TV 的 95 分位。 */
export function summarizeNormalFluctuation(
  baselines: readonly PerturbationBaselineRecord[],
): PerturbationNormalFluctuation[] {
  const regimes = [...new Set(baselines.map((entry) => entry.regimeKey))];
  return regimes.map((regimeKey) => {
    const scoped = baselines.filter((entry) => entry.regimeKey === regimeKey);
    const windowTvs: number[] = [];
    const windowDs: number[] = [];
    const tickTvs: number[] = [];
    for (let left = 0; left < scoped.length; left += 1) {
      for (let right = left + 1; right < scoped.length; right += 1) {
        const first = scoped[left] as PerturbationBaselineRecord;
        const second = scoped[right] as PerturbationBaselineRecord;
        const diff = pairedDiff(second.window, first.window);
        windowTvs.push(diff.tv);
        windowDs.push(dScore(diff));
        const ticks = Math.min(first.tickShares.length, second.tickShares.length);
        for (let index = 0; index < ticks; index += 1) {
          const tv = tickTv(
            first.tickShares[index]?.shares ?? null,
            second.tickShares[index]?.shares ?? null,
          );
          if (tv !== null) {
            tickTvs.push(tv);
          }
        }
      }
    }
    return {
      regimeKey,
      baselinePairs: windowTvs.length,
      windowTvMedian: windowTvs.length === 0 ? null : median(windowTvs),
      windowTvP95: percentile(windowTvs, 0.95),
      tickTvP95: percentile(tickTvs, 0.95),
      windowD95: percentile(windowDs, 0.95),
    };
  });
}

export interface PerturbationCellSummary {
  readonly cellKey: string;
  readonly kind: PerturbationKind;
  readonly field: string | null;
  readonly delta: number;
  readonly pairs: number;
  readonly validPairs: number;
  readonly invalidPairs: number;
  readonly classified: {
    readonly identical: number;
    readonly absorbed: number;
    readonly trajectoryOnly: number;
    readonly structural: number;
  };
  readonly windowTvMedian: number | null;
  readonly windowTvCi95: readonly [number, number] | null;
  readonly windowTvMax: number | null;
  readonly windowDMedian: number | null;
  readonly beyondBaselineD95Rate: number | null;
  readonly firstEventFlipTickMin: number | null;
  readonly firstEventFlipTickMedian: number | null;
  readonly eventFlipTicksMedian: number | null;
  readonly firstStructuralDeviationTickMedian: number | null;
  readonly structuralEvidence: boolean;
}

export interface PerturbationRegimeSummary {
  readonly regimeKey: string;
  readonly design: 'baseline' | 'interaction';
  readonly cells: readonly PerturbationCellSummary[];
}

export interface PerturbationAnalysis {
  readonly schemaVersion: 'p6-perturbation-analysis-v1';
  readonly protocol: '07-perturbation-exploratory';
  readonly primaryMetric: 'TV(P)';
  readonly tvThreshold: number;
  readonly seeds: number;
  readonly normalFluctuation: readonly PerturbationNormalFluctuation[];
  readonly regimes: readonly PerturbationRegimeSummary[];
  readonly claim: string;
}

function summarizeCell(
  cell: P6PerturbationCell,
  pairs: readonly PerturbationPairRecord[],
  baselineD95: number | null,
  tvThreshold: number,
  expectedPairs: number,
): PerturbationCellSummary {
  const scoped = pairs.filter((pair) => pair.cellKey === cell.cellKey);
  const valid = scoped.filter(
    (pair) => pair.applied && pair.invalidReason === null && pair.treatmentFinalStateHash !== null,
  );
  const values = valid.map((pair) => pair.windowTv);
  const classifications = valid.map((pair) =>
    classifyPerturbationPair({
      baselineFinalStateHash: pair.baselineFinalStateHash,
      treatmentFinalStateHash: pair.treatmentFinalStateHash,
      eventFlipTicks: pair.eventFlipTicks,
      windowTv: pair.windowTv,
      windowD: pair.windowD,
      baselineD95,
      tvThreshold,
    }),
  );
  const firstEventFlips = valid
    .map((pair) => pair.firstEventFlipTick)
    .filter((value): value is number => value !== null);
  const firstStructural = valid
    .map((pair) => pair.firstStructuralDeviationTick)
    .filter((value): value is number => value !== null);
  const center = values.length === 0 ? null : median(values);
  const ci = values.length === 0 ? null : bootstrapMedianCi(values, { iterations: 10_000 });
  const beyondRate =
    baselineD95 === null || valid.length === 0
      ? null
      : valid.filter((pair) => pair.windowD > baselineD95).length / valid.length;
  return {
    cellKey: cell.cellKey,
    kind: cell.kind,
    field: cell.field,
    delta: cell.delta,
    pairs: scoped.length,
    validPairs: valid.length,
    invalidPairs: scoped.length - valid.length,
    classified: {
      identical: classifications.filter((value) => value === 'identical').length,
      absorbed: classifications.filter((value) => value === 'absorbed').length,
      trajectoryOnly: classifications.filter((value) => value === 'trajectory-only').length,
      structural: classifications.filter((value) => value === 'structural').length,
    },
    windowTvMedian: center,
    windowTvCi95: ci,
    windowTvMax: percentile(values, 1),
    windowDMedian: valid.length === 0 ? null : median(valid.map((pair) => pair.windowD)),
    beyondBaselineD95Rate: beyondRate,
    firstEventFlipTickMin: firstEventFlips.length === 0 ? null : Math.min(...firstEventFlips),
    firstEventFlipTickMedian: firstEventFlips.length === 0 ? null : median(firstEventFlips),
    eventFlipTicksMedian:
      valid.length === 0 ? null : median(valid.map((pair) => pair.eventFlipTicks)),
    firstStructuralDeviationTickMedian:
      firstStructural.length === 0 ? null : median(firstStructural),
    // 严格的 07 §8 式结构证据：30 对全部有效、中位数过门槛、CI 不跨 0、全部超出波动带。
    structuralEvidence:
      valid.length === expectedPairs &&
      center !== null &&
      center >= tvThreshold &&
      ci !== null &&
      !(ci[0] <= 0 && ci[1] >= 0) &&
      beyondRate === 1,
  };
}

export function summarizePerturbationAnalysis(
  manifest: P6PerturbationManifest,
  baselines: readonly PerturbationBaselineRecord[],
  pairs: readonly PerturbationPairRecord[],
): PerturbationAnalysis {
  const normalFluctuation = summarizeNormalFluctuation(baselines);
  const regimes = manifest.regimes.map((regime) => {
    const normal = normalFluctuation.find((entry) => entry.regimeKey === regime.regimeKey);
    const baselineD95 = normal?.windowD95 ?? null;
    const scopedPairs = pairs.filter((pair) => pair.regimeKey === regime.regimeKey);
    return {
      regimeKey: regime.regimeKey,
      design: regime.design,
      cells: manifest.cells.map((cell) =>
        summarizeCell(
          cell,
          scopedPairs,
          baselineD95,
          manifest.differenceThresholds.tv,
          manifest.seeds.length,
        ),
      ),
    };
  });
  return {
    schemaVersion: 'p6-perturbation-analysis-v1',
    protocol: '07-perturbation-exploratory',
    primaryMetric: 'TV(P)',
    tvThreshold: manifest.differenceThresholds.tv,
    seeds: manifest.seeds.length,
    normalFluctuation,
    regimes,
    claim:
      'P6-03 微扰探索：只区分轨迹不同与结构不同，并给出 baseline 正常波动区间；' +
      '不构成确认、校准或 P6-05 三类结构验收（AGENTS #9、07 §7/§8）。',
  };
}
