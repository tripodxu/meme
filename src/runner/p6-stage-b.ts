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
  computePreregistrationHash,
  PREREG_PROMPT_STYLE,
  PREREG_PROMPT_VERSION,
  type PreregCell,
  type PreregManifest,
} from './preregistration.js';
import { diffConfigPaths } from '../core/config/diff.js';

/**
 * P6-01 Stage B：1000 人 × 3650 tick 确认轮（01 §9、07 §3/§8；changes/0039）。
 *
 * - 每个入选 cell 一个 manifest（baseline + candidate × 30 确认种子 = 60 run，
 *   恰为 D-04 v1 Stage B `maxRuns=60`；换 cell 或换种子 = 新 experimentId）；
 * - **确认种子集独立**（D-07 纪律外推）：`p6-stageB-seed-001…030` 与 Stage A
 *   `p6-stageA-seed-*` 及 p15 各轮不重叠——Stage A 择优不得沿用同一批种子确认；
 * - 窗口回 P1.5 冻结口径：warmup 1825 + w2b/w3 完整窗口（Stage A 的 730 tick
 *   筛查取舍在确认轮不适用）；statsStride=1（07 §8 Stage B 确认要求）；
 * - 预算 = D-04 v1 Stage B（60 run / 240 min / 512 MB）进哈希；
 * - 判读（07 §8「结构显著改变」）在脚本层：主指标门槛 + 配对差 95% 区间不跨 0
 *   + 方向一致率 ≥90% + 超出同 manifest baseline 波动带 + 非伪影（0 灭绝/0 回退）。
 */

