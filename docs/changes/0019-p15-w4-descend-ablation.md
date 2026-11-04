# 0019：W4 descend 门控消融——方向失败的来源定位

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0018 的开放问题）
- 关联：W4 确认轮（`changes/0014`）、descend 条件探针（`changes/0017`）、
  W4 策略敏感性（`changes/0018`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、预注册 manifest 或生产策略，
  不回溯改变 W4 的 G1.5 判定

## 1. 变更

1. **脚本能力（仅探索）**：`scripts/p15-grid.mjs` 新增
   `--policy unconditional-descend`。该策略由内联 `UnconditionalDescendPolicy`
   实现，复用 `MOCK_WEIGHTED_V1_CONSTANTS` 与 `mock_action` 随机地址，**唯一差异**
   是去掉 descend 的 `belowNeedStreak>=7` 门控（只要 descend 合法即给 1.2 权重）。
   因此与 mock 的对比只改变触发条件，不改变随机流。
2. **探索结果（60 run，6 cell × 10 seeds）**：
   - 聚类仍为 k=2、轮廓 0.560、ARI median/min 1.000、temporal 1.000；
     c0 = A（20 点）、c1 = B∪C（100 点），与 mock/random 同构。
   - 方向预测失败：A P0=0.965（过 ≥0.40）；B/C P0 0.691–0.727（门槛 ≤0.15）、
     mUp 0.964–0.978（门槛 ≤0.40）；P3/P4 ≤0.003。
   - 判定 `G1.5 未通过：方向预测不满足`。
3. **结论**：仅去掉 descend 门控就足以复现 random 下的 B/C 底重/高流动形态。
   因此 changes/0018 的方向失败由 **descend 触发条件**驱动，不是 random 的均匀
   抽样本身；这与 changes/0017 的 5-seed 路径实验结论一致。A vs B∪C 的聚类分裂
   在 mock/random/unconditional-descend 三种策略下都保留，但其方向解释只能在
   mock 口径下成立。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- `p15-grid.mjs` 默认行为不变；`unconditional-descend` 仅用于探索，产物带
  `exploratoryPolicySensitivity=true` 与 `policy.executed` 标记。
- W4 预注册 manifest 与 `preregistrationHash` 未改；本产物不能替代
  `out/p15-v10-full.json`。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- 预检 6 run 成功；正式探索 60 run（wall 2 分钟、0 全灭、budgets.ok）成功；
  `policy.executed=unconditional-descend`、判定字段完整。
- 同一策略使用 `mock_action` 地址，与 mock 的差异仅限 descend 门控。

## 4. 未完成

- 只补了 `unconditional-descend` 消融，未测 Jev；10 seeds/cell，未做 30-seed 复算。
- 无条件下降与 random 的 mUp 水平仍不同（约 0.96–0.98 vs 0.86–0.91），说明除门控
  外仍有策略差异；未做更细的权重/触发阈值扫描。
- 不改变 P6-05（≥3 类）状态，不把本探索升格为 G1.5/P6 证据。

## 5. 证据

- `out/p15-v10-policy-unconditional-descend-full.json`（60 run，300,763 B，
  sha256 `e386bcaa…f9908e`，`exploratoryPolicySensitivity=true`）
- 预检 `out/p15-v10-policy-unconditional-descend-screen.json`（6 run，未入库）
- 研究记录：`docs/research/2026-11-04-p15-w4-policy-sensitivity.md` §2.4
- 重跑：
  `node scripts/p15-grid.mjs --manifest v10 --stage full --policy unconditional-descend --seeds 10`
