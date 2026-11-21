import { diffConfigPaths } from '../core/config/diff.js';
import { computeConfigHash } from '../core/config/hash.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../core/control/versions.js';
import { computeLabelThresholdsHash, LABEL_THRESHOLDS_VERSION } from '../core/labels/thresholds.js';
import {
  assertCellDesign,
  buildBaseConfig,
  buildCellConfig,
  buildPreregHashInput,
  computePreregistrationHash,
  PREREG_PROMPT_STYLE,
  PREREG_PROMPT_VERSION,
  type PreregCell,
  type PreregManifest,
} from './preregistration.js';

/**
 * P6-01 Stage A：单参数筛查预注册（01 §9、07 §3/§6.2/§8）。
 *
 * 设计（本文件即冻结口径，运行前不得改）：
 * - 两阶段筛查的 Stage A：40 人与 200 人两个 manifest（同种子配对跨人口），
 *   730 tick；warmup 365 tick，筛选窗口 = `w1` 的观测段 [365, 729]
 *   （730 tick 视野下 w1 只覆盖到 729，`missingTicks>0` 是已知并预注册的取舍，
 *   Stage B 1000 人 × 3650 tick 确认轮使用完整 w2b/w3 窗口）；
 * - 覆盖 07 §6.2 验收要求的五个主导参数（needMultiplier/needThreshold/env0/crossDays/decay），
 *   其余反馈轴（β/η/κ/H/λO/lossRate/rewireProb 等）为后续 Stage A 轮次，另建 experimentId；
 * - 种子集 `p6-stageA-seed-001…030`（D-07 纪律：与 p15 各轮种子不重叠）；
 * - 预算 = D-04 v1 Stage A 冻结数字（changes/0036）；
 * - Stage A 只做方向/效应量筛选，不产出结构结论；候选 = 配对中位数超阈值且
 *   方向一致率 ≥ 90% 的单元，进入 Stage B（1000 人 × 3650 tick 独立确认）。
 */

