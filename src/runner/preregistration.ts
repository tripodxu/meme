import { hashValue } from '../core/hash/hash.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import type { RunConfig } from '../core/config/types.js';
import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../core/config/defaults.js';
import { computeConfigHash } from '../core/config/hash.js';
import { diffConfigPaths } from '../core/config/diff.js';
import { validateRunConfig } from '../core/config/validate.js';
import {
  RULES_VERSION,
  ENGINE_VERSION,
  DECISION_SCHEMA_VERSION,
} from '../core/control/versions.js';
import { LABEL_THRESHOLDS_VERSION, computeLabelThresholdsHash } from '../core/labels/thresholds.js';
import type { WindowLabel } from './window-stats.js';

/**
 * P1.5-04 预注册 manifest（01 §4.5 / 07 §3）。
 *
 * 冻结后才允许正式网格运行；`preregistrationHash` 覆盖假设、primary metric、
 * 网格、种子、窗口、标签阈值与聚类协议，排除 experimentId/createdAt/运行后字段。
 * 预算数字（budgets）为 P1.5 本机预研的护栏上限，不是 D-04 的 P6 正式预算。
 */

/**
 * P1.5 全部 cell 使用 `mock-weighted-v1`，不消费任何 prompt。
 * 该常量显式表达「无 prompt」，而不是留空或伪造一个 prompt 版本；
 * 接入 Jev live 对照时必须替换为真实 prompt 版本并重新预注册。
 */
export const PREREG_PROMPT_VERSION = 'prompt-none-v1' as const;
export const PREREG_PROMPT_STYLE = 'neutral' as const;

/**
 * cell 的设计类型（07 §6.2 vs §6.3）：
 * - `baseline`：零覆盖，作为对照基准；
 * - `single`：恰好改变一个叶子参数，其效应可**单轴归因**（§6.2「每次只变一项」）；
 * - `interaction`：同时改变 ≥2 个叶子参数，只回答「联合条件是否可达某结构」，
 *   其效应**不得**归因到单个轴（§6.3 小型 factorial）。
 *
 * 该字段存在的唯一理由：预注册网格里同时含单轴格点与交互格点，
 * 若不带标注，下游会把双变量 cell 当成单轴因果证据。标注后
 * `changedPaths` 由代码从 base/cell 实际差异派生，二者数量必须自洽。
 */
export type PreregCellDesign = 'baseline' | 'single' | 'interaction';

export interface PreregCell {
  readonly cellKey: string;
  readonly design: PreregCellDesign;
  /** `overrides` 实际生效的叶子点路径（相对 base），由代码派生并进预注册哈希。 */
  readonly changedPaths: readonly string[];
  readonly hypothesis: string;
  readonly overrides: DeepPartialConfig;
  /** 合并后完整配置的 `configHash`（07 §3：cells[].fullConfigHash，进预注册哈希）。 */
  readonly fullConfigHash: string;
}

