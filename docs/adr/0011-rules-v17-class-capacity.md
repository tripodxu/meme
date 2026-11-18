# 0011 阶段 R2-A：`rules-v17` 阶级结构性容量上限与 P6-10 三类离散结构确认

- 状态：accepted（2026-11-18，阶段 R2-A 30-run 探索探针达标：`k=3 sil=0.6302, ARI=1.0000`）
- 决策者：徐鼎
- 关联：[0009](0009-rules-v16-generational-succession.md)、[0010](0010-two-regime-continuum-silhouette-criterion.md)、[2026-11-18-scientific-research-roadmap.md](../research/2026-11-18-scientific-research-roadmap.md)
- 影响：`src/core`（`rules-v17` / `engine-v0.14.0` / `stratify-config-v11`）、`ascent.classCapacity`、`legal-actions.ts`、`engine.ts`、`P6-10` 预注册确认轮
- 不改变：默认 `ascent.classCapacity = [1, 1, ..., 1]` 时与 `rules-v16` 逐位一致；状态 schema 保持 `stratify-state-v5`

## 背景

在阶段 R1（`P6-09`）与阶段 R4（`changes/0090`）正式闭环 D1“2 体制 + 连续统”后，路线图阶段 R2 旨在检验：**在 11 维全特征空间中，如何从动力学上涌现 ≥3 类互不相同的离散宏观结构（金字塔 + 顶层寡头 + 橄榄型中产）**。

30-run 探索探针（`explore-r2-001..005` × 6 cell × 10950 tick）验证了 **R2-A（阶级结构性容量上限 `ascent.classCapacity`）** 的效力：`k=3` 轮廓系数 **`0.6302`**（门槛 `≥ 0.45`）、半样本稳定性 **`ARI median = 1.0000`**（门槛 `≥ 0.85`），且三类均含 2 个独立参数单元（完全满足反预设）。

## 决策

1. **新增注册参数 `ascent.classCapacity`**（长度 `classCount`，元素域 `(0, 1]`，默认 `[1, 1, 1, 1, 1]`）：
   - 期初快照 `classSharesStart[target] >= config.ascent.classCapacity[target]` 时，目标阶层达到物理承载上限，`ascend` 不进入合法行动集（执行端复核若超限记 `stale_invalid / class_capacity_full`）；
   - 因处于 `classIndex < target` 的个体本身占比 `> 0`，在目标层 `classSharesStart[target] <= (N-1)/N < 1` 恒成立，故默认全 `1` 时与 `rules-v16` 运行轨迹**逐位一致**。
2. **版本升级**：`rules-v17`、`engine-v0.14.0`、`stratify-config-v11`（`v10 → v11` 自动补齐长度为 `classCount` 的全 `1` 数组）。
3. **启动 `P6-10` 正式 `k=3` 确认轮**：
   - 6 个参数单元（`A1_pyramid_share1_w0`, `A2_pyramid_share1_w15`, `B1_top_open_share0`, `B2_top_open_share01`, `C1_olive_capped_A`, `C2_olive_capped_B`）× **30 个全新独立种子**（`p6-10-seed-001..030`）× 40 人 × 10950 tick（每 cell 前 10 续跑 14600 tick，共 240 run）；
   - 按 `docs/07 §8.1` 严格判读 `k=3`（全簇 ≥5、`ARI median ≥ 0.70`、`silhouette ≥ 0.35`、`14600 同簇率 ≥ 0.80`、`antiPreset = true`、`extinct ≤ 10%`）。