/** D-07 纪律：P6 各轮种子独立取用，与 p15 探索/确认各轮均不重叠。 */
export const P6_STAGE_A_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p6-stageA-seed-${String(index + 1).padStart(3, '0')}`,
);

export const P6_STAGE_A_TICKS = 730 as const;
export const P6_STAGE_A_WARMUP = 365 as const;
/** D-04 v1 Stage A 冻结预算（docs/research/2026-11-05-d04-p6-budget-freeze.md）。 */
export const P6_STAGE_A_BUDGET = {
  maxRuns: 1200,
  maxWallMinutes: 180,
  maxStorageBytes: 256 * 1024 * 1024,
} as const;

/** 07 §6.2 建议起点的五主导参数候选值（缺省值即 baseline，不设 cell）。 */
const P6_STAGE_A_CELL_DEFS: readonly {
  readonly cellKey: string;
  readonly hypothesis: string;
  readonly overrides: Record<string, unknown>;
}[] = [
  {
    cellKey: 'psi=1',
    hypothesis: 'needMultiplier ψ=1 消融（rule.md 56 的 ψ=1 预留对照）',
    overrides: { need: { needMultiplier: [1, 1, 1, 1, 1] } },
  },
  {
    cellKey: 'needMult=flat',
    hypothesis: 'needMultiplier 扁平 [1,1.5,1.5,1.5,1.5]：持有标尺层级差压缩',
    overrides: { need: { needMultiplier: [1, 1.5, 1.5, 1.5, 1.5] } },
  },
  {
    cellKey: 'needMult=steep',
    hypothesis: 'needMultiplier 陡峭 [1,1.2,1.6,2.2,3.0]：持有标尺层级差加大',
    overrides: { need: { needMultiplier: [1, 1.2, 1.6, 2.2, 3.0] } },
  },
  {
    cellKey: 'needMult=steeper',
    hypothesis: 'needMultiplier 更陡 [1,1.4,2.1,3.0,4.2]：持有标尺层级差最大',
    overrides: { need: { needMultiplier: [1, 1.4, 2.1, 3.0, 4.2] } },
  },
  {
    cellKey: 'needThreshold=0.3',
    hypothesis: 'need.threshold 0.3：升阶门槛下移',
    overrides: { need: { threshold: 0.3 } },
  },
  {
    cellKey: 'needThreshold=0.7',
    hypothesis: 'need.threshold 0.7：升阶门槛上移',
    overrides: { need: { threshold: 0.7 } },
  },
  {
    cellKey: 'needThreshold=0.9',
    hypothesis: 'need.threshold 0.9：升阶门槛最高档',
    overrides: { need: { threshold: 0.9 } },
  },
  {
    cellKey: 'env0=compressed',
    hypothesis: 'opportunity.env0 压缩 [1,1.2,1.5,1.9,2.4]：机会环境梯度压缩',
    overrides: { opportunity: { env0: [1, 1.2, 1.5, 1.9, 2.4] } },
  },
  {
    cellKey: 'env0=expanded',
    hypothesis: 'opportunity.env0 扩大 [1,2,3.5,5,7]：机会环境梯度扩大',
    overrides: { opportunity: { env0: [1, 2, 3.5, 5, 7] } },
  },
  {
    cellKey: 'crossDays=half',
    hypothesis: 'ascent.crossDays 减半 [15,20,25,30]：升阶所需连续天数减半',
    overrides: { ascent: { crossDays: [15, 20, 25, 30] } },
  },
  {
    cellKey: 'crossDays=double',
    hypothesis: 'ascent.crossDays 加倍 [60,80,100,120]：升阶所需连续天数加倍',
    overrides: { ascent: { crossDays: [60, 80, 100, 120] } },
  },
  {
    cellKey: 'decay=flat1',
    hypothesis: 'lifespan.decay 全 1.0：寿命折算与阶级无关',
    overrides: { lifespan: { decay: [1, 1, 1, 1, 1] } },
  },
  {
    cellKey: 'decay=steeper',
    hypothesis: 'lifespan.decay 更陡 [2.0,1.6,1.2,0.9,0.7]：上层寿命折算惩罚加大',
    overrides: { lifespan: { decay: [2.0, 1.6, 1.2, 0.9, 0.7] } },
  },
];

export const P6_STAGE_A_BASELINE_KEY = 'baseline' as const;

/**
 * 构建 Stage A 预注册 manifest（07 §3 权威字段全覆盖）。
 * `populationSize` ∈ {40, 200}（Stage A 口径）；哈希由 `computePreregistrationHash` 冻结。
 */
export function buildP6StageAManifest(populationSize: 40 | 200): PreregManifest {
  if (populationSize !== 40 && populationSize !== 200) {
    throw new TypeError('P6-01 Stage A 人口必须是 40 或 200（07 §8 Stage A 口径）');
  }
  const manifest: PreregManifest = {
    schemaVersion: 'experiment-v2',
    hypothesis:
      'rules-v11 体制下，五主导参数（needMultiplier/needThreshold/env0/crossDays/decay，07 §6.2）' +
      '的单参数扰动在 Stage A 视野（40/200 人 × 730 tick，warmup 365）产生方向可辨识、' +
      '超过 baseline 跨种子波动区间的配对效应；筛选出配对中位数超阈值且方向一致率 ≥90% 的单元' +
      '进入 Stage B（1000 人 × 3650 tick 独立种子确认）。Stage A 不产出结构结论；' +
      '筛选指标 = w1 窗口观测段 [365,729] 的日均值（730 tick 视野的预注册取舍，missingTicks>0）。' +
      '预算 = D-04 v1（changes/0036）；预算数字进哈希，换预算即新 experimentId。',
    primaryMetric: 'TV(P)',
    experimentType: 'rule_sensitivity',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    promptVersion: PREREG_PROMPT_VERSION,
    promptStyle: PREREG_PROMPT_STYLE,
    populationSize,
    totalTicks: P6_STAGE_A_TICKS,
    baseConfigHash: computeConfigHash(buildBaseConfig(populationSize, P6_STAGE_A_TICKS)),
    artifactProfile: 'metrics-only',
    seeds: P6_STAGE_A_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    warmupTicks: P6_STAGE_A_WARMUP,
    warmupDiagnostic:
      'Stage A 筛查：warmup=365 后的 [365,729] 单窗口日均值；w1 完整窗口（365–1094）超出 730 tick 视野，观测段覆盖是预注册取舍',
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
        'Stage A 为效应量筛选，不执行聚类判定；聚类块按 07 §3 权威字段清单保留并进哈希，口径与 D-03 冻结一致',
    },
    differenceThresholds: {
      gini: 0.03,
      tv: 0.1,
      mUp: 0.05,
      segregation: 0.05,
      openness: 0.05,
    },
    budgets: { ...P6_STAGE_A_BUDGET },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
    cells: buildP6StageACells(populationSize),
  };
  return manifest;
}

/** Stage A cells：baseline + 13 个 single 设计格点；changedPaths/fullConfigHash 由代码派生（07 §3）。 */
export function buildP6StageACells(populationSize: 40 | 200): readonly PreregCell[] {
  const base = buildBaseConfig(populationSize, P6_STAGE_A_TICKS);
  const definitions: readonly (
    | Omit<PreregCell, 'changedPaths' | 'fullConfigHash'>
    | {
        readonly cellKey: string;
        readonly design: 'baseline';
        readonly hypothesis: string;
        readonly overrides: Record<string, never>;
      }
  )[] = [
    {
      cellKey: P6_STAGE_A_BASELINE_KEY,
      design: 'baseline' as const,
      hypothesis: 'baseline（07 §6.2 各参数默认值）：跨种子波动区间与配对效应的对照',
      overrides: {},
    },
    ...P6_STAGE_A_CELL_DEFS.map((cell) => ({
      cellKey: cell.cellKey,
      design: 'single' as const,
      hypothesis: cell.hypothesis,
      overrides: cell.overrides,
    })),
  ];
  return definitions.map((definition) => {
    const config = buildCellConfig(definition, populationSize, P6_STAGE_A_TICKS);
    const changedPaths = diffConfigPaths(base, config);
    assertCellDesign(definition.cellKey, definition.design, changedPaths);
    return { ...definition, changedPaths, fullConfigHash: computeConfigHash(config) };
  });
}

/** Stage A 预注册哈希（冻结后写入产物；任何字段变化 = 新 experimentId）。 */
export function computeP6StageAHash(populationSize: 40 | 200): string {
  return computePreregistrationHash(buildP6StageAManifest(populationSize));
}

/** buildPreregHashInput 暴露给脚本层（避免脚本直接依赖内部字段清单）。 */
export { buildPreregHashInput };
