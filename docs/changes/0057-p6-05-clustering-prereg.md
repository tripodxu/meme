# 0057 P6-05 全特征结构指纹聚类预注册

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：07 §8.1、rule.md 57、changes/0050–0056、P6-05/G6
- 性质：**P6-05 候选聚类**；不是校准、现实因果或结构涌现声明
- 预注册：`out/p6-05-cluster-prereg.json`
- experimentId：`p6-05-9718860c`
- designHash：`sha256:9718860c4b0cd3fd7fa79e2d947e131f2d29d519c0ee9a8fbe860504e6638140`

## 1. 协议（运行前冻结）

- 配置：`rules-v11`、`mock-weighted-v1`、40 人、10950 tick；终端窗口
  `[10585,10949]`（365 日）取 07 §8.1 全特征向量：
  `P0..P4、G、top10、Mup、Mdown、S、O`（11 维）。
- 6 个参数区域 × 30 个全新 seed（`p6-05-seed-001…030`）= 180 run：
  - `A-share100-w0`（默认）
  - `B-share50-w15`、`C-share50-w60`（W6 的 B/C）
  - `D-share50-w30`、`E-share70-w15`、`F-share30-w60`（插值/外推）
  - 覆盖 `ascent.displacementShare` 与 `ascent.scarcityWeight`。
- 聚类：z-score(pooled)、Ward-LW、**k=3 固定**；20 次随机二分稳定性，
  报告 ARI median/min；轮廓系数；每簇至少 5 run。
- 时序一致性：每 cell 前 10 个 seed 续跑到 14600 tick（60 run），终端窗口
  `[14235,14599]`；用 10950 的 scaler/质心分配，同簇率需 ≥0.80。
- 反“三组预设”：至少一个簇包含 ≥2 个 cell；簇与 cell 不能一一对应。
- 排除：extinct、窗口不完整（`observedTicks < 365` 或 `missingTicks > 0`）；
  extinct 率 >10% 判失败。
- 预算：240 run / 120 min；mock 确定性，无外部请求。

## 2. 验收判据（运行前写死）

以下全部满足才判 `three-cluster-candidate`：

1. k=3，三个簇均 ≥5 run；
2. 稳定性 ARI median ≥0.70（同时报告 min）；
3. silhouette ≥0.35；
4. 14600 同簇率 ≥0.80；
5. extinct 率 ≤10%；
6. 至少一个簇包含 ≥2 个 cell。

任一项不满足即 `not-accepted-return-to-rule-review`，记录失败并回到规则评审，
不得改用 k=4/k=5 或事后挑选指标代替。

## 3. 结果（2026-11-05，240/240）

- 240/240 run 完成（180 个 10950 tick + 60 个 14600 tick），0 排除、0 灭绝；
  单元 13:14:30 UTC 正常退出，CPU 30m27s、内存峰值 379 MB。
- k=3 簇大小 **[30, 118, 32]**；组成：A 的 30 run 单独成簇；其余 118 run 来自
  B–F 五个 cell；第三簇 32 run 也来自 B–F（B8/C4/D5/E8/F7）。
- 质心（`P0..P4,G,top10,Mup,Mdown,S,O`）：
  - A 簇：`[0.537,0.297,0.068,0.050,0.049, 0.559,0.517,0.956,0.958,0.031,0.802]`
  - 非 A 主簇：`[0,0.108,0.419,0.296,0.176, 0.425,0.353,0.010,0.003,0.366,0.192]`
  - 第三簇：`[0,0.092,0.397,0.322,0.189, 0.336,0.281,0.030,0.009,0.049,0.553]`
- **ARI median 0.491**（min 0.242）<0.70；**silhouette 0.344** <0.35；
  **14600 同簇率 0.667** <0.80；`antiPreset=true`（第三簇混合 5 个 cell）。
- 诊断：k=2 `[30,150]` silhouette 0.649；k=4 `[30,68,32,50]` 0.329；
  k=5 `[13,17,68,32,50]` 0.273。
- **判定**：`not-accepted-return-to-rule-review`。A vs 其余的二簇结构稳健
  （与 G1.5 一致），但三簇在稳定性、轮廓与时序一致性上均未过线；W6 的
  class-share 三类候选在加入 G/top10/Mup/Mdown/S/O 后不成立。第三簇只是
  非 A 体制内按 S/O 的细分，且 14600 有 1/3 漂移，不能算第三类结构。
- 不得改用 k=4/k=5 或事后挑选指标；**G6 仍未通过**，需回到规则评审寻找
  能产生第三类稳定全特征结构的机制。

## 4. 复现

```bash
node scripts/p6-05-cluster.mjs --freeze
node scripts/p6-05-cluster.mjs --run
node scripts/p6-05-cluster.mjs --analyze
```
