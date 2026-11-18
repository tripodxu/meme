# 0088 — `rules-v16` 代际更替与 `P6-08` 预注册确认轮结果（未通过）

- 日期：2026-11-18
- 状态：已完成（`rules-v16` 实现与全量门禁通过；`P6-08` 240/240 run 零灭绝完成，按 `docs/07` §8.1 严格判读为**未通过**，G6 保持未通过）
- 关联：[ADR 0009](../adr/0009-rules-v16-generational-succession.md)、[ADR 0008](../adr/0008-stop-p6-engineering-track.md)、[07 §8.1](../07-experiment-calibration.md)
- 实验：`p6-08-f32cf4b4`（`preregistrationHash = sha256:f32cf4b41b8ebaa6ab05549c9dd8c21d441de149128210569f43e72de215f225`）
- 影响范围：`src/core`、`src/ui`、`scripts/p6-08-generational.mjs`、`test/`、`docs/`、`rule.md`

## 1. `rules-v16` 机制与版本升级

按 [ADR 0009](../adr/0009-rules-v16-generational-succession.md) 落地可控代际更替与遗产折算：

- **版本轴**：`rules-v16`、`engine-v0.13.0`、`stratify-config-v10`（`stratify-config-v9 → v10` 自动补齐 `generationalMode:'none', bequestRate:0, classInheritanceRate:0`）；状态 schema 保持 `stratify-state-v5`。
- **新增注册参数（共 101 项）**：
  - `population.generationalMode`（`'none' | 'replace'`，默认 `'none'`）：默认 `'none'` 时不生成新生个体、不消费新随机地址，轨迹与 `rules-v15` 逐位一致；
  - `population.bequestRate`（`[0,1]`，默认 `0`）：死亡亲代剩余财富按比例折算给继承者；
  - `population.classInheritanceRate`（`[0,1]`，默认 `0`）：继承者按该概率继承亲代阶级，否则从底层 `0` 起步（消费 `birth_class`）。
- **新增事件与 RNG 标签**：`agent_born` 事件；`birth_class` 与 `network_birth` 地址化随机标签；`replace` 模式下新生个体使用单调递增 `a-xxxx`（死亡者 ID 永不复用）并按当前开放度加权连接至存活邻居，维持跨代网络不断裂。
- **前端与 Golden**：更新 [setup.ts](../../src/ui/workspaces/setup.ts) 分组 01、版本徽章及 [config-default.test.ts](../../test/golden/config-default.test.ts) / [engine-mock.test.ts](../../test/golden/engine-mock.test.ts) Golden Fixture，新增 `v9→v10` 迁移与代际网络对称单测。

## 2. `P6-08` 预注册确认轮结果（240/240 run）

- **协议**：6 个参数单元（`A1_pyramid_beq0`, `A2_pyramid_beq50`, `B1_top_open_fresh`, `B2_top_open_dynasty`, `C1_olive_w30_fresh`, `C2_olive_w60_dynasty`）× 30 个全新种子（`p6-08-seed-001..030`）× 40 人 × 10950 tick（每 cell 前 10 续跑 14600 tick）；11 维全特征 `Ward-LW` + `z-score(pooled)` + 20 次二分洗牌，`wallSeconds = 471.99s`。
- **质量**：`180` base + `60` followup = `240/240` 完成，**`excluded = 0`、`extinctCount = 0`**（代际替补彻底消除了长视野人口灭绝）。
- **k=3 聚类结果**：
  - 簇大小：`[60, 115, 5]`（`antiPreset = true`）；
  - 组成：簇 0 = `A1(30) + A2(30)`；簇 1 = `B1(28) + B2(29) + C1(29) + C2(29)`；簇 2 = `B1(2) + B2(1) + C1(1) + C2(1)`；
  - 稳定性：`ARI median = 0.5646`（min `0.4564`, max `0.9689`）**< 0.70**；
  - 轮廓系数：`silhouette = 0.4757`（>= 0.35）；
  - 14600 时序同簇率：`0.9167`（>= 0.80）；
  - k=2 诊断参考：簇大小 `[60, 120]`，`silhouette = 0.4623`。
- **质心（`P0..P4, G, top10, Mup, Mdown, S, O`）**：
  - 簇 0（`A1/A2`）：`[0.9697, 0.0264, 0.0038, 0, 0, 0.4125, 0.3084, 0.6522, 0.6516, 0.1663, 0.7314]`；
  - 簇 1（`B1..C2` 主簇）：`[0.5075, 0.3156, 0.1665, 0.0104, 0, 0.4456, 0.3225, 0.9223, 0.9184, -0.0296, 0.9205]`；
  - 簇 2（5 个跨 cell 尾部 run）：`[0.4958, 0.3048, 0.1717, 0.0229, 0.0048, 0.5012, 0.3874, 0.9416, 0.9418, -0.0116, 0.9025]`。

## 3. 科学判读与边界

- **判定**：`verdict = 'not-accepted-return-to-rule-review'`，`passes = false`（因 `ARI median = 0.5646 < 0.70`）。**G6 仍未通过**。
- **机制读数**：开启代际更替后，`share=1`（`A1/A2`）与 `share<=0.5`（`B1..C2`）在 `10950` tick 下依然只形成**两类稳健宏观结构**（`[60, 120]`：`P0=0.97` 高压底层堆积 vs `P0=0.51` 高流动开放梯队）；在 `10950` tick 稳态下，代际持续补入反而让原本封闭的 `B/C` 区域重新获得持续流动性（`Mup~0.92, O~0.92`），导致 `B1/B2` 与 `C1/C2` 并未分化为两个独立离散簇，簇 2 仅是 5 个噪声尾部样本。
- **纪律边界**：不追认任何 k=2 诊断结果作为 G6 通过，不在见到结果后修改细胞定义、种子集或 `bequestRate`/`scarcityWeight` 参数重新凑数；保留 `rules-v16` 代码与 `P6-08` 完整实验产物供后续研究参考。
