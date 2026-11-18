# 0092 `rules-v18` 代际人力资本传递与阶段 R2-B 探索探针结果（未达标）

- 日期：2026-11-18
- 关联：[ADR 0012](../adr/0012-rules-v18-talent-inheritance.md)、[科研路线图](../research/2026-11-18-scientific-research-roadmap.md)、`scripts/explore-r2b-talent.mjs`

## 变更摘要

1. **核心规则与配置（`rules-v18` / `engine-v0.15.0` / `stratify-config-v12`）**：
   - 新增参数 `population.talentInheritanceWeight`（`γ ∈ [0, 2]`，默认 `0`），进入 `PARAM_DEFINITIONS`（103 项）、`configHash` 与 `paramsHash`；新增 `v11 → v12` 配置迁移补 `0`。
   - `generationalMode = 'replace'` 且 `γ > 0` 时，阶段 E 新生个体按 `ge_child = clamp(ge_raw * (1 + γ * (parent.classIndex/(classCount-1) - 0.5) * (1 - O)), min, max)` 调制天赋；默认 `0` 时跳过乘法与 clamp，与 `rules-v17` 逐位一致。
   - 同步更新 UI 版本徽标、`setup-talent-inheritance` 数值输入与 `rules-v18` golden fixtures。
2. **阶段 R2-B 30-run 探索探针（`explore-r2b-talent`）**：
   - 6 个参数单元（`A1_pyramid_bequest0`、`A2_pyramid_bequest50`、`B1_open_fresh`、`B2_open_talent1`、`C1_locked_w30_talent15`、`C2_locked_w60_talent20`）× 5 个全新探索种子（`explore-r2b-seed-001..005`）× `N=40` × `10950` tick，11 维全特征 Ward-LW 聚类。
   - **实测结果（30/30 有效，0 灭绝）**：
     - `k=2`：簇 `[10, 20]`，`ARI median = 1.000`、`silhouette = 0.4576`（精确分离 `A1/A2` 与 `B1/B2/C1/C2`）。
     - `k=3`：簇 `[10, 16, 4]`，`ARI median = 0.6145`（`< 0.85` 门槛）、`silhouette = 0.4302`（`< 0.45` 门槛），`passesProbeGate = false`。
     - 各非位移单元开放度 `O` 均保持在 `0.886–0.947`、`Mup` 保持在 `0.833–0.967`，代际更替下的高开放度削弱了 $(1 - O)$ 乘子，未能形成世袭贫困陷阱。
3. **科学结论**：
   - 按科研路线图执行纪律停止 R2-B 调参，不开启 240-run 正式确认轮；
   - 既有 D1「2 体制 + 连续统」G6 校准结论（[0089](0089-p6-09-two-regime-confirmation.md) / [0090](0090-p6-r4-calibration-g6-closure.md)）保持不变；传统 `k≥3` 离散结构仍未通过。
