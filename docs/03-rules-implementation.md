# 03 规则实现规格

> 本文把 `rule.md` 的 59 条规则转成唯一结算口径。默认数值用于首轮校准，不代表已验证结论。当前规则版本为 `rules-v10`；相对 v9 的修订（D-12，changes/0013）：占用锚定 `ascent.scarcityWeight`（默认 0 与 v9 行为一致；目标阶级超机会隐含份额时抬升上升余额门槛）。相对 v8 的修订（D-11，changes/0012）：位移准入份额 `ascent.displacementShare`（默认 1 与 v8 行为一致；<1 时其余份额走开放准入）。相对 v7 的修订（D-09，changes/0010）：位移准入——'class' 参照系下上升须击败目标阶级在位者，被击败者降级（零和下行流）。相对 v6 的修订（changes/0009）：裕度与需求线同参照系（'class' 模式 `ρ×refIncome×ψ_eff`）。相对 v5 的修订（D-06 选项 A′，changes/0008）：需求与上升费用统一以「阶级参照收入」`refIncome[c]` 计价（新参数 `need.referenceMode`，`'own'` 逐位退回 v5；`need.referenceSmoothing` EMA 平滑；`need.graceDays` 只控判定计时），状态 schema 升至 `stratify-state-v2`（SocietyState 增补 `refIncome`）。相对 v4 的修订（D-05 方向 B，changes/0005）：上升资格增加目标阶级持有裕度门槛（`ascent.holdingCushionDays`，默认 30，`0` 退回 v4 语义）。相对 v3 的修订：需求线阶级环境持有人乘子 `(env0[c]/env0[0])^φ`（`need.envExponent`，默认 1.0）、`openness.mobilityWeight` 默认 8→3。相对 v2 的修订：阶级需求乘子 `needMultiplier`、初始年龄模式、365 日流动参与率、调整后网络隔离度（双侧归一化，恒在 `[-1,1]`）、参数注册表。任何行为变化必须升级 `rulesVersion`、更新 golden fixture 和本文。

## 1. 坐标、单位与通用约定

- tick 从 `0` 开始，1 tick = 1 模拟日；`step(t)` 结算 tick t 后生成 tick t+1 的期初状态。
- 交互演示默认 40 人、120 tick；结构实验默认 3650 tick，舍弃前 365 tick，使用至少 730 tick 窗口。
- 固定人口，无出生/迁入；死亡个体永久退出，不参与任何后续结算。
- 当 tick 末存活人数为 0 且该 tick 早于最后一个计划 tick 时，run 以 `endReason=extinct` 技术完成，不再调用 step；最终状态的 `tick=t+1`。若全死亡恰好发生在最后一个计划 tick（`t=totalTicks-1`），仍记 `scheduled`，但必须置 `finalAliveCount=0` 并标记“不可用于结构判异”。全死亡实验不得用于正常社会结构判异。
- 所有 Value 变化以事件记录；Value 必须有限且 `>=0`。不得暗中取整财富。
- 只有到期个体能主动行动。默认 `decisionInterval=10`，当 `tick % 10 == 0` 时全部存活个体到期；其余 tick 仅自动积累与后续管线。
- 同一发起方每 tick 最多一个主动行动，同一目标每 tick 最多参与一场竞争。
- 小数以 JavaScript number 计算；相同引擎版本和运行时必须产生一致结果。不得混用不同数学库实现同一公式。

## 2. 状态字段

### 2.1 AgentState

| 字段                             | 类型/单位     | 说明                                                                                                                             |
| -------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | 稳定字符串    | 初始化后不变，禁止复用死亡者 ID                                                                                                  |
| `alive`                          | boolean       | 死亡后不可逆                                                                                                                     |
| `classIndex`                     | int `[0,C-1]` | 当前阶级                                                                                                                         |
| `maxClassIndex`                  | int           | 历史最高阶级，初始等于初始阶级，只升不降                                                                                         |
| `value`                          | number >=0    | 当前财富                                                                                                                         |
| `ge/hard`                        | number >0     | 天赋/努力，运行期不变                                                                                                            |
| `initialLife/remainingLife`      | 日            | 初始寿命预算与剩余寿命                                                                                                           |
| `classAge`                       | 日            | 当前阶级已完成停留日数，进入当日结算后为 1                                                                                       |
| `baselineSum`                    | Value         | 当前阶级历史基准积累积分；仅 `need.referenceMode='own'` 的需求线读取（v5 语义），`'class'` 模式不读取但仍按阶段 C 累加与升降清零 |
| `belowNeedStreak`                | tick          | 连续低于 `need.threshold×need` 的次数                                                                                            |
| `lastAscentTick/lastDescentTick` | tick or null  | 最近一次上升/下降（含被动跌落与主动降阶）的 tick，用于 `metrics.mobilityWindowDays` 流动参与率；死亡后保留审计值                 |
| `ties`                           | AgentId[]     | 无向关系，序列化时排序，最大 `network.maxDegree`                                                                                 |
| `deathTick/deathReason`          | nullable      | 死亡审计信息；`deathReason` 为枚举，MVP 只有 `'age'`（V1 新增原因必须升级 `rulesVersion`，不得写自由文本）                       |

### 2.2 SocietyState

| 字段                     | 说明                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `tick`                   | 下一个待结算 tick                                                                                  |
| `agents`                 | 全部个体，含死亡者；按 ID 排序序列化                                                               |
| `E[C]`                   | 当前 tick 使用的有效阶级机会系数                                                                   |
| `refIncome[C]`           | 需求参照系（v6）：上期各阶级人均收入的 EMA，初值 `B×env0[c]`；`'own'` 模式不读取不更新（保持初值） |
| `O`                      | 当前社会开放度                                                                                     |
| `P0[C]`                  | 初始人口占比，以实际人数计算，不直接用配置理想比例                                                 |
| `G/P/S/Mup/Mdown`        | 最近完成 tick 的宏观值；`S` 为调整后同层边占比，`Mup/Mdown` 为 365 日参与率                        |
| `edgeCount`              | 最近完成 tick 的存活网络边数；用于解释 `S=0` 是无边还是随机混合                                    |
| `flowMatrix`             | `metrics.flowWindowDays` 窗口内阶级转移计数；窗口规则版本化                                        |
| `lastOpennessUpdateTick` | 计算开放度的 Δt，防止重复更新                                                                      |
| `ruleset/config/seed`    | 完整不可变输入及 hash                                                                              |

