# 07 实验设计与校准计划

## 1. 目标与证据标准

校准要回答四个不同问题：

1. 参数变化是否改变宏观结构，而不只是改变个体轨迹？
2. 小扰动在稳定区能否被吸收，在临界区能否被放大？
3. 网络、制度、拥挤和分化反馈是否通过消融体现解释力？
4. Jev 行为与 mock/random 的差异是否可重复，还是外部模型噪声？

任何结论至少需要：完整 manifest、配对种子、规定窗口、分布/区间、失败运行和回退率。禁止只展示成功种子、终局截图或 D 总分。

## 2. 实验类型必须分开

| 类型          | 策略与随机性                    | 唯一改变量                  | 结论用途                          |
| ------------- | ------------------------------- | --------------------------- | --------------------------------- |
| 规则敏感性    | 固定初始人口和 mock；共同随机数 | 一个规则参数                | 规则对结构的影响                  |
| 微扰-决策重放 | 同检查点、同已存决策日志        | 一个体/参数                 | 隔离扰动传播，不重新问模型        |
| 微扰-策略重跑 | 同检查点、同策略配置            | 一个体/参数，模型可重新回答 | 包含行为反馈的总敏感性            |
| Jev 行为      | 固定模型/prompt/初始人口        | 策略或模型版本              | 与 mock/random 对照，保存全部原答 |
| 消融          | 同初始人口和策略                | 一个反馈开关                | 机制解释力                        |

不同类型的结果不得直接混成同一统计样本。live 与 replay 必须分别报告。

## 3. Manifest 契约

每个批次至少保存：

```json
{
  "schemaVersion": "experiment-v2",
  "experimentId": "exp_...",
  "preregistrationHash": "sha256:...",
  "hypothesis": "Registered before the full run",
  "primaryMetric": "TV(P)",
  "experimentType": "rule_sensitivity",
  "rulesVersion": "rules-v11",
  "engineVersion": "...",
  "decisionSchemaVersion": "stratify-decision-v1",
  "policyVersion": "mock-weighted-v1",
  "promptVersion": "prompt-v3",
  "promptStyle": "neutral",
  "requestedModel": "mock",
  "observedResponseModels": [],
  "runtimeVersions": [],
  "codeSha": "...",
  "populationSize": 1000,
  "baseConfigHash": "sha256:...",
  "artifactProfile": "metrics-only",
  "cells": [
    {
      "cellKey": "needMultiplier=default",
      "design": "single",
      "changedPaths": ["need.needMultiplier"],
      "overrides": { "need.needMultiplier": [1.0, 1.3, 1.8, 2.5, 3.5] },
      "fullConfigHash": "sha256:..."
    },
    {
      "cellKey": "v5:cushionDays=90+phi=0",
      "design": "interaction",
      "changedPaths": ["ascent.holdingCushionDays", "need.envExponent"],
      "overrides": { "ascent": { "holdingCushionDays": 90 }, "need": { "envExponent": 0 } },
      "fullConfigHash": "sha256:..."
    }
  ],
  "seeds": ["s-000", "s-001"],
  "pairing": "same-seed-derived-initial-population-and-addressed-random",
  "warmupTicks": 365,
  "warmupDiagnostic": "90-day rolling mean change < threshold on P/G/O",
  "windows": [{ "start": 365, "end": 1094, "label": "w1" }],
  "labelThresholdVersion": "labels-v3",
  "labelThresholdsHash": "sha256:...",
  "budgets": { "maxRuns": 3000, "maxWallMinutes": 10080, "maxStorageBytes": 500000000000 },
  "createdAt": "ISO-8601"
}
```

完整扫描前冻结假设、primary metric、窗口、种子列表、标签阈值和排除规则，并把它们的 canonical hash 写入 `preregistrationHash`。

`cells[].overrides` 的键必须是 `RunConfig` 点路径（与 `src/core/params.ts` 的注册名一致），值为完整替换值：标量直接替换，数组整体替换，嵌套对象按字段深合并。应用方式为深拷贝 base config 后逐项赋值，结果必须通过 `validateRunConfig`；`fullConfigHash` 是合并后完整配置的 `configHash`。未登记的键、非法值或校验失败必须拒绝该 cell，不得跳过。`populationSize` 必须等于 base config 的 `population.initialPopulation`；若某个 cell 覆盖人口规模，必须作为独立 cell 记录并纳入 `fullConfigHash`，不得用同一 `populationSize` 冒充。