/** 设计类型与差异路径数量的自洽校验（07 §6.2/§6.3）。 */
function assertCellDesign(
  cellKey: string,
  design: PreregCellDesign,
  changedPaths: readonly string[],
): void {
  const expectedEmpty = design === 'baseline';
  const expectedSingle = design === 'single';
  if (expectedEmpty && changedPaths.length !== 0) {
    throw new Error(`cell ${cellKey}: baseline 不得有任何覆盖，实际 ${changedPaths.length} 项`);
  }
  if (expectedSingle && changedPaths.length !== 1) {
    throw new Error(
      `cell ${cellKey}: single 设计必须恰好改变 1 个参数，实际 ${changedPaths.length} 项 ` +
        `(${changedPaths.join(', ')})；同时改变多项须标 design='interaction'`,
    );
  }
  if (design === 'interaction' && changedPaths.length < 2) {
    throw new Error(
      `cell ${cellKey}: interaction 设计必须改变 >=2 个参数，实际 ${changedPaths.length} 项`,
    );
  }
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
  /** mock 策略不消费 prompt；字段存在于预注册哈希覆盖清单（07 §3）。 */
  readonly promptVersion: typeof PREREG_PROMPT_VERSION;
  readonly promptStyle: typeof PREREG_PROMPT_STYLE;
  readonly populationSize: number;
  readonly totalTicks: number;
  /** base config（未加 cell overrides）的 `configHash`；进预注册哈希（07 §3）。 */
  readonly baseConfigHash: string;
  /** `full|metrics-only`；P1.5 保存逐 run 窗口指标与状态哈希，取 full。 */
  readonly artifactProfile: 'full' | 'metrics-only';
  readonly seeds: readonly string[];
  readonly pairing: 'same-seed-derived-initial-population-and-addressed-random';
  readonly warmupTicks: 1825;
  readonly warmupDiagnostic:
    | '90-day rolling mean change < threshold on P/G/O'
    | 'attractor stability: same-run w2/w3 feature points fall in the same cluster (limit-cycle system)';
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
    /**
     * 聚类特征窗口（07 §8.1 特征向量来源）：每个 run 在这些窗口各贡献一个特征点，
     * 全部特征点在同一 z-score 空间聚类。v5 轮 2（07 §5）要求 w2b 与 w3 同时入簇，
     * 以便直接检验「同一 run 的 w2b/w3 落入同一簇」。
     */
    readonly featureWindows: readonly WindowLabel[];
    readonly kRange: readonly [2, 5];
    readonly stabilityMinAri: 0.7;
    readonly minClusterRuns: number;
    /** 吸引子稳定性门槛：同 run 的 w2b/w3 特征点落同簇的最低比例（07 §5 v5 修订）。 */
    readonly temporalConsistencyMinRate: number;
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
  /** 预注册排除规则（07 §3：与假设同时冻结，运行后不得按结果调整）。 */
  readonly exclusionRules: {
    /** 全死亡 / 末 tick 全死亡的 run 不计入结构判定（07 §5）。 */
    readonly excludeExtinctRuns: boolean;
    /** `missingTicks>0` 的窗口不参与结构判异与聚类（07 §5）。 */
    readonly excludeUnavailableWindows: boolean;
    /** `networkEmpty` 窗口不参与依赖 S 的标签与 O 反馈诊断（07 §5）。 */
    readonly excludeNetworkEmptyFromSegregation: boolean;
    /** 技术失败可重跑，但必须保留失败原因与次数（07 §3）。 */
    readonly maxTechnicalRetries: number;
  };
  readonly cells: readonly PreregCell[];
}

