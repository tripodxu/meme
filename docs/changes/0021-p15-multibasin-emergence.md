# 0021：多吸引域与开放体制反馈探针（探索层）

- 日期：2026-11-04
- 作者：核心/规则负责人（用户要求「继续研究如何产生涌现现象」）
- 关联：W4 确认轮（`changes/0014`）、策略敏感性（`changes/0018`–`0020`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、参数注册表或生产策略，
  不构成 G1.5/P6-05 判定

## 1. 变更

1. **反馈轴脚本扩展**：`scripts/p15-feedback-explore.mjs`
   - `INITIAL_CONDITIONS` 增加 `ic-bottom`/`ic-top`（默认仍是 2 个，旧 family 行为不变）；
   - 新增 `open-feedback` family：在 `share=0.5, w=10` 的开放体制下重跑网络 β、
     阶级同配、重连、拥挤、极化、O 权重/时间常数等 9 个反馈轴，用于检验开放体制
     能否恢复多吸引域。
2. **新探针脚本**：`scripts/p15-multibasin-probe.mjs`
   - A/B/C 三个参数体制 × 4 个 IC × 3650/7300 两个视野；
   - 支持 `--cells` 过滤与 `--out` 自定义输出，避免覆盖既有产物；
   - 输出每个 (cell, IC, horizon) 的终态 P、mUp/mDown、IC 对 L1/噪声，以及
     k=2…5 的轮廓/稳定性/簇组成。
3. **主要发现**：
   - **闭合体制 A（share=1）**：220-run 反馈轴全部显示 ic-default（P0≈0.57）与
     ic-middle（P1≈0.55）两个吸引域，差异 0.72–0.81 L1，远大于种子噪声 0.10–0.24；
     7300 tick 下仍有至少三个可分离终态族（底重 / 中产 / 上中产）。
   - **开放体制 B/C（share=0.5）**：IC 差异落入噪声（B 0.20–0.52 vs 噪声 0.29–0.57；
     C 0.11–0.17 vs 噪声 0.11–0.18），且 7300 tick 仍在漂移；开放准入擦除初始记忆。
   - **开放反馈轴**：9 个轴在测试强度下都没有产生稳定 IC 依赖；仅 congestion=1
     在 3650 出现候选信号，但 80-run/7300 复算显示聚类按**视野**而非 IC 分裂，
     是瞬态而非多吸引域。
   - **k=3 候选**：120 个多点 k=3 轮廓 0.538、ARI 0.964/0.886，但簇组成混合了
     A 的 IC 族与 C；不能据此声称 P6-05 通过。
4. **结论**：当前规则中稳健的涌现来源是**组成守恒/闭合**，不是开放性；要得到
   ≥3 类语义干净的结构，需要阶级配额、网络闭锁阈值、占用棘轮/滞后或位置外部性
   等 rules-v11 级机制，需另立规则决策与预注册。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- `p15-feedback-explore.mjs` 的默认 family 仍为 `feedback`，默认 `--ics 2`；
  新 IC 与 `open-feedback` 只在显式参数下启用。
- `p15-multibasin-probe.mjs` 为新增脚本；默认输出
  `out/p15-multibasin-probe.json`，`--out` 可避免覆盖。
- 所有产物标记 `exploratory=true`，不能替代 W4 产物或作为 P6-05 证据。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- 四组探索均成功运行：220 / 120 / 180 / 80 run；0 全灭；聚类字段完整。
- 复算的 congestion 探针使用 10 seeds × 2 horizons，确认 3650 的 IC 信号不跨视野。

## 4. 未完成

- 仅 mock 策略；未测 Jev/random。策略敏感性已表明 descend 门控会改变方向结论，
  多吸引域也需策略复核。
- A 的 default/bottom、middle/top 分离是边际的；需 30 seeds 与更长视野确认。
- 反馈轴只测一个强度；不能排除更强非线性会改变结论。
- 未实现 rules-v11 机制（配额/闭锁阈值/棘轮/位置外部性），也未预注册 P6-05。

## 5. 证据

- `out/p15-feedback-v10-explore.json`（220 run，453,746 B，
  sha256 `bc9f1f28…eeabaa`）
- `out/p15-multibasin-probe.json`（120 run，69,817 B，
  sha256 `4836d01c…46b62a`）
- `out/p15-open-feedback-explore.json`（180 run，374,713 B，
  sha256 `9b8088ec…65b842`）
- `out/p15-multibasin-congestion-probe.json`（80 run，41,126 B，
  sha256 `7ae91bd8…12b2be`）
- 研究记录：`docs/research/2026-11-04-p15-multibasin-emergence.md`
