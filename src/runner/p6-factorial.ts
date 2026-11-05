import { diffConfigPaths } from '../core/config/diff.js';
import { computeConfigHash } from '../core/config/hash.js';
import type { DeepPartialConfig } from '../core/config/defaults.js';
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

/**
 * P6-02：多参数 factorial 探索预注册（01 §9、07 §6.3）。
 *
 * 设计（本文件即冻结口径，运行前不得改）：
 * - 5 个主导轴各取「Stage A 已扫描的高/低水平」：needThreshold=0.9、
 *   needMultiplier=flat、env0=expanded、crossDays=half、decay=steeper；
 *   低水平均为默认配置。2^5 全因子 = 32 cell（baseline + 5 single + 26 interaction）；
 * - 200 人 × 730 tick，warmup 365，w1 观测段 [365,729]；30 个**新**种子
 *   `p6-factorial-seed-001…030`（D-07 纪律：不得复用 Stage A/B 种子择优）；
 * - 每个 cell 主指标 TV(P) 对 baseline 做 30 配对，bootstrap 区间由 `evaluateStageA` 计算；
 * - **探索性质**：本实验只回答「联合条件下某结构是否可达/不可达」，
 *   interaction cell 不得归因到单一轴，也不构成确认或校准（AGENTS #9、07 §6.3）。
 */

/** D-07 纪律：P6-02 使用独立种子集，不与 Stage A/B 或 p15 轮次重叠。 */
export const P6_FACTORIAL_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p6-factorial-seed-${String(index + 1).padStart(3, '0')}`,
);

export const P6_FACTORIAL_TICKS = 730 as const;
export const P6_FACTORIAL_WARMUP = 365 as const;
export const P6_FACTORIAL_POPULATION = 200 as const;

/** P6-02 冻结预算：32 cell × 30 seed = 960 run；换预算 = 新 experimentId。 */
export const P6_FACTORIAL_BUDGET = {
  maxRuns: 1000,
  maxWallMinutes: 180,
  maxStorageBytes: 256 * 1024 * 1024,
} as const;

/** 五个主导轴的高水平；低水平 = 默认配置（不写 override）。 */
const P6_FACTORIAL_AXES: readonly {
  readonly slug: string;
  readonly overrides: DeepPartialConfig;
}[] = [
  { slug: 'threshold=0.9', overrides: { need: { threshold: 0.9 } } },
  {
    slug: 'psi=flat',
    overrides: { need: { needMultiplier: [1, 1.5, 1.5, 1.5, 1.5] } },
  },
  {
    slug: 'env0=expanded',
    overrides: { opportunity: { env0: [1, 2, 3.5, 5, 7] } },
  },
  {
    slug: 'crossDays=half',
    overrides: { ascent: { crossDays: [15, 20, 25, 30] } },
  },
  {
    slug: 'decay=steeper',
    overrides: { lifespan: { decay: [2.0, 1.6, 1.2, 0.9, 0.7] } },
  },
];

export const P6_FACTORIAL_BASELINE_KEY = 'baseline' as const;

function mergeOverrides(parts: readonly DeepPartialConfig[]): DeepPartialConfig {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const part of parts) {
    for (const [section, values] of Object.entries(part)) {
      if (values === undefined) {
        continue;
      }
      merged[section] = { ...(merged[section] ?? {}), ...(values as Record<string, unknown>) };
    }
  }
  return merged as DeepPartialConfig;
}

/** 32 个格点：位掩码枚举 2^5，cellKey 按固定轴序拼接（可复现、可读）。 */
export function buildP6FactorialCells(): readonly PreregCell[] {
  const base = buildBaseConfig(P6_FACTORIAL_POPULATION, P6_FACTORIAL_TICKS);
  const definitions: Omit<PreregCell, 'changedPaths' | 'fullConfigHash'>[] = [];
  for (let mask = 0; mask < 1 << P6_FACTORIAL_AXES.length; mask += 1) {
    const selected = P6_FACTORIAL_AXES.filter((_, index) => (mask & (1 << index)) !== 0);
    const changed = selected.length;
    const design = changed === 0 ? 'baseline' : changed === 1 ? 'single' : 'interaction';
    const cellKey =
      changed === 0 ? P6_FACTORIAL_BASELINE_KEY : selected.map((axis) => axis.slug).join('+');
    definitions.push({
      cellKey,
      design,
      hypothesis:
        changed === 0
          ? 'P6-02 factorial 基准（全部默认）：稳定区参照与跨种子波动带'
          : changed === 1
            ? `P6-02 单轴参照 ${cellKey}：与 Stage A 单参数方向对账（单轴可归因）`
            : `P6-02 联合条件 ${cellKey}：仅回答该组合下结构是否可达/不可达，不得单轴归因`,
      overrides: mergeOverrides(selected.map((axis) => axis.overrides)),
    });
  }
  const cells = definitions.map((definition) => {
    const config = buildCellConfig(definition, P6_FACTORIAL_POPULATION, P6_FACTORIAL_TICKS);
    const changedPaths = diffConfigPaths(base, config);
    assertCellDesign(definition.cellKey, definition.design, changedPaths);
    return { ...definition, changedPaths, fullConfigHash: computeConfigHash(config) };
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

export function buildP6FactorialManifest(): PreregManifest {
  return {
    schemaVersion: 'experiment-v2',
    hypothesis:
      'P6-02 多参数探索：以 Stage A 单参数结果给出的高低水平（needThreshold/needMultiplier/env0/crossDays/decay）' +
      '做 2^5 全因子，在 200 人 × 730 tick 视野定位结构变化较大的联合区域，并保留全默认稳定区作波动参照。' +
      '主指标 TV(P) 对 baseline 的 30 配对中位数与 bootstrap 区间用于描述差异；interaction 格点只回答' +
      '「该联合条件下结构是否可达/不可达」，不作单轴归因、不构成确认或校准。' +
      '结论按 07 §6.3 与 §9 标 exploratory；预算 P6_FACTORIAL_BUDGET 进哈希，换预算即新 experimentId。',
    primaryMetric: 'TV(P)',
    experimentType: 'rule_sensitivity',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: 'mock-weighted-v1',
    promptVersion: PREREG_PROMPT_VERSION,
    promptStyle: PREREG_PROMPT_STYLE,
    populationSize: P6_FACTORIAL_POPULATION,
    totalTicks: P6_FACTORIAL_TICKS,
    baseConfigHash: computeConfigHash(buildBaseConfig(P6_FACTORIAL_POPULATION, P6_FACTORIAL_TICKS)),
    artifactProfile: 'metrics-only',
    seeds: P6_FACTORIAL_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    warmupTicks: P6_FACTORIAL_WARMUP,
    warmupDiagnostic:
      'P6-02 探索：warmup=365 后的 [365,729] 单窗口日均值；w1 完整窗口超出 730 tick 视野，观测段覆盖是预注册取舍',
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
        'P6-02 为多参数探索，不执行聚类判定；聚类块按 07 §3 权威字段清单保留并进哈希，口径与 D-03 冻结一致',
    },
    differenceThresholds: {
      gini: 0.03,
      tv: 0.1,
      mUp: 0.05,
      segregation: 0.05,
      openness: 0.05,
    },
    budgets: { ...P6_FACTORIAL_BUDGET },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
    },
    cells: buildP6FactorialCells(),
  };
}

export function computeP6FactorialHash(): string {
  return computePreregistrationHash(buildP6FactorialManifest());
}