事件、日志、视图缓存和 wall-clock 时间不得进入权威状态哈希。快照必须包含未来结算所需的全部上述字段。

## 3. 配置默认值

| 组           | 参数                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 人口         | `C=5`，初始比例 `[0.45,0.30,0.15,0.08,0.02]`，`initialValue=0`，`initialAgeMode=uniform`                                                                                         |
| 机会         | `B=2`，`env0=[1,1.5,2.2,3.2,4.5]`                                                                                                                                                |
| 寿命         | `decay=[1.30,1.15,1.00,0.88,0.75]`，初始寿命正态均值 25550、标准差 1825 日，截断 `[3650,43800]`；`hardLifeFactor=0.15`、`hardLifeFloor=0.50`                                     |
| 属性         | `ge/hard` 为独立截断对数正态，底层 `sigma=0.5`、中位数 1、截断 `[0.2,3.0]`                                                                                                       |
| 努力函数     | `F(h)=(1-exp(-FShape×h))/(1-exp(-FShape))`，`FShape=1.2`                                                                                                                         |
| 需求         | `needThreshold=0.5`，`belowNeedLimit=14`，`bufferDays=30`，`buffer(age)=clamp((age-1)/(bufferDays-1),0,1)`，`needMultiplier=[1.0,1.3,1.8,2.5,3.5]`，`envExponent=1.0`（v4 新增） |
| 主动降阶     | `descendDays=7`，`descendCost=descendDays×B×E[t,currentClass]`                                                                                                                   |
| 上升         | `crossDays=[30,40,50,60]`，`crossBase=crossDays[c]×B×E[t,c+1]`                                                                                                                   |
| 重返         | 距历史最高阶级 `d=1/2/>=3` 时依次应用 `returnDiscount=[0,0.20,0.40]`；三项都必须可被接线测试观测，默认值允许 `returnDiscount[0]=0`                                               |
| 竞争能力     | `power=(1+Value)^powerValueExponent×ge^powerGeExponent×hard^powerHardExponent`，默认 `0.35/0.6/0.4`                                                                              |
| 跨层能力     | 原发起方 ×`crossClassInitiatorMultiplier=0.85`，原被竞争方 ×`crossClassTargetMultiplier=1.15`，同层均 ×1                                                                         |
| 竞争转移     | `lossRate=0.08`，`baseTransferEfficiency=0.70`                                                                                                                                   |
| 方向修正     | 原发起方高打低获胜 ×`highToLowWinMultiplier=0.5`；低打高获胜 ×`lowToHighWinMultiplier=1.25`；其他获胜 ×1                                                                         |
| 网络         | `maxDegree=6`、`initialDegree=4`、`rewireProb=0.05`、`classWeight=1.2`、`valueWeight=0.4`                                                                                        |
| 目标候选     | 最多 `competition.candidateCount=6` 个，局部网络概率 `competition.localTargetProbability=0.70`，全局概率 `1-localTargetProbability`                                              |
| 网络机会     | `β=0.6`，乘子截断 `[opportunityMin,opportunityMax]=[0.70,1.50]`                                                                                                                  |
| 动态 E       | `ρE=0.03`、`η=0.35`、`κ=0.8`、`Gref=0.25`                                                                                                                                        |
| 拥挤/分化    | Congestion 截断 `[congestionMin,congestionMax]=[0.20,1.20]`，Polarization 截断 `[polarizationMin,polarizationMax]=[0.85,1.18]`                                                   |
| 开放度       | `O0=0.5`、`τO=60`、`θ0=0`、`θM=3`（v4 由 8 下调）、`Mref=0.10`、`θG=6`、`θS=4`、`Sref=0.30`、`λO=2`                                                                              |
| 跨越动态乘子 | 截断 `[0.50,2.50]`                                                                                                                                                               |
| 流动率       | 参与率窗口 `metrics.mobilityWindowDays=365`；`Mup/Mdown` 不使用 EMA、不按日频截断                                                                                                |
| 转移矩阵     | `metrics.flowWindowDays=365`；窗口内累计阶级转移计数与行暴露量                                                                                                                   |

`openness.updateMode` 由 P1-10 引入（默认 `dynamic`，消融为 `fixed`）；`fixed` 时 O 始终等于 `openness.initial`，不得用极大 `τO` 近似。

| 简写                                        | 配置路径                                                                                                               | 说明                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `N` / `C`                                   | `population.initialPopulation` / `population.classCount`                                                               | 初始人口 / 阶级数                |
| `B` / `env0[c]`                             | `opportunity.dailyBase` / `opportunity.env0`                                                                           | 日基础机会 / 初始阶级机会        |
| `decay[c]`                                  | `lifespan.decay`                                                                                                       | 阶级寿命损耗                     |
| `ψ[c]` / `needThreshold`                    | `need.needMultiplier` / `need.threshold`                                                                               | 持有成本 / 跌落阈值              |
| `φ`                                         | `need.envExponent`                                                                                                     | 环境持有人乘子指数（v4 新增）    |
| `belowNeedLimit` / `bufferDays`             | `need.belowNeedLimit` / `need.bufferDays`                                                                              | 连续低需求天数 / 需求缓冲        |
| `descendDays` / `crossDays[c]`              | `descent.days` / `ascent.crossDays`                                                                                    | 主动降阶 / 上升成本天数          |
| `discount`                                  | `ascent.returnDiscount`                                                                                                | 重返减免                         |
| `FShape`                                    | `effort.shape`                                                                                                         | 努力函数形状                     |
| `H` / `hV`                                  | `network.classWeight` / `network.valueWeight`                                                                          | 网络阶级 / 财富权重              |
| `maxDegree` / `initialDegree`               | `network.maxDegree` / `network.initialDegree`                                                                          | 度上限 / 目标初始度              |
| `candidateCount` / `localTargetProbability` | `competition.candidateCount` / `competition.localTargetProbability`                                                    | 竞争候选数 / 局部目标概率        |
| `β`                                         | `networkOpportunity.beta`                                                                                              | 网络机会权重                     |
| `ρE` / `η` / `κ` / `Gref`                   | `dynamics.classSmoothing` / `dynamics.congestionExponent` / `dynamics.polarizationExponent` / `dynamics.giniReference` | E 平滑 / 拥挤 / 极化 / 基尼参考  |
| `O0` / `τO` / `λO`                          | `openness.initial` / `openness.timeConstantDays` / `openness.ascentCostWeight`                                         | 开放度初值 / 时间常数 / 成本权重 |
| `θ0/θM/Mref/θG/θS/Sref`                     | `openness.intercept/mobilityWeight/mobilityReference/giniWeight/segregationWeight/segregationReference`                | 开放度目标参数                   |
| `flowWindowDays` / `mobilityWindowDays`     | `metrics.flowWindowDays` / `metrics.mobilityWindowDays`                                                                | 转移 / 流动参与率窗口            |
| `decisionInterval` / `topK`                 | `decision.interval` / `decision.topK`                                                                                  | 决策间隔 / topK                  |

