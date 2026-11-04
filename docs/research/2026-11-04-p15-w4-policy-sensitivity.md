# P1.5 W4 策略敏感性：聚类分裂保留，方向解释不保留（2026-11-04）

> **性质：探索层**（07 §6.1）。使用 W4 预注册 manifest 的格点，但把策略覆盖为
> `random-uniform-v1`、每 cell 只跑 10 个种子（60 run）。产物标记
> `exploratoryPolicySensitivity=true`，**不构成 G1.5 确认证据**，也不改变 W4 的
> mock 确认结论。
>
> **结论**：A vs B∪C 的 **k=2 聚类分裂在 random 策略下仍复现**（ARI 1.0、temporal 1.0），
> 但 **B/C 的方向含义完全改变**：mock 下 B/C 是底轻/中产（P0≈0–0.15、mUp≈0.12–0.18），
> random 下 B/C 是底重/高流动（P0≈0.61–0.68、mUp≈0.86–0.91）。因此：
> **聚类结构对该策略替换稳健，方向预测不稳健**；不得把「开放准入 + 锚定 → 底轻/中产」
> 表述为策略无关的机制结论。后续 descend 门控消融（`unconditional-descend`，60 run）
> 复现同一模式，把原因定位到 mock 的 `belowNeedStreak>=7` 门控，而非一般随机性。

## 1. 设计

- manifest：`buildV10ConfirmationManifest()`（prereg `sha256:ece0a98b…`），6 cell
  （A-share1、B-w10/w15、C-w60/w80/w100）。
- 策略：`random-uniform-v1`（对全部合法行动等概率），覆盖 manifest 的
  `policyVersion=mock-weighted-v1`；`preregistrationHash` 仍对应预注册设计。
- 种子：`p15r4-seed-001…010`（W4 种子集前 10 个；与 W4 的 30 个同源但只取子集）。
- 视野：3650 tick；w2b/w3 两个特征窗口；聚类协议不变（`ward-lw-v1`、k∈[2,5]、
  20 次半样本、median 判定）。
- 规模：6 cell × 10 seeds = 60 run，wall 1 分钟，0 全灭，budgets.ok。

## 2. 结果

### 2.1 w3 各 cell 均值（random，n=10）

| cell     | P0    | P1    | P2    | P3    | P4    | mUp   | mDown |
| -------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| A-share1 | 0.960 | 0.032 | 0.006 | 0.001 | 0.000 | 0.707 | 0.708 |
| B-w10    | 0.612 | 0.295 | 0.085 | 0.008 | 0.000 | 0.904 | 0.904 |
| B-w15    | 0.631 | 0.276 | 0.088 | 0.005 | 0.000 | 0.906 | 0.906 |
| C-w60    | 0.658 | 0.256 | 0.080 | 0.005 | 0.001 | 0.873 | 0.873 |
| C-w80    | 0.677 | 0.249 | 0.071 | 0.003 | 0.000 | 0.857 | 0.853 |
| C-w100   | 0.669 | 0.245 | 0.082 | 0.003 | 0.000 | 0.868 | 0.863 |

### 2.2 与 W4 mock 确认轮对照（w3 均值）

| cell     | mock P0 | mock P1 | mock P2 | mock P3 | mock P4 | mock mUp | random P0 | random mUp |
| -------- | ------- | ------- | ------- | ------- | ------- | -------- | --------- | ---------- |
| A-share1 | 0.542   | 0.357   | 0.050   | 0.024   | 0.027   | 0.948    | 0.960     | 0.707      |
| B-w10    | 0.000   | 0.149   | 0.502   | 0.261   | 0.088   | 0.178    | 0.612     | 0.904      |
| B-w15    | 0.001   | 0.267   | 0.434   | 0.210   | 0.087   | 0.166    | 0.631     | 0.906      |
| C-w60    | 0.083   | 0.394   | 0.267   | 0.168   | 0.088   | 0.136    | 0.658     | 0.873      |
| C-w80    | 0.121   | 0.390   | 0.249   | 0.161   | 0.078   | 0.141    | 0.677     | 0.857      |
| C-w100   | 0.147   | 0.365   | 0.248   | 0.154   | 0.085   | 0.121    | 0.669     | 0.868      |

- random 下 B/C 的 `scarcityWeight` 几乎不再改变阶级占比（P0 0.612–0.677），
  上层 P3/P4 几乎消失（≤0.008）；mock 下 B/C 的 P3/P4 分别为 0.15–0.26 / 0.08。
- A 在两种策略下都是底重，但 random 下更极端（P0 0.960 vs 0.542），mUp 反而更低
  （0.707 vs 0.948）。

### 2.3 聚类与门槛

| 子项                  | 实测                                     | 门槛                   | 结果     |
| --------------------- | ---------------------------------------- | ---------------------- | -------- |
| k=2 ARI median / min  | 1.000 / 1.000                            | ≥0.70                  | 过       |
| 选中 k / 轮廓         | k=2 / 0.530                              | —                      | 稳定     |
| temporalConsistency   | 1.000（60/60）                           | ≥0.80                  | 过       |
| 最小簇 run            | 10 run（20 点）                          | ≥5                     | 过       |
| 非退化簇              | 2                                        | ≥1                     | 过       |
| 方向预测（cell 均值） | A P0 0.960；B/C 最差 P0 0.677、mUp 0.906 | A≥0.40；B/C≤0.15/≤0.40 | **未过** |

