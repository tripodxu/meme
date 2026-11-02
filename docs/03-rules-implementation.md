# 03 规则实现规格

> 本文把 `rule.md` 的 59 条规则转成唯一结算口径。默认数值用于首轮校准，不代表已验证结论。任何行为变化必须升级 `rulesVersion`、更新 golden fixture 和本文。

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

| 字段 | 类型/单位 | 说明 |
|---|---|---|
| `id` | 稳定字符串 | 初始化后不变，禁止复用死亡者 ID |
| `alive` | boolean | 死亡后不可逆 |
| `classIndex` | int `[0,C-1]` | 当前阶级 |
| `maxClassIndex` | int | 历史最高阶级，初始等于初始阶级，只升不降 |
| `value` | number >=0 | 当前财富 |
| `ge/hard` | number >0 | 天赋/努力，运行期不变 |
| `initialLife/remainingLife` | 日 | 初始寿命预算与剩余寿命 |
| `classAge` | 日 | 当前阶级已完成停留日数，进入当日结算后为 1 |
| `baselineSum` | Value | 当前阶级历史基准积累积分 |
| `belowNeedStreak` | tick | 连续低于 50% 需求线的次数 |
| `ties` | AgentId[] | 无向关系，序列化时排序，最大 6 |
| `deathTick/deathReason` | nullable | 死亡审计信息 |

### 2.2 SocietyState

| 字段 | 说明 |
|---|---|
| `tick` | 下一个待结算 tick |
| `agents` | 全部个体，含死亡者；按 ID 排序序列化 |
| `E[C]` | 当前 tick 使用的有效阶级机会系数 |
| `O` | 当前社会开放度 |
| `P0[C]` | 初始人口占比，以实际人数计算，不直接用配置理想比例 |
| `G/P/S/Mup/Mdown` | 最近完成 tick 的宏观值 |
| `flowMatrix` | 配置窗口内阶级转移计数；窗口规则版本化 |
| `lastOpennessUpdateTick` | 计算开放度的 Δt，防止重复更新 |
| `ruleset/config/seed` | 完整不可变输入及 hash |

事件、日志、视图缓存和 wall-clock 时间不得进入权威状态哈希。快照必须包含未来结算所需的全部上述字段。

## 3. 配置默认值

| 组 | 参数 |
|---|---|
| 人口 | `C=5`，初始比例 `[0.45,0.30,0.15,0.08,0.02]`，`initialValue=0` |
| 机会 | `B=2`，`env0=[1,1.5,2.2,3.2,4.5]` |
| 寿命 | `decay=[1.30,1.15,1.00,0.88,0.75]`，初始寿命正态均值 25550、标准差 1825 日，截断 `[3650,43800]` |
| 属性 | `ge/hard` 为独立截断对数正态，底层 `sigma=0.5`、中位数 1、截断 `[0.2,3.0]` |
| 努力函数 | `F(h)=(1-exp(-1.2h))/(1-exp(-1.2))` |
| 需求 | 阈值 0.5，连续 14 tick 被动跌落，`buffer(age)=clamp((age-1)/29,0,1)` |
| 主动降阶 | `descendCost=7×B×E[t,currentClass]` |
| 上升 | `crossDays=[30,40,50,60]`，`crossBase=crossDays[c]×B×E[t,c+1]` |
| 重返 | 距历史最高阶级 `d=1/2/>=3` 时减免 `0/0.20/0.40` |
| 竞争能力 | `power=(1+Value)^0.35×ge^0.6×hard^0.4` |
| 跨层能力 | 原发起方 ×0.85，原被竞争方 ×1.15，同层均 ×1 |
| 竞争转移 | 失败者损失自身 Value 的 8%，基础传递效率 70% |
| 方向修正 | 原发起方高打低获胜 ×0.5；低打高获胜 ×1.25；其他获胜 ×1 |
| 网络 | 最大度 6、目标初始度 4、`rewireProb=0.05`、`H=1.2`、`hV=0.4` |
| 目标候选 | 最多 6 个，局部网络概率 0.70，全局概率 0.30 |
| 网络机会 | `β=0.6`，乘子截断 `[0.70,1.50]` |
| 动态 E | `ρE=0.03`、`η=0.35`、`κ=0.8`、`Gref=0.25` |
| 拥挤/分化 | Congestion 截断 `[0.80,1.20]`，Polarization 截断 `[0.85,1.18]` |
| 开放度 | `O0=0.5`、`τO=60`、`θ0=0`、`θM=8`、`Mref=0.10`、`θG=6`、`θS=4`、`Sref=0.65`、`λO=2` |
| 跨越动态乘子 | 截断 `[0.50,2.50]` |
| 流动率 | 30 日 EMA，平滑系数 `αM=1-exp(-1/30)`，结果截断 `[0,1]` |

