# P6-04b 前置：Jev 重测信度（2026-11-05）

- 协议：07 §11 的 20 次同 state 重测
- state：40 人 mock 跑至 tick 365，个体 `a-0010`（9 个合法行动）
- 模型/提示：`jev-1.13.0` / `neutral`；响应模型 `jev-1.13-free`
- 结论：**reliable（临界通过）**，可以进入正式 live/mock 对照；本轮不是结构证据

## 1. 方法

1. `createDemoConfig` 构造 40 人、365 tick 配置；`runSingle` 用 `mock-weighted-v1`
   跑到 tick 365，取 `finalState`。
2. 选择合法行动最多的存活个体（`a-0010`，9 个行动），用
   `buildDecisionState` 固定 state，`stateHash=sha256:acf7c83d…`、
   `actionSetHash=sha256:eda37639…`。
3. 同一 `DecisionInput` 连续调用 `callJev` 20 次；每次记录 `probabilities`、
   `selectedAction`、`source`、`usage`、`latencyMs`、`fallbackReason`。
4. `summarizeReliability` 计算选项分布、top-1 一致率、概率向量 ICC(2,1)
   （行=选项、列=重复）与重复间平均 TV 距离；门槛取 07 §11。

## 2. 结果

| 指标         | 结果                                 | 门槛  |
| ------------ | ------------------------------------ | ----- |
| 有效重复     | 20/20（0 回退、20 exact）            | 20    |
| top-1 一致率 | **0.70**（accumulate 6 / ascend 14） | ≥0.70 |
| ICC(2,1)     | **0.9886**                           | ≥0.50 |
| 平均 TV 距离 | **0.0565**                           | ≤0.15 |
| usage        | input 30520 / output 2546，missing 0 | —     |
| 延迟         | min 898 / p50 1025 / max 2238 ms     | —     |

`verdict=reliable`、`passed=true`。

## 3. 判读

- **临界通过**：top-1 恰好 14/20；再出现一次不一致即低于 0.70。模型概率向量很稳定
  （ICC 0.989、平均 TV 0.056），但 top-1 在 `accumulate` 与 `ascend` 之间接近
  （样本概率约 0.33–0.43），不能把本轮当成强稳定性证据。
- 只验证了**单 state 的重复性**，没有推进模拟、没有做 mock/live 结构对照；
  不能据此声称 Jev 行为有效、结构差异显著或已校准（AGENTS #9、07 §11）。
- 正式 P6-04b 仍需：`mock-weighted-v1`、`random-uniform-v1`、`jev_live` 三组，
  `neutral` 与 `survival_hint` 两种提示，固定初始人口和规则；live 5–10 seeds ×
  40 人 × 730 tick × `decision.interval=30`，单独报告；模型漂移或回退率超闸门的批次
  不并入正式对照。
- 本轮**未运行**正式 live/mock 对照。

## 4. 产物与复现

- 产物：`out/p6-04b-reliability.json`（14.1 KiB，`sha256:519d7da0…`）。
- 复现：`pnpm build && node --env-file=.env scripts/jev-reliability.mjs --repeats 20 --out out/p6-04b-reliability.json`。
- 代码：`src/runner/reliability.ts`、`scripts/jev-reliability.mjs`、`test/unit/runner/reliability.test.ts`（7 项）。