### 3.1 合法配置域

| 字段组    | 约束                                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 人口/阶级 | `initialPopulation` 为 `[2,10000]` 整数；`C` 为 `[2,8]` 整数；初始比例非负且 `abs(sum-1)<=1e-12`；initialValue>=0；`initialAgeMode` 为 `uniform                                                                                                                                                              | newborn` |
| 数组      | env0/decay/needMultiplier 长度为 C，crossDays 长度为 C-1；env0/crossDays/B>0；`0<=decay<=3`；needMultiplier 非递减、`needMultiplier[0]=1`、每项在 `[1,6]`                                                                                                                                                    |
| 分布      | ge/hard 的 sigma 在 `[0, ln(max/min)]`、截断满足 `0<min<=median<=max`；寿命 `0<min<=mean<=max`、sigma 在 `[0, max-min]`（sigma 上界是拒绝采样收敛护栏；待议 D-02）                                                                                                                                           |
| 需求/跨越 | needThreshold 在 `[0,1]`；belowNeedLimit>=1 整数；bufferDays>=2；`envExponent` 在 `[0,4]`（v4 新增；0 为 v3 语义消融值）；`holdingCushionDays` 在 `[0,365]` 整数（v5 新增；0 为 v4 语义消融值）；descendDays>0；重返减免为固定长度 3 的非递减数组，依次对应 `d=1/2/>=3`，每项在 `[0,1]` 且三项都必须参与计算 |
| 反馈      | β/η/κ/H/hV>=0（消融值 0 合法）；`0<=λO<=100`；`0<ρE<=1`；τO>0；Gref/Mref 在 `[0,1]`，Sref 在 `[-1,1]`；`0<=θM/θG/θS<=100`，θ0 有限且在 `[-20,20]`；`openness.updateMode` 为 `dynamic` 或 `fixed`                                                                                                             |
| 寿命损耗  | `hardLifeFactor` 在 `[0,10]`；`hardLifeFloor` 为 `(0,1]` 的正数且必须 `<= 1+hardLifeFactor×(attributes.hard.min-1)`，保证在合法 `hard` 域内只作数值护栏、不产生业务分支（配置面去留见待议 D-01）                                                                                                             |
| 网络/候选 | `maxDegree` 为 `[0,6]` 整数；initialDegree 为 `[0,6]` 整数；`competition.candidateCount` 为 `[0,6]` 整数；localTargetProbability 在 `[0,1]`，global 概率恒为 `1-localTargetProbability`                                                                                                                      |
| 竞争      | 三个 power 指数在 `[0,4]`；lossRate 在 `[0,0.5]`；`baseTransferEfficiency` 在 `[0,1]`（同层与防守方方向乘子恒为 1）；各方向乘子在 `[0,1.25]`；所有 `baseTransferEfficiency×directionMultiplier<=1`（包括隐含乘子 1）                                                                                         |
| 决策      | decisionInterval/topK 为正整数，topK<=9；topK 实际还不得超过当次合法行动数；timeout/预算为正且有限                                                                                                                                                                                                           |
| 调度/指标 | totalTicks>=1、statsStride/snapshotStride/metrics.flowWindowDays/metrics.mobilityWindowDays>=1 整数；statsStride<=totalTicks                                                                                                                                                                                 |

MVP 不允许负 decay，因此寿命不会因阶级而反向增加；`rule.md` 中“可能为负”留作未来规则版本。除表中显式允许 0 的参数外，不得用“正参数”笼统推断范围。所有 schema-valid 配置必须满足收益不超过损失等核心不变量；运行端可进一步限制人口/预算，但不得放宽数学合法域。`totalTicks/statsStride/snapshotStride` 属于 RunConfig 并被 `configHash` 覆盖，05 的顶层 `schedule` 只是服务端索引镜像。

### 3.2 参数注册表与字面量禁令

本文公式中的业务常数必须来自第 3 节的命名参数；未列出的实现常量（如 `2^-53`、`1e-12`）必须在 `src/core/params.ts` 集中注册，带名称、单位、默认值、合法域、公式引用和是否进入 `configHash` 的标记。禁止在结算函数中直接写业务字面量。

P0 必须提供：

- `ParameterRegistry` 单一来源，配置校验与本文参数表由它驱动；对外 JSON Schema（导入导出用）必须由注册表生成并有一致性测试；
- 每个参数至少一个“接线测试”：改变参数值必须改变对应输出，或明确标记为不影响行为并说明原因；
- golden fixture 记录 `paramsHash`；参数改名或含义变化升级 `rulesVersion`。