### 3.1 合法配置域

| 字段组 | 约束 |
|---|---|
| 人口/阶级 | `initialPopulation` 为 `[2,10000]` 整数；`C` 为 `[2,8]` 整数；初始比例非负且 `abs(sum-1)<=1e-12`；initialValue>=0 |
| 数组 | env0/decay 长度为 C，crossDays 长度为 C-1；env0/crossDays/B>0；`0<=decay<=3` |
| 分布 | ge/hard 的 sigma>=0、截断满足 `0<min<=median<=max`；寿命 `0<min<=mean<=max`、sigma>=0 |
| 需求/跨越 | needThreshold 在 `[0,1]`；belowNeedLimit>=1 整数；bufferDays>0；descendDays>0；重返减免在 `[0,1]` |
| 反馈 | β/η/κ/λO/H/hV>=0（消融值 0 合法）；`0<ρE<=1`；τO>0；Gref/Mref/Sref 在 `[0,1]`；θM/θG/θS>=0，θ0 有限且在 `[-20,20]` |
| 网络/候选 | v2 `maxDegree=6`；initialDegree 为 `[0,6]` 整数；competitionCandidateCount 为 `[0,6]` 整数；localTargetProbability 在 `[0,1]`，global 概率恒为 `1-localTargetProbability` |
| 竞争 | lossRate 在 `[0,0.5]`；baseTransferEfficiency 和各方向乘子在 `[0,1.25]`；所有 `baseTransferEfficiency×directionMultiplier<=1` |
| 决策 | decisionInterval/topK 为正整数，topK<=9；topK 实际还不得超过当次合法行动数；timeout/预算为正且有限 |
| 调度 | totalTicks>=1、statsStride/snapshotStride>=1 整数；statsStride<=totalTicks |

MVP 不允许负 decay，因此寿命不会因阶级而反向增加；`rule.md` 中“可能为负”留作未来规则版本。除表中显式允许 0 的参数外，不得用“正参数”笼统推断范围。所有 schema-valid 配置必须满足收益不超过损失等核心不变量；运行端可进一步限制人口/预算，但不得放宽数学合法域。`totalTicks/statsStride/snapshotStride` 属于 RunConfig 并被 `configHash` 覆盖，05 的顶层 `schedule` 只是服务端索引镜像。

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
- **截断分布**：ge/hard/life 分别使用 `init_ge/init_hard/init_life`；每次拒绝后 a+=1，lognormal=`exp(sigma×z)`，正态=`mean+sigma×z`。每个属性独立计数，直到落入截断区间。

### 4.3 初始化顺序与地址

1. 校验配置，用最大余数法转为精确人数；余数并列时优先较小 classIndex。生成对应阶级的多重集合并按 classIndex 排序。
2. 以 `agentId="population"`、`eventTag="init_class_shuffle"` 对上述数组做 Fisher–Yates，再按稳定 agentId 顺序分配。
3. 按 agentId 依次用独立 tag 生成 ge/hard/initialLife；属性之间不共享 counter。
4. 初始化 Value=0、寿命余量=初始寿命、classAge/baselineSum/belowNeedStreak=0、maxClass=当前阶级。
5. `E=env0`、`O=0.5`、宏观值由初始状态计算，Mup/Mdown=0。
6. 按 agentId 顺序为未达目标初始度者加边，直到度 4 或无合法候选。每个体的 `network_init` counter 从 0 开始，每成功加一条边后 +1；候选为空不加边也不继续消费。

