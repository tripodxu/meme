import type { RulesVersion } from '../control/versions.js';
import { CONFIG_SCHEMA_VERSION } from '../control/versions.js';

/** 初始年龄模式。`uniform` 产生年龄结构；`newborn` 仅用于演示。 */
export type InitialAgeMode = 'uniform' | 'newborn';

/** 决策策略标识。真实 live 策略在 P2 接入，P0 只冻结标识。 */
export type PolicyId = 'mock-weighted-v1' | 'random-uniform-v1' | 'jev_live';

/** 截断对数正态先验；`median` 为 ln 均值对应的中位数。 */
export interface TruncatedLognormalSpec {
  readonly sigma: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/** 截断正态先验。 */
export interface TruncatedNormalSpec {
  readonly mean: number;
  readonly sigma: number;
  readonly min: number;
  readonly max: number;
}

export interface PopulationConfig {
  readonly initialPopulation: number;
  readonly classCount: number;
  readonly classShares: readonly number[];
  readonly initialValue: number;
  readonly initialAgeMode: InitialAgeMode;
}

export interface OpportunityConfig {
  readonly dailyBase: number;
  readonly env0: readonly number[];
}

export interface LifespanConfig {
  readonly decay: readonly number[];
  readonly initialLife: TruncatedNormalSpec;
  readonly hardLifeFactor: number;
  readonly hardLifeFloor: number;
}

export interface AttributesConfig {
  readonly ge: TruncatedLognormalSpec;
  readonly hard: TruncatedLognormalSpec;
}

export interface EffortConfig {
  readonly shape: number;
}

export interface NeedConfig {
  readonly threshold: number;
  readonly belowNeedLimit: number;
  readonly bufferDays: number;
  readonly needMultiplier: readonly number[];
  /** v4 环境持有人乘子指数 φ；0 退回 v3 语义（need 与自身阶级 E 无关）。 */
  readonly envExponent: number;
}

export interface DescentConfig {
  readonly days: number;
}

export interface AscentConfig {
  readonly crossDays: readonly number[];
  readonly returnDiscount: readonly number[];
  /** v5 持有裕度天数 ρ；上升要求 `value >= cross + ρ×B×E[target]×ψ_eff[target]`；0 退回 v4。 */
  readonly holdingCushionDays: number;
}

export interface CompetitionConfig {
  readonly powerValueExponent: number;
  readonly powerGeExponent: number;
  readonly powerHardExponent: number;
  readonly crossClassInitiatorMultiplier: number;
  readonly crossClassTargetMultiplier: number;
  readonly lossRate: number;
  readonly baseTransferEfficiency: number;
  readonly highToLowWinMultiplier: number;
  readonly lowToHighWinMultiplier: number;
  readonly candidateCount: number;
  readonly localTargetProbability: number;
}

export interface NetworkConfig {
  readonly maxDegree: number;
  readonly initialDegree: number;
  readonly rewireProb: number;
  readonly classWeight: number;
  readonly valueWeight: number;
}

export interface NetworkOpportunityConfig {
  readonly beta: number;
  readonly min: number;
  readonly max: number;
}

export interface DynamicsConfig {
  readonly classSmoothing: number;
  readonly congestionExponent: number;
  readonly polarizationExponent: number;
  readonly giniReference: number;
  readonly congestionMin: number;
  readonly congestionMax: number;
  readonly emptyClassPopulationFloor: number;
  readonly polarizationMin: number;
  readonly polarizationMax: number;
}

/** O 更新模式（P1-10）：`dynamic` 为默认反馈；`fixed` 为 P6-04 消融开关。 */
export type OpennessUpdateMode = 'dynamic' | 'fixed';

export interface OpennessConfig {
  readonly initial: number;
  readonly updateMode: OpennessUpdateMode;
  readonly timeConstantDays: number;
  readonly intercept: number;
  readonly mobilityWeight: number;
  readonly mobilityReference: number;
  readonly giniWeight: number;
  readonly segregationWeight: number;
  readonly segregationReference: number;
  readonly ascentCostWeight: number;
  readonly multiplierMin: number;
  readonly multiplierMax: number;
}

export interface DecisionConfig {
  readonly interval: number;
  readonly topK: number;
  readonly policy: PolicyId;
}

export interface ScheduleConfig {
  readonly totalTicks: number;
  readonly statsStride: number;
  readonly snapshotStride: number;
}

/** 指标与窗口参数；`flowWindowDays/MupWindowDays` 按 05 §4.2 归入 `RunConfig.metrics`。 */
export interface MetricsConfig {
  readonly flowWindowDays: number;
  readonly mobilityWindowDays: number;
  readonly topWealthShareFraction: number;
}

/**
 * 冻结后的运行配置。`seed` 不是 RunConfig 字段，也不进入 `configHash`；
 * 它与 config 一起作为 `createSimulation(config, seed)` 的独立入参。
 */
export interface RunConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly rulesVersion: RulesVersion;
  readonly population: PopulationConfig;
  readonly opportunity: OpportunityConfig;
  readonly lifespan: LifespanConfig;
  readonly attributes: AttributesConfig;
  readonly effort: EffortConfig;
  readonly need: NeedConfig;
  readonly descent: DescentConfig;
  readonly ascent: AscentConfig;
  readonly competition: CompetitionConfig;
  readonly network: NetworkConfig;
  readonly networkOpportunity: NetworkOpportunityConfig;
  readonly dynamics: DynamicsConfig;
  readonly openness: OpennessConfig;
  readonly decision: DecisionConfig;
  readonly schedule: ScheduleConfig;
  readonly metrics: MetricsConfig;
}
