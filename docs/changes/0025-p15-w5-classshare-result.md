# 0025：W5 class-share 三类候选确认（未通过）

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0024 的三类候选）
- 关联：W4 特征子空间（`changes/0024`）、W4 确认轮（`changes/0014`）
- 性质：探索层确认候选；不改变 rules-v10 结算语义、参数注册表或生产策略，
  不构成 G1.5/P6-05 判定

## 1. 变更

1. **新增 W5 确认脚本**：`scripts/p15-w5-classshare.mjs`，按先冻结的设计
   `docs/research/2026-11-04-p15-w5-classshare.design.json`
   （`sha256:3352d521…43f35`）运行：
   - 6 个 W4 cell × 30 个全新 `p15r5-*` 种子 × 3650 tick = 180 run；
   - 仅用 5 个阶级占比（w3）做 z-score + Ward，k 固定为 3；
   - 20 次半样本 ARI、temporalConsistency、每簇 run 数、方向预测；
   - 10 seeds/cell × 7300 tick 收敛子集。
2. **结果**：
   - 轮廓 0.527；ARI median/min **0.904/0.787**（过 ≥0.70）；
   - temporalConsistency **0.789**（142/180，**未过 0.80**）；
   - 最小簇 30 run（过）；方向预测 6/6 过；7300 收敛 0.833（过）。
   - 判定：`W5 三类候选未通过：temporalConsistency`。
3. **诊断**：38 个时序失配集中在 B 边界——B-w10 10/30、B-w15 22/30 从 C 侧
   转入 B 侧；A 30/30 稳定，C 三 cell 各 2/30 失配。w2b 时 B 尚未收敛，w3 才
   进入 B；这是开放体制慢收敛，不是随机噪声。
4. **10950 tick 收敛探针**（探索层，30 seeds/cell，对齐 W5 的 3650 簇）：
   - B-w15：25/30 同簇（5 个从 C 转入 B；最终 30/30 都在 B）；
   - C-w60：3/30；C-w80：8/30；C-w100：19/30。
     C 类越往低 `scarcityWeight` 越容易滑回 B，C-w100 也有 11/30 滑回。
     **A/B/C 三类是有限视野现象，A vs B/C 两类才是稳健结构。**
5. **结论**：W5 未通过；P6-05 的 ≥3 类仍未满足。不得放宽 temporal gate、
   删除边界 cell 或改短视野来“救” W5；要产生稳健第三类，需要 rules-v11 的
   阶级配额、网络闭锁阈值、占用棘轮/滞后或位置外部性。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- 新增脚本仅做探索/确认候选；产物标记 `confirmationCandidate=true`、
  `postHocHypothesis=true`，不能替代 W4 产物或作为 P6-05 证据。
- 设计 JSON 在运行前冻结；运行输出携带 `designHash`，可离线核对。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- W5 主跑 180 run + 收敛 60 run；两次 10950 探针各 60 run；0 全灭，
  边界与判定字段完整。
- 运行前后 `designHash` 一致（`3352d521…43f35`），证明设计未在运行中改写。

## 4. 未完成

- 仅 mock 策略；未测 Jev/random。
- 10950 探针是探索层，未覆盖所有 cell；未做 10950 的全 6-cell 聚类。
- 未实现 rules-v11 机制，也未预注册 P6-05。
- `p15r5-*` 种子已用于 W5；后续确认需另取新种子集。

## 5. 证据

- `out/p15-w5-classshare.json`（180 + 60 run，87,666 B，
  sha256 `0e70be3c…73ee31`）
- `out/p15-w5-convergence-10950.json`（60 run，9,941 B，
  sha256 `ee72e45f…16d7aa6`）
- `out/p15-w5-convergence-10950-c80-c100.json`（60 run，9,973 B，
  sha256 `65cb9019…bd3736`）
- 设计：`docs/research/2026-11-04-p15-w5-classshare.design.json`
  （`sha256:3352d521…43f35`）
- 研究记录：`docs/research/2026-11-04-p15-w5-classshare-result.md`
