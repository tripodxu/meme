# 0054 P6-04b 前置：Jev 重测信度通过

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：07 §11、08 §质量门禁、changes/0053、P6-04b
- 性质：实验前置验证；不改变规则、引擎、配置或结构判定
- 产物：`out/p6-04b-reliability.json`（14.1 KiB，`sha256:519d7da0…`）

## 1. 协议

- 固定 state：40 人 mock 跑至 tick 365，取存活个体 `a-0010`（9 个合法行动）；
  `stateHash=sha256:acf7c83d…`、`actionSetHash=sha256:eda37639…`。
- 同一 state 连续调用 live 模型 **20 次**；`requestedModel=jev-1.13.0`、
  `promptStyle=neutral`、端点 `https://jev.logicc.top/v1/systemone`。
- 只调用模型，不推进模拟；不写请求/回答原文，只保留概率向量、usage、延迟与回退。

## 2. 结果

| 指标         | 结果                                 | 07 §11 门槛 | 判定         |
| ------------ | ------------------------------------ | ----------- | ------------ |
| 有效重复     | 20/20（0 回退、20 exact）            | 20          | 通过         |
| top-1 一致率 | **0.70**（accumulate 6 / ascend 14） | ≥0.70       | 通过（临界） |
| ICC(2,1)     | **0.9886**                           | ≥0.50       | 通过         |
| 平均 TV 距离 | **0.0565**                           | ≤0.15       | 通过         |
| 响应模型     | `jev-1.13-free`                      | 单一模型    | 通过         |

usage：input 30520 / output 2546，`missingRecords=0`；延迟 min 898 / p50 1025 / max 2238 ms；
`AttemptBudget` 无 overage。

**verdict = `reliable`，`passed=true`。**

## 3. 判读与边界

- top-1 一致率恰好等于门槛 0.70（14/20）：再出现一次不一致就会失败，属于**临界通过**；
  正式对照必须继续记录逐决策响应，不能把本轮当作模型稳定性的强证据。
- ICC 很高、平均 TV 很低，说明概率向量整体稳定；top-1 的分裂主要来自
  `accumulate` 与 `ascend` 的接近（样本概率约 0.33–0.43）。
- 本轮只是**单 state 的 20 次重测**，不是完整 run，也不是 mock/live 结构对照；
  结论仅支持「可以进入正式 P6-04b live/mock 对照」，不构成模型有效性、结构差异或校准。
- 正式对照仍需按 07 §11：`mock-weighted-v1`、`random-uniform-v1`、`jev_live` 三组，
  `promptStyle=neutral` 与 `survival_hint` 两种提示，固定初始人口和规则；
  live 默认 5–10 seeds × 40 人 × 730 tick × `decision.interval=30`，单独报告。
- 本轮**未运行**正式 live/mock 对照。

## 4. 复现

```bash
pnpm build
node --env-file=.env scripts/jev-reliability.mjs --repeats 20 --out out/p6-04b-reliability.json
```

脚本只从 `JEV_API_KEY` 读取密钥，不打印/不写盘；`pnpm check:secrets` 通过。

## 5. 兼容性

无规则/配置/哈希/实验产物变化；新增 `src/runner/reliability.ts`、脚本与报告产物。
