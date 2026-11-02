/**
 * 参数注册表：所有业务常数的唯一来源。
 *
 * 结算函数不得直接写业务字面量；每个可调参数必须在此登记名称、单位、合法域、
 * 公式引用和接线测试说明。`guardOnly=true` 表示只作数值护栏、不产生业务分支。
 */

export type ParamUnit =
  | 'dimensionless'
  | 'value'
  | 'days'
  | 'ticks'
  | 'ratio'
  | 'exponent'
  | 'person'
  | 'classCount'
  | 'count';

export type ScalarDomain =
  | {
      readonly kind: 'number';
      readonly min?: number;
      readonly max?: number;
      readonly exclusiveMin?: number;
      readonly exclusiveMax?: number;
      readonly integer?: boolean;
    }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export type ArrayDomain = {
  readonly kind: 'array';
  readonly length: number | 'classCount' | 'classCountMinus1';
  readonly element: Extract<ScalarDomain, { kind: 'number' }>;
  readonly nonDecreasing?: boolean;
  readonly sumToOne?: boolean;
  readonly firstElement?: number;
};

export type ParamDomain = ScalarDomain | ArrayDomain;

export interface ParamDefinition {
  /** 注册名，同时是 `RunConfig` 内的点路径，如 `need.needMultiplier`。 */
  readonly name: string;
  readonly unit: ParamUnit;
  /** 03 §3/§4 中的公式或规则引用。 */
  readonly formulaRef: string;
  readonly domain: ParamDomain;
  /** 是否只作数值护栏；为 true 时不得出现业务分支。 */
  readonly guardOnly: boolean;
  /** 修改该参数是否应改变核心输出；`false` 必须有理由并配边界测试。 */
  readonly affectsBehavior: boolean;
  /** 接线测试说明：改变该参数后应观察到什么。 */
  readonly wireTest: string;
}

