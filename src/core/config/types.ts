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

/**
 * 需求参照系（rules-v6，D-06 选项 A′）：
 * - `own`：v5 语义——`need = buffer(classAge)×baselineSum×ψ_eff[c]`，个体计时器；
 * - `class`：阶级标准——`need = refIncome[c]×bufferDays×ψ_eff[c]`，refIncome 为
 *   上期各阶级人均收入的 EMA；`graceDays` 只控判定计时（belowNeedStreak 起算推迟）。
 */
export type NeedReferenceMode = 'own' | 'class';

export interface NeedConfig {
  readonly threshold: number;
  readonly belowNeedLimit: number;
  /**
   * 语义随 `referenceMode` 分派：`own` 为缓冲爬坡长度；`class` 为持有标尺天数。
   * 同一参数两种模式的公式引用不同，不新增 `need.needDays`（changes/0008）。
   */
  readonly bufferDays: number;
  readonly needMultiplier: readonly number[];
  /** v4 环境持有人乘子指数 φ；0 退回 v3 语义（need 与自身阶级 E 无关）。 */
  readonly envExponent: number;
  /** v6 需求参照系模式；`own` 与 v5 逐位一致（G-D 硬门禁）。 */
  readonly referenceMode: NeedReferenceMode;
  /** v6 refIncome 的 EMA 平滑系数 α；`own` 模式不读取。 */
  readonly referenceSmoothing: number;
  /** v6 判定计时宽限期（days）；仅 `class` 模式生效，`own` 按 0 处理。 */
  readonly graceDays: number;
}

export interface DescentConfig {
  readonly days: number;
}

export interface AscentConfig {
  readonly crossDays: readonly number[];
  readonly returnDiscount: readonly number[];
  /** v5 持有裕度天数 ρ；上升要求 `value >= cross + ρ×B×E[target]×ψ_eff[target]`；0 退回 v4。 */
  readonly holdingCushionDays: number;
  /**
   * v9 位移准入份额（changes/0012）：'class' 参照系下，上升以该概率触发在位者对决与降级
   *（1:1 零和位移）；低于 1 时其余份额走开放准入（不挤下在位者，目标阶级净 +1）。
   * 1 与 v8 行为一致（state hash 含 config，跨版本不可按哈希比较）；0 为完全开放准入。
   */
  readonly displacementShare: number;
  /**
   * v10 占用锚定/位置稀缺权重（changes/0013）：目标阶级占比高于
   * 机会隐含参照份额时，上升余额门槛增加
   * `scarcityWeight × crossBase × pressure`，pressure = max(0, P[c]/target[c] − 1)，
   * target[c] ∝ 1/env0[c]。0 与 v9 行为一致。
   */
  readonly scarcityWeight: number;
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