`src/core/config/validate.ts` 的标量与数组元素范围必须从注册表读取，不得另行硬编码；跨字段约束（数组长度、顺序、和为一、`hardLifeFloor` 关系上界等）单独实现并有测试。`test/unit/params.test.ts` 必须覆盖“每个 RunConfig 叶子都已登记”和注册表域边界。参数注册表定义由 `test/fixtures/config/param-definitions.json` 快照冻结，变更需运行 `pnpm params:snapshot` 并人工审查 diff。

至少覆盖：`FShape`、`powerValueExponent/powerGeExponent/powerHardExponent`、`crossClassInitiatorMultiplier/crossClassTargetMultiplier`、`lossRate`、`baseTransferEfficiency`、`highToLowWinMultiplier/lowToHighWinMultiplier`、`descendDays`、`returnDiscount`、`bufferDays`、`needThreshold`、`belowNeedLimit`、`needMultiplier`、`initialAgeMode`、`opportunityMin/Max`、`congestionMin/Max`、`polarizationMin/Max`、`opennessMultiplierMin/Max`、`hardLifeFactor/hardLifeFloor`、`metrics.flowWindowDays`、`metrics.mobilityWindowDays`。

`initialAgeMode` 是枚举参数而非数值参数，接线测试必须证明 `uniform` 与 `newborn` 产生不同 `initialPopulationHash`，且两者消费同一 `init_age` 地址。`hardLifeFloor` 在合法 `hard` 域内不改变输出：配置必须满足 `hardLifeFloor <= 1+hardLifeFactor×(attributes.hard.min-1)`，违反时 schema 直接拒绝；注册表把它标记为 `guardOnly`，不得算作业务可调参数。所有参数条目标注 `configHash` 覆盖、`paramsHash` 覆盖和是否有接线测试。

## 4. 可寻址随机数与初始化

### 4.1 RNG 规范

```text
key = length-prefixed("stratify-rng-v1", seed, decimal(tick), agentId, eventTag, decimal(counter))
u   = unsigned_big_endian_uint64(SHA-256(UTF-8(key))[0..8])
R   = Number(u >> 11n) / 2^53
```

长度前缀为每个 UTF-8 分量前的 4 字节无符号大端字节长度。只取高 53 位，避免 JS number 把接近 2^64 的值舍入为 1；因此 `0<=R<1`。使用固定版本的纯 JS SHA-256 实现（如 `@noble/hashes`），不依赖异步 WebCrypto。

所有 eventTag 在中央注册；初始化使用 `tick=-1`。每个地址独立，未列出的新随机行为必须先注册新 tag 和版本，不能复用含义相近的 tag。

### 4.2 标准抽样算法

- **均匀索引**：候选先按 agentId/约定键升序，`j=floor(R×length)`；length=0 不抽样。
- **Fisher–Yates**：数组先升序，i 从 n-1 降到 1，counter 从 0 递增，`j=floor(R(...,counter)×(i+1))` 并交换。
- **加权抽样**：候选稳定排序，权重有限且 >=0；`r=R×sumWeight`，选择首个使 `r<cumulativeWeight` 的候选；sum=0 时视为无候选。每次选择只消费指定的一个地址，候选集更新后另用下一地址，不做无界拒绝。
- **正态样本**：第 a 次尝试取 `u1=R(...,2a)`、`u2=R(...,2a+1)`，`z=sqrt(-2ln(max(u1,2^-53)))×cos(2πu2)`；不缓存第二个 Box–Muller 样本。sigma=0 直接取均值且不消费随机数。
- **截断分布**：ge/hard/life 分别使用 `init_ge/init_hard/init_life`；每次拒绝后 a+=1，lognormal=`exp(sigma×z)`，正态=`mean+sigma×z`。每个属性独立计数，直到落入截断区间。拒绝采样必须有界：尝试次数上限是实现常量并进入 `NUMERIC_CONSTANTS`，超限立即抛 `invariant_violated` 并停止 run，不得无界循环或用 clamp 伪造样本；`sigma` 的配置上界保证合法配置的期望尝试次数有界。采样器方案与 sigma 上界待议 D-02：若改用逆 CDF，应同步放宽该上界。
- **初始年龄**：每个体用 `init_age` 消费一次 `u_age=R(...,"init_age",0)`；`initialAgeMode=uniform` 时 `remainingLife=initialLife×(1-u_age)`，`newborn` 时 `remainingLife=initialLife`。两种模式都消费该地址，避免模式切换改变其他随机流。

### 4.3 初始化顺序与地址

1. 校验配置，用最大余数法转为精确人数；余数并列时优先较小 classIndex。生成对应阶级的多重集合并按 classIndex 排序。允许某些阶级初始人数为 0；`P0[c]=0` 的语义见阶段 H。
2. 以 `agentId="population"`、`eventTag="init_class_shuffle"` 对上述数组做 Fisher–Yates，再按稳定 agentId 顺序分配。
3. 按 agentId 依次用独立 tag 生成 ge/hard/initialLife；属性之间不共享 counter。
4. 按 agentId 用 `init_age` 生成初始年龄并设置 `remainingLife`；`initialAgeMode=newborn` 时仍消费 `init_age` 但取 `remainingLife=initialLife`。
5. 初始化 Value=0、classAge/baselineSum/belowNeedStreak=0、maxClass=当前阶级、lastAscentTick/lastDescentTick=null。
6. `E=env0`、`O=openness.initial`、`lastOpennessUpdateTick=0`，宏观值由初始状态计算，Mup/Mdown=0。tick 0 若为决策周期，O 更新的 `Δt=0`，因此初始 O 不因首次更新而改变。
7. 按 agentId 顺序为未达目标初始度者加边，直到度 `network.initialDegree` 或无合法候选。每个体的 `network_init` counter 从 0 开始，每成功加一条边后 +1；候选为空不加边也不继续消费。

网络候选必须双方存活、非自身、未连边、双方度均小于 `network.maxDegree`，按初始权重 `w=exp(-H×|classDiff|-hV×|logValueDiff|)` 抽样。

### 4.4 运行期地址表