`cells[].design` 是**可判定的归因声明**，取 `baseline|single|interaction`：

- `baseline`：零覆盖，只作对照；`changedPaths` 必须为空。
- `single`：恰好改变一个叶子参数（§6.2「每次只变一项」），其效应可单轴归因。
- `interaction`：同时改变 ≥2 个叶子参数（§6.3 小型 factorial），**只回答「联合条件是否可达某结构」**，不得把该 cell 的差异归因到其中任一单轴。

`cells[].changedPaths` 由 base config 与该 cell 合并后配置的实际差异**自动派生**（数组视为单个叶子，不按下标展开），不得手写；构造期校验 `design` 与 `changedPaths.length` 自洽（`baseline=0`、`single=1`、`interaction≥2`），不自洽直接抛错。同一网格内两个 cell 的 `fullConfigHash` 相同也属于非法（重复格点白耗预算），同样在构造期拒绝。

该声明存在的理由：cell 名会谎报。`v5:geMedian=0.7+cushion30` 曾把 `holdingCushionDays` 写成 30，而 30 恰是默认值——该 cell 实际只改 `ge.median`，与 `v4:geMedian=0.7` 配置完全相同，既不是交互格点，也不是新信息（changes/0007）。

`artifactProfile` 取 `full|metrics-only`：`full` 保存完整事件/决策/快照，用于审计与回放证据；`metrics-only` 只保存配置、初始/最终快照、全分辨率 tick metrics 和聚合，用于大规模扫描筛选。两者都不得伪造缺失数据；`replayable=true` 仍要求初始快照加全部到期决策。

`budgets` 的示例数字是占位值；真实 `maxRuns/maxWallMinutes/maxStorageBytes` 必须由 P1.5 基准冻结（待议 D-04），不得直接用于正式 P6 扫描。

`labelThresholdsHash` 是对完整标签阈值表（含 `monotonicTolerance/modeTolerance` 与各条件）计算的语义 hash，domain 为 `stratify-label-thresholds-v1`（P1-02 注册并提供向量）；只记录 `labelThresholdVersion` 不足以防止阈值被静默修改。

`preregistrationHash` 的权威口径：

- 覆盖：`schemaVersion`、`hypothesis`、`primaryMetric`、`experimentType`、`rulesVersion/engineVersion/decisionSchemaVersion/policyVersion/promptVersion/promptStyle`、`baseConfigHash`、`artifactProfile`、`cells[].cellKey/design/changedPaths/overrides/fullConfigHash`、`seeds`、`pairing`、`warmupTicks`、`warmupDiagnostic`、`windows`、`labelThresholdVersion`、`labelThresholdsHash`、`clustering`、`differenceThresholds`、`budgets` 和预注册排除规则。
- 排除：`experimentId`、`createdAt`、`observedResponseModels`、`runtimeVersions`、运行结果、失败次数等创建后或运行后字段。

哈希预像由 `buildPreregHashInput()` 单独构造并导出，`computePreregistrationHash()` 只是对预像做域分隔哈希；测试直接枚举预像字段清单与 §3 权威口径比对。理由：`hashValue` 不校验字段，漏一个字段不会报错，只会让「设计变了而哈希不变」静默存在（changes/0006 曾漏 6 个字段）。

排除规则必须是**可判定的字段**，不能只是散文：

```json
{
  "excludeExtinctRuns": true,
  "excludeUnavailableWindows": true,
  "excludeNetworkEmptyFromSegregation": true,
  "maxTechnicalRetries": 1
}
```

`baseConfigHash` 是 base config（默认配置 + 预注册人口与调度，**不含任何 cell overrides**）的
`configHash`；`cells[].fullConfigHash` 是该 cell 深合并并校验后完整配置的 `configHash`。
二者都必须进预注册哈希：只记录 `overrides` 时，默认配置变化会让产物变化而哈希不变。

使用 `mock`/`random` 策略时 `promptVersion` 取显式的 `prompt-none-v1`（不是 `null`
也不是空串），`promptStyle` 取 `neutral`：字段必须存在于哈希输入，接入 Jev 后替换为真实版本
并新建 `experimentId`。

