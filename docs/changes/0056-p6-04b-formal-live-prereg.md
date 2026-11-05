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

## 3. 结果

待运行（VPS `2zhou`，`scripts/p6-04b-formal.mjs --run`）。运行完成后在本文件追加
结果与判读，并登记 `out/p6-04b-formal-analysis.json`。

## 4. 复现

```bash
node scripts/p6-04b-formal.mjs --freeze
node --env-file=.env scripts/p6-04b-formal.mjs --run --concurrency 4
node scripts/p6-04b-formal.mjs --analyze
```