网络候选必须双方存活、非自身、未连边、双方度均小于 6，按初始权重 `w=exp(-H×|classDiff|-hV×|logValueDiff|)` 抽样。

### 4.4 运行期地址表

| 行为 | agentId/eventTag/counter |
|---|---|
| 行动顺序 | 每个到期 agent 计算 `R(seed,tick,id,"action_order",0)`，按 `(值,id)` 升序，不用共享洗牌流 |
| 竞争候选槽位 k | `id/"competition_candidate"/2k` 选 local/global，`2k+1` 选目标；每槽最多这两个地址 |
| mock 行动 | `id/"mock_action"/0` |
| random 行动 | `id/"random_action"/0` |
| Jev topK | `id/"jev_topk"/0`，每次最终响应最多消费一次 |
| 竞争胜负 | 原发起方 `id/"competition_resolve"/0` |
| 网络重构判定 | `id/"network_rewire"/0`，每决策周期每 agent 都消费 |
| 选旧关系/新关系 | 同 tag counter 1/2；判定成功且有旧边才消费 1，随后无论是否有新候选都消费 2 |

## 5. 合法行动与执行前复核

```text
accumulate
ascend                  # 非最高层且期初费用足够
descend                 # 非最低层且期初费用足够
compete:<agentId>       # 最多 6 个由代码采样的存活目标
```

- 竞争目标生成：槽位 k 从 0 开始，先消费来源地址，以 0.70 选邻居、0.30 选全局；再消费目标地址，从该来源的剩余合法目标中均匀抽样。来源为空则用目标地址在另一来源抽样；若已选满 6 个或全局剩余目标为 0 即停止，不为空槽继续消费。去除已选目标本身就是无放回，不做重复拒绝抽样。
- 候选排序稳定，先按行动类型，再按 agentId；展示顺序不得改变 RNG 结果。
- Jev 只看见这些合法行动。执行顺序按 4.4 的每 agent `action_order` 随机键排序。
- 因前序竞争导致费用不足、目标已被作为目标、目标死亡或关系已变化时，执行前重新校验；失效行动记 `stale_invalid`，不执行主动行动，仍进入日常积累。目标占用集合为 `targetedAgents`：作为发起方不阻止其另作为目标；A→B 后 B→C 合法，但任何再次以 B 为目标的行动非法。
- `accumulate` 不收取额外费用，只表示本 tick 不做升降/竞争。

## 6. 单 tick 唯一结算顺序

### 阶段 A：期初快照与决策

使用 tick t 的期初状态生成合法行动和决策。E、O 和宏观慢变量在本阶段不得被决策过程修改。

### 阶段 B：主动行动

按洗牌顺序逐一执行，立即改变 Value/阶级/竞争占用标记。

**上升**：

```text
d = maxClassIndex - classIndex
discount = d<=1 ? 0 : d==2 ? 0.20 : 0.40   # 首次上升d=0与返回上一层d=1均无减免
openMultiplier = clamp(exp(λO×(0.5-O)),0.50,2.50)
cost = crossBase×(1-discount)×openMultiplier
```

支付 cost，`classIndex+=1`，更新 maxClass，重置 classAge=0、baselineSum=0、belowNeedStreak=0。一次只能上升一层。

**主动降阶**：支付 `7×B×E[t,current]`，阶级减 1，重置上述阶级停留字段。maxClass 不变。

**竞争**：