| 行为            | agentId/eventTag/counter                                                                  |
| --------------- | ----------------------------------------------------------------------------------------- |
| 初始年龄        | `id/"init_age"/0`；两种 initialAgeMode 都消费                                             |
| 行动顺序        | 每个到期 agent 计算 `R(seed,tick,id,"action_order",0)`，按 `(值,id)` 升序，不用共享洗牌流 |
| 竞争候选槽位 k  | `id/"competition_candidate"/2k` 选 local/global，`2k+1` 选目标；每槽最多这两个地址        |
| mock 行动       | `id/"mock_action"/0`                                                                      |
| random 行动     | `id/"random_action"/0`                                                                    |
| Jev topK        | `id/"jev_topk"/0`，每次最终响应最多消费一次                                               |
| 竞争胜负        | 原发起方 `id/"competition_resolve"/0`                                                     |
| 网络重构判定    | `id/"network_rewire"/0`，每决策周期每 agent 都消费                                        |
| 选旧关系/新关系 | 同 tag counter 1/2；判定成功且有旧边才消费 1，随后无论是否有新候选都消费 2                |

探索/脚本层 tag（不得用于生产策略或规则结算）：`id/"explore_descend"/0`，仅由
`scripts/p15-descend-threshold.mjs` 的加权抽样消费（changes/0017）。

## 5. 合法行动与执行前复核

```text
accumulate
ascend                  # 非最高层且期初费用 + 持有裕度足够（v5）
descend                 # 非最低层且期初费用足够
compete:<agentId>       # 最多 competition.candidateCount 个由代码采样的存活目标
```

- 竞争目标生成：槽位 k 从 0 开始，先消费来源地址，以 `competition.localTargetProbability` 选邻居、以 `1-localTargetProbability` 选全局；再消费目标地址，从该来源的剩余合法目标中均匀抽样。来源为空则用目标地址在另一来源抽样；若已选满 `competition.candidateCount` 个或全局剩余目标为 0 即停止，不为空槽继续消费。去除已选目标本身就是无放回，不做重复拒绝抽样。
- 候选排序稳定，先按行动类型，再按 agentId；行动类型顺序固定为 `accumulate<ascend<descend<compete`，同类内按 agentId 的 UTF-8 字节序升序。该顺序同时决定 `legalActions` 请求顺序、`actionSetHash`、mock 加权抽样顺序和 topK 并列规则；展示顺序不得改变 RNG 结果。任何排序语义变化必须升级 `promptVersion`。
- Jev 只看见这些合法行动。执行顺序按 4.4 的每 agent `action_order` 随机键排序。
- 因前序竞争导致费用不足、目标已被作为目标、目标死亡或关系已变化时，执行前重新校验；失效行动记 `stale_invalid`，不执行主动行动，仍进入日常积累。失效行动不占用 `targetedAgents`、不改变 Value/阶级/网络，只写执行记录。目标占用集合为 `targetedAgents`：作为发起方不阻止其另作为目标；A→B 后 B→C 合法，但任何再次以 B 为目标的行动非法。
- `stale_invalid` 的 `reason` 取值固定为：`insufficient_cushion`（上升费用或裕度不足）、`insufficient_value`（降阶费用不足）、`self_target`（决策层传入自身为目标）、`target_dead`、`target_taken`。新增取值必须同时更新本节与事件断言；不得用自由文本代替。
- 竞争目标必须匹配 `AGENT_ID_PATTERN`（`a-<≥4 位数字>`）；`compete:<任意字符串>` 在解析阶段即抛不变量错误，不得进入执行端。
- `accumulate` 不收取额外费用，只表示本 tick 不做升降/竞争。

## 6. 单 tick 唯一结算顺序

### 阶段 A：期初快照与决策

使用 tick t 的期初状态生成合法行动和决策。E、O 和宏观慢变量在本阶段不得被决策过程修改。

### 阶段 B：主动行动

按洗牌顺序逐一执行，立即改变 Value/阶级/竞争占用标记。

**上升**：

```text
d = maxClassIndex - classIndex
discount = d==0 ? 0 : d==1 ? returnDiscount[0] : d==2 ? returnDiscount[1] : returnDiscount[2]
# d=0 首次上升无减免；d=1/2/>=3 分别读取 returnDiscount[0]/[1]/[2]
openMultiplier = clamp(exp(λO×(0.5-O)), opennessMultiplierMin, opennessMultiplierMax)
cost = crossBase×(1-discount)×openMultiplier
# 持有裕度（changes/0005 引入；rules-v7 起参照量随 need.referenceMode 分派）：只作余额门槛，不支付
ψ_eff[target] = needMultiplier[target]×(env0[target]/env0[0])^φ
cushion = referenceMode=='class' ? ρ×refIncome[t,target]×ψ_eff[target] : ρ×B×E[t,target]×ψ_eff[target]
          # ρ = ascent.holdingCushionDays，ρ=0 时为 0；'own' 与 v5 逐位一致（G-D）
合法 ⇔ classIndex < C-1 且 value >= cost + cushion
```

**位移准入（rules-v8，D-09）**：`'class'` 参照系下，通过费用+裕度复核后还须击败目标阶级
**在位者**——按 `R(seed,t,agentId,"displacement_target",0)` 从目标阶级当前存活者均匀抽样一名
对手，对决复用本节「竞争」结算（含财富转移，消费攻击方的 `competition_resolve` 地址）：

```text
if 目标阶级无存活者: 无对决，直接准入（边界扩张）
elif 对决攻击方获胜: 在位者降级到攻击方原阶级（classIndex-=1、计时字段清零、
                     lastDescentTick=t 计入 Mdown、maxClass 不变、事件 reason='passive'），
                     攻击方支付 cost 并升阶
else（在位者守擂成功）: 攻击方不支付、不升阶，事件 action_invalid/displacement_lost、
                     执行记录 stale_invalid/displacement_lost（对决财富转移已结算）
```

'own' 模式不进入该分支、不消费 `displacement_target` 地址（RNG 流与 v5 逐位一致，G-D）。

**位移份额（rules-v9，D-11，changes/0012）**：`ascent.displacementShare ∈ [0,1]`，默认 1。

