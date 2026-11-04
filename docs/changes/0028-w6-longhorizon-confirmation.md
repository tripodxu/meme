# 0028：W6 长视野三类候选确认（通过，非 P6-05 正式验收）

- 日期：2026-11-04
- 作者：核心/规则负责人
- 关联：W5 未通过（`changes/0025`/`0026`）、rules-v11 与长视野复核
  （`changes/0027`）、设计
  `docs/research/2026-11-04-p15-w6-longhorizon.design.json`
- 性质：预注册确认候选通过；不改变规则/参数/生产策略，不构成校准或 P6-05 正式验收

## 1. 变更

新增并运行 `scripts/p15-w6-longhorizon.mjs`，按运行前冻结的设计：

- 3 cell：A（share=1）、B（share=0.5,w=15）、C（share=0.5,w=60），全部 `H=0`；
- 30 个全新 `p15r6-seed-001…030`；10950 tick 终态 5D class-share；
- k 固定 3；`ward-lw-v1` + Euclidean + z-score(pooled)；20 次半样本 ARI；
- cell 主簇纯度、B/C 质心 L1、方向预测；
- 10 seeds/cell × 14600 收敛子集。

设计 sha256 `04ed2dde…4820`；运行输出携带同一 `designHash`，运行中未改写设计。

## 2. 结果

| 子项             | 实测                      | 门槛   | 结果   |
| ---------------- | ------------------------- | ------ | ------ |
| 轮廓（k=3）      | 0.638                     | ≥0.35  | 过     |
| ARI median / min | 0.997 / 0.938             | ≥0.70  | 过     |
| 最小簇 run       | 30                        | ≥5     | 过     |
| 簇大小           | 30 / 30 / 30              | —      | 非退化 |
| cell 主簇纯度    | A 30/30、B 30/30、C 30/30 | ≥27/30 | 过     |
| 三 cell 映射     | A/B/C 三个不同簇          | 3 簇   | 过     |
| B/C 质心 L1      | 0.5133                    | ≥0.20  | 过     |
| 方向预测         | 3/3                       | 全满足 | 过     |
| 14600 同簇率     | 29/30 = 0.967             | ≥0.80  | 过     |

120 run，wall 13 min，0 全灭。14600 分 cell：A 10/10、B 10/10、C 9/10。

10950 cell 均值：

- A：`[0.537, 0.300, 0.056, 0.053, 0.053]`
- B：`[0, 0.002, 0.392, 0.405, 0.201]`
- C：`[0, 0.258, 0.369, 0.219, 0.154]`

## 3. 解释

- W5 的“C 滑回 B”是**3650 簇映射 10950 终态**的方法学产物，不是 C 必然消失。
  直接在同一 10950 视野聚类，A/B/C 30/30/30 分开。
- 第三类不是 rules-v11 的占用记忆造成的：W6 全部 `H=0`；H 扫描中
  H=0/90/180/365 的 10950 终态几乎重合。rules-v11 保持默认 0，不据此宣称有效。
- 第三类是长视野终态候选，不是 3650 的 C 原地保持：C 的组成从 3650 的 P1-heavy
  漂移到 10950 的 P2-heavy。

## 4. 结论边界

W6 通过的是 **class-share 终态的三类候选**。它不是 P6-05 正式验收，也不是校准：

- 仅 `mock-weighted-v1`，未测 Jev/random；
- 仅 3 个 cell、class-share 单特征，未覆盖 07 §8.1 的全特征向量；
- 未做 P6-04 的五个消融与 Jev/mock 对照；
- 未证明外部效度，不得声称默认参数已校准或结构已涌现。

P6-05 仍要求按 07 的全特征、消融与校准报告完成正式验收。若要在 3650 视野内得到
三类，仍需正反馈机制（占用优势/网络闭锁），而不是继续增大 H。

## 5. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`stateSchemaVersion` 不变
  （rules-v11/engine-v0.9.0/config-v6/state-v3；W6 使用 `H=0`）。
- 无 config/state 迁移；无生产行为变化。
- 新增脚本仅做确认分析；产物标记 `confirmationCandidate=true`，不得替代 P6-05 证据。

## 6. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、`build` 通过。
- W6 运行 120 run，0 全灭；`designHash` 与冻结文件一致（`04ed2dde…4820`）。
- 预注册设计文件已加入 `.prettierignore`，防止格式化改变字节哈希。

## 7. 证据

- `out/p15-w6-longhorizon.json`（120 run，34,041 B，
  sha256 `ea01c62a…d87a7`）
- 设计：`docs/research/2026-11-04-p15-w6-longhorizon.design.json`
  （sha256 `04ed2dde…4820`）
- 方法学复核：`out/p15-longhorizon-probe.json`（90 run，36,645 B，
  sha256 `9541965f…b1d81`）
- H 扫描：`out/p15-v11-ratchet-probe.json`（60 run，37,528 B，
  sha256 `3fd84a2c…c500`）
- 研究记录：`docs/research/2026-11-04-p15-w6-longhorizon-result.md`