1. 原发起方 A、原目标 B 的身份和方向冻结，不因后续 Value 改变。
2. `powerA/B` 使用当前 Value/ge/hard，跨层分别乘 0.85/1.15，同层乘 1。
3. `pA=powerA/(powerA+powerB)`；用 `R(seed,tick,A.id,"competition_resolve",0)` 判定，只消费发起方地址下的随机数。
4. loser 损失 `loss=min(loser.value,0.08×loser.value)`。
5. winner 获得 `gain=loss×0.70×directionMultiplier`；directionMultiplier 仅按原发起方是否获胜及原方向确定，防守方获胜恒为 1。
6. 先扣 loser，再加 winner，双方 Value 不得为负。竞争本身不改变阶级。

**成功主动升降**设置 `activeClassChanged=true`，本 tick 被动跌落跳过；竞争和 accumulate 不设置。

### 阶段 C：日常积累与需求

对所有此时仍存活个体，按稳定 agentId 顺序独立计算：

```text
Opportunity = clamp(exp(β×(log(1+median(neighborValues))-log(1+median(allAliveValues)))),0.70,1.50)
gain = B×E[t,class]×ge×F(hard)×Opportunity
Value += gain
baselineSum += B×E[t,class]
classAge += 1
need = buffer(classAge)×baselineSum
```

- 邻居只取当前存活者；无邻居 Opportunity=1。
- 全体中位数含本个体；偶数取中间两数均值；无存活人口时不再执行积累。
- 本阶段基于同一阶段期初 Value/网络快照计算全部 Opportunity，再统一应用 gain，避免 agentId 顺序影响结果。
- 主动变动阶级者已在 B 清零，因此在 C 累积新阶级的第一天；首日 buffer=0。

### 阶段 D：被动跌落

仅对未成功主动变动阶级的存活者：

```text
if Value < 0.5×need: belowNeedStreak += 1
else: belowNeedStreak = 0
if belowNeedStreak >= 14 and classIndex > 0: classIndex -= 1
```

跌落后重置 classAge=0、baselineSum=0、belowNeedStreak=0，maxClass 不变；每次最多跌一层。最低层即使持续低于需求也不跌落，streak 可保留 14 但不得继续增长无意义，实现可固定为 14。需求为 0 时严格比较 `Value<0`，因此不会触发。

### 阶段 E：寿命与死亡

对仍存活者：

```text
loss = decay[classIndex]×max(0.6,1+0.15×(hard-1))
remainingLife = max(0,remainingLife-loss)
if remainingLife==0: alive=false, deathTick=t, ties从所有邻居移除
```

使用被动跌落后的阶级，不追溯历史。死亡者当天已完成的积累/行动仍保留在事件和当日统计中；从下一 tick 不再参与。

### 阶段 F：网络重构

仅在决策周期且仍有存活者时执行，使用当前 O 和存活网络。按 agentId 顺序，每人以 `rewireProb` 尝试一次：

1. 有关系才尝试；均匀选一条旧边 `(i,j)` 并暂时移除。
2. 新候选为存活、非 i、当前无连边、双方度合法且不是 j 的个体。
3. 权重 `w=exp(-H×(1-O)×|classDiff|-hV×|logValueDiff|)`。
4. 无候选则恢复旧边；有候选则加一条新边。一次最多替换一条。

所有抽样使用 `network_rewire` 独立地址。最终结果必须无自连/重边，度不超过 6。

### 阶段 G：宏观指标

在行动、死亡和网络完成后计算：

- `P[c]=存活且class=c人数/存活人数`；无存活者时全 0，并单独报告 `aliveCount=0`。
- Gini：存活者 Value 升序 `x[i]`，`G=Σ(2i-n-1)x[i]/(nΣx)`，i 从 1 开始；总和为 0 时 G=0。
- `S=同阶级无向边数/全部无向边数`，无边时 S=1。
- 原始年化流动 `rawUp=365×upEventsThisTick/max(aliveAtTickStart,1)`，down 同理；分母固定为 tick 期初存活数。
- `Mup=clamp(Mup+αM×(rawUp-Mup),0,1)`，Mdown 同理。
- 同时计算中位数、前 10% 财富占比、转移矩阵、跨层边、平均度、连通分量、死亡率、竞争损耗率、Jev 回退率。

