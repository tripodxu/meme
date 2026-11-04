# 0024：W4 特征子空间——class-share 空间出现 A/B/C 三类候选

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0021–0023 的第三类问题）
- 关联：W4 确认轮（`changes/0014`）、多吸引域/壁垒/A-IC30（`changes/0021`–`0023`）
- 性质：探索层（07 §6.1）；只读分析，不跑模拟，不改变 rules-v10、参数注册表或
  预注册 manifest，不构成 G1.5/P6-05 判定

## 1. 变更

1. **只读分析脚本**：新增 `scripts/p15-feature-subspace.mjs`，读取
   `out/p15-v10-full.json`（W4 的 180 run），对 5 种特征子空间做 k=2…5 的
   Ward 聚类、轮廓、20 次半样本 ARI 与簇组成：
   - `class`：仅 5 个阶级占比；
   - `network`：segregation/openness/cross-class edge/degree/mUp/mDown；
   - `classNet`：class + 3 个网络量；
   - `full`：W4 预注册的完整 `featureVector`；
   - `traj`：w3−w2b 的占比/网络变化。
2. **主要结果（180 点，20 次半样本）**：
   - `class` k=3：轮廓 0.517、ARI median/min **0.828/0.660**；簇为
     c0=A（30）、c1=B（60，B-w10 30 + B-w15 29 + C-w100 1）、
     c2=C（90，C-w60/80/100 89 + B-w15 1）。**A/B/C 几乎完全按 cell 分开。**
   - `classNet` k=3：轮廓 0.426、ARI **0.834/0.629**；A 30、B 53、C 97。
   - `full` k=3：轮廓 0.371、ARI **0.757/0.522**；B/C 被混成两簇
     （107 = B 18 + C 89；43 = B 42 + C 1）。
   - `network` k=2：轮廓 0.575、ARI **1.000/1.000**（A vs 其余）；k=3 只有
     0.367/0.673，B/C 不按 cell 分。
   - `traj` k=3：0.285/0.658，弱。
3. **解释**：B 与 C 的差异主要是**阶级占比形状**（B 的 P2≈0.43–0.50、P0≈0；
   C 的 P0≈0.08–0.15、P1≈0.37–0.39、P2≈0.25），而 W4 的完整特征向量把
   gini/network 维度也纳入，稀释了这条轴，所以 k=2 把 B∪C 合并。第三类不是
   “没有”，而是被**特征选择**掩盖。
4. **不能直接宣布 P6-05**：k=3 的 ARI min 0.660 < 0.70；且特征集是看到 W4 后
   选的，存在 post-hoc 选择风险。要确认，必须新开 `experimentId`、用全新种子
   （`p15r5-*`）预注册 class-share 特征与 k=3，并加 7300 tick 收敛检查
   （changes/0022 的开放体制漂移 caveat）。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- 只读脚本不进入构建产物；产物 `out/p15-w4-feature-subspace.json` 标记
  `exploratory=true`，不能替代 W4 产物或作为 P6-05 证据。
- 更换特征集属于分析管线变更，按 07 §8.1 必须新 `experimentId`；本记录不改变
  W4 的预注册结论。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- 脚本只读 W4 产物，180 点全部可用；k=2…5 的轮廓/ARI/组成完整。
- 结果可离线复算：`node scripts/p15-feature-subspace.mjs`。

## 4. 未完成

- 未跑 W5 确认轮；未使用 `p15r5-*` 新种子；未做 7300 tick 收敛检查。
- class-share k=3 的 ARI min 0.660 未过 0.70；需要 30 个新种子与更长视野确认。
- 未解决 post-hoc 特征选择风险；W5 预注册必须披露假设来自 W4 探索。
- 不改变 P6-05 状态，也不把本分析升格为 G1.5/P6 证据。

## 5. 下一步（W5 提案，尚未运行）

若继续，建议预注册 W5：

- **cells**：与 W4 相同的 6 个（A-share1、B-w10/w15、C-w60/w80/w100）；
- **seeds**：`p15r5-seed-001…030`（全新，不与 p15r3/p15r4 重叠）；
- **feature set**：仅 5 个阶级占比（z-score pooled），k **固定为 3**；
- **gates**：ARI median/min ≥0.70、temporalConsistency ≥0.80、每簇 ≥5 run、
  方向预测 A P0≥0.40；B P0≤0.02 且 P2≥0.40；C P0≥0.05 且 P1≥0.35；
- **收敛**：3650 tick 主判定 + 每 cell 10 seeds 的 7300 tick 收敛子集
  （同一簇分配率 ≥0.80），防止把慢混合当成结构；
- **声明**：假设来自 W4 的 class-share 探索，属于新 experimentId，不回溯改写 W4。

## 6. 证据

- `out/p15-w4-feature-subspace.json`（180 点，14,812 B，
  sha256 `3ae38cd3…4cf7c7`）
- 脚本：`scripts/p15-feature-subspace.mjs`
- 研究记录：`docs/research/2026-11-04-p15-multibasin-emergence.md` §3.6
