# 0012 阶段 R2-B：`rules-v18` 代际人力资本传递与 30-run 探索探针

- 状态：accepted（2026-11-18，探索探针未过线，停止该机制调参）
- 决策者：徐鼎
- 关联：[科研路线图](../research/2026-11-18-scientific-research-roadmap.md)、[ADR 0009](0009-rules-v16-generational-succession.md)、[changes/0092](../changes/0092-rules-v18-r2b-probe-result.md)
- 影响：`src/core`（`rules-v18` / `engine-v0.15.0` / `stratify-config-v12`）、阶段 E 新生个体天赋计算、UI 参数面板
- 不改变：`population.talentInheritanceWeight = 0`（默认）时与 `rules-v17` 运行轨迹逐位一致；D1「2 体制 + 连续统」G6 结论不变

## 机制假设（阶段 R2-B）

在 `generationalMode = 'replace'` 下，新生儿先天有效天赋 `ge` 受亲代阶级与社会开放度 `O` 调节：

$$ge_{\text{child}} = \text{clamp}\left(ge_{\text{raw}} \times \left(1 + \gamma \cdot z[\text{parentClass}] \cdot (1 - O)\right),\ \text{min},\ \text{max}\right)$$

其中 $z[c] = \frac{c}{C - 1} - 0.5 \in [-0.5, +0.5]$，$\gamma = \text{population.talentInheritanceWeight} \in [0, 2]$（默认 `0` 不生效）。

## 探索探针纪律与结论

按路线图 §3 阶段 R2 执行纪律，先以全新小规模探索种子（`explore-r2b-seed-001..005` × 6 单元 = 30 run、`N=40`、`10950` tick）检验是否达到 `k=3 ARI >= 0.85` 且 `silhouette >= 0.45` 门槛再决定是否立项 240 run 正式确认轮：

- 实测 `30/30` 有效、0 灭绝；`k=2` 仍以 `ARI = 1.000`、`silhouette = 0.4576` 分离 `A(share=1)` 与 `B∪C(share<1)`；
- `k=3` 簇大小为 `[10, 16, 4]`、`ARI median = 0.6145 < 0.85`、`silhouette = 0.4302 < 0.45`，**探索探针未达标**；
- 原因为代际更替下社会开放度 `O` 维持在 `0.88–0.95`，使 $(1 - O) \le 0.12$，天赋调制幅度不足以形成封闭贫困陷阱。按预注册纪律停止对该机制调参，不再消耗 240 run 正式确认轮。