`HASH_DOMAINS.config` 的域前缀 `stratify-config-v1` 是**哈希契约**，与
`CONFIG_SCHEMA_VERSION`（配置字段 schema）是两条独立的轴，后者升版不改变前者。

运行后不得因结果不理想删除种子；技术失败可重跑，但必须保留失败原因和次数。任何预注册内容变化必须新建 `experimentId`，不得覆盖旧实验。

## 4. 配对与共同随机数

- 一个 seed 对应由 `(config, seed)` 纯函数派生的初始人口、初始网络和地址化随机序列；不得另行传入独立 roster，否则配对与哈希校验不成立。对照单元使用同一 seed。
- 参数改变导致合法行动变化是允许的结果，不能为保持行动相同而强制改写规则。
- 为隔离纯传播，可使用同一检查点和决策日志重放；这与策略重跑是另一实验。
- 初始化、竞争、网络、topK、init_age 使用不同 eventTag；分析用 bootstrap 随机数不得消耗模拟 RNG。
- 规则敏感性/mock 单元至少 30 个配对种子。live Jev 受请求/成本限制，默认 5–10 个种子、40 人、730 tick、`decision.interval=30`，单独报告，不与 30 种子 mock 样本合并。区间过宽或结构混合时增加样本并报告，不以挑选子集代替。

## 5. 时间窗口与预处理

结构实验默认 3650 tick：候选 burn-in 365 tick，但必须用平稳性诊断确认；不平稳则延长 burn-in 并重新预注册，不得把排序暂态当作结构。平稳性判据固定为：相邻两个 90 日块的滚动均值满足 `max(TV(P_block), |ΔG|, |ΔO|) < 0.01`，且连续两次检查通过；`TV(P_block)` 用 07 §8 的定义。90 日窗口只用于 burn-in 诊断，正式统计使用 30 日块，二者不得混用。正式判断使用至少 730 tick 窗口。建议预注册三个不重叠窗口：

```text
w1: 365–1094   w2: 1095–1824   w3: 2555–3284
```

**v5 轮 2 修订（2026-11-03，待重跑验证）**：P1.5 v5 轮 2 观测到 w1 的 90 日块 `TV(P)` 在 0.03–0.23 持续振荡，平稳性判据永不通过（极限环系统），因此按本节“不平稳则延长 burn-in 并重新预注册”把 `warmupTicks` 延长至 1825，并把诊断改为**吸引子稳定性**（同一 run 的 w2b/w3 特征点应落入同一簇）。对应窗口为：

```text
w2b: 1825–2554   w3: 2555–3284
```

该修订只改变预注册与窗口，不改变本节统计算法；w1/w2 仍可用于诊断，但不得在运行后据此挑选有利窗口。实现必须真实产出 w2b 并在同一 z-score 空间比较 w2b/w3，否则时间一致性结论无效（见 `docs/reviews/2026-11-03-zcodes-nightly-audit.md`）。

也可以只用后期 w2/w3 做持续判异，但不能运行后选择最有利窗口。每日高度自相关，统计时使用 30 日块均值或窗口汇总，不把 730 天当作 730 个独立样本；相邻窗口不构成独立复现。块边界固定为窗口起点起每 30 日一块；窗口长度不是 30 的整数倍时，末尾不足 30 日的残块并入前一块（不足 15 日时不得单独成块），并在报告中标记 `partialBlockMerged`。窗口短于 30 日时整窗作为单一 block，标记低功效，不得据此宣称显著。

每个窗口输出：均值、中位数、标准差、30 日块序列、末值和缺失率；P/G/top10/Mup/Mdown/S/O/edgeCount 必须同时保留。窗口标量的唯一算法如下：

