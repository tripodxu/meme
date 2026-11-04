# decision fixtures

真实上游（Jev System One）的请求/响应样本，用于 P2-03 与预算估算器回归。
断言见 `test/unit/decision/real-response-fixture.test.ts`。

## 文件

| 文件                                 | 内容                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `systemone-request-2026-11-04.json`  | `buildRequestBody()` 的真实输出（8 人、tick 0、`promptStyle=neutral`） |
| `systemone-response-2026-11-04.json` | 上游原样返回的响应体                                                   |

## 捕获条件（2026-11-04）

- 端点：`https://jev.logicc.top/v1/systemone`（自建网关；官方域名在本机返回
  `451 Typesafe is not available in your region`）
- 请求模型名：`jev-1.13.0`；响应 `model` 为 **`jev-1.13-free`**，说明网关把模型名
  归一化到免费档。真实模型名以响应为准并必须落日志。
- `usage.cost = 0`、`opencode.billing_source = "free"`：本次冒烟无成本，
  但不能据此认为生产调用免费。
- 实测比例：紧凑 JSON **2170 字节 → `input_tokens=1200`**，即约 **0.553 tokens/byte**。

## 脱敏

- 不含 API Key：密钥只经 `Authorization` 头传递，从不进入请求体或响应体。
- 不含任何外部账号信息、IP、cookie 或调试头。
- `state` 是确定性仿真的虚构个体/社会状态，不是真实人口数据。

## 为什么保留请求体

`utf8-half-v1`（`bytes/2`）对这条请求给出 1085 < 1200，属于**低估**。由于
`AttemptBudget` 一旦 `overageDetected` 就永久 `exhausted`，低估会让 live run 在
第一次调用之后自锁（P2-07 冒烟实测：第二个决策即 `budget_exhausted`、`attempts=0`）。
保留请求体是为了让「估算是否保守」成为可回归的断言，而不是靠一次手工核验。
