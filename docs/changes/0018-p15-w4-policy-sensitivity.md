# 0018：W4 策略敏感性（random）与 G1.5 的适用范围

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0017 的策略敏感性结论）
- 关联：W4 确认轮（`changes/0014`）、descend 触发条件探针（`changes/0017`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、预注册 manifest 或生产策略，
  不回溯改变 W4 的 G1.5 判定

## 1. 变更

1. **脚本能力（仅探索）**：`scripts/p15-grid.mjs` 新增
   `--policy random-uniform-v1` 与 `--seeds N`，用于对预注册格点做策略敏感性检查。
   策略覆盖仅允许 `--manifest v10`；产物写入
   `out/p15-<manifest>-policy-<policy>-<stage>.json`，并带
   `exploratoryPolicySensitivity=true` 与 `policy.executed` 标记。
2. **verdict 文案修复**：原先只要 k=2 硬门槛通过、任一其它子项失败，就笼统写成
   「聚类协议子项不满足」。现改为逐项列出失败原因（如「方向预测不满足」）；
   判定结果本身不变。该缺陷由本轮 random 产物暴露。
3. **探索结果（60 run，6 cell × 10 seeds）**：
   - **聚类分裂保留**：k=2、轮廓 0.530、ARI median/min 1.000、temporal 1.000；
     c0 = A（20 点）、c1 = B∪C（100 点），与 W4 mock 同构。
   - **方向预测失败**：A P0=0.960（过 ≥0.40）；B/C 最差 P0=0.677（门槛 ≤0.15）、
     最差 mUp=0.906（门槛 ≤0.40）。判定 `G1.5 未通过：方向预测不满足`。
   - **机制差异**：mock 下 B/C 为底轻/中产（P0≈0–0.147、mUp≈0.12–0.18，
     P3/P4≈0.15–0.26/0.08）；random 下 B/C 为底重/高流动（P0≈0.612–0.677、
     mUp≈0.857–0.906，P3/P4≤0.008），`scarcityWeight` 几乎不再改变占比。
4. **结论**：W4 的 A vs B∪C 分裂对该策略替换稳健，但 **B/C 的方向含义不稳健**。
   因此 G1.5 的通过范围是「预注册 `mock-weighted-v1` + 该格点」；
   「开放准入 + 锚定 → 底轻/中产」不得表述为策略无关的规则层机制。
   Jev 实验必须单独预注册并按策略分层报告。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- `p15-grid.mjs` 是脚本而非构建产物；默认不带 `--policy` 时行为与旧版一致
  （仍为 `mock-weighted-v1`，输出路径不变）。
- W4 的预注册 manifest 与 `preregistrationHash` 未改；random 产物只是覆盖策略的
  探索运行，不能替代 `out/p15-v10-full.json`。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- random 预检 6 run 成功；正式探索 60 run（wall 1 分钟、0 全灭、budgets.ok）
  成功；判定与聚类字段完整。
- verdict 修复后用同一 random 配置重跑，产物输出
  `G1.5 未通过：方向预测不满足`；mock 的 W4 产物未重跑（其判定仍为通过，
  不受文案修复影响）。

## 4. 未完成

- 只测 `random-uniform-v1`，未测 Jev，也未测「无条件 descend + mock 其它权重」
  的中间策略；10 seeds/cell，未做 30-seed 复算。
- 未区分随机性本身与下降条件各自的贡献（后者由 changes/0017 部分回答）。
- 不改变 P6-05（≥3 类）状态，不把本探索升格为 G1.5/P6 证据。

## 5. 证据

- `out/p15-v10-policy-random-full.json`（60 run，302,989 B，
  sha256 `a10dff5b…21b6de`，`exploratoryPolicySensitivity=true`）
- 预检 `out/p15-v10-policy-random-screen.json`（6 run，未入库）
- 研究记录：`docs/research/2026-11-04-p15-w4-policy-sensitivity.md`
- 重跑：
  `node scripts/p15-grid.mjs --manifest v10 --stage full --policy random-uniform-v1 --seeds 10`