- P/G/top10/Mup/Mdown/S/O/E：对窗口内全分辨率 tick 数据取算术平均；仅当该 run 的 `statsStride=1` 时才可直接从 D1 `tick_stats` 复算。D1 的采样行只用于展示，不得把采样均值冒充每日均值。30 日块只用于观察自相关和稳定性，不再二次加权。D 和标签使用这些日均值。
- 全死亡日的处理是硬约束：结构均值只对 `aliveCount>0` 的行求平均，`aliveCount=0` 的行（含「末 tick 才全死亡、`endReason=scheduled` 但 `finalAliveCount=0`」）既不计入分子也不计入分母，并计入 `missingTicks`。窗口摘要必须同时给出 `observedTicks`（实有行数）与 `deadTicks`（其中全死亡行数），以便区分「未跑到」与「跑到但全死」。死亡暴露量与竞争损耗仍按全部实有行累计——全死亡 tick 的死亡数是窗口事件，不得因结构均值剔除而漏计。
- 转移矩阵：按 `metrics.flowWindowDays` 窗口累计事件计数；另给行暴露量（各 tick 期初处于该行阶级的存活人日数），行转移率=该行各去向计数/行暴露量，暴露量为 0 时比率为 null，不能填 0 冒充无转移。
- 死亡率=窗口死亡数/窗口存活人日暴露量（基于全分辨率 tick 数据）；竞争损耗率=Σ(loss-gain)/Σloss，分母 0 时为 0；回退率=fallback 决策数/非 cancelled 到期决策数，分母 0 时为 null。
- Mup/Mdown 的 D 输入是每日 `metrics.mobilityWindowDays` 日参与率的窗口均值，不用窗口事件另算替代；可另报 `metrics.mobilityWindowDays×ΣupEvents/aliveExposure` 作为诊断。
- S 为调整后同层边占比；`edgeCount=0` 的窗口标记 `networkEmpty`，不参与依赖 S 的标签和 O 反馈诊断。
- 窗口中存在全死亡后的缺失日时（含最后一 tick 才全死亡、记 scheduled 但 finalAliveCount=0 的 run），该 run 标 extinct 且该窗口不参与正常结构判异；不得把全死亡后的 P=0 日补入均值。空窗口/全缺失指标为 null 并标记质量无效。

## 6. 扫描顺序

### 6.1 数值与稳定性预检

先用 mock、少量种子做短预检，仅用于排除崩溃/爆炸，不用于结构结论：NaN、负 Value、全死亡、E/O 卡边界、过度回退、明显性能异常均记录。

扫描分两阶段，避免把全部候选值直接跑满 1000 人×3650 tick：

- **Stage A（筛选）**：40/200 人、730 tick、每点 30 个配对种子；只做崩溃/方向/效应量筛选。
- **Stage B（确认）**：1000 人、3650 tick、每点 30 个配对种子，仅对 Stage A 入选单元执行；确认 run 必须 `statsStride=1` 或上传全分辨率 tick metrics artifact。
- 两阶段都满足 rule.md 56 的 30 种子要求；Stage A 不得用于最终结构结论，Stage B 不得复用 Stage A 的择优结果而不做独立种子集确认。
- **种子集分离（D-07，已定）**：探索轮用 `p15-seed-001…030`，确认轮用 `p15r3-seed-001…030`，
  两组**不得重叠**，且确认轮的种子必须在预注册中写死后再运行。沿用探索轮种子等于在同一批种子上择优，
  07 本节与 rule.md 56 的「独立确认」要求都不成立。种子名进入 `seeds` 字段，随 `preregistrationHash` 冻结。

### 6.2 单参数探索扫描

建议起点，不等于最终有效范围；参数简写与配置路径映射见 03 §3，cell 的 `overrides` 必须使用点路径：

