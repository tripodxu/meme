import type { RunConfig } from './types.js';
import { CONFIG_SCHEMA_VERSION, RULES_VERSION } from '../control/versions.js';

/**
 * `rules-v3` 首轮默认配置。默认值来自 03 §3，是校准起点，不是已验证结论。
 * 仓库当前处于施工前规格阶段，不得把本配置称为“已校准预设”。
 */
export const DEFAULT_RUN_CONFIG: RunConfig = deepFreeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  rulesVersion: RULES_VERSION,
  population: {
    initialPopulation: 40,
    classCount: 5,
    classShares: [0.45, 0.3, 0.15, 0.08, 0.02],
    initialValue: 0,
    initialAgeMode: 'uniform',
  },
  opportunity: {
    dailyBase: 2,
    env0: [1, 1.5, 2.2, 3.2, 4.5],
  },
  lifespan: {
    decay: [1.3, 1.15, 1.0, 0.88, 0.75],
    initialLife: { mean: 25550, sigma: 1825, min: 3650, max: 43800 },
    hardLifeFactor: 0.15,
    hardLifeFloor: 0.5,
  },
  attributes: {
    ge: { sigma: 0.5, median: 1, min: 0.2, max: 3.0 },
    hard: { sigma: 0.5, median: 1, min: 0.2, max: 3.0 },
  },
  effort: {
    shape: 1.2,
  },
  need: {
    threshold: 0.5,
    belowNeedLimit: 14,
    bufferDays: 30,
    needMultiplier: [1.0, 1.3, 1.8, 2.5, 3.5],
  },
  descent: {
    days: 7,
  },
  ascent: {
    crossDays: [30, 40, 50, 60],
    returnDiscount: [0, 0.2, 0.4],
  },
  competition: {
    powerValueExponent: 0.35,
    powerGeExponent: 0.6,
    powerHardExponent: 0.4,
    crossClassInitiatorMultiplier: 0.85,
    crossClassTargetMultiplier: 1.15,
    lossRate: 0.08,
    baseTransferEfficiency: 0.7,
    highToLowWinMultiplier: 0.5,
    lowToHighWinMultiplier: 1.25,
    candidateCount: 6,
    localTargetProbability: 0.7,
  },
  network: {
    maxDegree: 6,
    initialDegree: 4,
    rewireProb: 0.05,
    classWeight: 1.2,
    valueWeight: 0.4,
  },
  networkOpportunity: {
    beta: 0.6,
    min: 0.7,
    max: 1.5,
  },
  dynamics: {
    classSmoothing: 0.03,
    congestionExponent: 0.35,
    polarizationExponent: 0.8,
    giniReference: 0.25,
    congestionMin: 0.2,
    congestionMax: 1.2,
    emptyClassPopulationFloor: 0.02,
    polarizationMin: 0.85,
    polarizationMax: 1.18,
  },
  openness: {
    initial: 0.5,
    timeConstantDays: 60,
    intercept: 0,
    mobilityWeight: 8,
    mobilityReference: 0.1,
    giniWeight: 6,
    segregationWeight: 4,
    segregationReference: 0.3,
    ascentCostWeight: 2,
    multiplierMin: 0.5,
    multiplierMax: 2.5,
  },
  decision: {
    interval: 10,
    topK: 1,
    policy: 'mock-weighted-v1',
  },
  schedule: {
    totalTicks: 3650,
    statsStride: 10,
    snapshotStride: 100,
  },
  metrics: {
    flowWindowDays: 365,
    mobilityWindowDays: 365,
    topWealthShareFraction: 0.1,
  },
});

/** 深度冻结默认配置，防止跨 run 意外修改共享对象。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as unknown as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** 交互演示默认：40 人、120 tick（03 §1）。结构实验请显式提高 `schedule.totalTicks`。 */
export function createDemoConfig(overrides: DeepPartialConfig = {}): RunConfig {
  const base: RunConfig = {
    ...DEFAULT_RUN_CONFIG,
    schedule: { ...DEFAULT_RUN_CONFIG.schedule, totalTicks: 120 },
  };
  return mergeConfig(base, overrides);
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type DeepPartialConfig = DeepPartial<RunConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 递归合并纯对象；数组整体替换，避免把数组按索引合并成语义错误的结构。
 * 嵌套对象（如 `lifespan.initialLife`）只覆盖声明字段，保留其余先验；
 * 通过 Map + Object.fromEntries 构造结果，避免 `__proto__` 之类的键触发赋值器。
 */
export function mergeConfig(base: RunConfig, patch: DeepPartialConfig): RunConfig {
  return mergeValue(base, patch) as RunConfig;
}

function mergeValue(baseValue: unknown, patchValue: unknown): unknown {
  if (patchValue === undefined) {
    return baseValue;
  }
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return patchValue;
  }
  const entries = new Map<string, unknown>(Object.entries(baseValue));
  for (const [key, value] of Object.entries(patchValue)) {
    entries.set(key, mergeValue(entries.get(key), value));
  }
  return Object.fromEntries(entries);
}
