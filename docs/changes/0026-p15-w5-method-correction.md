# 0026：W5 方法学修正——w3-only 与 pooled 两种口径均未通过

- 日期：2026-11-04
- 作者：核心/规则负责人（承接 changes/0025 的 W5 结果）
- 关联：W5 确认（`changes/0025`）、W4 特征子空间（`changes/0024`）
- 性质：探索层确认候选的方法学修正；不改变 rules-v10、参数注册表或生产策略，
  不构成 G1.5/P6-05 判定

## 1. 问题

W5 设计 JSON 的 `featureWindows` 同时列出 `w2b`/`w3`，但没有写死是否把两个窗口
一起聚类、以及如何做 temporal 检查。实现出现了两种口径：

- **w3-only（主脚本 `p15-w5-classshare.mjs`）**：只用 w3 的 180 个点聚类，
  w2b 按最近质心分配到 w3 簇；
- **pooled（W4 `p15-grid` 协议）**：把 w2b+w3 的 360 个点一起聚类，
  temporal 检查同 run 两窗是否同簇。

两种口径给出不同的失败项，必须同时报告，不能挑选有利口径。

## 2. 结果

| 方法                     | 点数 | 轮廓  | ARI median/min    | temporal | 最小簇 run | 失败项   |
| ------------------------ | ---- | ----- | ----------------- | -------- | ---------- | -------- |
| w3-only + 最近质心       | 180  | 0.527 | 0.904 / 0.787     | 0.789    | 30         | temporal |
| pooled w2b+w3（W4 协议） | 360  | 0.438 | 0.781 / **0.610** | 0.944    | 30         | ARI min  |

pooled 簇组成：c0=A 60 点；c1=B-w10 55 + B-w15 48 + C-w60 1；c2=B-w10 5 +
B-w15 12 + C-w60 59 + C-w80 60 + C-w100 60。B-w15 有 12/60 点落到 C 侧，
C-w60 有 1/60 点落到 B 侧，边界仍模糊。

**两种口径各有一项未过，W5 均不通过。** 0025 中“失败只来自 temporal”的诊断
只适用于 w3-only；pooled 口径的 temporal 通过，但 ARI min 失败。失败点仍然是
B/C 边界，而不是 A 类或随机噪声。

## 3. 结论与修正

- W5 **未通过**，P6-05 的 ≥3 类仍未满足；不得用“换口径”把 W5 改成通过。
- 10950 tick 探针（changes/0025）仍成立：B-w15 最终 30/30 都在 B；
  C-w60/80/100 仅 3/8/19 保持 C，C 类随时间滑回 B。A vs B/C 两类才稳健。
- **流程缺陷**：W5 设计未冻结 pooling/assignment/tie-breaking，导致主脚本与
  W4 协议不可直接比较。后续 W6（若启动）必须在设计 JSON 中写死
  “pooled 360 点 + 20 次半样本 ARI + 同 run 两窗同簇 + 最小簇按 run 计”，
  并在运行前冻结分析脚本版本。
- 不改变 P6-05 状态；不把 W5 或 pooled 复核升格为 G1.5/P6 证据。

## 4. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- 新增只读脚本 `scripts/p15-w5-pooled.mjs`；不进入构建产物。
- 产物 `out/p15-w5-classshare-pooled.json` 标记 `exploratory=true`，
  不能替代 W5 主产物或作为 P6-05 证据。

## 5. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- pooled 复核只读 W5 的 180×2 窗口，360 点全部可用；k=3 轮廓/ARI/组成完整。
- 两口径结论一致：W5 未通过。

## 6. 证据

- `out/p15-w5-classshare-pooled.json`（360 点，921 B，
  sha256 `28b2b0a7…b49f66`）
- 主结果：`out/p15-w5-classshare.json`（changes/0025）
- 脚本：`scripts/p15-w5-pooled.mjs`
- 研究记录：`docs/research/2026-11-04-p15-w5-classshare-result.md` §2.1
