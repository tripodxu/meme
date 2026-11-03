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
    /** 距离度量（07 §8.1）；与 `algorithm` 分列，避免旧组合字符串掩盖实现标识。 */
    readonly distance: 'euclidean';
    /**
     * 聚类实现标识（07 §8.1 实现敏感性约束，W0-2）：实现是分析管线的一部分，
     * 更换实现＝分析管线变更＝新 `experimentId`；并列或 1 ulp 级近并列的
     * 合并取舍依赖数值路径，跨实现比较簇号没有意义。
     */
    readonly algorithm: 'ward-lw-v1';
    readonly standardization: 'z-score(pooled)';
    /**
     * 聚类特征窗口（07 §8.1 特征向量来源）：每个 run 在这些窗口各贡献一个特征点，
     * 全部特征点在同一 z-score 空间聚类。v5 轮 2（07 §5）要求 w2b 与 w3 同时入簇，
     * 以便直接检验「同一 run 的 w2b/w3 落入同一簇」。
     */
    readonly featureWindows: readonly WindowLabel[];
    readonly kRange: readonly [2, 5];
    readonly stabilityMinAri: 0.7;
    /** 半样本重聚类次数（07 §8.1 W0-3 冻结口径：判定量 = median，必报 min）。 */
    readonly stabilityShuffles: 20;
    readonly minClusterRuns: number;
    /** 吸引子稳定性门槛：同 run 的 w2b/w3 特征点落同簇的最低比例（07 §5 v5 修订）。 */
    readonly temporalConsistencyMinRate: number;
    /** D-03 已随本 manifest 冻结（关闭证据 = manifest 的 algorithm/标准化/k/稳定性参数）。 */
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

/** 探索轮预注册的 30 个配对种子（冻结列表；p15 探索层专用）。 */
export const PREREG_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p15-seed-${String(index + 1).padStart(3, '0')}`,
);

/**
 * W2 确认轮种子（D-07 已定）：`p15r3-seed-001…030`，与探索轮种子不重叠
 *（07 §6.1 探索/确认分离）。门禁 GATE_SEEDS 沿用探索轮列表，不复用本列表。
 */
export const PREREG_SEEDS_R3: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p15r3-seed-${String(index + 1).padStart(3, '0')}`,
);

/**
 * W2 确认轮参数网格（diagnosis §6 重组，约 26 cell；D-07 种子）。
 *
 * 设计纪律（07 §6.2/§6.3）：单轴 cell 效应可归因到单一参数；双轴组合标
 * `design:'interaction'`，只回答联合条件是否可达，不得单轴归因。
 * 五个轴（diagnosis §6.1–6.4）：分离面（envExponent）、参照强度（α × ψ 尺度）、
 * 持有标准（bufferDays × belowNeedLimit）、底层占位（threshold）。
 *
 * `fullConfigHash` 在此按 (populationSize, totalTicks) 合并后计算，
 * 使预注册哈希覆盖每个 cell 的完整配置（07 §3）。
 */
