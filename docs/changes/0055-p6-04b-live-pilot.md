# 0055 P6-04b 1-seed live pilot

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：07 §11、changes/0053/0054、P6-04b
- 性质：**pilot**（harness/回退/运行时长验证）；不是正式 live/mock 对照
- 产物：`out/p6-04b-live-pilot.json`、`out/p6-04b-live-pilot-decisions.ndjson.gz`

## 1. 协议

- 单个 seed `p6-04b-live-seed-001`；40 人 × 730 tick；`decision.interval=30`
  → 25 个决策点 × 40 人 = **1,000 个到期决策**。
- 同一配置分别跑 `mock-weighted-v1`、`random-uniform-v1`、`jev_live`（`neutral`）。
- live：`jev-1.13.0` 请求、端点 `https://jev.logicc.top/v1/systemone`；
  预算 3,000 calls / 6,000,000 input tokens / 90 min 截止；重试 3 次上限；
  熔断与回退率窗口与 smoke 一致。
- 输出 w1 结构指标、live 决策聚合（回退/模型/usage/延迟）与三方描述性差异；
  live 决策原始记录（含 rawResponse）压缩保存在本地，不打印 Key。

## 2. 基线（mock/random）

- mock w1：P `[0.5583, 0.2895, 0.1348, 0.0175, 0]`、G 0.4485、Mup 0.5009、
  Mdown 0.4887、S 0.0642、O 0.6225。
- random w1：P `[0.8657, 0.1116, 0.0227, 0, 0]`、G 0.4622、Mup 0.2008、
  Mdown 0.3697、S 0.0445、O 0.4801。
- `mockVsRandom`：TV(P) **0.3074**、D **0.1582**（同 seed、同配置；仅描述政策差异）。

## 3. live 结果

- **993/993 到期决策成功，0 回退、0 缺失 usage、993 exact**；响应模型
  `jev-1.13-free`（单一模型）。到期数 993 而非 1,000：7 个决策点因个体在此之前死亡
  而没有到期决策。
- wall **18.6 min**（预算 90 min）；p50 **1,048 ms**、max **12,795 ms**；
  usage input **1,873,726** / output **123,156**；`AttemptBudget` 3,000 calls 未耗尽。
- live w1：P `[0.5431, 0.3046, 0.1348, 0.0175, 0]`、G 0.4803、Mup 0.4989、
  Mdown 0.5099、S 0.0425、O 0.6385。
- 最终状态：`finalStateHash=sha256:33d8af55…`、`aliveAtEnd=39`、`endTick=729`、未灭绝。

| 对比           | TV(P)  | D      | ΔG      | ΔMup    | ΔMdown  | ΔS      | ΔO      |
| -------------- | ------ | ------ | ------- | ------- | ------- | ------- | ------- |
| live vs mock   | 0.0152 | 0.0186 | +0.0318 | -0.0020 | +0.0211 | -0.0216 | +0.0160 |
| live vs random | 0.3226 | 0.1619 | +0.0181 | +0.2981 | +0.1402 | -0.0019 | +0.1584 |

## 4. 判读边界

- **harness 通过**：993 次 live 调用 0 回退、0 缺失 usage、单一模型，18.6 min 完成；
  可以进入正式 5–10 seeds 对照。
- 描述性信号：live 的 w1 结构更接近 mock（TV 0.0152、D 0.0186），远于 random
  （TV 0.3226、D 0.1619）。但这是 **1 个 seed**、无区间/显著性，不能据此判断
  live 与 mock/random 的结构差异，也不能声称模型有效或已校准（AGENTS #9、07 §11）。
- `live vs mock` 的 ΔG +0.0318 刚过 07 §8 的次要门槛 0.03，但主指标 TV 只有 0.0152，
  且只有 1 个 seed；只能记为 pilot 线索，不得写成结构变化。
- 通过后才决定正式 5–10 seeds 对照（本地长跑或 VPS 部署）。正式对照需把 live 与
  mock/random 分开报告，模型漂移或回退率超闸门的批次不并入。

## 5. 复现

```bash
pnpm build
node --env-file=.env scripts/p6-04b-live-pilot.mjs --skip-live   # 基线
node --env-file=.env scripts/p6-04b-live-pilot.mjs --out out/p6-04b-live-pilot.json
```