前 10% 按 `ceil(0.1×n)` 个最高 Value 个体计算；n=0 或财富总和 0 时占比为 0，并附空人口标记。竞争损耗率窗口内为 `(loserLoss-winnerGain)/loserLoss`，无损失时为 0。

### 阶段 H：慢变量更新

每个 tick 根据 G 阶段指标计算下一 tick 的 E：

```text
Congestion=clamp((P0[c]/max(P[c],0.02))^η,0.80,1.20)
Polarization=clamp(exp(κ×z[c]×(G-Gref)),0.85,1.18)
Eraw=env0[c]×Congestion×Polarization
E[next,c]=(1-ρE)×E[t,c]+ρE×Eraw
```

空阶级 P=0 按公式提高机会，但不得超过上限。存活人数为 0 时 F 阶段跳过网络重构，G 阶段记录最终指标，随后结束 run：早于最后计划 tick 记 `extinct`，恰在最后计划 tick 则记 `scheduled` 且 `finalAliveCount=0`；两种情况 H 都不再执行，也不再有后续 step。

仅在决策周期更新 O，Δt=距上次更新的 tick 数：

```text
Otarget=sigmoid(θ0+θM×(Mup-Mref)-θG×(G-Gref)-θS×(S-Sref))
O=O+(Otarget-O)×(1-exp(-Δt/τO))
```

同一 tick 不得用新 E/O 回头重算刚完成的 gain/cost/network。

## 7. 不变量

每 tick 在 debug/test 中断言：

1. Value、life、E、gain、need、cost 全部有限；Value/remainingLife/baselineSum/classAge 不为负。
2. classIndex/maxClassIndex 在合法范围且 max>=current；alive=false 后状态除审计字段外不再改变。
3. ties 对称、无自连/重边、度<=6、死亡者无边。
4. O/S/Mup/Mdown/G 在 `[0,1]`，E>0；P 在有存活者时和为 1。
5. 每 tick 每发起方最多一次主动行动、每目标最多一场竞争；不重复扣费/转移。
6. 胜者收益<=败者损失；同层/跨层最大传递效率分别为 70%/87.5%。
7. 任何需求、成本或慢变量不得在同 tick 被二次追溯结算。
8. 序列化/恢复后的权威状态哈希一致，连续运行与快照恢复一致。

## 8. 规则到模块映射

| 规则 | 模块 | 验收重点 |
|---|---|---|
| 1–4 | config/init/accumulation | 属性分布、F(1)、机会积累 |
| 5–8 | need/class | 历史积分、缓冲、14 日、主动降阶 |
| 9–11 | class/cost | 动态成本、重返减免、一次一层 |
| 12–19 | competition | 能力、方向、损耗、目标占用 |
| 20–25 | life | 分布、decay、hard 损耗、死亡 |
| 26–29 | experiment/macros | 长窗口、非强制结构、反馈边界 |
| 30–32 | network/macros | 状态完整、慢变量 |
| 33–37 | feedback/accumulation/need | E、有界反馈、Opportunity、历史需求 |
| 38–41 | network/legal-actions | 初始/重构、70/30、Jev 边界 |
| 42–45 | feedback/openness | Otarget、τO、动态跨越、双路径 |
| 46–49 | rng/experiment/replay | 地址随机、三类实验、微扰、重放 |
| 50–53 | macros/labels | 指纹、D、阈值表、显著性 |
| 54–59 | invariants/engine/calibration | 空态、顺序、30 种子、消融、稳定性 |

## 9. 事件最小字段

所有事件含 `schemaVersion/runId/tick/seq/type`。Value 变化事件另含 `agentId/before/delta/after/cause/referenceId`；竞争含双方、power、pA、winner、loss、gain；阶级事件含 from/to/cost/reason；决策失效含原行动和原因。事件 seq 按固定管线递增，不能使用 wall-clock 排序。