export function buildPreregCells(
  populationSize: number,
  totalTicks: number,
): readonly PreregCell[] {
  const base = buildBaseConfig(populationSize, totalTicks);
  const psiScale = (scale: number): readonly number[] => {
    // ψ[0]=1 是注册表结构约束；缩放 ψ[1..] 并钳制 [1,6]，保持非递减（同 p15-gates）。
    const psi = base.need.needMultiplier as readonly number[];
    return [1, ...psi.slice(1).map((value) => Math.min(6, Math.max(1, value * scale)))];
  };

  const definitions: Omit<PreregCell, 'fullConfigHash' | 'changedPaths'>[] = [
    {
      cellKey: 'baseline',
      design: 'baseline',
      hypothesis: '位移准入体制默认参数下的基准结构（预测：底重稳态金字塔）',
      overrides: {},
    },
    // 轴 1：分离面定位（diagnosis §6.1）
    ...([0, 0.3, 0.5, 0.7, 1.2, 1.5, 2] as const).map((phi) => ({
      cellKey: `envExponent=${phi}`,
      design: 'single' as const,
      hypothesis: `分离面定位：φ=${phi} 时持有标尺的环境梯度改变（1.0 为基准）`,
      overrides: { need: { envExponent: phi } },
    })),
    // 轴 2：参照强度 α（diagnosis §6.2）
    ...([0.05, 0.6] as const).map((alpha) => ({
      cellKey: `referenceSmoothing=${alpha}`,
      design: 'single' as const,
      hypothesis: `参照强度：α=${alpha} 时 refIncome 跟随速度改变（0.2 为基准）`,
      overrides: { need: { referenceSmoothing: alpha } },
    })),
    // 轴 2：ψ 尺度（diagnosis §6.2）
    ...([0.7, 1.4] as const).map((scale) => ({
      cellKey: `needMultiplier×${scale}`,
      design: 'single' as const,
      hypothesis: `ψ 尺度 ×${scale}：持有标尺整体抬升/压低（1.0 为基准）`,
      overrides: { need: { needMultiplier: psiScale(scale) } },
    })),
    // 轴 2 交互：α × ψ 尺度（联合条件，不得单轴归因）
    ...([0.05, 0.6] as const).flatMap((alpha) =>
      ([0.7, 1.4] as const).map((scale) => ({
        cellKey: `alpha=${alpha}+psi×${scale}`,
        design: 'interaction' as const,
        hypothesis: `参照强度 × ψ 尺度联合条件（α=${alpha}, ×${scale}）；双变量，不得单轴归因`,
        overrides: { need: { referenceSmoothing: alpha, needMultiplier: psiScale(scale) } },
      })),
    ),
    // 轴 3：持有标准 bufferDays × belowNeedLimit（diagnosis §6.3）
    ...([10, 60] as const).map((days) => ({
      cellKey: `bufferDays=${days}`,
      design: 'single' as const,
      hypothesis: `持有标尺天数 ${days}（30 为基准）`,
      overrides: { need: { bufferDays: days } },
    })),
    ...([7, 30] as const).map((limit) => ({
      cellKey: `belowNeedLimit=${limit}`,
      design: 'single' as const,
      hypothesis: `跌落判定时长 ${limit}（14 为基准）`,
      overrides: { need: { belowNeedLimit: limit } },
    })),
    ...([10, 60] as const).flatMap((days) =>
      ([7, 30] as const).map((limit) => ({
        cellKey: `bufferDays=${days}+limit=${limit}`,
        design: 'interaction' as const,
        hypothesis: `持有标准联合条件（bufferDays=${days}, limit=${limit}）；双变量，不得单轴归因`,
        overrides: { need: { bufferDays: days, belowNeedLimit: limit } },
      })),
    ),
    // 轴 4：底层占位（diagnosis §6.4）
    ...([0.3, 0.8] as const).map((threshold) => ({
      cellKey: `needThreshold=${threshold}`,
      design: 'single' as const,
      hypothesis: `需求线判定比例 ${threshold}（0.5 为基准）：检查 P0 是否被托住`,
      overrides: { need: { threshold: threshold } },
    })),
  ];
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

/**
 * W2 确认轮预注册 manifest（diagnosis §6；D-07 种子 p15r3-001…030；冻结后再运行）。
 *
 * 假设与均值场方向预测（预注册写死，运行后不得调整）：
 * - 位移准入体制下，网格内存在 ≥2 类可复现（20 次半样本 ARI median ≥0.70，含 k=2 硬门槛）
 *   且非退化（非全死亡/空网络/未归类）的结构指纹聚类；
 * - 均值场方向预测：位移平衡把 P0 钉在高位（全部 cell P0(w3) ≥ 0.15），
 *   分布稳态（全部 cell ‖P(w2b)−P(w3)‖₁ < 0.10）——若系统性格点违反，则方向不一致。
 */
export function buildPreregManifest(): PreregManifest {
  const populationSize = 40;
  const totalTicks = 3650;
  return {
    schemaVersion: 'experiment-v2',
    hypothesis:
      'rules-v8（位移准入）体制下，预注册参数网格内存在 >=2 类可复现（20 次半样本 ARI median>=0.70，' +
      '含 k=2 硬门槛）且非退化（非全死亡/空网络/未归类）的结构指纹聚类；均值场方向预测与仿真一致' +
      '（全 cell P0(w3)>=0.15 且 ‖P(w2b)-P(w3)‖1<0.10）。',
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
    seeds: PREREG_SEEDS_R3,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    // burn-in 与窗口沿用探索轮冻结口径（1825 + w2b/w3）；变更须重新预注册。
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
      distance: 'euclidean',
      algorithm: 'ward-lw-v1',
      standardization: 'z-score(pooled)',
      featureWindows: ['w2b', 'w3'],
      kRange: [2, 5],
      stabilityMinAri: 0.7,
      // W0-3 冻结口径：20 次半样本重聚类，判定量 = median，产物必报 min（07 §8.1）。
      stabilityShuffles: 20,
      minClusterRuns: 5,
      temporalConsistencyMinRate: 0.8,
      d03Note:
        '聚类协议按 07 §8.1 冻结：Ward(Lance–Williams, ward-lw-v1) + Euclidean、' +
        'z-score(pooled)、k∈[2,5]、稳定性 20 次取 median 且必报 min；更换实现＝新 experimentId。',
    },
    differenceThresholds: { gini: 0.03, tv: 0.1, mUp: 0.05, segregation: 0.05, openness: 0.05 },
    // 确认轮预算（07 §3：本机预研护栏；D-04 正式 P6 预算另行冻结）。
    budgets: { maxRuns: 26 * 30, maxWallMinutes: 240, maxStorageBytes: 2_000_000_000 },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
    cells: buildPreregCells(populationSize, totalTicks),
  };
}
