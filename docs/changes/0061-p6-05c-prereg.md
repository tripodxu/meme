# 0061 P6-05c 自反馈 θH 四 cell 预注册

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0004、changes/0060、changes/0057/0058、07 §8.1
- 性质：**rules-v12 机制检验**；不是校准、现实因果或结构涌现声明
- 预注册：`out/p6-05c-prereg.json`
- experimentId：`p6-05c-f7f3cc91`
- designHash：`sha256:f7f3cc910ccef56593c89ae6becf142aaef4a8482bdc464bef5935aa569989ac`

## 1. 协议（运行前冻结）

- 配置：`rules-v12`、`mock-weighted-v1`、40 人、10950 tick；终端窗口
  `[10585,10949]` 的 11 维全特征（`P0..P4、G、top10、Mup、Mdown、S、O`）。
- 固定 `ascent.displacementShare=0.5`、`ascent.scarcityWeight=15`。
- 4 个 cell：`openness.selfReinforcement` θH ∈ {0, 6, 10, 14}；
  其中 θH=0 是 rules-v12 下的 v11 等价对照。
- 30 个全新 seed（`p6-05c-seed-001…030`）× 10950 tick = 120 run；
  每 cell 前 10 seed 续跑 14600（40 run）。
- 聚类与验收沿用 P6-05：z-score(pooled)、Ward-LW、k=3、20 次稳定性、
  每簇 ≥5、ARI median ≥0.70、silhouette ≥0.35、14600 同簇率 ≥0.80、
  至少一个簇含 ≥2 个 cell。

## 2. 预注册预测（运行前写死）

- θH=0 应保持 P6-05b 的二簇/弱三簇形态；
- θH∈{6,10,14} 若真的产生两个 O 稳定区间，应出现 14600 同簇率 ≥0.80 的第三簇
  （高 S/低 O 或低 S/高 O）；
- 若四个 cell 都没有稳定第三簇，ADR 0004 的 A 方案判失败，转方案 B
  （显式制度状态机）；不得继续调 θH、换 seed 或换 k。

## 3. 结果

**执行（2026-11-05 23:10–23:43 UTC，VPS `2zhou`）**：160/160 run 完成、
0 排除、0 灭绝；120 个 base run 全部可用，40 个 14600 followup。
产物：`out/p6-05c/runs.ndjson`、`out/p6-05c-analysis.json`。

**判读**：k=3 簇大小 **[72, 39, 9]**；簇 0 与簇 1 都混合全部四个 θH cell，
簇 2 只含 θH∈{6,10,14}（1/5/3，无 θH=0）。`silhouette 0.215`、
`ARI median 0.182`（min 0.107）、14600 同簇率 **0.675**，三项均未过线；
`antiPreset=true`。k=2 诊断 [111, 9]、silhouette 0.505：**二簇结构稳健，
第三簇只是 9 个 run 的小而不稳定子群**。

**结论**：θH 自反馈没有产生稳定第三簇；ADR 0004 的 A 方案判失败。
按预注册**停止调 θH、换 seed 或换 k**，转方案 B（显式制度状态机）。
本结果只针对 mock、40 人、10950 tick，不构成校准、现实因果或结构涌现声明。

## 4. 复现

```bash
node scripts/p6-05-cluster.mjs --freeze --design p6-05c
node scripts/p6-05-cluster.mjs --run --design p6-05c
node scripts/p6-05-cluster.mjs --analyze --design p6-05c
```