export const P6_STAGE_B_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p6-stageB-seed-${String(index + 1).padStart(3, '0')}`,
);

export const P6_STAGE_B_TICKS = 3650 as const;
export const P6_STAGE_B_WARMUP = 1825 as const;
/**
 * D-04 v2 Stage B 冻结预算（changes/0039）：v1 的 240 min 基于 statsStride=10 基准估计，
 * 实测 statsStride=1（07 §8 Stage B 强制）单 run ≈ 280 s（基准偏差 +130% > 50%，
 * 触发 §4 重冻结）；60 run ≈ 280 min → 480 min（≈1.7× 余量）。
 */
export const P6_STAGE_B_BUDGET = {
  maxRuns: 60,
  maxWallMinutes: 480,
  maxStorageBytes: 512 * 1024 * 1024,
} as const;

export const P6_STAGE_B_POPULATION = 1000 as const;

/** Stage A 筛选后的候选 cell（changes/0038；与 Stage A 的 overrides 逐字一致）。 */
export const P6_STAGE_B_CANDIDATES: readonly {
  readonly cellKey: string;
  readonly overrides: Record<string, unknown>;
  readonly stageAEvidence: string;
}[] = [
  {
    cellKey: 'env0=expanded',
    overrides: { opportunity: { env0: [1, 2, 3.5, 5, 7] } },
    stageAEvidence: '两人口入选；40人 d>band 0.57、200人 0.97；ΔMup −0.36/−0.38、ΔO −0.33/−0.38',
  },
  {
    cellKey: 'env0=compressed',
    overrides: { opportunity: { env0: [1, 1.2, 1.5, 1.9, 2.4] } },
    stageAEvidence: '两人口入选；40人 d>band 0.10、200人 0.50；ΔMup +0.15/+0.21、ΔO +0.11/+0.22',
  },
  {
    cellKey: 'crossDays=half',
    overrides: { ascent: { crossDays: [15, 20, 25, 30] } },
    stageAEvidence: '两人口入选（Mup 通道 +0.080/+0.114）',
  },
  {
    cellKey: 'crossDays=double',
    overrides: { ascent: { crossDays: [60, 80, 100, 120] } },
    stageAEvidence: '两人口入选（Mup 通道 −0.187/−0.257；200人 d>band 0.37）',
  },
  {
    cellKey: 'psi=1',
    overrides: { need: { needMultiplier: [1, 1, 1, 1, 1] } },
    stageAEvidence: '两人口入选（Mup +0.107/+0.139）；兼为 P6-04 消融先验',
  },
  {
    cellKey: 'needThreshold=0.9',
    overrides: { need: { threshold: 0.9 } },
    stageAEvidence: '仅 200 人口入选（TV 0.180/0.168 均超门槛；40人口方向不稳）——Stage B 裁决',
  },
];

export function isP6StageBCandidate(cellKey: string): boolean {
  return P6_STAGE_B_CANDIDATES.some((candidate) => candidate.cellKey === cellKey);
}

/**
 * 构建一个候选 cell 的 Stage B 确认 manifest（baseline + candidate）。
 * 注意：cell 的 overrides 与 Stage A 逐字一致——确认的是 Stage A 观察到的同一声明变量。
 */
export function buildP6StageBManifest(candidateCellKey: string): PreregManifest {
  const candidate = P6_STAGE_B_CANDIDATES.find((entry) => entry.cellKey === candidateCellKey);
  if (candidate === undefined) {
    throw new TypeError(
      `未知 Stage B 候选 cell：${candidateCellKey}（候选：${P6_STAGE_B_CANDIDATES.map((entry) => entry.cellKey).join(', ')}）`,
    );
  }
  const base = buildBaseConfig(P6_STAGE_B_POPULATION, P6_STAGE_B_TICKS);
  const definitions: Omit<PreregCell, 'changedPaths' | 'fullConfigHash'>[] = [
    {
      cellKey: 'baseline',
      design: 'baseline',
      hypothesis: 'baseline（rules-v11 默认参数，1000 人 × 3650 tick）：确认轮对照与波动带',
      overrides: {},
    },
    {
      cellKey: candidate.cellKey,
      design: 'single',
      hypothesis: `Stage B 确认：${candidate.cellKey}（Stage A 证据：${candidate.stageAEvidence}）`,
      overrides: candidate.overrides,
    },
  ];
  const cells = definitions.map((definition) => {
    const config = buildCellConfig(definition, P6_STAGE_B_POPULATION, P6_STAGE_B_TICKS);
    const changedPaths = diffConfigPaths(base, config);
    assertCellDesign(definition.cellKey, definition.design, changedPaths);
    return { ...definition, changedPaths, fullConfigHash: computeConfigHash(config) };
  });

  return {
    schemaVersion: 'experiment-v2',
    hypothesis:
      `P6-01 Stage B 确认：${candidate.cellKey} 在 1000 人 × 3650 tick（独立确认种子 p6-stageB-seed-001…030）` +
      '下复现 Stage A 的方向与效应量：主指标 TV(P) 配对中位数 ≥ 0.10 或其他预注册指标超门槛，' +
      '配对差 95% 区间不跨 0，方向一致率 ≥ 0.90，且超出同 manifest baseline 两两 D 95 分位波动带，' +
      '0 灭绝/0 回退（非伪影）。满足全部条件 = 确认入选；否则记录「Stage A 效应未在 1000 人复现」。',
    primaryMetric: 'TV(P)',
    experimentType: 'rule_sensitivity',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    promptVersion: PREREG_PROMPT_VERSION,
    promptStyle: PREREG_PROMPT_STYLE,
    populationSize: P6_STAGE_B_POPULATION,
    totalTicks: P6_STAGE_B_TICKS,
    baseConfigHash: computeConfigHash(base),
    artifactProfile: 'metrics-only',
    seeds: P6_STAGE_B_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    warmupTicks: P6_STAGE_B_WARMUP,
    warmupDiagnostic:
      'attractor stability: same-run w2/w3 feature points fall in the same cluster (limit-cycle system)',
    windows: [
      { label: 'w2b', start: 1825, end: 2554 },
      { label: 'w3', start: 2555, end: 3284 },
    ],
    labelThresholdVersion: LABEL_THRESHOLDS_VERSION,
    labelThresholdsHash: computeLabelThresholdsHash(),
    clustering: {
      distance: 'euclidean',
      algorithm: 'ward-lw-v1',
      standardization: 'z-score(pooled)',
      featureWindows: ['w2b', 'w3'],
      kRange: [2, 5],
      stabilityMinAri: 0.7,
      stabilityShuffles: 20,
      minClusterRuns: 5,
      temporalConsistencyMinRate: 0.8,
      d03Note:
        'Stage B 为效应确认，不执行聚类判定；聚类块按 07 §3 权威字段清单保留并进哈希，口径与 D-03 冻结一致',
    },
    differenceThresholds: {
      gini: 0.03,
      tv: 0.1,
      mUp: 0.05,
      segregation: 0.05,
      openness: 0.05,
    },
    budgets: { ...P6_STAGE_B_BUDGET },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
    cells,
  };
}

export function computeP6StageBHash(candidateCellKey: string): string {
  return computePreregistrationHash(buildP6StageBManifest(candidateCellKey));
}