簇组成与 mock 完全同构：c0 = A 的全部 20 点（10 run × 2 窗口），
c1 = B/C 的全部 100 点。**聚类分裂保留，方向预测失败**；脚本判定为
`G1.5 未通过：方向预测不满足`。

### 2.4 descend 门控消融（unconditional-descend，n=10）

只去掉 mock 的 `belowNeedStreak>=7` 门控（descend 恒有正权重），保留 mock 的
`mock_action` 随机地址与其它权重：

| cell     | P0    | P1    | P2    | P3    | P4    | mUp   | mDown |
| -------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| A-share1 | 0.965 | 0.032 | 0.003 | 0.000 | 0.000 | 0.905 | 0.905 |
| B-w10    | 0.691 | 0.267 | 0.040 | 0.002 | 0.000 | 0.978 | 0.977 |
| B-w15    | 0.702 | 0.258 | 0.037 | 0.003 | 0.000 | 0.964 | 0.964 |
| C-w60    | 0.717 | 0.243 | 0.038 | 0.002 | 0.000 | 0.978 | 0.977 |
| C-w80    | 0.723 | 0.235 | 0.040 | 0.001 | 0.000 | 0.974 | 0.974 |
| C-w100   | 0.727 | 0.233 | 0.039 | 0.001 | 0.000 | 0.974 | 0.973 |

- 与 random **同向**：B/C 变为底重/高流动（P0 0.691–0.727、mUp 0.964–0.978，
  P3/P4 ≤0.003），方向预测失败（最差 P0 0.727、最差 mUp 0.978）。
- 聚类仍为 k=2、轮廓 0.560、ARI 1.000、temporal 1.000，簇组成仍
  c0=A（20 点）/ c1=B/C（100 点）；A P0=0.965。
- 与 random 的差别是 mUp 更高（mock 的 ascend 权重仍在），但
  「底层抽空/上层消失」的结论一致。

## 3. 解释

- **结构层**：A vs B∪C 的分裂由 `displacementShare=1` vs `0.5` 驱动，在两种策略下
  都足以形成可复现的两簇。因此该分裂不是 mock 的偶然产物。
- **机制层**：mock 的条件权重（ascend 0.8、descend 仅 streak≥7）把 B/C 推到
  中上层并压低流动；random 的无条件下降与均匀上升把社会留在底层并保持近最大流动。
  `scarcityWeight` 在 random 下几乎不起作用——高流动不断把个体送回底层，锚定
  无法积累成阶级结构。
- **原因定位**：`unconditional-descend` 消融只去掉 `belowNeedStreak>=7` 门控、
  保留 mock 的随机流与其它权重，结果与 random 同向。因此方向失败由**下降门控**
  驱动，不是 random 的均匀抽样本身；这与 changes/0017 的 5-seed 路径实验一致。
- **G1.5 的范围**：W4 的通过是「预注册 mock 策略 + 该格点」下的通过；本探索表明
  聚类子项对 random 替换稳健，但**方向子项不稳健**。因此不能把 B/C 的
  「底轻/中产」写成规则层、策略无关的涌现结论；Jev 策略必须单独预注册与报告。
- 本探索同时暴露了脚本 verdict 文案的缺陷：原先只要 k=2 硬门槛通过、任一其它子项
  失败，就笼统写成「聚类协议子项不满足」；已改为逐项列出失败原因
  （本次为「方向预测不满足」）。

## 4. 限制

- 已补 `unconditional-descend` 消融，但仍未测 Jev；10 seeds/cell，非 30，未做
  ARI 的 30-seed 复算；60 run 的结论只作探索。
- 产物携带 W4 的 `preregistrationHash`（设计未变），但策略被覆盖；已用
  `exploratoryPolicySensitivity=true` 与 `policy.executed` 标记，不得引用为
  G1.5 确认证据。
- 无条件下降与 random 的 mUp 水平仍不同（约 0.96–0.98 vs 0.86–0.91），说明除
  门控外还有策略差异；但两者对 B/C 方向预测的否定一致。未做更细的权重扫描。
- 未改变 P6-05（≥3 类）状态；未做 Jev。

## 5. 产物与重跑

```bash
pnpm build
node scripts/p15-grid.mjs --manifest v10 --stage full --policy random-uniform-v1 --seeds 10
node scripts/p15-grid.mjs --manifest v10 --stage full --policy unconditional-descend --seeds 10
```

- `out/p15-v10-policy-random-full.json`（60 run，302,989 B，
  sha256 `a10dff5b…21b6de`；`exploratoryPolicySensitivity=true`）
- `out/p15-v10-policy-unconditional-descend-full.json`（60 run，300,763 B，
  sha256 `e386bcaa…f9908e`；`exploratoryPolicySensitivity=true`）
- 预检 `out/p15-v10-policy-{random,unconditional-descend}-screen.json`
  （各 6 run × 400 tick，未入库）