/** P1.5 预注册的 30 个配对种子（冻结列表）。 */
export const PREREG_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p15-seed-${String(index + 1).padStart(3, '0')}`,
);

/**
 * P1.5 参数网格：覆盖主导阶级分布参数与全部五个消融（07 §6.2/§11）。
 *
 * `fullConfigHash` 在此按 (populationSize, totalTicks) 合并后计算，
 * 使预注册哈希覆盖每个 cell 的完整配置（07 §3）。
 */
export function buildPreregCells(
  populationSize: number,
  totalTicks: number,
): readonly PreregCell[] {
  const definitions: Omit<PreregCell, 'fullConfigHash' | 'changedPaths'>[] = [
    {
      cellKey: 'baseline',
      design: 'baseline',
      hypothesis: '默认参数下的基准结构',
      overrides: {},
    },
    {
      cellKey: 'needMultiplier=flat',
      design: 'single',
      hypothesis: '扁平持有成本削弱阶级分离',
      overrides: { need: { needMultiplier: [1, 1.5, 1.5, 1.5, 1.5] } },
    },
    {
      cellKey: 'needMultiplier=steeper',
      design: 'single',
      hypothesis: '更陡持有成本强化分层',
      overrides: { need: { needMultiplier: [1, 1.4, 2.1, 3.0, 4.2] } },
    },
    {
      cellKey: 'needThreshold=0.3',
      design: 'single',
      hypothesis: '宽松需求线减少被动跌落',
      overrides: { need: { threshold: 0.3 } },
    },
    {
      cellKey: 'needThreshold=0.9',
      design: 'single',
      hypothesis: '严格需求线加剧跌落',
      overrides: { need: { threshold: 0.9 } },
    },
    {
      cellKey: 'env0=compressed',
      design: 'single',
      hypothesis: '压缩阶级机会差削弱分层',
      overrides: { opportunity: { env0: [1, 1.2, 1.5, 1.9, 2.4] } },
    },
    {
      cellKey: 'env0=expanded',
      design: 'single',
      hypothesis: '扩大阶级机会差强化分层',
      overrides: { opportunity: { env0: [1, 2, 3.5, 5, 7] } },
    },
    {
      cellKey: 'ablation:beta=0',
      design: 'single',
      hypothesis: '无网络机会（消融 β=0）',
      overrides: { networkOpportunity: { beta: 0 } },
    },
    {
      cellKey: 'ablation:O=fixed',
      design: 'single',
      hypothesis: '无制度反馈（O 固定，P1-10 开关）',
      overrides: { openness: { updateMode: 'fixed' } },
    },
    {
      cellKey: 'ablation:eta=0',
      design: 'single',
      hypothesis: '无阶级拥挤（消融 η=0）',
      overrides: { dynamics: { congestionExponent: 0 } },
    },
    {
      cellKey: 'ablation:kappa=0',
      design: 'single',
      hypothesis: '无贫富分化反馈（消融 κ=0）',
      overrides: { dynamics: { polarizationExponent: 0 } },
    },
    {
      cellKey: 'ablation:psi=1',
      design: 'single',
      hypothesis: '无阶级持有成本（消融 ψ=1，预期顶层塌缩）',
      overrides: { need: { needMultiplier: [1, 1, 1, 1, 1] } },
    },
    {
      cellKey: 'initialShares=bottom-heavy',
      design: 'single',
      hypothesis: '底层更重的初始分布',
      overrides: { population: { classShares: [0.6, 0.25, 0.1, 0.04, 0.01] } },
    },
    {
      cellKey: 'initialShares=middle-heavy',
      design: 'single',
      hypothesis: '中层更重的初始分布',
      overrides: { population: { classShares: [0.2, 0.3, 0.3, 0.15, 0.05] } },
    },
    {
      cellKey: 'lambdaO=0',
      design: 'single',
      hypothesis: '开放度不影响跨越成本',
      overrides: { openness: { ascentCostWeight: 0 } },
    },
    {
      cellKey: 'rewireProb=0.2',
      design: 'single',
      hypothesis: '更高网络流动',
      overrides: { network: { rewireProb: 0.2 } },
    },
    // v4 新增：φ 扫描与 θM 对照（changes/0004 的效果分离归因）
    {
      cellKey: 'v4:envExponent=0',
      design: 'single',
      hypothesis: 'φ=0 退回 v3 语义（消融对照，预期仍为顶层旋转门）',
      overrides: { need: { envExponent: 0 } },
    },
    {
      cellKey: 'v4:envExponent=0.5',
      design: 'single',
      hypothesis: '弱环境持有成本',
      overrides: { need: { envExponent: 0.5 } },
    },
    {
      cellKey: 'v4:envExponent=1.5',
      design: 'single',
      hypothesis: '强环境持有成本',
      overrides: { need: { envExponent: 1.5 } },
    },
    {
      cellKey: 'v4:thetaM=8',
      design: 'single',
      hypothesis: 'v3 值 θM=8 对照（预期 O 钉在高位）',
      overrides: { openness: { mobilityWeight: 8 } },
    },
    // v4 第二轮：中位生产力平衡轴（rule.md 45 双路径的机制旋钮）
    {
      cellKey: 'v4:geMedian=0.8',
      design: 'single',
      hypothesis: '中位生产力轻度低于持有标准（G 上升、O 下降）',
      overrides: { attributes: { ge: { median: 0.8 } } },
    },
    {
      cellKey: 'v4:geMedian=0.7',
      design: 'single',
      hypothesis: '中位生产力进一步下降（中间层重心、高 G）',
      overrides: { attributes: { ge: { median: 0.7 } } },
    },
    {
      cellKey: 'v4:geMedian=0.6',
      design: 'single',
      hypothesis: '强生产力约束（橄榄型倾向、O 低位）',
      overrides: { attributes: { ge: { median: 0.6 } } },
    },
    {
      cellKey: 'v4:envExponent=2',
      design: 'single',
      hypothesis: '极强环境持有成本（顶部快速流失）',
      overrides: { need: { envExponent: 2 } },
    },
    // v5 新增：持有裕度轴（changes/0005，D-05 方向 B）
    {
      cellKey: 'v5:cushionDays=0',
      design: 'single',
      hypothesis: 'ρ=0 退回 v4 语义（消融对照）',
      overrides: { ascent: { holdingCushionDays: 0 } },
    },
    {
      cellKey: 'v5:cushionDays=90',
      design: 'single',
      hypothesis: '强裕度封锁顶部（预期 c3 重心或封闭结构）',
      overrides: { ascent: { holdingCushionDays: 90 } },
    },
    {
      cellKey: 'v5:cushionDays=90+phi=0',
      design: 'interaction',
      hypothesis: '强裕度×v3 需求（预期富人俱乐部顶层）；双变量联合条件，不得单轴归因',
      overrides: { ascent: { holdingCushionDays: 90 }, need: { envExponent: 0 } },
    },
    {
      cellKey: 'v5:cushionDays=90+geMedian=0.7',
      design: 'interaction',
      hypothesis: '裕度×生产力双约束（预期封闭分层可达）；双变量联合条件，不得单轴归因',
      overrides: { ascent: { holdingCushionDays: 90 }, attributes: { ge: { median: 0.7 } } },
    },
  ];
  const base = buildBaseConfig(populationSize, totalTicks);
  const cells = definitions.map((definition) => {
    const config = buildCellConfig(definition, populationSize, totalTicks);
    const changedPaths = diffConfigPaths(base, config);
    assertCellDesign(definition.cellKey, definition.design, changedPaths);
    return { ...definition, changedPaths, fullConfigHash: computeConfigHash(config) };
  });
  // 07 §3：同一网格内不应存在配置完全相同的两个 cell——那只是白耗预算的重复格点。
  const seen = new Map<string, string>();
  for (const cell of cells) {
    const duplicate = seen.get(cell.fullConfigHash);
    if (duplicate !== undefined) {
      throw new Error(
        `cell ${cell.cellKey} 与 ${duplicate} 的完整配置相同（fullConfigHash=${cell.fullConfigHash}），` +
          '重复格点无信息量，须改参数或删除',
      );
    }
    seen.set(cell.fullConfigHash, cell.cellKey);
  }
  return cells;
}

/** base config：默认配置 + 预注册人口与调度（不含任何 cell overrides）。 */
export function buildBaseConfig(populationSize: number, totalTicks: number): RunConfig {
  const merged = mergeConfig(DEFAULT_RUN_CONFIG, {
    population: { initialPopulation: populationSize },
    schedule: { totalTicks, statsStride: 1, snapshotStride: 1000 },
  } as DeepPartialConfig);
  const result = validateRunConfig(merged);
  if (!result.ok) {
    throw new Error(`base config 非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/** 由预注册 cell 构造完整 RunConfig（深合并 + 校验；失败拒绝该 cell）。 */
