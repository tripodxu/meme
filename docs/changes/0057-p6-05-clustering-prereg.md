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

## 3. 结果

待运行（VPS `2zhou`，`node scripts/p6-05-cluster.mjs --run`）。完成后追加结果与判读，
并登记 `out/p6-05-cluster-analysis.json`。

## 4. 复现

```bash
node scripts/p6-05-cluster.mjs --freeze
node scripts/p6-05-cluster.mjs --run
node scripts/p6-05-cluster.mjs --analyze
```
