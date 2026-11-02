import { hashValue } from '../core/hash/hash.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import type { RunConfig } from '../core/config/types.js';
import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../core/config/defaults.js';
import { validateRunConfig } from '../core/config/validate.js';
import {
  RULES_VERSION,
  ENGINE_VERSION,
  DECISION_SCHEMA_VERSION,
} from '../core/control/versions.js';
import { LABEL_THRESHOLDS_VERSION, computeLabelThresholdsHash } from '../core/labels/thresholds.js';
import { ANALYSIS_WINDOWS } from './window-stats.js';

/**
 * P1.5-04 预注册 manifest（01 §4.5 / 07 §3）。
 *
 * 冻结后才允许正式网格运行；`preregistrationHash` 覆盖假设、primary metric、
 * 网格、种子、窗口、标签阈值与聚类协议，排除 experimentId/createdAt/运行后字段。
 * 预算数字（budgets）为 P1.5 本机预研的护栏上限，不是 D-04 的 P6 正式预算。
 */

export interface PreregCell {
  readonly cellKey: string;
  readonly hypothesis: string;
  readonly overrides: DeepPartialConfig;
}

export interface PreregManifest {
  readonly schemaVersion: 'experiment-v2';
  readonly hypothesis: string;
  readonly primaryMetric: 'TV(P)' | 'G' | 'Mup' | 'Mdown' | 'S' | 'O';
  readonly experimentType: 'rule_sensitivity';
  readonly rulesVersion: typeof RULES_VERSION;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly decisionSchemaVersion: typeof DECISION_SCHEMA_VERSION;
  readonly policyVersion: 'mock-weighted-v1';
  readonly populationSize: number;
  readonly totalTicks: number;
  readonly seeds: readonly string[];
  readonly pairing: 'same-seed-derived-initial-population-and-addressed-random';
  readonly warmupTicks: 365;
  readonly warmupDiagnostic: '90-day rolling mean change < threshold on P/G/O';
  readonly windows: readonly {
    readonly label: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly labelThresholdVersion: typeof LABEL_THRESHOLDS_VERSION;
  readonly labelThresholdsHash: string;
  readonly clustering: {
    readonly algorithm: 'ward+euclidean';
    readonly standardization: 'z-score(pooled)';
    readonly kRange: readonly [2, 5];
    readonly stabilityMinAri: 0.7;
    readonly minClusterRuns: number;
    /** D-03 未关闭：以下为文档默认建议，非已确认的科学口径。 */
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
  readonly cells: readonly PreregCell[];
}

/** P1.5 预注册的 30 个配对种子（冻结列表）。 */
export const PREREG_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p15-seed-${String(index + 1).padStart(3, '0')}`,
);

/** P1.5 参数网格：覆盖主导阶级分布参数与全部五个消融（07 §6.2/§11）。 */
export function buildPreregCells(): readonly PreregCell[] {
  const cells: PreregCell[] = [
    { cellKey: 'baseline', hypothesis: '默认参数下的基准结构', overrides: {} },
    {
      cellKey: 'needMultiplier=flat',
      hypothesis: '扁平持有成本削弱阶级分离',
      overrides: { need: { needMultiplier: [1, 1.5, 1.5, 1.5, 1.5] } },
    },
    {
      cellKey: 'needMultiplier=steeper',
      hypothesis: '更陡持有成本强化分层',
      overrides: { need: { needMultiplier: [1, 1.4, 2.1, 3.0, 4.2] } },
    },
    {
      cellKey: 'needThreshold=0.3',
      hypothesis: '宽松需求线减少被动跌落',
      overrides: { need: { threshold: 0.3 } },
    },
    {
      cellKey: 'needThreshold=0.9',
      hypothesis: '严格需求线加剧跌落',
      overrides: { need: { threshold: 0.9 } },
    },
    {
      cellKey: 'env0=compressed',
      hypothesis: '压缩阶级机会差削弱分层',
      overrides: { opportunity: { env0: [1, 1.2, 1.5, 1.9, 2.4] } },
    },
    {
      cellKey: 'env0=expanded',
      hypothesis: '扩大阶级机会差强化分层',
      overrides: { opportunity: { env0: [1, 2, 3.5, 5, 7] } },
    },
    {
      cellKey: 'ablation:beta=0',
      hypothesis: '无网络机会（消融 β=0）',
      overrides: { networkOpportunity: { beta: 0 } },
    },
    {
      cellKey: 'ablation:O=fixed',
      hypothesis: '无制度反馈（O 固定，P1-10 开关）',
      overrides: { openness: { updateMode: 'fixed' } },
    },
    {
      cellKey: 'ablation:eta=0',
      hypothesis: '无阶级拥挤（消融 η=0）',
      overrides: { dynamics: { congestionExponent: 0 } },
    },
    {
      cellKey: 'ablation:kappa=0',
      hypothesis: '无贫富分化反馈（消融 κ=0）',
      overrides: { dynamics: { polarizationExponent: 0 } },
    },
    {
      cellKey: 'ablation:psi=1',
      hypothesis: '无阶级持有成本（消融 ψ=1，预期顶层塌缩）',
      overrides: { need: { needMultiplier: [1, 1, 1, 1, 1] } },
    },
    {
      cellKey: 'initialShares=bottom-heavy',
      hypothesis: '底层更重的初始分布',
      overrides: { population: { classShares: [0.6, 0.25, 0.1, 0.04, 0.01] } },
    },
    {
      cellKey: 'initialShares=middle-heavy',
      hypothesis: '中层更重的初始分布',
      overrides: { population: { classShares: [0.2, 0.3, 0.3, 0.15, 0.05] } },
    },
    {
      cellKey: 'lambdaO=0',
      hypothesis: '开放度不影响跨越成本',
      overrides: { openness: { ascentCostWeight: 0 } },
    },
    {
      cellKey: 'rewireProb=0.2',
      hypothesis: '更高网络流动',
      overrides: { network: { rewireProb: 0.2 } },
    },
    // v4 新增：φ 扫描与 θM 对照（changes/0004 的效果分离归因）
    {
      cellKey: 'v4:envExponent=0',
      hypothesis: 'φ=0 退回 v3 语义（消融对照，预期仍为顶层旋转门）',
      overrides: { need: { envExponent: 0 } },
    },
    {
      cellKey: 'v4:envExponent=0.5',
      hypothesis: '弱环境持有成本',
      overrides: { need: { envExponent: 0.5 } },
    },
    {
      cellKey: 'v4:envExponent=1.5',
      hypothesis: '强环境持有成本',
      overrides: { need: { envExponent: 1.5 } },
    },
    {
      cellKey: 'v4:thetaM=8',
      hypothesis: 'v3 值 θM=8 对照（预期 O 钉在高位）',
      overrides: { openness: { mobilityWeight: 8 } },
    },
  ];
  return cells;
}

/** 由预注册 cell 构造完整 RunConfig（深合并 + 校验；失败拒绝该 cell）。 */
export function buildCellConfig(
  cell: PreregCell,
  populationSize: number,
  totalTicks: number,
): RunConfig {
  const merged = mergeConfig(DEFAULT_RUN_CONFIG, {
    ...cell.overrides,
    population: { ...cell.overrides.population, initialPopulation: populationSize },
    schedule: { totalTicks, statsStride: 1, snapshotStride: 1000 },
  } as DeepPartialConfig);
  const result = validateRunConfig(merged);
  if (!result.ok) {
    throw new Error(`cell ${cell.cellKey} 配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/** `preregistrationHash`（02 §8）：排除运行后字段（experimentId/createdAt/observed…）。 */
export function computePreregistrationHash(manifest: PreregManifest): string {
  return hashValue(HASH_DOMAINS.preregistration, {
    schemaVersion: manifest.schemaVersion,
    hypothesis: manifest.hypothesis,
    primaryMetric: manifest.primaryMetric,
    experimentType: manifest.experimentType,
    rulesVersion: manifest.rulesVersion,
    engineVersion: manifest.engineVersion,
    decisionSchemaVersion: manifest.decisionSchemaVersion,
    policyVersion: manifest.policyVersion,
    populationSize: manifest.populationSize,
    totalTicks: manifest.totalTicks,
    cells: manifest.cells.map((cell) => ({
      cellKey: cell.cellKey,
      overrides: cell.overrides,
    })),
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
  });
}

/** P1.5 预注册 manifest（Stage A：40 人 × 3650 tick；冻结后再运行）。 */
export function buildPreregManifest(): PreregManifest {
  const windows = ANALYSIS_WINDOWS.map((w) => ({ label: w.label, start: w.start, end: w.end }));
  return {
    schemaVersion: 'experiment-v2',
    hypothesis:
      'rules-v4（持有成本解耦 + θM 再平衡）在预注册参数网格内能产生 >=2 类可复现（ARI>=0.70）且非退化（非全死亡/空网络/未归类）的结构指纹聚类；均值场预测与仿真方向一致。',
    primaryMetric: 'TV(P)',
    experimentType: 'rule_sensitivity',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    populationSize: 40,
    totalTicks: 3650,
    seeds: PREREG_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    warmupTicks: 365,
    warmupDiagnostic: '90-day rolling mean change < threshold on P/G/O',
    windows,
    labelThresholdVersion: LABEL_THRESHOLDS_VERSION,
    labelThresholdsHash: computeLabelThresholdsHash(),
    clustering: {
      algorithm: 'ward+euclidean',
      standardization: 'z-score(pooled)',
      kRange: [2, 5],
      stabilityMinAri: 0.7,
      minClusterRuns: 5,
      d03Note:
        'Ward+Euclidean 为 07 §8.1 文档默认建议；待议 D-03 未关闭，不得声称已获科学负责人确认。',
    },
    differenceThresholds: { gini: 0.03, tv: 0.1, mUp: 0.05, segregation: 0.05, openness: 0.05 },
    // 本机预研护栏（07 §3：budgets 示例为占位值；D-04 的正式 P6 预算另行冻结）。
    budgets: { maxRuns: 20 * 30, maxWallMinutes: 300, maxStorageBytes: 2_000_000_000 },
    cells: buildPreregCells(),
  };
}
