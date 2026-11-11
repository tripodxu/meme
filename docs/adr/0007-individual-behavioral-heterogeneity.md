# 0007 rules-v15：个体行为异质性（D2）

- 状态：accepted（2026-11-11，规则负责人选择 D2）
- 决策者：徐鼎
- 关联：changes/0067、ADR 0006、changes/0066（P6-06 未通过）
- 影响：结算输入、`mock-weighted-v2`、配置/状态 schema、参数注册表、P6-07 探索轮
- 不改变：结算公式本身不读取行为特质；G6 目标仍是 ADR 0006 的“2 体制 + 连续统”

## 背景

P6-06 在 D1 目标（k=2 + 无稳定第三簇）下得到非常强的 k=2 结果
（簇 [30,150]、ARI 1.000、silhouette 0.661、同簇率 1.000、体制差异 0.723），
但 k=3 在 B–F 内部形成稳定二分（[30,66,84]、ARI 0.768、同簇率 0.850），
按预注册的“无稳定第三簇”检查未通过。根因不是 k=2 不稳，而是现有规则
让 6 个参数区域只能产生“A vs 其余”一个宏观分裂，其余区域在闭合体制
内部沿连续参数漂移。

规则负责人选择 D2：在**不继续调 θH/θR/θS/H/share/w** 的前提下，引入
个体层面的行为异质性，使同一参数区域内的个体不再按同一权重竞争，
从而检验“行为差异本身能否产生额外的宏观结构”。

## 决策

### 1. 不可变行为特质

每个个体在初始化时获得两个不可变特质，值域 `[0,1]`：

- `riskTolerance`：风险/竞争倾向；
- `crossClassOpenness`：跨层竞争意愿。

由 `(config, seed)` 纯函数派生，使用地址化随机流：

```text
riskTolerance      = clamp(0.5 + riskTraitSigma      × (2·R(seed,-1,id,'init_risk_trait',0)      − 1), 0, 1)
crossClassOpenness = clamp(0.5 + crossClassTraitSigma × (2·R(seed,-1,id,'init_cross_class_trait',0) − 1), 0, 1)
```

`sigma=0` 时仍消费各自随机地址，但结果恒为 `0.5`。特质初始化后不随
tick、阶级或财富变化；它们进入初始人口哈希与权威状态，但不进入结算
公式（需求、跌落、流动、网络重构均不读取）。

### 2. `mock-weighted-v2`

行为特质只通过新策略版本 `mock-weighted-v2` 影响 `compete` 权重：

```text
w_compete = w_v1 × exp(
  riskCompeteSensitivity      × (riskTolerance − 0.5) +
  crossClassCompeteSensitivity × (crossClassOpenness − 0.5) × [target.class ≠ self.class]
)
```

其余行动权重、抽样地址（`mock_action`）、决策 schema 和概率归一化方式
与 v1 相同。两个敏感性为 0 时 `exp(0)=1`，v2 的概率与选择逐位等于 v1；
默认配置（`behavior.*=0`）与 rules-v13/v14 语义逐位一致。

### 3. 版本与兼容性

- `rules-v15`、`engine-v0.12.0`、`stratify-config-v9`、`stratify-state-v5`。
- 配置迁移 v8→v9：缺失的 `behavior` 补四个 0（保持 v13/v14 行为）。
- 状态迁移 v3/v4→v5：缺失特质按 `0.5` 解码；v5 必须显式携带且位于 `[0,1]`。
- 旧 run 的 `configHash`/`stateHash` 因 schema 与 `behavior` 字段变化而不同；
  旧 ledger 不能与新版本逐字节对齐，实验可比性以 rules 版本隔离。
- 默认 `decision.policy` 仍是 `mock-weighted-v1`；只有显式选择
  `mock-weighted-v2` 的实验读取特质。

### 4. 参数注册表

新增四个参数，全部进入 `paramsHash` 与 `configHash`：

| 参数                                    | 默认 | 域     | 说明                     |
| --------------------------------------- | ---- | ------ | ------------------------ |
| `behavior.riskTraitSigma`               | 0    | [0,1]  | 风险特质初始化半宽       |
| `behavior.crossClassTraitSigma`         | 0    | [0,1]  | 跨层意愿特质初始化半宽   |
| `behavior.riskCompeteSensitivity`       | 0    | [0,10] | 风险特质对竞争权重的斜率 |
| `behavior.crossClassCompeteSensitivity` | 0    | [0,10] | 跨层意愿对跨层竞争的斜率 |

## 验收与解释边界

- P6-07 是**机制探索轮**，不是 G6 确认轮：固定 P6-05 B 参数区域，6 个
  行为异质性 cell × 30 个全新 seed，`mock-weighted-v2`，10950 tick，
  每 cell 前 10 续跑 14600。
- P6-07 的 k=2/k=3 结果只作描述性证据；`verdict.passes=null`，
  `status='exploratory-not-g6-confirmation'`。不得据其声称 G6 通过、
  参数已校准或结构已涌现。
- 若行为异质性没有改变结构，结论是“本规则族中该机制不足以产生额外
  宏观结构”，不得转而调 sigma/敏感性直到出现有利结果；任何后续确认
  必须另立预注册并使用全新 seed。
- D1 目标与 `docs/07` §8.2 的验收口径不变；旧 P6-06 结果不因本 ADR 改判。

## 后果

- 正面：把“个体差异”从隐含的 mock 权重常数变成显式、可复现、可消融的
  机制；为“同一参数区域内部异质性是否足以产生新体制”提供干净检验。
- 负面/限制：特质只作用于 mock 策略的竞争权重，不是完整的行为模型；
  Jev live 策略仍不读取这些特质。若 P6-07 无效，不能外推到“行为差异
  在现实中不重要”。
- 消融：`A-control`（全 0）、`B-risk-traits-only`（有方差但不读取）、
  `C/D`（单轴）、`E/F`（双轴中等/强）。A 与 B 的轨迹应逐位一致，
  作为特质初始化不影响其他随机流的安慰剂检查。

## 备选方案

| 方案                                 | 结果                                              |
| ------------------------------------ | ------------------------------------------------- |
| 继续细化 D1 的第三簇定义             | P6-06 的 66/84 分裂差异已接近体制级，难以诚实细化 |
| 继续调 θH/θR/θS/H/share/w            | 违反预注册纪律，且五轮均失败                      |
| 让特质直接进入结算（需求/流动/网络） | 影响面更大、难以归因；本轮先限定在竞争权重        |
| 停止 P6，转工程轨道                  | 保留为 D2 无效后的选项                            |