```text
share = 1:     完全按 v8（不消费 displacement_admit 地址，行为不变）
0 < share < 1: u = R(seed,t,agentId,"displacement_admit",0)
               u < share → 走 v8 位移；否则走开放准入（不抽在位者、不降级，目标阶级净 +1）
share = 0:     完全开放准入（不消费 displacement 相关地址）
'own' 模式:    不读取该参数（G-D 逐位一致）
```

探索结论（changes/0012 §4）：share<1 会产生净上行流并把底层抽空，
同参数种子间结构离散度 >1，属棘轮而非第二稳态；该参数不是产生参数区域多结构的机制。

**占用锚定（rules-v10，D-12，changes/0013）**：`ascent.scarcityWeight ∈ [0,100]`，默认 0。

```text
target[c]   = (1/env0[c]) / Σ_j (1/env0[j])
pressure[c] = max(0, P[c]/target[c] − 1)      # P 为 tick 期初存活者占比（行动循环前快照）
barrier(c)  = scarcityWeight × crossBase(c−1) × pressure[c]
上升余额门槛: value >= cost + cushion + barrier
```

`scarcityWeight=0` 时 barrier 恒为 0，行为与 v9 一致；壁垒不支付、只作门槛。
`P` 的快照在阶段 B 之前取一次，枚举侧与引擎复核侧共享，禁止按行动顺序重算。
探索结论（changes/0013 §4）：w 与 share 联动给出 A/B/C 三个参数区域
（底重金字塔 / 上位中产 / 中产隆起），w=80–100 时底层恢复到 P0≈0.10；
但每个参数组合仍只有一个吸引域，未证明双稳态，不构成 G1.5 通过。

支付 cost，`classIndex+=1`，更新 maxClass，重置 classAge=0、baselineSum=0、belowNeedStreak=0，记 `lastAscentTick=t`。一次只能上升一层。

**主动降阶**：支付 `descendDays×B×E[t,current]`，阶级减 1，重置上述阶级停留字段，记 `lastDescentTick=t`。maxClass 不变。

**竞争**：

1. 原发起方 A、原目标 B 的身份和方向冻结，不因后续 Value 改变。
2. `powerA/B` 使用当前 Value/ge/hard，跨层分别乘 `crossClassInitiatorMultiplier/crossClassTargetMultiplier`，同层乘 1。
3. `pA=powerA/(powerA+powerB)`；用 `R(seed,tick,A.id,"competition_resolve",0)` 判定，只消费发起方地址下的随机数。`power` 必须在 log 空间计算或比较（例如比较 `logPowerA-logPowerB` 后用数值稳定 sigmoid），避免极大 Value 下 `Infinity/Infinity` 产生 NaN；任一 power 非有限属于不变量失败，不得静默 clamp。
4. loser 损失 `loss=min(loser.value, lossRate×loser.value)`。
5. winner 获得 `gain=loss×baseTransferEfficiency×directionMultiplier`；directionMultiplier 仅按原发起方是否获胜及原方向确定，防守方获胜恒为 1。
6. 先扣 loser，再加 winner，双方 Value 不得为负。竞争本身不改变阶级。

**成功主动升降**设置 `activeClassChanged=true`，本 tick 被动跌落跳过；竞争和 accumulate 不设置。

### 阶段 C：日常积累与需求

对所有此时仍存活个体，按稳定 agentId 顺序独立计算：

```text
Opportunity = clamp(exp(β×(log(1+median(neighborValues))-log(1+median(allAliveValues)))), opportunityMin, opportunityMax)
gain = B×E[t,class]×ge×F(hard)×Opportunity
Value += gain
baselineSum += B×E[t,class]
classAge += 1
ψ_eff[c] = needMultiplier[c]×(env0[c]/env0[0])^φ            # v4 阶级环境持有人乘子，φ=need.envExponent

# 需求参照系（rules-v6，D-06 选项 A′）分派：
if need.referenceMode == 'class':
    need = refIncome[class]×bufferDays×ψ_eff[class]         # 持有标尺=阶级标准，不乘 buffer(classAge)
else:  # 'own'：v5 语义，逐位一致（G-D 硬门禁）
    need = buffer(classAge)×baselineSum×ψ_eff[class]
```

**refIncome 更新（v6）**：阶段 C 全部 `gain` 算完之后、同 tick 末尾执行——

```text
refGain[c](t)  = mean{ gain_i(t) : i 存活且 class_i(t)=c }    # 空阶级不参与（保持上期值）
refIncome[c](t+1) = (1-α)·refIncome[c](t) + α·refGain[c](t)  # α = need.referenceSmoothing
```

本 tick 的 `need`/`ascendCost` 一律使用**上期** `refIncome`（先算后用，禁止同期值，否则引入 agent 顺序依赖）。
`refIncome` 属于权威状态（`stratify-state-v2`），初值 `B×env0[c]` 由 `(config, seed)` 纯函数派生；
`'own'` 模式**不读取也不更新**（保持初值），保证与 v5 逐位一致（G-D）。
`bufferDays` 在两种模式下语义不同：`'class'` 为持有标尺天数（`need` 对其等比缩放），`'own'` 为缓冲爬坡长度
（`buffer(classAge)` 在 `bufferDays` 日后达到 1）；同一参数不另设 `need.needDays`。
`baselineSum` 在两种模式下都按本阶段累加并在升降时清零，但 `'class'` 模式不读取它。

`φ=0` 时 `ψ_eff=needMultiplier`，精确退回 v3 语义。乘子锚定 `env0[0]`（不是 `env0` 均值或 `E` 均值），使「顶层相对底层的机会差」成为持有成本的唯一环境来源；`E` 的实时变化只通过 `gain` 与 `cushion` 影响个体，不直接改写需求线。