| 参数           | 候选值                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| needMultiplier | `[1,1,1,1,1]`（ψ=1 消融）、默认 `[1,1.3,1.8,2.5,3.5]`、扁平 `[1,1.5,1.5,1.5,1.5]`、陡峭 `[1,1.2,1.6,2.2,3.0]`、更陡 `[1,1.4,2.1,3.0,4.2]`                              |
| needThreshold  | 0.3, 0.5, 0.7, 0.9                                                                                                                                                     |
| env0           | 默认、压缩 `[1,1.2,1.5,1.9,2.4]`、扩大 `[1,2,3.5,5,7]`                                                                                                                 |
| crossDays      | 默认、减半、加倍                                                                                                                                                       |
| decay          | 默认、全 1.0、更陡 `[2.0,1.6,1.2,0.9,0.7]`                                                                                                                             |
| β              | 0, 0.2, 0.6, 1.0                                                                                                                                                       |
| η              | 0, 0.20, 0.35, 0.60                                                                                                                                                    |
| κ              | 0, 0.4, 0.8, 1.2                                                                                                                                                       |
| H              | 0.4, 1.2, 2.0                                                                                                                                                          |
| λO             | 0, 1, 2, 3                                                                                                                                                             |
| 竞争损失率     | 0.02, 0.08, 0.15                                                                                                                                                       |
| rewireProb     | 0, 0.05, 0.20                                                                                                                                                          |
| 初始阶级分布   | 默认 `[0.45,0.30,0.15,0.08,0.02]`、底层更重 `[0.60,0.25,0.10,0.04,0.01]`、中层更重 `[0.20,0.30,0.30,0.15,0.05]`、两端更重 `[0.40,0.10,0.10,0.10,0.30]`（完整配置入库） |
| initialAgeMode | `uniform`（默认）、`newborn`（对照；3650 tick 内死亡率接近 0，不参与寿命结论）                                                                                         |

在单参数扫描前先做一次全局筛选（Morris elementary effects 或小型 Sobol），覆盖上表及 `congestionMin/Max`、`polarizationMin/Max`、`Mref/Sref/θM/θS`。不得只凭直觉挑 8 个反馈参数而漏掉主导阶级分布的 `needMultiplier/needThreshold/env0/crossDays/decay`；`initialAgeMode` 作为初始化模式对照单独报告，不与连续参数混合做敏感性排序。每次只变一项，其他冻结；候选值可因护栏/先验试验调整，但要保留搜索历史。

本节格点必须标 `design: 'single'`，且 `changedPaths` 恰好 1 项（§3）。参数值与默认值相同时该格点不产生差异——若格点名声称改变了某参数，而该参数已被默认值吸收，构造期会因 `changedPaths` 计数不符或 `fullConfigHash` 重复而拒绝，不得靠命名蒙混。

### 6.3 多参数与临界区

- 从单参数结果选择影响方向和合理范围，做小型 factorial/Latin hypercube；不得直接无预算全笛卡尔积。
- 在结构指纹变化大的相邻参数间细化网格，定位“参数小变化导致结构类别改变”的区域。
- 同时选择远离边界的稳定区，验证扰动吸收。只找临界区而不验证稳定区不算完成。
- 探索扫描与确认扫描分开；确认使用新的一组预注册种子，避免对同一批种子反复择优。
- factorial 格点必须标 `design: 'interaction'` 并声明 ≥2 个 `changedPaths`；其结论只能表述为「该联合条件下结构 X 可达/不可达」，不得写成「参数 a 使结构变化」，因为交互格点的差异无法归因到单一轴。单轴因果证据只能来自 §6.2 的 `single` 格点。

## 7. 微扰协议

1. 在预注册检查点（默认 burn-in 后 tick 365）保存权威快照和 hash。
2. 克隆 baseline 与 treatment，核对克隆前 hash 完全一致。
3. 默认 `wealth_absolute` 财富扰动从绝对 `ΔValue=0.0001` 开始，Value=0 也加该绝对量；参数扰动从相对 `1e-6` 开始。若另做财富相对扰动，实验类型字段必须写 `wealth_relative` 并记录 `ΔValue=baselineValue×relativeDelta`，不得与默认绝对扰动混称。
4. 若扰动小于序列化精度或 round-trip 后 hash 不变，标记无效并提高精度/幅度，不能报告为“无敏感性”。
5. 使用幅度阶梯（如 1e-6、1e-4、1e-2 相对/绝对量级，按变量定义）描述吸收与放大，不假设任意无穷小都改变结构。每个幅度同时报告首次事件翻转 tick、翻转事件数、首次结构指纹偏离 tick；若 730 天内零事件翻转，只能判“被离散阈值吸收”，不能判“负反馈稳定”。
6. 至少 30 个配对检查点/种子；除声明字段外所有输入一致。
7. 分开运行“固定决策日志重放”和“策略重跑”，前者解释规则传播，后者包含策略适应。

## 8. 结构指纹与距离

D 按 `rule.md` 第 51 条，对窗口汇总指标计算。`primaryMetric` 必须从 `TV(P)`、`G`、`Mup`、`Mdown`、`S`、`O` 中预注册一个（可另报 D 与分项）；D 只用于筛选，不得作为“结构显著改变”的唯一主指标：

