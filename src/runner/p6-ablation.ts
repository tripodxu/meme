import { diffConfigPaths } from '../core/config/diff.js';
import { computeConfigHash } from '../core/config/hash.js';
import type { DeepPartialConfig } from '../core/config/defaults.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../core/control/versions.js';
import { computeLabelThresholdsHash, LABEL_THRESHOLDS_VERSION } from '../core/labels/thresholds.js';
import { median, pairedDiff, type P6WindowMetrics } from './p6-analysis.js';
import {
  assertCellDesign,
  buildBaseConfig,
  buildCellConfig,
  computePreregistrationHash,
  PREREG_PROMPT_STYLE,
  PREREG_PROMPT_VERSION,
  type PreregCell,
  type PreregManifest,
} from './preregistration.js';

/**
 * P6-04a：五个必跑消融（01 §9、07 §11；changes/0051）。
 *
 * 设计（本文件即冻结口径，运行前不得改）：
 * - baseline + 五个单轴消融：β=0（无网络机会）、O 固定（openness.updateMode=fixed）、
 *   η=0（congestionExponent=0 → Congestion=1）、κ=0（polarizationExponent=0 →
 *   Polarization=1）、ψ=1（needMultiplier 全 1，无阶级持有成本）；
 * - 200 人 × 730 tick，warmup 365，w1 观测段 [365,729]；30 个新种子
 *   `p6-ablation-seed-001…030`（D-07 纪律：不复用 Stage A/B、P6-02/03 或 p15 种子）；
 * - 主指标 TV(P)；只有消融后结构显著退化（TV 门槛 + 区间 + 波动带）才可说
 *   「该机制在本实验范围内有解释力」（07 §11）；不构成现实因果或校准。
 *
 * 方向预测只预注册文档明确给出的那一条：ψ=1 预期顶层塌缩显著增强（P4 下降，07 §11）。
 * 其余消融不预设方向，避免事后挑选有利结论。
 */