> **D-06 已修（rules-v6，changes/0008）**：v3–v5 语义中 `need` 乘 `buffer(classAge)` 且累加个体
> `baselineSum`（它不是个体自身收入，而是阶级参照人的累计积分），叠加「升降清零」产生两个缺陷：
> **免租期**（升阶清空持有义务，30 天无持有成本）与**标尺无界**（`need=D×B×E[c]×ψ[c]` 随停留天数线性
> 增长，久居者被自己的计时器赶下去；持有能力退化为绝对生产率测试而非相对位置测试）。实测后果：
> `mUp≈0.95`、底层占比 0.45→w3 0.003、最粗 k=2 半样本 ARI 与随机无异（诊断见
> [`research/2026-11-03-p15-diagnosis-and-next-round.md`](research/2026-11-03-p15-diagnosis-and-next-round.md)）。
> v6 按选项 **A′** 修断：`need` 与 `ascendCost` 统一以阶级参照收入 `refIncome[c]` 计价、`need` 不再乘
> `buffer(classAge)`，判定计时拆给 `graceDays`；`'own'` 模式逐位保留 v5 语义作消融对照（G-D）。
> 施工说明见 [`research/2026-11-03-p15-w0-w1-handoff.md`](research/2026-11-03-p15-w0-w1-handoff.md)。

`F(h)=(1-exp(-FShape×h))/(1-exp(-FShape))` 必须用 `expm1` 实现稳定形式 `expm1(-FShape×h)/expm1(-FShape)`；否则 `FShape` 接近 0 时分子分母同时下溢为 0，产生 NaN。

- 邻居只取当前存活者；无邻居 Opportunity=1。
- 全体中位数含本个体；偶数取中间两数均值；无存活人口时不再执行积累。
- 本阶段基于同一阶段期初 Value/网络快照计算全部 Opportunity，再统一应用 gain，避免 agentId 顺序影响结果。
- 主动变动阶级者已在 B 清零，因此在 C 累积新阶级的第一天；首日 buffer=0。
- `needMultiplier` 使高阶有更高的持有标准；没有它，`Value/need` 近似 `ge×F(hard)×Opportunity`，与阶级无关，人口会向顶层塌缩。

### 阶段 D：被动跌落

仅对未成功主动变动阶级的存活者：

```text
if need.referenceMode=='class' and classAge <= graceDays:
    belowNeedStreak = 0                       # 宽限期只控判定计时，不影响 need 数值
elif Value < needThreshold×need: belowNeedStreak += 1
else: belowNeedStreak = 0
if belowNeedStreak >= belowNeedLimit and classIndex > 0: classIndex -= 1
```

`graceDays` 仅在 `'class'` 模式生效（默认 30，域 `[0,120]`）；`'own'` 模式按 0 处理——不读配置、
不走宽限分支，与 v5 判定计时逐位一致（G-D）。

跌落后重置 classAge=0、baselineSum=0、belowNeedStreak=0，记 `lastDescentTick=t`，maxClass 不变；每次最多跌一层。最低层即使持续低于需求也不跌落；其 `belowNeedStreak` 仍按上式递增，但必须在达到 `belowNeedLimit` 后钳制为该值，不得无界增长。需求为 0 时严格比较 `Value<0`，因此不会触发。

### 阶段 E：寿命与死亡

对仍存活者：

```text
loss = decay[classIndex]×max(1+hardLifeFactor×(hard-1), hardLifeFloor)
remainingLife = max(0,remainingLife-loss)
if remainingLife==0: alive=false, deathTick=t, ties从所有邻居移除
```

默认 `hardLifeFactor=0.15`、`hardLifeFloor=0.50`；默认配置下合法 `hard∈[0.2,3.0]` 的因子范围为 `[0.88,1.30]`。配置约束保证 `hardLifeFloor` 不高于合法域内的最小因子，因此它只作数值护栏，不是可达的业务分支。使用被动跌落后的阶级，不追溯历史。死亡者当天已完成的积累/行动仍保留在事件和当日统计中；从下一 tick 不再参与。

### 阶段 F：网络重构

仅在决策周期且仍有存活者时执行，使用当前 O 和存活网络。按 agentId 顺序，每人以 `rewireProb` 尝试一次：

1. 有关系才尝试；均匀选一条旧边 `(i,j)` 并暂时移除。
2. 新候选为存活、非 i、当前无连边、双方度合法且不是 j 的个体。
3. 权重 `w=exp(-H×(1-O)×|classDiff|-hV×|logValueDiff|)`。
4. 无候选则恢复旧边；有候选则加一条新边。一次最多替换一条。

所有抽样使用 `network_rewire` 独立地址。最终结果必须无自连/重边，度不超过 `network.maxDegree`。

### 阶段 G：宏观指标

在行动、死亡和网络完成后计算：

- `P[c]=存活且class=c人数/存活人数`；无存活者时全 0，并单独报告 `aliveCount=0`。
- Gini：存活者 Value 升序 `x[i]`，`G=Σ(2i-n-1)x[i]/(nΣx)`，i 从 1 开始；总和为 0 时 G=0。
- `edgeCount`：存活网络的无向边数；`sameShare=edgeCount==0 ? 0 : 同阶级边数/edgeCount`；`expectedShare=Σ P[c]²`；`S` 使用双侧归一化，保证恒在 `[-1,1]`：`S = edgeCount==0 ? 0 : expectedShare>=1 ? 1 : sameShare>=expectedShare ? (sameShare-expectedShare)/(1-expectedShare) : (sameShare-expectedShare)/expectedShare`。即随机混合时 `S=0`，全部同层时 `S=1`，无同层边时 `S=-1`；无边时必须同时输出 `edgeCount=0`，不得用 `S=1` 冒充完全隔离。
- `Mup = count(alive && lastAscentTick!=null && lastAscentTick >= t-metrics.mobilityWindowDays+1) / max(aliveCount,1)`；`t<metrics.mobilityWindowDays` 时窗口从 0 开始。`Mdown` 同法使用 `lastDescentTick`，包含被动跌落和主动降阶。二者均在 `[0,1]`，不使用 EMA、不按日频截断。
- 同时计算中位数、前 `metrics.topWealthShareFraction` 财富占比、`metrics.flowWindowDays` 转移矩阵、跨层边、平均度、连通分量、死亡率、竞争损耗率、Jev 回退率。

前 `metrics.topWealthShareFraction` 按 `ceil(metrics.topWealthShareFraction×n)` 个最高 Value 个体计算；n=0 或财富总和 0 时占比为 0，并附空人口标记。竞争损耗率窗口内为 `(loserLoss-winnerGain)/loserLoss`，无损失时为 0。

