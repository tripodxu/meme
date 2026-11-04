# 0030：P2-07 真实冒烟跑通；端点可配置；预算估算器改为保守口径

- 日期：2026-11-04
- 作者：决策层负责人
- 关联：P2-07 / P2-03 / P2-05（04 §3.3、§7、§10）、`changes/0015`
- 性质：**决策层实现变更**；触及 04 契约（端点、估算器）与 `tokenEstimatorVersion`；
  不改变规则、参数注册表、默认配置与引擎版本

## 1. 结论先行

P2-07 的首个真实冒烟**没有按原计划直连官方域名跑通**，过程中暴露了一个会导致 live 路径
完全不可用的实现缺陷。三件事必须一起记录，否则后来者会误以为"只是网络问题"。

## 2. 实测事实（2026-11-04）

| 事实                                                                               | 证据                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------- |
| 官方 `api.typesafe.ai` 从开发机返回 `451 Typesafe is not available in your region` | `curl -o /dev/null -w '%{http_code}'` |
| 从 VPS（出口 `207.188.6.69`）网络可达，但同一 Key 返回 `401 authentication_error`  | VPS 上 POST `/v1/systemone`           |
| 自建网关 `jev.logicc.top` 可用，`GET /v1/models` 与 `POST /v1/systemone` 均 200    | 同上                                  |
| 网关把请求模型名归一化：请求 `jev-1.13.0` → 响应 `model = jev-1.13-free`           | 两次对照请求                          |
| 该档位 `usage.cost = 0`、`opencode.billing_source = "free"`                        | 响应 usage                            |
| `python-urllib` 被 Cloudflare 以 `1010` 拦截，`curl` 与 Node `fetch` 均正常        | 三种客户端对照                        |

结论：这个 Key **只对自建网关有效**，官方域名直连不可行；端点必须可配置，否则 P2-07
在任何网络环境下都无法完成。

## 3. 变更一：上游端点可配置

`JevClientOptions.endpoint`（可选），默认仍为 `DEFAULT_UPSTREAM_ENDPOINT`。

- 只接受 `https:`——明文会把 Bearer Key 暴露在链路上；
- 拒绝 URL 内嵌 `user:pass`——凭据只经 `Authorization` 头，不得进入 URL 或错误对象；
- 校验在 `callJev` 开头完成，**早于预算预留与第一次 attempt**，非法端点不消耗任何调用；
- 端点随 run manifest 记录：不改变决策语义，但影响可达性、真实模型名与计费单位。

响应里的 `model` 必须按实际值落日志。请求名与响应名不一致是这个网关的常态，
不得用请求名冒充。

## 4. 变更二：预算估算器必须真正保守（缺陷修复）

### 4.1 现象

冒烟在第二个决策即失败：

```text
source=fallback reason=budget_exhausted attempts=0
```

`attempts=0` 说明失败发生在 `budget.reserve()`，不是请求本身。

### 4.2 根因

`AttemptBudget` 一旦 `overageDetected` 就永久 `exhausted`（04 §7 的 fail-closed）。
而 `overageDetected` 由 `actual > reserved` 触发。实测：

| 样本                | payload 字节 | `utf8-half-v1` 估算 | 上游实际 `input_tokens` | 结论     |
| ------------------- | ------------ | ------------------- | ----------------------- | -------- |
| 8 人 tick 0（早测） | 1524         | 762                 | 908                     | 低估 16% |
| fixture 样本        | 2170         | 1085                | 1200                    | 低估 10% |

即 `bytes/2` 对英文 JSON **不是保守估算而是偏乐观**（实测约 0.55 tokens/byte）。
第一次调用就把 `overageDetected` 置真，此后所有 `reserve()` 一律失败——
**live 路径在第一次调用之后自锁**，与 `maxInputTokens` 设多大无关。

此前未暴露，是因为全部单测的 mock usage 只有 100 tokens，远低于估算值。

### 4.3 修复

`estimateInputTokens` 改为 `max(1, ceil(UTF8*3/4))`，`TOKEN_ESTIMATOR_VERSION` 升为
`utf8-three-quarter-v1`。对两条真实样本分别给出 1143 / 1628，均高于上游实际，
余量约 26–35%。中文 payload 高估更多，属可接受的保守方向（该值是调度阈值，不冒充账单）。

回归断言写在 `test/unit/decision/real-response-fixture.test.ts`，并**保留一条反向断言**：
旧口径对同一 payload 必须算出小于实际值的数——防止有人把比例调回去。

## 5. 变更三：真实请求/响应入库（P2-03）

`test/fixtures/decision/` 新增 `systemone-request-2026-11-04.json` 与
`systemone-response-2026-11-04.json`：请求体是 `buildRequestBody()` 的真实输出，
响应体是上游原样返回，不含任何凭据（Key 只在请求头）。

`test/fixtures/README.md` 的旧约定「禁止写入真实 Jev 响应原文」与 P2-03 直接冲突，
已改为「脱敏后的真实响应允许入库，但必须在同目录 README 写明捕获条件与脱敏范围，
且 `decision/` 是唯一允许的分组」。

## 6. 冒烟结果

`scripts/smoke-live.mjs`，8 人 / 30 tick（4 个决策点）：

| 指标     | 值                                       |
| -------- | ---------------------------------------- |
| 决策     | 24 到期，**24 成功，0 回退**             |
| usage    | input 39753 / output 2981 tokens         |
| 成本     | `listCost = 0`（免费档，不代表生产免费） |
| 延迟     | p50 1.30 s，max 4.41 s                   |
| 响应模型 | `jev-1.13-free`                          |
| 产物     | `out/p2-07-smoke.json`                   |

**这不是实验证据**：规模与视野远低于 07 §8 的验收口径（≥30 配对种子、40/200/1000 人、
730/3650 tick），脚本输出里 `isExperimentalEvidence: false` 显式标注。

## 7. 未完成与风险

- CI 默认不跑真实冒烟；需要 `JEV_API_KEY` 显式注入，密钥从不落盘、不打印、不进摘要。
- `utf8-three-quarter-v1` 只由两条真实样本标定。若上游 tokenizer 变更或 payload 结构
  变化（例如中文 `criteria`、更长的 `recentEvents`），仍需重新核对；overage 是硬停止，
  一旦误判会整 run 终止。
- 网关可能随时改变模型档位或计费口径；`usage.cost=0` 只对当前免费档成立。
- P2-07 的"VPS 直连"原始目标并未达成：VPS 能连官方域名，但这个 Key 在官方端点上无效。
  若将来换成官方 Key，端点只需切换，无需改代码。