export function buildCellConfig(
  cell: Pick<PreregCell, 'cellKey' | 'overrides'>,
  populationSize: number,
  totalTicks: number,
): RunConfig {
  const base = buildBaseConfig(populationSize, totalTicks);
  const merged = mergeConfig(base, {
    ...cell.overrides,
    // 人口规模与调度由 manifest 统一决定，cell 不得借覆盖各自改写。
    population: { ...cell.overrides.population, initialPopulation: populationSize },
    schedule: { totalTicks, statsStride: 1, snapshotStride: 1000 },
  } as DeepPartialConfig);
  const result = validateRunConfig(merged);
  if (!result.ok) {
    throw new Error(`cell ${cell.cellKey} 配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/**
 * 预注册哈希的**预像**（07 §3 权威字段清单）。
 *
 * 单独暴露的理由：`hashValue` 不校验字段，漏一个字段不会报错，只会让
 * 「设计变了 hash 不变」这一类缺陷静默存在（changes/0006 曾漏 6 个字段）。
 * 预像可被测试直接枚举与比较，使字段清单成为可断言契约而非注释。
 */
export function buildPreregHashInput(manifest: PreregManifest) {
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
    baseConfigHash: manifest.baseConfigHash,
    artifactProfile: manifest.artifactProfile,
    populationSize: manifest.populationSize,
    totalTicks: manifest.totalTicks,
    cells: manifest.cells.map((cell) => ({
      cellKey: cell.cellKey,
      design: cell.design,
      changedPaths: cell.changedPaths,
      overrides: cell.overrides,
      fullConfigHash: cell.fullConfigHash,
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
    exclusionRules: manifest.exclusionRules,
  } as const;
}

/**
 * `preregistrationHash`（02 §8 / 07 §3 权威口径）：覆盖假设、主指标、版本轴、
 * base config、artifact profile、每个 cell 的完整配置哈希、种子、窗口、
 * 标签阈值、聚类协议、预算与排除规则；排除运行后字段
 *（experimentId/createdAt/observedResponseModels/runtimeVersions/结果/失败次数）。
 */
export function computePreregistrationHash(manifest: PreregManifest): string {
  return hashValue(HASH_DOMAINS.preregistration, buildPreregHashInput(manifest));
}

/** P1.5 预注册 manifest（Stage A：40 人 × 3650 tick；冻结后再运行）。 */
export function buildPreregManifest(): PreregManifest {
  const populationSize = 40;
  const totalTicks = 3650;
  return {
    schemaVersion: 'experiment-v2',
    hypothesis:
      'rules-v5（持有裕度 + 需求解耦 + θM 再平衡）在预注册参数网格内能产生 >=2 类可复现（ARI>=0.70）且非退化（非全死亡/空网络/未归类）的结构指纹聚类；均值场预测与仿真方向一致。',
    primaryMetric: 'TV(P)',
    experimentType: 'rule_sensitivity',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    promptVersion: PREREG_PROMPT_VERSION,
    promptStyle: PREREG_PROMPT_STYLE,
    populationSize,
    totalTicks,
    baseConfigHash: computeConfigHash(buildBaseConfig(populationSize, totalTicks)),
    artifactProfile: 'full',
    seeds: PREREG_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    // v5 轮 2：w1 非平稳（90 日块 TV(P) 0.03-0.23 持续振荡，极限环）→ burn-in 延长至 1825，
    // 诊断改为吸引子稳定性（07 §5 「不平稳则延长 burn-in 并重新预注册」）。
    warmupTicks: 1825,
    warmupDiagnostic:
      'attractor stability: same-run w2/w3 feature points fall in the same cluster (limit-cycle system)',
    windows: [
      { label: 'w2b', start: 1825, end: 2554 },
      { label: 'w3', start: 2555, end: 3284 },
    ],
    labelThresholdVersion: LABEL_THRESHOLDS_VERSION,
    labelThresholdsHash: computeLabelThresholdsHash(),
    clustering: {
      algorithm: 'ward+euclidean',
      standardization: 'z-score(pooled)',
      // 每个 run 在 w2b（主分析窗）与 w3（紧邻后续窗）各贡献一个特征点，
      // 全部特征点在同一 z-score 空间聚类——这是 07 §5「同一 run 的 w2b/w3
      // 特征点应落入同一簇」的唯一可判定实现，不再用质心投影近似。
      featureWindows: ['w2b', 'w3'],
      kRange: [2, 5],
      stabilityMinAri: 0.7,
      minClusterRuns: 5,
      temporalConsistencyMinRate: 0.8,
      d03Note:
        'Ward+Euclidean 为 07 §8.1 文档默认建议；待议 D-03 未关闭，不得声称已获科学负责人确认。',
    },
    differenceThresholds: { gini: 0.03, tv: 0.1, mUp: 0.05, segregation: 0.05, openness: 0.05 },
    // 本机预研护栏（07 §3：budgets 示例为占位值；D-04 的正式 P6 预算另行冻结）。
    budgets: { maxRuns: 28 * 30, maxWallMinutes: 480, maxStorageBytes: 2_000_000_000 },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
    cells: buildPreregCells(populationSize, totalTicks),
  };
}