```text
D=0.30|ΔG|+0.25×TV(P)+0.20|ΔMup|+0.15|ΔS|+0.10|ΔO|
TV(P)=0.5Σ|P[c]-P'[c]|
```

D 只用于筛选。初始实际差异门槛（可在预注册时调整）：

- `|ΔG| >= 0.03`；或
- `TV(P) >= 0.10`；或
- `|ΔMup| >= 0.05`；或
- `|ΔS| >= 0.05` 且跨层边同向变化；或
- `|ΔO| >= 0.05` 且跨越成本/流动有对应变化。

“结构显著改变”同时要求：

1. 预注册的 primary metric 达到实际差异门槛，不能只靠 D 或事后挑选的次要指标；
2. 配对差异的 95% 区间不跨 0，且效应方向在至少 90% 的配对种子上一致，或使用分层模型给出同向概率；
3. 超出同配置 baseline 跨种子结构波动区间（baseline 两两 D 的 95 分位作为参考）；
4. 在一个主窗口显著，并在独立确认种子集复现；相邻窗口（如 w1/w2）不构成独立复现；
5. 不是由全死亡、NaN、模型大面积回退或数据缺失造成。

不满足但轨迹 hash 不同：报告“轨迹不同、结构证据不足”。不能把 p 值显著但效应极小当作社会结构改变。

### 8.1 聚类协议（P1.5-04/P6-05 必须预注册）

“结构聚类”不是标签计数。预注册必须固定以下内容；未固定即不得声称“三类结构”：

- **特征向量**：窗口均值 `P[c]`、`G`、`top10`、`Mup`、`Mdown`、`S`、`O`（可选 `edgeCount`/平均度）；标准化方法固定（如 z-score，均值/方差来源固定），不得按结果挑特征。
- **特征窗口**：`clustering.featureWindows` 列出每个 run 贡献特征点的窗口（v5 轮 2 为 `['w2b','w3']`）。全部特征点在**同一** z-score 空间聚类；同一 run 的多个特征点落入同一簇的比例即吸引子稳定性，门槛由 `clustering.temporalConsistencyMinRate`（默认 0.8）预注册。不得把某一窗口的特征点投影到另一窗口的质心来代替入簇，也不得在运行后只保留有利窗口。
- **距离与算法**：默认建议 Ward 层次聚类 + Euclidean（待议 D-03，需科学负责人确认）；允许改用其他方法，但必须预注册并说明理由。
- **k 与选择**：`k∈[2,5]`，用 gap statistic/轮廓系数与跨种子稳定性选择；不得运行后按结果改 k。
- **稳定性**：按种子集随机二分重聚类，调整 Rand 指数阈值 `>=0.70`；每个聚类至少包含 5 个 run（或预注册的最小值）。
- **稳定性统计口径（W0-3，已冻结）**：`clustering.stabilityShuffles=20`（v3/v5 轮为 3，样本量不足以给出可用的估计量），
  每次洗牌得到一组半样本 ARI，产物必须同时输出 `stabilityAriMin/Median/Max`。
  **判定量 = median**（降低估计量方差），**但报告必须同时给出 min**，且不得只引用最大值。
  口径在规则冻结前写死，不得在看到结果后改判定量；若需改判定量，须先修订本节并说明理由，新旧口径同时报告。
  适用范围：本节口径自 `rules-v6` 轮起强制执行；`rules-v5` 轮 2 的产物按当时口径（3 次、取 min）判定，
  即 `min ARI=0.366 < 0.70`，结论仍为「未形成可复现结构」，不因口径变更而改判。
