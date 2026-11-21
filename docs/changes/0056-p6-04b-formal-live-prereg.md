# 0056 P6-04b 正式 live 对照预注册

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：07 §11、changes/0054/0055、P6-04b
- 性质：**正式对照的预注册冻结**（10 seed 单集合，描述性；不是确认或校准）
- 预注册：`out/p6-04b-formal-prereg.json`
- experimentId：`p6-04b-formal-9a8febe2`
- designHash：`sha256:9a8febe2d7374aef638ee89c20a8cd7a154f065dae1846fad7d1726414977dec`

## 1. 协议（运行前冻结）

- 配置：`rules-v11`、40 人、730 tick、`decision.interval=30`（25 个决策点）；
  warmup=365；分析窗口 `w1=[365,729]`（365 日，预注册的部分观测取舍）。
- 种子：`p6-04b-formal-seed-001…010`（10 个新 seed，与 pilot 的
  `p6-04b-live-seed-001` 不重叠）。
- 分组（每组 10 run，共 40 run）：
  - `mock-weighted-v1`（promptStyle=null）
  - `random-uniform-v1`（promptStyle=null）
  - `jev_live` + `promptStyle=neutral`
  - `jev_live` + `promptStyle=survival_hint`
- 请求：`jev-1.13.0` → 网关 `https://jev.logicc.top/v1/systemone`；逐决策记录
  responseModel、prompt、rawResponse、回退、token、延迟。
- 预算：25,000 calls / 45,000,000 input tokens / 240 min；并发 4。
- 统计（预注册）：
  - 主指标 `TV(P)`，门槛 **0.10**；10,000 次配对 bootstrap（分析 seed 20261105）。
  - TV 非负，**不做符号翻转置换检验**；有符号 `ΔG` 做 100,000 次符号翻转置换，
    方向一致率门槛 **0.90**。
  - baseline 波动带：同策略不同 seed 两两 D 的 95 分位；候选-基线 D 需 **100%**
    超出该分位（07 §8 严格口径）。
  - BH 校正：5 个比较（两 promptStyle × mock/random，加 neutral vs survival_hint），
    q=0.05。
- 排除规则：extinct、窗口不完整、回退率 > 0.20、responseModels > 1（模型漂移）、
  missing usage、cancelled 的 run 不进入正式合并；技术重试上限 1。
- 可靠性前置：changes/0054 已通过（top-1 0.70、ICC(2,1) 0.9886、平均 TV 0.0565）。

## 2. 判读边界（运行前写死）

- 单个 10-seed 集合不满足 07 §8 第 4 条「独立确认种子集复现」；即使全部条件满足，
  最高只能标 `descriptive-structural-candidate`，不得称为确认、校准或结构已涌现。
- 回退率超闸门或模型漂移的批次不得并入正式对照；被剔除的 run 逐条报告。
- live 与 mock/random 分开报告，不与 30 种子 mock 样本合并。

## 3. 结果（2026-11-05，40/40）

- 40/40 run 完成、0 失败、0 被质量闸门剔除。live 20 run 共 **19,799** 个到期决策，
  8 次回退（`upstream_5xx`，**0.040%**）、0 缺失 usage，响应模型仅 `jev-1.13-free`；
  input **37,481,272** / output **2,450,870**；max latency **25.9 s**；
  systemd 单元 12:29:23 UTC 正常退出。
- baseline 跨种子波动带：mock 两两 D 的 95 分位 **0.2156**、random **0.1183**。

| 比较                     | n   | TV(P) 中位数 [95% CI]      | ΔG      | 置换 p | BH p   | 方向一致率 | D 中位数 | 超出 D95 | 结论                                          |
| ------------------------ | --- | -------------------------- | ------- | ------ | ------ | ---------- | -------- | -------- | --------------------------------------------- |
| live(neutral) vs mock    | 10  | 0.0175 [0.0106, 0.0288]    | -0.0021 | 0.7284 | 0.7284 | 0.50       | 0.0338   | 0%       | 未达 TV 门槛；方向不一致                      |
| live(neutral) vs random  | 10  | **0.3781** [0.3317,0.3927] | +0.0435 | 0.0315 | 0.1577 | 0.80       | 0.1495   | 100%     | TV/区间/波动带通过；方向 0.80<0.90、BH 不显著 |
| live(survival) vs mock   | 10  | 0.0248 [0.0186, 0.0339]    | -0.0100 | 0.1426 | 0.2376 | 0.90       | 0.1912   | 40%      | 未达 TV 门槛，未超出波动带                    |
| live(survival) vs random | 10  | **0.3839** [0.3383,0.3974] | +0.0134 | 0.1272 | 0.2376 | 0.70       | 0.2121   | 100%     | 方向 0.70<0.90、BH 不显著                     |
| survival_hint vs neutral | 10  | 0.0311 [0.0250, 0.0507]    | -0.0058 | 0.2958 | 0.3698 | 0.60       | 0.1808   | n/a      | 未达 TV 门槛                                  |

- **判定**：`verdict=no-structural-evidence`。五个比较均未同时满足 07 §8 的
  TV(P)≥0.10、CI 不跨 0、方向一致率≥0.90、超出 baseline D95 四项；BH 校正后
  没有一个比较 p<0.05（最小 0.1577）。
- **描述性信号 1**：live 的 w1 结构与 random 相差很大（TV≈0.38、D≈0.15–0.21，
  100% 超出 random D95），但与 mock 很接近（TV 0.017–0.025；D 中位数 0.034
  [neutral] / 0.191 [survival]，均低于 mock 跨种子 D95 0.2156）。方向与 1-seed
  pilot 一致。
- **描述性信号 2（次要指标，exploratory）**：`survival_hint` 组中位
  S 0.354、O 0.143、Mup 0.000、Mdown 0.043，而 `neutral` 组为 S 0.101、
  O 0.590、Mup 0.433、Mdown 0.464；阶级分布 P 几乎不变（TV 0.0311）。
  即提示语主要改变流动/网络/制度指标，而不是阶级占比。该差异未通过预注册
  主指标与方向闸门（ΔG 方向一致率仅 0.60），只能作为后续机制假设，不能称为
  结构变化。
- **不可声称**：单集合 10 seed 不满足 07 §8 第 4 条独立确认；以上不是确认、
  校准或现实因果。回退率与模型漂移未触发排除，但不改变上述边界。

## 4. 复现

```bash
node scripts/p6-04b-formal.mjs --freeze
node --env-file=.env scripts/p6-04b-formal.mjs --run --concurrency 4
node scripts/p6-04b-formal.mjs --analyze
```

VPS 上以 `stratify-runner` 身份经 systemd 注入 `/etc/stratify/runner.env`，
命令与单元模板见 `docs/guides/jev-and-vps-runbook.md` §4.6。原始逐决策记录
（20 个 gzip NDJSON，含 rawResponse，不含 Key）保存在
`/var/lib/stratify/exports/p6-04b-formal/raw/`，本地副本不纳入仓库。
