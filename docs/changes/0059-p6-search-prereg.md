# 0059 P6 参数搜索预注册（探索层）

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：P6-05/0057、P6-05b/0058、07 §9、rule 57
- 性质：**探索性参数搜索**；不是确认、校准或结构涌现声明
- 预注册：`out/p6-search-prereg.json`
- experimentId：`p6-search-90893363`
- designHash：`sha256:90893363a7a72b769dd23479eef946280a40fe87c6bbc78de60350407d0d3ee8`

## 1. 协议（运行前冻结）

- 配置：`rules-v11`、`mock-weighted-v1`、40 人；粗筛 3650 tick，终端窗口
  `[3285,3649]`。
- 12 个参数轴（固定种子随机采样）：
  `ascent.displacementShare` [0.2,1]、`ascent.scarcityWeight` [0,60]、
  `ascent.occupancyMemoryDays` {0,90,180,365}、
  `openness.segregationWeight` [2,12]、`openness.mobilityWeight` [1,8]、
  `openness.ascentCostWeight` [0.5,4]、`openness.timeConstantDays` [30,180]、
  `networkOpportunity.beta` [0.2,1.2]、`network.rewireProb` [0.02,0.15]、
  `dynamics.congestionExponent` [0.2,0.6]、
  `dynamics.polarizationExponent` [0.4,1.2]、`need.threshold` [0.5,0.95]。
- 粗筛：**800 个候选 × 12 个 search seed × 3650 tick = 9,600 run**，
  4 个 shard 并行；按候选内 k=3 的 silhouette + ARI median − 惩罚项排序，
  取 top 20。
- 验证：从 top 20 中选 **6 个候选 × 30 个全新 validation seed × 10950 tick**
  （前 10 个续跑 14600），全特征 k=3、z-score+Ward-LW、20 次稳定性；
  验收沿用 P6-05（ARI median ≥0.70、silhouette ≥0.35、同簇率 ≥0.80、
  每簇 ≥5、反预设）。
- 种子隔离：`p6-search-seed-*`（粗筛）、`p6-search-val-seed-*`（验证）；
  两者不得复用，最终确认必须另立 `confirm-seed-*` 实验。
- 预算：9,600 + 240 run；4 shard；约 1.5–2.5 h VPS；纯 mock，无外部请求。

## 2. 判读边界（运行前写死）

- 搜索结果只作 exploratory；验证通过只说明“该参数区域值得独立确认”，
  不得直接称为三簇、校准或结构涌现。
- 若验证失败，结论是“rules-v11 参数空间内未找到稳定三簇区域”，
  支持转 rules-v12 ADR；不得换算法/fitness/seed 继续搜同一问题。
- 不得把 search/validation seed 的结果写进正式 P6-05 对照；confirm 必须新种子。
- 所有候选、失败与剔除都要报告，不得只展示 top。

## 3. 结果

待运行（VPS `2zhou`，4 个 `p6-search-i` 单元）。完成后追加粗筛 top、
验证判读与产物哈希。

## 4. 复现

```bash
node scripts/p6-search.mjs --freeze
node scripts/p6-search.mjs --run --shard 0/4   # 4 个 shard 并行
node scripts/p6-search.mjs --analyze
node scripts/p6-search.mjs --validate-freeze
node scripts/p6-search.mjs --validate-run --shard 0/4
node scripts/p6-search.mjs --validate-analyze
```
