# 0091 — `rules-v17` 阶级容量上限与 `P6-10` 预注册确认轮结果（未通过）

- 日期：2026-11-18
- 状态：已完成（`rules-v17` 实现与全量门禁通过；`P6-10` 240/240 run 零灭绝完成，因 `clusterSizes=[61, 117, 2]` 第三簇 `< 5` 判**未通过**；D1 两体制校准成果不变，传统 `k≥3` 离散结构仍未通过）
- 关联：[ADR 0011](../adr/0011-rules-v17-class-capacity.md)、[07 §8.1](../07-experiment-calibration.md#L251)、[changes/0090](0090-p6-r4-calibration-g6-closure.md)
- 实验：`p6-10-80e12386`（`preregistrationHash = sha256:80e12386de7f86dd23207eb86330391e8df377912bebea1b8c9b3391ea9822fb`）
- 复现脚本：[p6-10-class-capacity.mjs](../../scripts/p6-10-class-capacity.mjs)

## 1. `rules-v17` 机制与版本升级

按 [ADR 0011](../adr/0011-rules-v17-class-capacity.md) 落地阶级结构性容量上限：

- **版本轴**：`rules-v17`、`engine-v0.14.0`、`stratify-config-v11`（`stratify-config-v10 → v11` 自动补齐长度为 `classCount` 的全 `1` 数组）；状态 schema 保持 `stratify-state-v5`。
- **新增注册参数（共 102 项）**：`ascent.classCapacity`（长度 `classCount`，元素域 `(0, 1]`，默认 `[1, 1, 1, 1, 1]`）。当期初存活占比 `classSharesStart[target] >= classCapacity[target]` 时，目标层承载已满，上升不进入合法行动集（执行端复核若超限记 `stale_invalid / class_capacity_full`）；默认全 `1` 时与 `rules-v16` 逐位一致。
- **前端与 Golden**：更新 [setup.ts](../../src/ui/workspaces/setup.ts) 分组 05 向量编辑器、版本徽章及 [config-default.test.ts](../../test/golden/config-default.test.ts) / [engine-mock.test.ts](../../test/golden/engine-mock.test.ts) Golden Fixture，新增 `v10→v11` 迁移与 `classCapacity` 接线单测。

## 2. `P6-10` 预注册确认轮结果（`240/240` run，`wallSeconds = 275.92s`）

- **协议**：6 个参数单元（`A1_pyramid_share1_w0`, `A2_pyramid_share1_w15`, `B1_top_open_share0`, `B2_top_open_share01`, `C1_olive_capped_A`, `C2_olive_capped_B`）× 30 个全新独立种子（`p6-10-seed-001..030`）× 40 人 × `10950` tick（每 cell 前 10 续跑 `14600` tick）；11 维全特征 `ward-lw-v1` + `z-score(pooled)` + 20 次二分洗牌。
- **质量**：`180` base + `60` followup = `240/240` 完成，**`excluded = 0`、`extinctCount = 0`**。
- **`k=3` 严格判读（[07 §8.1](../07-experiment-calibration.md#L251)）**：
  - **簇大小：`[61, 117, 2]`**（簇 2 仅 2 个样本 **< 5**）；
  - 组成：簇 0 = `A1(30) + A2(30) + C2(1)`；簇 1 = `B1(30) + B2(29) + C1(29) + C2(29)`；簇 2 = `B2(1) + C1(1)`；
  - 稳定性：`ARI median = 0.8346`（min `0.4823`, max `1.000`）`>= 0.70`；
  - 轮廓系数：`silhouette = 0.5135` `>= 0.35`；
  - 14600 时序同簇率：`0.9833` `>= 0.80`；
  - 反预设：`antiPreset = true`。
- **质心（`P0..P4, G, top10, Mup, Mdown, S, O`）**：
  - 簇 0：`[0.9144, 0.0647, 0.0208, 0, 0, 0.4064, 0.3425, 0.7127, 0.7095, 0.2135, 0.7184]`；
  - 簇 1：`[0.4013, 0.3289, 0.2460, 0.0238, 0, 0.4188, 0.3397, 0.9422, 0.9398, -0.1105, 0.9357]`；
  - 簇 2（2 个极端样本）：`[0.4022, 0.3263, 0.2415, 0.0122, 0.0178, 0.5554, 0.5085, 0.9787, 0.9761, -0.1819, 0.9225]`。

## 3. 科学判读与边界

- **判定**：`verdict = 'not-accepted-return-to-rule-review'`，`passes = false`（簇 2 仅 `2 < 5` 个样本）。
- **机制读数**：5-seed 探索探针（`k=3 sil=0.6302, ARI=1.0000`）的分离未在 30 个全新确认种子上复现；大样本下 `B1/B2` 与 `C1/C2` 依然合并为同一开放连续统簇（117/120 run），印证了本规则族的核心结构仍是 **D1“2 体制 + 连续统”**（已在 `P6-09` + 阶段 R4 闭环），而不是三类离散吸引域。
- **纪律边界**：严守预注册纪律，不在见到结果后调整 `classCapacity` 阈值或重选种子；保留 `rules-v17` 与 `P6-10` 完整数据。