### 阶段 H：慢变量更新

每个 tick 根据 G 阶段指标计算下一 tick 的 E：

```text
Congestion=clamp((P0[c]/max(P[c],dynamics.emptyClassPopulationFloor))^η, congestionMin, congestionMax)
Polarization=clamp(exp(κ×z[c]×(G-Gref)), polarizationMin, polarizationMax)
Eraw=env0[c]×Congestion×Polarization
E[next,c]=(1-ρE)×E[t,c]+ρE×Eraw
```

空阶级 `P[c]=0` 时按公式 `P0[c]/dynamics.emptyClassPopulationFloor` 计算；若该阶级初始就为空（`P0[c]=0`），Congestion 落到 `congestionMin`，**不会**获得额外机会。因此“空阶级提高机会”只适用于初始占比为正、后来被抽空的阶级；初始为空的阶级在 v3 中没有入口激励。该语义必须在 P1.5-02 评估，若需要入口激励应升级 rules-v4，不得在 v3 静默改公式。存活人数为 0 时 F 阶段跳过网络重构，G 阶段记录最终指标，随后结束 run：早于最后计划 tick 记 `extinct`，恰在最后计划 tick 则记 `scheduled` 且 `finalAliveCount=0`；两种情况 H 都不再执行，也不再有后续 step。

仅在决策周期更新 O，`Δt=tick-lastOpennessUpdateTick`，更新后写回 `lastOpennessUpdateTick=tick`；tick 0 的 `Δt=0`，首次更新不改变 O：

```text
Otarget=sigmoid(θ0+θM×(Mup-Mref)-θG×(G-Gref)-θS×(S-Sref))
O=O+(Otarget-O)×(1-exp(-Δt/τO))
```

`openness.updateMode=fixed` 时跳过上述 O 更新，O 始终保持 `openness.initial`；该开关必须作为可哈希配置项实现（P1-10），不得用极大 `τO` 近似。同一 tick 不得用新 E/O 回头重算刚完成的 gain/cost/network。

## 7. 不变量

每 tick 在 debug/test 中断言：

1. Value、life、E、gain、need、cost 全部有限；Value/remainingLife/baselineSum/classAge 不为负。
2. classIndex/maxClassIndex 在合法范围且 max>=current；alive=false 后状态除审计字段外不再改变。
3. ties 对称、无自连/重边、度<=`network.maxDegree`、死亡者无边。
4. `O/Mup/Mdown/G` 在 `[0,1]`，`S` 在 `[-1,1]`，`edgeCount>=0`，E>0；P 在有存活者时和为 1。
5. 每 tick 每发起方最多一次主动行动、每目标最多一场竞争；不重复扣费/转移。
6. 胜者收益<=败者损失；默认参数下同层/跨层最大传递效率分别为 70%/87.5%，合法域由 `baseTransferEfficiency×directionMultiplier<=1` 保证。
7. 任何需求、成本或慢变量不得在同 tick 被二次追溯结算。
8. 序列化/恢复后的权威状态哈希一致，连续运行与快照恢复一致。
9. `needMultiplier` 长度为 C、非递减、`needMultiplier[0]=1`；`initialAgeMode` 只影响初始化，不影响其他随机流。
10. `lastAscentTick/lastDescentTick` 单调且不超过当前 tick；Mup/Mdown 的分子只统计存活者。
11. `S` 恒在 `[-1,1]`：随机混合时接近 0，全部同层时为 1，无同层边时为 -1；`edgeCount=0` 时 `S=0`。
12. `returnDiscount` 长度固定为 3，依次对应 `d=1/2/>=3`；修改任一项必须改变对应距离的上升成本（默认 `returnDiscount[0]=0` 时该项不可观测，需用非零测试值覆盖）。

## 8. 规则到模块映射

| 规则  | 模块                          | 验收重点                                                 |
| ----- | ----------------------------- | -------------------------------------------------------- |
| 1–4   | config/init/accumulation      | 属性分布、F(1)、机会积累                                 |
| 5–8   | need/class                    | 历史积分、缓冲、needMultiplier、belowNeedLimit、主动降阶 |
| 9–11  | class/cost                    | 动态成本、重返减免、一次一层                             |
| 12–19 | competition                   | 能力、方向、损耗、目标占用                               |
| 20–25 | life                          | 初始年龄、寿命分布、decay、hard 损耗、死亡               |
| 26–29 | experiment/macros             | 长窗口、非强制结构、反馈边界                             |
| 30–32 | network/macros                | 状态完整、慢变量、调整后 S、365 日流动                   |
| 33–37 | feedback/accumulation/need    | E、有界反馈、Opportunity、历史需求与 ψ                   |
| 38–41 | network/legal-actions         | 初始/重构、70/30、Jev 边界                               |
| 42–45 | feedback/openness             | Otarget、τO、动态跨越、双路径                            |
| 46–49 | rng/experiment/replay         | 地址随机、init_age、三类实验、微扰、重放                 |
| 50–53 | macros/labels                 | 指纹、D、阈值表、聚类判异                                |
| 54–59 | invariants/engine/calibration | 空态、顺序、30 种子、消融、稳定性                        |

## 9. 事件最小字段

所有事件含 `schemaVersion/runId/tick/seq/type`。Value 变化事件另含 `agentId/before/delta/after/cause/referenceId`；竞争含双方、power、pA、winner、loss、gain；阶级事件含 from/to/cost/reason；决策失效含原行动和原因（取值见 §5）。事件 seq 按固定管线递增，不能使用 wall-clock 排序。

竞争事件中的 `pA` 必须有限且位于 `(0,1)`：`power` 全程在 log 空间计算，跨层乘子只接受严格正值（`(0,1.25]`，端点 0 被配置校验拒绝）。任一 power 或乘子非有限属于不变量失败，必须抛错而非 clamp；否则 `-Inf−(−Inf)=NaN` 会让 `r<pA` 恒假，静默地把发起方判为必败。
