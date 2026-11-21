# 0014 阶段 R2-C：`rules-v19` 岗位容量硬门槛 + 代际出身折损

- 状态：rejected（2026-11-20 R2-C 探索探针未通过簇规模与消融门槛，按纪律停止；见 [changes/0100](../changes/0100-explore-r2c-hcg-result.md)）
- 决策者：徐鼎
- 关联：[0009](0009-rules-v16-generational-succession.md)、[0011](0011-rules-v17-class-capacity.md)、[0012](0012-rules-v18-talent-inheritance.md)、[changes/0090](../changes/0090-p6-r4-calibration-g6-closure.md)
- 影响：`src/core`（`rules-v19` / `engine-v0.16.0` / `stratify-config-v13`）、`ascent.hardGateStrength`、`population.lineageDiscount`、`legal-actions.ts`、`engine.ts`
- 不改变：两个新参数均为 `0` 时与 `rules-v18` 运行轨迹逐位一致；状态 schema 保持 `stratify-state-v5`

## 背景

R4 的五项消融（`beta=0`、`O=fixed`、`eta=0`、`kappa=0`、`psi=1`）在两套体制下
`median TV(P)` 最大只有 `0.0740`，未达到 07 §11 的 `0.10` 结构退化门槛。ADR 0012
的代际天赋传递因 `O` 长期处于 `0.88–0.95`、`(1-O)` 调节幅度过小而失败。

G6 要继续，必须引入**不依赖 O 的、强非线性的结构机制**，并且该机制在消融后
能让结构指纹显著退化。本 ADR 提出两个可独立消融、默认不生效的机制，组合成
“岗位容量硬门槛 × 代际出身折损”（HCG）。

## 机制

### 1. 岗位容量硬门槛（`ascent.hardGateStrength = g ≥ 0`）

在 `rules-v17` 的 `classCapacity` 硬布尔门之上，给上升成本加一个随目标层占用率
凸增的乘子：

$$
o_c = \min\left(\frac{P_c}{\text{classCapacity}[c]},\ 1 - 10^{-6}\right),\qquad
M_{\text{gate}}(c) = 1 + g \cdot \frac{o_c^2}{1 - o_c}
$$

其中 `P_c` 是 tick 期初目标阶级占比（与 v10 占用压力同一快照），成本变为
`crossBase × (1 - discount) × openMultiplier × M_gate`。`o_c → 1` 时成本发散，
形成硬墙；`g = 0` 时与 v18 逐位一致。

### 2. 代际出身折损（`population.lineageDiscount = d ≥ 0`）

新生儿的先天有效天赋按亲代阶级折损，不经过 `O`：

$$
ge_{\text{child}} = ge_{\text{raw}} \cdot \left(1 - d \cdot \left(1 - \frac{c_{\text{parent}}}{C-1}\right)\right)
$$

`d = 0` 时与 v18 逐位一致；`d > 0` 时低阶级后代即使随机天赋相同也更难积累，
与硬门槛组合形成“低出身 + 高占用”双重锁定。

## 预注册与判读

### 阶段 1：30-run 探索探针（先做，未过则停止）

- 6 个参数单元：沿用 P6-05 的 A–F 区域；每单元 5 个全新探索种子
  （`explore-r2c-seed-001..005`）× 40 人 × 10950 tick = 30 run。
- 机制参数固定为一个中等强度组合（`g`、`d` 各取一个非零值，取值在冻结前写入
  `out/explore-r2c-prereg.json`，不得在看到结果后调整）。
- 探索门槛：`k=2` `ARI ≥ 0.85` 且 `silhouette ≥ 0.45`（仅筛选，不构成 G6 结论）；
  同时做单参数消融（`g=0` 或 `d=0`）的 30-run 对照，要求至少一个消融的
  `median TV(P) ≥ 0.10`。
- 未达标：按 ADR 0009 纪律停止该机制，不调 `g/d`，不以剩余 run 凑数。

### 阶段 2：240-run 正式确认轮（仅在阶段 1 达标后）

- `g`、`d` 冻结后，6 cell × 30 个全新 seed（`p6-15-seed-001..030`）× 10950 tick，
  前 10 续跑 14600（240 base + 60 followup）。
- G6 按 07 §8.2（ADR 0010）判读；结构退化按 07 §11 的 `median TV(P) ≥ 0.10`。
- 不改变 `θH/θR/θS/H/share/w/k`；所有实验在上海 VPS 执行。

## 版本与兼容

1. 参数注册：`ascent.hardGateStrength ∈ [0, 4]`、`population.lineageDiscount ∈ [0, 0.8]`，
   默认均为 `0`；进入 `configHash/paramsHash`。
2. 版本：`rules-v19`、`engine-v0.16.0`、`stratify-config-v13`（v12 → v13 自动补 0）。
3. 状态 schema 不变（`stratify-state-v5`）；golden 与 domain vectors 必须重算并在
   changes 记录中说明默认参数下的逐位一致性。

## 风险

- 硬门槛可能让 `ascend` 在占用率接近上限时被完全抑制，导致流动性骤降、run 灭绝；
  阶段 1 以 0 灭绝为硬前提，出现灭绝即停止。
- 折损可能把低阶级锁死到无法参与，`P` 变为单点；同样以探针门槛判定。
- 本 ADR 只提出可检验假设，不预先声称能通过 G6。
