# 0023：A 体制 30-seed 复算——k=3 候选不成立

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0021 的 k=3 候选）
- 关联：多吸引域探针（`changes/0021`）、开放壁垒扫描（`changes/0022`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、参数注册表或生产策略，
  不构成 G1.5/P6-05 判定

## 1. 变更

1. **复算设计**：`scripts/p15-multibasin-probe.mjs` 对 A-share1（`share=1, w=0`）
   跑 4 个初始阶级分布（default/middle/bottom/top）× 30 seeds × 3650 tick
   = 120 run；使用 `p15r3-*` 前 30 个种子。
2. **k=2（稳健）**：轮廓 0.507、ARI median/min **0.942/0.869**；
   簇为 {default+bottom} 59 点 vs {middle+top} 61 点。即**底重 vs 中上**两类。
3. **k=3（不成立）**：轮廓 0.559、ARI **0.676/0.610**（低于 0.70 门槛）；
   第三簇只有 13 个混合点（middle/top/default 混合），不对应任何干净机制。
   5-seed 的 k=3 ARI 0.964 是**小样本过拟合**。
4. **k=4（稳定但非三类）**：轮廓 0.630、ARI 0.991/0.962；但簇是把
   {default+bottom} 与 {middle+top} 各自再细分（51+8、13+48），不是三个语义类。
5. **结论**：当前 rules-v10 在 A 体制的稳健结构是**两类**；即使把初始阶级分布
   作为设计因子，也不能达到 P6-05 的三类。要得到 ≥3 类，需要 rules-v11 的
   守恒/棘轮机制，或换一个结构轴（如网络社区/制度状态），而不是继续加 IC 或
   提高壁垒。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- 仅新增探索产物；`p15-multibasin-probe.mjs` 的行为与默认输出未变。
- 产物带 `exploratory=true`，不能替代 W4 产物或作为 P6-05 证据。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- 120 run 成功，0 全灭；k=2…5 的轮廓/稳定性/簇组成完整。
- 30-seed 复算推翻了 5-seed 的 k=3 候选；k=2 的结论与 changes/0021 的
  “A 体制双吸引域”一致。

## 4. 未完成

- 仅 mock 策略；未测 Jev/random。
- 只测 A-share1 一个参数点；未把 IC 因子加到 B/C（B/C 已被 0021/0022 证明
  记忆擦除/慢混合）。
- 未实现 rules-v11 机制，也未预注册 P6-05。

## 5. 证据

- `out/p15-a-ic30-probe.json`（120 run，55,951 B，
  sha256 `dde1fad0…deb28d`）
- 研究记录：`docs/research/2026-11-04-p15-multibasin-emergence.md` §3.5
- 重跑：
  `node scripts/p15-multibasin-probe.mjs --cells A-share1 --seeds 30 --horizons 3650 --out out/p15-a-ic30-probe.json`