/** D-07 纪律：P6-04 使用独立种子集，不与任何历史轮次重叠。 */
export const P6_ABLATION_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p6-ablation-seed-${String(index + 1).padStart(3, '0')}`,
);

export const P6_ABLATION_TICKS = 730 as const;
export const P6_ABLATION_WARMUP = 365 as const;
export const P6_ABLATION_POPULATION = 200 as const;

/**
 * P6-04 消融预算（D-04 重冻结，changes/0051）：baseline + 5 消融 = 6 cell × 30 seed =
 * 180 run，超过 D-04 v1 的 120 run 占位值；按 0036 §1「换预算 = 新 experimentId」重冻结。
 */
export const P6_ABLATION_BUDGET = {
  maxRuns: 200,
  maxWallMinutes: 240,
  maxStorageBytes: 512 * 1024 * 1024,
} as const;

export const P6_ABLATION_BASELINE_KEY = 'baseline' as const;

export type AblationPredictionMetric = 'classShare4' | 'none';

export interface P6AblationPrediction {
  readonly metric: AblationPredictionMetric;
  readonly direction: 'decrease' | 'none';
  readonly note: string;
}

/** 预注册方向：只有 07 §11 明示的 ψ=1 顶层塌缩；其余保持无方向。 */
export const P6_ABLATION_PREDICTIONS: Readonly<Record<string, P6AblationPrediction>> = {
  baseline: { metric: 'none', direction: 'none', note: '对照，不设方向' },
  'beta=0': { metric: 'none', direction: 'none', note: '无网络机会；不预设方向，报告 TV 与分项' },
  'openness=fixed': {
    metric: 'none',
    direction: 'none',
    note: '停止制度更新；不预设结构方向，报告 O 与跨层流动',
  },
  'eta=0': { metric: 'none', direction: 'none', note: 'Congestion=1；不预设方向' },
  'kappa=0': { metric: 'none', direction: 'none', note: 'Polarization=1；不预设方向' },
  'psi=1': {
    metric: 'classShare4',
    direction: 'decrease',
    note: '07 §11：移除阶级持有成本，预期顶层塌缩显著增强（P4 下降）',
  },
};

interface AblationDefinition {
  readonly cellKey: string;
  readonly design: 'baseline' | 'single';
  readonly hypothesis: string;
  readonly overrides: DeepPartialConfig;
}

const ABLATION_DEFINITIONS: readonly AblationDefinition[] = [
  {
    cellKey: P6_ABLATION_BASELINE_KEY,
    design: 'baseline',
    hypothesis: 'P6-04 消融基准：默认规则与参数，作为五个消融的单轴对照。',
    overrides: {},
  },
  {
    cellKey: 'beta=0',
    design: 'single',
    hypothesis:
      '无网络机会（β=0）：Opportunity 恒为 1；网络关系、网络竞争与 S 保留。' +
      '报告 TV(P) 与 G/Mup/Mdown/S/O 分项；不预设方向。',
    overrides: { networkOpportunity: { beta: 0 } },
  },
  {
    cellKey: 'openness=fixed',
    design: 'single',
    hypothesis:
      'O 固定（openness.updateMode=fixed）：停止制度更新；跨越/网络中的 O 乘子仍在但恒定。' +
      '报告 O 与跨层流动；不预设结构方向。',
    overrides: { openness: { updateMode: 'fixed' } },
  },
  {
    cellKey: 'eta=0',
    design: 'single',
    hypothesis:
      'η=0（congestionExponent=0）：Congestion=1，其他反馈保留；' +
      '报告 TV(P) 与流动性分项；不预设方向。',
    overrides: { dynamics: { congestionExponent: 0 } },
  },
  {
    cellKey: 'kappa=0',
    design: 'single',
    hypothesis:
      'κ=0（polarizationExponent=0）：Polarization=1，其他反馈保留；' +
      '报告 TV(P) 与 G/M 分项；不预设方向。',
    overrides: { dynamics: { polarizationExponent: 0 } },
  },
  {
    cellKey: 'psi=1',
    design: 'single',
    hypothesis:
      'ψ=1（needMultiplier=[1,1,1,1,1]）：移除阶级持有成本；' +
      '07 §11 预测顶层塌缩显著增强（P4 下降），同时报告 TV(P) 与 G/M 分项。',
    overrides: { need: { needMultiplier: [1, 1, 1, 1, 1] } },
  },
];

export function buildP6AblationCells(): readonly PreregCell[] {
  const base = buildBaseConfig(P6_ABLATION_POPULATION, P6_ABLATION_TICKS);
  const cells = ABLATION_DEFINITIONS.map((definition) => {
    const config = buildCellConfig(
      { cellKey: definition.cellKey, overrides: definition.overrides },
      P6_ABLATION_POPULATION,
      P6_ABLATION_TICKS,
    );
    const changedPaths = diffConfigPaths(base, config);
    assertCellDesign(definition.cellKey, definition.design, changedPaths);
    return {
      ...definition,
      changedPaths,
      fullConfigHash: computeConfigHash(config),
    };
  });
  const seen = new Map<string, string>();
  for (const cell of cells) {
    const duplicate = seen.get(cell.fullConfigHash);
    if (duplicate !== undefined) {
      throw new Error(
        `cell ${cell.cellKey} 与 ${duplicate} 的完整配置相同（fullConfigHash=${cell.fullConfigHash}），重复格点无信息量`,
      );
    }
    seen.set(cell.fullConfigHash, cell.cellKey);
  }
  return cells;
}

export function buildP6AblationManifest(): PreregManifest {
  return {
    schemaVersion: 'experiment-v2',
    hypothesis:
      'P6-04 五消融：β=0、O 固定、η=0、κ=0、ψ=1 分别移除一个反馈机制，' +
      '以 30 个新配对种子与 baseline 比较 200 人 × 730 tick 的 w1 结构。' +
      '只有消融后结构显著退化（TV(P)≥0.10、CI 不跨 0、100% 超出 baseline D95）' +
      '才可说该机制在本实验范围内有解释力；ψ=1 另检验 07 §11 的 P4 下降方向。' +
      '结果仅 exploratory，不构成现实因果、确认或校准（07 §11、AGENTS #9）。' +
      '预算 P6_ABLATION_BUDGET 为 D-04 重冻结（6 cell × 30 seed = 180 run），进哈希。',
    primaryMetric: 'TV(P)',
    experimentType: 'rule_sensitivity',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    promptVersion: PREREG_PROMPT_VERSION,
    promptStyle: PREREG_PROMPT_STYLE,
    populationSize: P6_ABLATION_POPULATION,
    totalTicks: P6_ABLATION_TICKS,
    baseConfigHash: computeConfigHash(buildBaseConfig(P6_ABLATION_POPULATION, P6_ABLATION_TICKS)),
    artifactProfile: 'metrics-only',
    seeds: P6_ABLATION_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    warmupTicks: P6_ABLATION_WARMUP,
    warmupDiagnostic:
      'P6-04 消融：warmup=365 后的 [365,729] 单窗口日均值；w1 完整窗口超出 730 tick 视野，观测段覆盖是预注册取舍',
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
        'P6-04 为消融实验，不执行聚类判定；聚类块按 07 §3 权威字段清单保留并进哈希，口径与 D-03 冻结一致',
    },
    differenceThresholds: {
      gini: 0.03,
      tv: 0.1,
      mUp: 0.05,
      segregation: 0.05,
      openness: 0.05,
    },
    budgets: { ...P6_ABLATION_BUDGET },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
    cells: buildP6AblationCells(),
  };
}

export function computeP6AblationHash(): string {
  return computePreregistrationHash(buildP6AblationManifest());
}

// ---------------------------------------------------------------------------
// 纯分析层：class-share / 分项差异与预注册方向判定。
// ---------------------------------------------------------------------------

export interface AblationWindowPair {
  readonly baseline: P6WindowMetrics;
  readonly candidate: P6WindowMetrics;
}

export interface AblationExtras {
  readonly cellKey: string;
  readonly pairs: number;
  readonly classShareDeltaMedians: readonly number[];
  readonly giniDelta: number | null;
  readonly mUpDelta: number | null;
  readonly mDownDelta: number | null;
  readonly segregationDelta: number | null;
  readonly opennessDelta: number | null;
  readonly prediction: P6AblationPrediction;
  readonly predictionMetricDelta: number | null;
  readonly predictionAgree: number | null;
  readonly predictionHolds: boolean | null;
}

function deltaMedian(values: readonly number[]): number | null {
  return values.length === 0 ? null : median(values);
}

/** 消融相对 baseline 的 class-share 与分项中位差；预测方向只在预注册时才判定。 */
export function summarizeAblationExtras(
  cellKey: string,
  pairs: readonly AblationWindowPair[],
): AblationExtras {
  const prediction = P6_ABLATION_PREDICTIONS[cellKey] ?? {
    metric: 'none',
    direction: 'none',
    note: '未登记预测',
  };
  const classCount = pairs[0]?.baseline.classShares.length ?? 0;
  const classShareDeltaMedians = Array.from({ length: classCount }, (_, classIndex) =>
    deltaMedian(
      pairs.map(
        (pair) =>
          (pair.candidate.classShares[classIndex] ?? 0) -
          (pair.baseline.classShares[classIndex] ?? 0),
      ),
    ),
  ).map((value) => value ?? 0);
  const diffs = pairs.map((pair) => pairedDiff(pair.candidate, pair.baseline));
  const giniDelta = deltaMedian(diffs.map((diff) => diff.gini));
  const mUpDelta = deltaMedian(diffs.map((diff) => diff.mUp));
  const mDownDelta = deltaMedian(diffs.map((diff) => diff.mDown));
  const segregationDelta = deltaMedian(
    diffs.map((diff) => diff.segregation).filter((value): value is number => value !== null),
  );
  const opennessDelta = deltaMedian(diffs.map((diff) => diff.openness));

  let predictionMetricDelta: number | null = null;
  let predictionAgree: number | null = null;
  if (prediction.metric === 'classShare4') {
    const values = pairs.map(
      (pair) => (pair.candidate.classShares[4] ?? 0) - (pair.baseline.classShares[4] ?? 0),
    );
    predictionMetricDelta = deltaMedian(values);
    predictionAgree =
      values.length === 0
        ? null
        : values.filter((value) => (prediction.direction === 'decrease' ? value < 0 : value > 0))
            .length / values.length;
  }
  const predictionHolds =
    prediction.metric === 'none' || predictionMetricDelta === null || predictionAgree === null
      ? null
      : prediction.direction === 'decrease'
        ? predictionMetricDelta < 0 && predictionAgree >= 0.9
        : predictionMetricDelta > 0 && predictionAgree >= 0.9;

  return {
    cellKey,
    pairs: pairs.length,
    classShareDeltaMedians,
    giniDelta,
    mUpDelta,
    mDownDelta,
    segregationDelta,
    opennessDelta,
    prediction,
    predictionMetricDelta,
    predictionAgree,
    predictionHolds,
  };
}
