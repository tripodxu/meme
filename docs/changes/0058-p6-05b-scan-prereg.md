# 0058 P6-05b 开放度–网络迟滞 × 占用记忆筛选预注册

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：changes/0057、docs/reviews/2026-11-05-p6-05-rule-review.md、07 §8.1、rule 45
- 性质：**P6-05 失败后的机制筛选**；不是校准、现实因果或结构涌现声明
- 预注册：`out/p6-05b-scan-prereg.json`
- experimentId：`p6-05b-4ba8dc0a`
- designHash：`sha256:4ba8dc0a1c9ad7359ee8b43073eabc93514872eace7a5244000cb55a607c7e3a`

## 1. 协议（运行前冻结）

- 配置：`rules-v11`、`mock-weighted-v1`、40 人、10950 tick；终端窗口
  `[10585,10949]` 取 11 维全特征（`P0..P4、G、top10、Mup、Mdown、S、O`）。
- 固定：`ascent.displacementShare=0.5`、`ascent.scarcityWeight=15`（W6 的 B 区域）。
- 2 轴 6 cell：
  - `openness.segregationWeight` θS ∈ {4, 8, 12}
  - `ascent.occupancyMemoryDays` H ∈ {0, 180}
  - 即 `thetaS4-H0`、`thetaS8-H0`、`thetaS12-H0`、`thetaS4-H180`、
    `thetaS8-H180`、`thetaS12-H180`。
- 种子：`p6-05b-seed-001…030`（30 个全新 seed，与 P6-05 的 `p6-05-seed-*` 不重叠）。
- 每 cell 30 run × 10950 tick（180 run）；每 cell 前 10 seed 续跑 14600 tick
  （60 run），终端窗口 `[14235,14599]`，用 10950 scaler/质心分配。
- 聚类：z-score(pooled)、Ward-LW、k=3；20 次随机二分稳定性；轮廓系数；
  每簇 ≥5 run；至少一个簇含 ≥2 个 cell。
- 验收沿用 P6-05：ARI median ≥0.70、silhouette ≥0.35、14600 同簇率 ≥0.80、
  extinct ≤10%、反预设分组。
- 预算：240 run / 120 min；mock 确定性，无外部请求。

## 2. 预注册预测（运行前写死）

- **H1 开放度–网络迟滞**：θS 越高，非 A 区域的 S/O 双峰越清晰，第三簇的
  14600 同簇率应 ≥0.80；第三簇质心应是高 S/低 O/低 Mup（封闭）或
  低 S/高 O/高 Mup（高流动），而不是只把 P 形状再切一刀。
- **H2 占用记忆锁定**：H=180 的 14600 同簇率应显著高于 H=0；若 H 只延迟不锁定，
  则 H2 不成立。
- **失败决策**：若 6 个 cell 都没有稳定第三簇，停止参数扫描，转 rules-v12 ADR
  讨论显式制度双稳态；不得继续换种子、调 k 或事后挑 cell。

## 3. 结果（2026-11-05，240/240）

- 240/240 run 完成（180 个 10950 + 60 个 14600），0 排除、0 灭绝；
  单元 13:54:40 UTC 正常退出，CPU 27m43s、内存峰值 419 MB。
- k=3 簇大小 **[136, 17, 27]**；**三个簇都混合了全部 6 个 cell**（θS/H 没有
  把任何 cell 分开），`antiPreset=true` 只是因为簇内混 cell，而不是结构分离。
- 质心（`P0..P4,G,top10,Mup,Mdown,S,O`）：
  - 簇 0（136）：`[0,0,0.404,0.388,0.208, 0.428,0.343,0.005,0.001,0.398,0.151]`
  - 簇 1（17）：`[0,0.002,0.410,0.380,0.208, 0.412,0.328,0.058,0.038,0.331,0.257]`
  - 簇 2（27）：`[0,0.000,0.369,0.406,0.225, 0.325,0.249,0.013,0.001,0.075,0.708]`
- **ARI median 0.291**（min 0.050）<0.70；**silhouette 0.297** <0.35；
  **14600 同簇率 0.550**（33/60）<0.80。
- 诊断：k=2 `[153,27]` silhouette 0.289；k=4 `[136,16,27,1]` 0.292；
  k=5 `[53,83,16,27,1]` 0.175。
- **判定**：`not-accepted-return-to-rule-review`。**H1（θS 提高）与 H2（H=180）
  都没有产生稳定第三簇**；三个簇仍是同一非 A 阶级形状内沿 S/O 的细分，
  且比 P6-05 更不稳定（ARI 0.291 vs 0.491、同簇率 0.550 vs 0.667）。
  按预注册决策规则：**停止参数扫描**，转 rules-v12 ADR 讨论显式制度双稳态；
  不得继续换种子、调 k 或事后挑 cell。

## 4. 复现

```bash
node scripts/p6-05-cluster.mjs --freeze --design p6-05b
node scripts/p6-05-cluster.mjs --run --design p6-05b
node scripts/p6-05-cluster.mjs --analyze --design p6-05b
```