- **与标签的关系**：标签只作描述；三类结构按聚类计数，不按标签组合计数。聚类不稳定时报告“未形成可复现结构”，不得挑选有利种子。
- **实现敏感性（v5 轮 2 发现）**：Ward 是「每轮合并 SSE 增量最小的簇对」，但**并列或近并列的取舍依赖数值路径与扫描顺序**。同一份 60 点、3 团数据上，两个数学等价实现（成员遍历重算 SSE vs Lance–Williams 递推）在 `k=3` 给出一致划分，在 `k=4` 给出 ARI=0.948 的不同划分——2 个点换簇，因为紧簇内多个候选合并的代价在 1 ulp 内接近。
  后果：**只写 `ward+euclidean` 不足以复现聚类结果**；跨实现或跨实现版本比较簇标签没有意义。
  约束：同一批次的全部 run 必须由**同一实现版本**聚类；更换聚类实现属于分析管线变更，须新建 `experimentId` 并重跑，不得把新旧实现的簇号或簇数直接对比。
  实现标识：`clustering.algorithm` 必须记录 `'ward-lw-v1'`（Lance–Williams 递推版，W0-1 落地）并进 `preregistrationHash`。
  该字段自 `rules-v6` 轮起必填；`rules-v5` 轮 2 的产物无此字段，属历史存档，不得与新批次比较簇结构。
- **k=2 门槛（诊断轮补充，已冻结）**：选择 k 时不仅看轮廓系数，**必须同时报告 `k=2` 的稳定性 ARI**；
  若 `k=2` 的 ARI median `< 0.70`，直接判定「不存在可复现的宏观二态」，**不得退而用 k=4/k=5 的稳定性充作通过**。
  理由：更细的切分在连续谱上总能有更高的局部稳定度，用它替代最粗二分类等于用度量技巧掩盖「没有宏观结构」。
  该门槛已登记于 `research/2026-11-03-p15-diagnosis-and-next-round.md` §5 W2 判定协议。

## 9. 区间与多重比较

- 主分析按 seed 的配对差做 bootstrap（至少 10,000 次，分析 seed 固定）估计 95% 区间；报告方法与版本。
- 确认扫描前用 pilot 方差做功效分析：给定 30 个种子和预注册的 primary metric，报告可检测的最小效应；若最小效应大于实际差异门槛，增加种子或降低噪声，不得运行后再解释“不显著”。
- 需要 BH-FDR 时，另对每个预注册主指标做双侧配对符号翻转置换检验：每个 seed 差值随机翻转符号，至少 100,000 次、分析 seed 固定，p 值使用 `(1+极端次数)/(1+置换次数)`。一个比较族定义为同一确认批次、experimentType、窗口和主指标下的全部 cell 比较，在该族内做 BH（q=0.05）。不同主指标/窗口不得事后拼成有利比较族。
- 多参数探索和次要指标只标 exploratory；未预注册置换检验时不宣称完成 BH。效应值和原始分布始终与 p 值同时报告。
- 区间方法不能消除模型错误；先通过不变量、缺失和回退质量检查。

## 10. 结构标签（首轮筛查阈值）

标签是可配置描述，不是现实分类，可多标签或“未归类”；不得反馈到模拟。以下为 `C=5` 的首轮筛查值，P1.5/P6 的结构判异固定 `C=5`；其他 `C` 只用于机制/性能测试，不得用这些标签判异。结构判异同时固定 `metrics.flowWindowDays=365`、`metrics.mobilityWindowDays=365`、`metrics.topWealthShareFraction=0.1`；改变这些值必须升级 `labelThresholdVersion`/阈值 hash 并重新预注册，不得与 labels-v3 结果混比。确认扫描前冻结版本：

| 标签       | 窗口条件                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------- |
| 金字塔     | 对每个相邻阶级满足 `P[i]>=P[i+1]-0.02`，P[0]+P[1]>=0.60，P[4]<=0.10，且中间三层合计>=0.20 |
| 橄榄       | P[1]+P[2]+P[3]>=0.60；对所有 i 满足 `P[2]>=P[i]-0.02`；P[0]/P[4] 均<=0.20                 |
| 两极化     | P[0]+P[4]>=0.50，中间三层<=0.40，G>=0.40                                                  |
| 封闭分层   | O<=0.25、Mup<=0.05、S>=0.50，且 `edgeCount>0`，在窗口至少 80% 的 30 日块成立              |
| 高流动网络 | Mup>=0.20、O>=0.60、S<=0.20、跨层边比例>=0.35                                             |
| 顶层过重   | P[4]>=0.50 且不满足金字塔/橄榄；报告为“未归类-顶层过重”，不得算作金字塔                   |

