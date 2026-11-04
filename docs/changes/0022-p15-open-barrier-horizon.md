# 0022：开放体制壁垒扫描——3650 的“多吸引域”是慢混合

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0021 的开放体制问题）
- 关联：多吸引域与开放反馈探针（`changes/0021`）、W4 确认轮（`changes/0014`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、参数注册表或生产策略，
  不构成 G1.5/P6-05 判定

## 1. 变更

1. **探针 cell 扩展**：`scripts/p15-multibasin-probe.mjs` 增加开放体制的上升壁垒
   组合（均在 `share=0.5, w=10` 上）：
   - `B-cushion90/180/365`：`ascent.holdingCushionDays` = 90/180/365（默认 30）；
   - `B-cross120`：`ascent.crossDays=[120,150,180,210]`（默认 `[30,40,50,60]`）。
2. **壁垒扫描（160 run）**：4 cell × 4 IC × 10 seeds × 3650 tick。
   - cushion90/180 与 cross120 的 IC 对 L1 均未超过 2× 种子噪声；
   - 只有 cushion365 在 3650 出现强 IC 分离：default-middle 0.597（2.86×）、
     default-top 0.733（3.29×）、middle-bottom 0.769（3.46×）、bottom-top 0.897（4.03×）。
3. **cushion365 复算（80 run，10 seeds × 3650/7300）**：
   - 3650：default P0=0.332、middle P2=0.258、bottom P0=0.423、top P2=0.440；
   - 7300：default P1=0.777、middle P1=0.703、bottom P1=0.797、top P2=0.457；
     default/middle/bottom 收敛到 P1≈0.70–0.80，只有 top 保持独立；
   - IC 对 L1 从 0.60–0.90 降到 0.19–0.74；k=2 的 19 点小簇是 **default+bottom
     的 3650 点**，即聚类按**视野**而非 IC 分裂。
4. **结论**：高上升壁垒只是**减慢混合**，3650 tick 的 IC 分离在 7300 大多收敛；
   开放体制的短视野“多吸引域”是瞬态，不是稳定结构。该结果强化 changes/0021 的
   结论：稳健涌现来自组成守恒/闭合，而不是壁垒强度或开放性。后续任何开放体制
   结构声明都必须加**收敛/长视野门槛**。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- 仅新增探索 cell 与产物；`p15-multibasin-probe.mjs` 默认 cell 集合未变。
- 产物带 `exploratory=true`，不能替代 W4 产物或作为 P6-05 证据。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- 壁垒扫描 160 run 与 cushion365 复算 80 run 均成功；0 全灭；聚类字段完整。
- 复算确认 3650 的强分离不跨视野保持，属于慢混合而非稳定多吸引域。

## 4. 未完成

- 仅 mock 策略；未测 Jev/random。
- cushion365 是参数域上限（365）；未做 `holdingCushionDays` 与 `crossDays` 的组合扫描。
- 仍未实现 rules-v11 的守恒/棘轮机制，也未预注册 P6-05。

## 5. 证据

- `out/p15-barrier-probe.json`（160 run，78,551 B，
  sha256 `8bf2dd8f…3544ca`）
- `out/p15-cushion365-probe.json`（80 run，39,968 B，
  sha256 `427d729c…1baa10`）
- 研究记录：`docs/research/2026-11-04-p15-multibasin-emergence.md` §3.4
- 重跑：
  `node scripts/p15-multibasin-probe.mjs --cells B-cushion90,B-cushion180,B-cushion365,B-cross120 --seeds 10 --horizons 3650 --out out/p15-barrier-probe.json`
  与
  `node scripts/p15-multibasin-probe.mjs --cells B-cushion365 --seeds 10 --horizons 3650,7300 --out out/p15-cushion365-probe.json`
