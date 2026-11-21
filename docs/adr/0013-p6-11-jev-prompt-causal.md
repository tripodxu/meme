# 0013 阶段 R3：`P6-11` 真实 Jev 提示词规范诱导宏观相变因果实验

- 状态：accepted（2026-11-18，正式立项）
- 决策者：徐鼎
- 关联：[科研路线图](../research/2026-11-18-scientific-research-roadmap.md)、[04 Jev 契约](../04-jev-decision-contract.md)、[07 实验方案](../07-experiment-calibration.md)、[changes/0056](../changes/0056-p6-04b-formal-live-prereg.md)
- 影响：预注册实验 `P6-11`（不改 `src/core` 规则与默认配置）

## 科学问题

在**完全相同的客观经济与制度规则**（`rules-v18` 默认配置、`N=40`、`730` tick、`decision.interval=30`）下，仅改变微观个体所接收的社会叙事提示（`promptStyle: 'neutral'` vs `'survival_hint'`），是否足以引起宏观制度开放度 $O$ 与社会分层结构（$S$、$M_{\text{up}}$）的统计显著配对因果相变？

## 预注册实验设计（`P6-11`）

- **配对种子集**：`30` 个全新独立种子（`p6-jev-seed-001..030`）；
- **三组对照（共 `90` run）**：`mock-weighted-v1`、`jev_live(neutral)`、`jev_live(survival_hint)`；
- **观测窗口**：`w1`（tick `365..729`，共 `365` tick）；
- **质量闸门（07 §11）**：`extinct=false`、`cancelled=false`、`observedTicks === 365`、`fallbackRate <= 0.20`、`responseModels.length === 1`、`missingUsage === 0`；
- **主假设与统计口径**：
  - 主对比：`live(survival_hint) vs live(neutral)`；
  - 主指标：`|median(ΔO)| >= 0.05` 且 10,000 次配对 bootstrap 95% CI 不跨 0、100,000 次配对符号翻转置换检验经 Benjamini–Hochberg（`q = 0.05`）校正后显著；
  - 次要指标：`ΔS`（阈值 `0.05`）、`ΔMup`（阈值 `0.05`），同报 `TV(P)` 与 `ΔG` 及 `live vs mock` 对照。