首轮 `monotonicTolerance=0.02`、`modeTolerance=0.02`，上表已给出比较方向；标签配置必须显式保存这两个值，不能靠目视。`S` 是调整后同层边占比（范围 `[-1,1]`），不是未调整的同层边比例；阈值为首轮筛查值，须在确认扫描前冻结。这里的 P 是窗口内阶级占比，与 03 的初始分布 `P0[C]` 不是同一变量。标签表必须做覆盖/重叠审计：同一状态可多标签，但“三种结构”按指纹聚类计数，不按标签计数；若标签阈值与结构判异冲突，以原始指标和预注册统计口径为准。

“至少 80% 的 30 日块成立”必须逐块判定：O/Mup/S（以及 `edgeCount>0`）要在**同一个块内**同时满足，再统计成立块占比；用整窗均值套每个块等于放弃块级判定（任一块 O 低就通过）。因此 30 日块必须携带 `mUp`、`segregation`、`edgeCountAverage`，而不只是 `gini/openness/classShares`。`networkEmpty`（**整窗** `edgeCount=0`，不看末行）的窗口不产出 `closedStratified`/`highFlowNetwork`。

## 11. 消融与 Jev 对照

五个必跑消融，其他输入与 baseline 完全配对：

- `β=0`：移除网络机会，但保留关系、网络竞争和 S。
- `O=openness.initial 固定`：通过 P1-10 的 `openness.updateMode=fixed` 冻结，停止制度更新；跨越/网络中的 O 乘子仍在但恒定。不得用极大 `τO` 近似；该开关必须进入 `configHash/paramsHash`。
- `η=0`：Congestion=1，其他反馈保留。
- `κ=0`：Polarization=1，其他反馈保留。
- `ψ=1`：移除阶级持有成本，验证 needMultiplier 对结构的解释力；预期顶层塌缩显著增强。

只有消融后预期结构特征显著退化，才可说机制“在该实验范围内有解释力”；不能说证明现实因果。

Jev 对照至少含 `mock-weighted-v1`、`random-uniform-v1`、jev_live，固定初始人口和规则，并至少比较 `promptStyle=neutral` 与 `promptStyle=survival_hint` 两种提示；规范性提示是 treatment，不得混在同一个 promptVersion 里静默变化。记录 policyVersion、requestedModel、逐决策 responseModel、prompt、原始回答、回退、token、延迟。run 的 responseModels 超过一个时按模型分组并将该批标模型漂移；回退率超闸门或模型漂移批次不参与正式对照合并。

正式 live 对照前先做重测信度：同一组 state 重复 20 次，报告选项分布、top-1 一致率、概率向量的 ICC(2,1) 和重复间平均 TV 距离。进入正式结构对照的门槛为：top-1 一致率 `>=0.70`、ICC `>=0.50`、平均 TV 距离 `<=0.15`；任一项不达标时报告 `model_unstable`，live 只作描述性案例，不作结构差异证据。重复次数少于 20 时只能标 exploratory。按 40 人、730 tick、`decisionInterval=30` 估算，一次 live run 约 40×25=1,000 次到期决策；5–10 个种子约 5,000–10,000 次请求。30 种子×3650 tick 的 14,600 次/run 只适用于 mock/VPS 无模型批量，不得直接套到 live。

## 12. 校准报告与预设冻结

报告必须包含：假设、配置/版本、搜索范围、全部单元、种子、窗口、失败、资源/成本、主指标分布、D 及分项、区间、消融、微扰、限制和 artifact 索引。

冻结一个预设需要：

- 完整 Ruleset JSON/hash 和代码 commit；
- 至少 30 个配对种子及独立确认集；
- 结构指纹、标签阈值版本和 `preregistrationHash`；
- 与同批其他预设的差异证据，以及该预设所属的指纹聚类编号；
- 稳定区扰动吸收结果；
- 可一键重现的 manifest 和校验通过的 artifact。

至少三类互不相同的结构指纹聚类通过后才完成规则 v3 校准；“三组预设”不等于“三类结构”，同一聚类下的三个预设不算通过。若只得到一种结构，先检查 `needMultiplier/needThreshold/env0/crossDays/decay` 是否被扫描，再调整反馈并重开 rules 版本；若每次不可归类，降低噪声/反馈或延长窗口，不将其包装成理想涌现。