export const PARAM_DEFINITIONS: readonly ParamDefinition[] = [
  {
    name: 'population.initialPopulation',
    unit: 'person',
    formulaRef: '03 §3.1 人口/阶级',
    domain: { kind: 'number', min: 2, max: 10000, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 N 后初始 roster 长度与 initialPopulationHash 改变。',
  },
  {
    name: 'population.classCount',
    unit: 'classCount',
    formulaRef: '03 §3.1 人口/阶级',
    domain: { kind: 'number', min: 2, max: 8, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 C 后 env0/decay/needMultiplier 长度约束与阶级索引域改变。',
  },
  {
    name: 'population.classShares',
    unit: 'ratio',
    formulaRef: '03 §3.1 人口/阶级',
    domain: {
      kind: 'array',
      length: 'classCount',
      element: { kind: 'number', min: 0, max: 1 },
      sumToOne: true,
    },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变初始比例后最大余数分配结果与 P0 改变。',
  },
  {
    name: 'population.initialValue',
    unit: 'value',
    formulaRef: '03 §4.3 初始化顺序',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变初值后 tick 0 初始 Value 与 initialPopulationHash 改变。',
  },
  {
    name: 'population.initialAgeMode',
    unit: 'dimensionless',
    formulaRef: '03 §4.2 初始年龄 / rule.md 20',
    domain: { kind: 'enum', values: ['uniform', 'newborn'] },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: 'uniform 与 newborn 在同 seed 下产生不同 initialPopulationHash，且都消费 init_age。',
  },
  {
    name: 'opportunity.dailyBase',
    unit: 'value',
    formulaRef: '03 §6 阶段 C / rule.md 3',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 B 后 gain 与 baselineSum 按比例改变。',
  },
  {
    name: 'opportunity.env0',
    unit: 'value',
    formulaRef: '03 §3 / rule.md 2、33',
    domain: {
      kind: 'array',
      length: 'classCount',
      element: { kind: 'number', exclusiveMin: 0 },
    },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 env0[c] 后对应阶级 E 与 gain 改变。',
  },
  {
    name: 'lifespan.decay',
    unit: 'days',
    formulaRef: '03 §6 阶段 E / rule.md 22',
    domain: {
      kind: 'array',
      length: 'classCount',
      element: { kind: 'number', min: 0, max: 3 },
    },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 decay[c] 后对应阶级剩余寿命损耗改变。',
  },
  {
    name: 'lifespan.initialLife.mean',
    unit: 'days',
    formulaRef: '03 §3 寿命 / rule.md 20',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变均值后同 seed 的 initialLife 与 remainingLife 改变。',
  },
  {
    name: 'lifespan.initialLife.sigma',
    unit: 'days',
    formulaRef: '03 §3 寿命 / rule.md 20',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: 'sigma>0 时同 seed 的抽样离散度改变；sigma=0 时退化为均值。',
  },
  {
    name: 'lifespan.initialLife.min',
    unit: 'days',
    formulaRef: '03 §4.2 截断分布',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '截断下界改变时超出下界的样本被重新抽样。',
  },
  {
    name: 'lifespan.initialLife.max',
    unit: 'days',
    formulaRef: '03 §4.2 截断分布',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '截断上界改变时超出上界的样本被重新抽样。',
  },
  {
    name: 'lifespan.hardLifeFactor',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 E / rule.md 25',
    domain: { kind: 'number', min: 0, max: 10 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 hardLifeFactor 后合法 hard 区间的寿命损耗乘子改变；上限 10 仅作数值护栏。',
  },
  {
    name: 'lifespan.hardLifeFloor',
    unit: 'dimensionless',
    formulaRef: '03 §3.1 寿命损耗',
    domain: { kind: 'number', exclusiveMin: 0, max: 1 },
    guardOnly: true,
    affectsBehavior: false,
    wireTest:
      '合法 hard 域内输出不变；配置必须满足 <= 1+hardLifeFactor×(attributes.hard.min-1)，否则 schema 拒绝。',
  },
  {
    name: 'attributes.ge.sigma',
    unit: 'dimensionless',
    formulaRef: '03 §3 属性',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 sigma 后同 seed 的 ge 抽样改变。',
  },
  {
    name: 'attributes.ge.median',
    unit: 'dimensionless',
    formulaRef: '03 §3 属性',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变中位数后 ge 分布中心改变。',
  },
  {
    name: 'attributes.ge.min',
    unit: 'dimensionless',
    formulaRef: '03 §3.1 分布',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '截断下界改变后越界样本被重抽。',
  },
  {
    name: 'attributes.ge.max',
    unit: 'dimensionless',
    formulaRef: '03 §3.1 分布',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '截断上界改变后越界样本被重抽。',
  },
  {
    name: 'attributes.hard.sigma',
    unit: 'dimensionless',
    formulaRef: '03 §3 属性',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 sigma 后同 seed 的 hard 抽样改变。',
  },
  {
    name: 'attributes.hard.median',
    unit: 'dimensionless',
    formulaRef: '03 §3 属性',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变中位数后 hard 分布中心改变。',
  },
  {
    name: 'attributes.hard.min',
    unit: 'dimensionless',
    formulaRef: '03 §3.1 分布',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '截断下界改变后越界样本被重抽。',
  },
  {
    name: 'attributes.hard.max',
    unit: 'dimensionless',
    formulaRef: '03 §3.1 分布',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '截断上界改变后越界样本被重抽。',
  },
  {
    name: 'effort.shape',
    unit: 'exponent',
    formulaRef: '03 §3 努力函数 / rule.md 3、36',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 FShape 后 F(hard) 曲线形状改变。',
  },
  {
    name: 'need.threshold',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 D / rule.md 7',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 needThreshold 后被动跌落触发点改变。',
  },
  {
    name: 'need.belowNeedLimit',
    unit: 'ticks',
    formulaRef: '03 §6 阶段 D / rule.md 7',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 belowNeedLimit 后连续低需求触发跌落的时长改变。',
  },
  {
    name: 'need.bufferDays',
    unit: 'days',
    formulaRef: '03 §6 阶段 C / rule.md 6',
    domain: { kind: 'number', min: 2, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: 'bufferDays 改变后 buffer(classAge) 的爬坡斜率改变。',
  },
  {
    name: 'need.needMultiplier',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 C / rule.md 5',
    domain: {
      kind: 'array',
      length: 'classCount',
      element: { kind: 'number', min: 1, max: 6 },
      nonDecreasing: true,
      firstElement: 1,
    },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 ψ[c] 后对应阶级 need 与跌落风险改变。',
  },
  {
    name: 'need.envExponent',
    unit: 'exponent',
    formulaRef: '03 §6 阶段 C / rule.md 5、37（rules-v4）',
    domain: { kind: 'number', min: 0, max: 4 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest:
      'φ=0 时 need 与 v3 公式逐位一致；φ>0 时高阶级 need 按 (E[c]/E[0])^φ 相对提高，跌落边界改变。',
  },
  {
    name: 'descent.days',
    unit: 'days',
    formulaRef: '03 §6 阶段 B / rule.md 8',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 descendDays 后主动降阶费用改变。',
  },
  {
    name: 'ascent.crossDays',
    unit: 'days',
    formulaRef: '03 §6 阶段 B / rule.md 9',
    domain: {
      kind: 'array',
      length: 'classCountMinus1',
      element: { kind: 'number', exclusiveMin: 0 },
    },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 crossDays[c] 后对应上升费用改变。',
  },
  {
    name: 'ascent.returnDiscount',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 B / rule.md 10、11',
    domain: {
      kind: 'array',
      length: 3,
      element: { kind: 'number', min: 0, max: 1 },
      nonDecreasing: true,
    },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '非零测试值下 d=1/2/>=3 的上升费用分别改变。',
  },
  {
    name: 'competition.powerValueExponent',
    unit: 'exponent',
    formulaRef: '03 §6 阶段 B / rule.md 12',
    domain: { kind: 'number', min: 0, max: 4 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变指数后同 Value 的 power 改变；上限 4 仅作溢出护栏。',
  },
  {
    name: 'competition.powerGeExponent',
    unit: 'exponent',
    formulaRef: '03 §6 阶段 B / rule.md 12',
    domain: { kind: 'number', min: 0, max: 4 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变指数后同 ge 的 power 改变；上限 4 仅作溢出护栏。',
  },
  {
    name: 'competition.powerHardExponent',
    unit: 'exponent',
    formulaRef: '03 §6 阶段 B / rule.md 12',
    domain: { kind: 'number', min: 0, max: 4 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变指数后同 hard 的 power 改变；上限 4 仅作溢出护栏。',
  },
  {
    name: 'competition.crossClassInitiatorMultiplier',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 B / rule.md 16',
    domain: { kind: 'number', min: 0, max: 1.25 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '跨层发起时 powerA 按该乘子改变。',
  },
  {
    name: 'competition.crossClassTargetMultiplier',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 B / rule.md 17',
    domain: { kind: 'number', min: 0, max: 1.25 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '跨层被竞争时 powerB 按该乘子改变。',
  },
  {
    name: 'competition.lossRate',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 B / rule.md 13',
    domain: { kind: 'number', min: 0, max: 0.5 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 lossRate 后败者损失与胜者收益改变。',
  },
  {
    name: 'competition.baseTransferEfficiency',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 B / rule.md 13',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变效率后胜者收益改变，且效率<=1、效率×方向乘子<=1。',
  },
  {
    name: 'competition.highToLowWinMultiplier',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 B / rule.md 18',
    domain: { kind: 'number', min: 0, max: 1.25 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '高打低发起方获胜时收益乘子改变。',
  },
  {
    name: 'competition.lowToHighWinMultiplier',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 B / rule.md 19',
    domain: { kind: 'number', min: 0, max: 1.25 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '低打高发起方获胜时收益乘子改变。',
  },
  {
    name: 'competition.candidateCount',
    unit: 'count',
    formulaRef: '03 §5 合法行动 / rule.md 40',
    domain: { kind: 'number', min: 0, max: 6, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变候选数后 compete 合法行动数量改变。',
  },
  {
    name: 'competition.localTargetProbability',
    unit: 'ratio',
    formulaRef: '03 §5 合法行动 / rule.md 40',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变局部概率后候选来源分布改变。',
  },
  {
    name: 'network.maxDegree',
    unit: 'count',
    formulaRef: '03 §3 / rule.md 30',
    domain: { kind: 'number', min: 0, max: 6, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变最大度后加边与重构边界改变。',
  },
  {
    name: 'network.initialDegree',
    unit: 'count',
    formulaRef: '03 §4.3 初始化 / rule.md 30',
    domain: { kind: 'number', min: 0, max: 6, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变目标初始度后初始边数改变。',
  },
  {
    name: 'network.rewireProb',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 F / rule.md 39',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变重构概率后单周期重构次数期望改变。',
  },
  {
    name: 'network.classWeight',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 F / rule.md 38、39',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 H 后初始与重构权重改变。',
  },
  {
    name: 'network.valueWeight',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 F / rule.md 38、39',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 hV 后初始与重构权重改变。',
  },
  {
    name: 'networkOpportunity.beta',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 C / rule.md 36',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 β 后 Opportunity 偏离 1 的幅度改变。',
  },
  {
    name: 'networkOpportunity.min',
    unit: 'ratio',
    formulaRef: '03 §3 网络机会 / rule.md 36',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '下界改变后极端低机会被截断的位置改变。',
  },
  {
    name: 'networkOpportunity.max',
    unit: 'ratio',
    formulaRef: '03 §3 网络机会 / rule.md 36',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '上界改变后极端高机会被截断的位置改变。',
  },
  {
    name: 'dynamics.classSmoothing',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 H / rule.md 33',
    domain: { kind: 'number', exclusiveMin: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 ρE 后 E 向 Eraw 收敛速度改变。',
  },
  {
    name: 'dynamics.congestionExponent',
    unit: 'exponent',
    formulaRef: '03 §6 阶段 H / rule.md 34',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 η 后拥挤乘子曲线改变。',
  },
  {
    name: 'dynamics.polarizationExponent',
    unit: 'exponent',
    formulaRef: '03 §6 阶段 H / rule.md 35',
    domain: { kind: 'number', min: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 κ 后极化乘子曲线改变。',
  },
  {
    name: 'dynamics.giniReference',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 H / rule.md 35',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 Gref 后极化方向切换点改变。',
  },
  {
    name: 'dynamics.congestionMin',
    unit: 'ratio',
    formulaRef: '03 §3 拥挤/分化 / rule.md 34',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '下界改变后空阶级 E 的下限改变。',
  },
  {
    name: 'dynamics.congestionMax',
    unit: 'ratio',
    formulaRef: '03 §3 拥挤/分化 / rule.md 34',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '上界改变后过度稀疏阶级 E 的上限改变。',
  },
  {
    name: 'dynamics.emptyClassPopulationFloor',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 H / rule.md 34',
    domain: { kind: 'number', exclusiveMin: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 floor 后空阶级与稀疏阶级（P<floor）的 Congestion 与 E 改变。',
  },
  {
    name: 'dynamics.polarizationMin',
    unit: 'ratio',
    formulaRef: '03 §3 拥挤/分化 / rule.md 35',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '下界改变后极化乘子下限改变。',
  },
  {
    name: 'dynamics.polarizationMax',
    unit: 'ratio',
    formulaRef: '03 §3 拥挤/分化 / rule.md 35',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '上界改变后极化乘子上限改变。',
  },
  {
    name: 'openness.initial',
    unit: 'ratio',
    formulaRef: '03 §4.3 初始化 / rule.md 43',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 O0 后 tick 0 的 O 与上升成本改变。',
  },
  {
    name: 'openness.updateMode',
    unit: 'dimensionless',
    formulaRef: '03 §3 开放度 / P1-10 消融开关',
    domain: { kind: 'enum', values: ['dynamic', 'fixed'] },
    guardOnly: false,
    affectsBehavior: true,
    wireTest:
      'fixed 时 O 恒等于 openness.initial，E 更新不受影响；开关变化改变 configHash/paramsHash。',
  },
  {
    name: 'openness.timeConstantDays',
    unit: 'days',
    formulaRef: '03 §6 阶段 H / rule.md 43',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 τO 后 O 的更新步长改变。',
  },
  {
    name: 'openness.intercept',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 H / rule.md 42',
    domain: { kind: 'number', min: -20, max: 20 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 θ0 后 O_target 的基线改变。',
  },
  {
    name: 'openness.mobilityWeight',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 H / rule.md 42',
    domain: { kind: 'number', min: 0, max: 100 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 θM 后 Mup 对 O_target 的敏感度改变；上限 100 仅作溢出护栏。',
  },
  {
    name: 'openness.mobilityReference',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 H / rule.md 42',
    domain: { kind: 'number', min: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 Mref 后 O_target 的中性点改变。',
  },
  {
    name: 'openness.giniWeight',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 H / rule.md 42',
    domain: { kind: 'number', min: 0, max: 100 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 θG 后 G 对 O_target 的抑制强度改变；上限 100 仅作溢出护栏。',
  },
  {
    name: 'openness.segregationWeight',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 H / rule.md 42',
    domain: { kind: 'number', min: 0, max: 100 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 θS 后 S 对 O_target 的抑制强度改变；上限 100 仅作溢出护栏。',
  },
  {
    name: 'openness.segregationReference',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 H / rule.md 42',
    domain: { kind: 'number', min: -1, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 Sref 后隔离度的中性点改变。',
  },
  {
    name: 'openness.ascentCostWeight',
    unit: 'dimensionless',
    formulaRef: '03 §6 阶段 B / rule.md 44',
    domain: { kind: 'number', min: 0, max: 100 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 λO 后 O 对跨越成本乘子的敏感度改变；上限 100 仅作溢出护栏。',
  },
  {
    name: 'openness.multiplierMin',
    unit: 'ratio',
    formulaRef: '03 §3 跨越动态乘子 / rule.md 44',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '下界改变后成本乘子的最小值改变。',
  },
  {
    name: 'openness.multiplierMax',
    unit: 'ratio',
    formulaRef: '03 §3 跨越动态乘子 / rule.md 44',
    domain: { kind: 'number', exclusiveMin: 0 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '上界改变后成本乘子的最大值改变。',
  },
  {
    name: 'decision.interval',
    unit: 'ticks',
    formulaRef: '03 §1 通用约定',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变决策间隔后到期 tick 集合改变。',
  },
  {
    name: 'decision.topK',
    unit: 'count',
    formulaRef: '04 §4 响应校验与选择',
    domain: { kind: 'number', min: 1, max: 9, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: 'topK>1 时使用 jev_topk 地址采样，结果与 topK=1 不同。',
  },
  {
    name: 'decision.policy',
    unit: 'dimensionless',
    formulaRef: '04 §2.1 默认 mock 与 random 策略',
    domain: { kind: 'enum', values: ['mock-weighted-v1', 'random-uniform-v1', 'jev_live'] },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '切换策略后决策来源与采样地址改变。',
  },
  {
    name: 'schedule.totalTicks',
    unit: 'ticks',
    formulaRef: '03 §1 通用约定',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变 totalTicks 后最终 tick 与 stats 行数改变。',
  },
  {
    name: 'schedule.statsStride',
    unit: 'ticks',
    formulaRef: '05 §4.3 聚合 tick 批量写',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变采样步长后 tick_stats 行集合改变。',
  },
  {
    name: 'schedule.snapshotStride',
    unit: 'ticks',
    formulaRef: '02 §9 数据规模策略',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变快照步长后周期快照 tick 集合改变。',
  },
  {
    name: 'metrics.flowWindowDays',
    unit: 'days',
    formulaRef: '03 §3 转移矩阵 / rule.md 50',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变窗口后 flowMatrix 的累计范围改变。',
  },
  {
    name: 'metrics.mobilityWindowDays',
    unit: 'days',
    formulaRef: '03 §6 阶段 G / rule.md 31',
    domain: { kind: 'number', min: 1, integer: true },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变窗口后 Mup/Mdown 的统计范围改变。',
  },
  {
    name: 'metrics.topWealthShareFraction',
    unit: 'ratio',
    formulaRef: '03 §6 阶段 G / rule.md 50',
    domain: { kind: 'number', exclusiveMin: 0, max: 1 },
    guardOnly: false,
    affectsBehavior: true,
    wireTest: '改变比例后前 10% 类指标的分位边界改变。',
  },
];

/**
 * 非配置的数值护栏与实现常量。它们不进入 `configHash`/`paramsHash`，
 * 但必须命名并登记，禁止散落在结算函数里。
 */
export interface NumericConstant {
  readonly name: string;
  readonly value: number;
  readonly reason: string;
}

export const NUMERIC_CONSTANTS: readonly NumericConstant[] = [
  {
    name: 'TWO_POW_NEG_53',
    value: 2 ** -53,
    reason: 'RNG 取 53 位尾数的归一化除数，避免浮点舍入到 1。',
  },
  {
    name: 'CONFIG_SHARE_TOLERANCE',
    value: 1e-12,
    reason: '初始比例之和允许的绝对误差，见 03 §3.1。',
  },
  {
    name: 'CONFIG_RELATION_TOLERANCE',
    value: 1e-12,
    reason: '跨字段关系约束（如 hardLifeFloor 上界）比较时允许的浮点误差。',
  },
  {
    name: 'TWO_PI',
    value: 2 * Math.PI,
    reason: 'Box–Muller 正态抽样的角度参数（03 §4.2）。',
  },
  {
    name: 'REJECTION_ATTEMPT_LIMIT',
    value: 10000,
    reason:
      '截断分布拒绝抽样的尝试次数上限（03 §4.2）；sigma 合法域保证期望尝试次数有界，超限抛 invariant_violated。',
  },
];

const definitionByName = new Map<string, ParamDefinition>(
  PARAM_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export function getParamDefinition(name: string): ParamDefinition | undefined {
  return definitionByName.get(name);
}

export function listParamDefinitions(): readonly ParamDefinition[] {
  return PARAM_DEFINITIONS;
}

export function getNumericConstant(name: string): NumericConstant | undefined {
  return NUMERIC_CONSTANTS.find((constant) => constant.name === name);
}

/**
 * 读取必须登记的护栏常数。注册表是静态枚举，缺失属于构建期错误，
 * 因此不提供兜底字面量；`test/unit/params.test.ts` 同时覆盖命中与缺失两条路径。
 */
export function readNumericConstant(name: string): number {
  const constant = getNumericConstant(name);
  if (constant === undefined) {
    throw new Error(`NUMERIC_CONSTANTS 缺少登记项：${name}`);
  }
  return constant.value;
}

/** 读取 `RunConfig` 上的点路径。仅用于注册表与校验，不用于结算。 */
export function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function readNumberPath(root: unknown, path: string): number | undefined {
  const value = readPath(root, path);
  return typeof value === 'number' ? value : undefined;
}

export function readNumberArrayPath(root: unknown, path: string): readonly number[] | undefined {
  const value = readPath(root, path);
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? (value as readonly number[])
    : undefined;
}
