# src/decision

决策策略层（生产路径）。P2 已启动（G1.5 于 2026-11-04 W4 通过，见 `changes/0014`、
`docs/adr/0003`）；本目录是唯一的策略实现位置，`src/experimental/` 不再保留副本。

## 模块

| 文件                    | 任务     | 说明                                                                                                 |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `types.ts`              | 04 §2    | `DecisionRecord` / `ExecutionRecord` / `FallbackReason` / `PromptStyle` 共享契约                     |
| `policy.ts`             | P2-01    | `DecisionPolicy` 接口与 `DecisionInput`；核心不感知 HTTP                                             |
| `policies.ts`           | P2-01    | `MockPolicy` / `RandomPolicy` 适配器（与纯函数逐位一致）                                             |
| `mock.ts` / `random.ts` | 04 §2.1  | `mock-weighted-v1` / `random-uniform-v1` 确定性策略                                                  |
| `serialize.ts`          | P2-02    | 固定构造顺序的英文决策 state、`stateHash`、prompt 指令                                               |
| `schema.ts`             | P2-02    | 决策 state 的冻结 JSON Schema（prompt-v3），与序列化器字段一一对应                                   |
| `jev-client.ts`         | P2-03~05 | Jev HTTP 客户端：超时、有限重试、取消、预算、熔断、非法响应安全失败；`topK>1` 用 `jev_topk` 地址采样 |
| `live.ts`               | P2-01/05 | `JevLivePolicy` 与共享预算/熔断窗口                                                                  |
| `replay.ts`             | P2-06    | `ReplayPolicy`：只重放 `selectedAction`，非法/缺失记 `replay_invalid`                                |

## 接线

- `ReplayPolicy` 通过 `runSingleWithPolicy` 注入：按 `(tick,agentId)` 重放日志中的
  `selectedAction`，不调用 Jev、不消耗预算；
- `src/runner/run-cell.ts` 的**同步**路径通过 `DecisionPolicy` 调用 mock/random
  （`runSingle` 的 `policy` 字符串选择 `MockPolicy`/`RandomPolicy`）；
- **异步**路径 `runSingleWithPolicy` 接受任意 `DecisionPolicy`，为 live/replay 构建
  真实 `DecisionState`、`stateHash`、`actionSetHash` 与最近事件；取消信号在 tick 边界
  生效，未结算 tick 的决策不进入产物（`RunWindowReport.cancelled=true`）；
- `RunOutcome.decisions` 保存逐决策 `DecisionRecord`（P2-06）；执行结果仍由核心事件与
  `ExecutionRecord` 单独记录，不回写决策记录；
- 更换策略必须改变 `policyVersion`，并进入 run identity / 预注册 manifest。

## 边界

- 只读取 `src/core` 暴露的只读视图与合法行动枚举，不修改核心状态，也不重新计算财富、胜率、阶级、寿命或网络。
- 只在代码枚举的行动中选择：`accumulate`、`ascend`、`descend`、`compete:<agentId>`；禁止从模型文本中解析或拼接行动。
- 真实调用必须带超时、有限重试、取消、预算和失败熔断；失败时走确定性 fallback，不得静默改变规则。
- `401/403` 不是普通回退：`JevLivePolicy` 抛 `jev_auth_failed` 终止 live run（04 §5/§6），
  避免全部个体静默 accumulate；错误消息不得包含 Key。
- 熔断打开（`jev_circuit_open`）与回退率超阈值（`jev_fallback_rate_exceeded`）同样终止 run；
  单次可重试失败才走逐决策 fallback。
- 预算按 attempt 预留 1 call + `utf8-three-quarter-v1` 估算 token（04 §7）；实际 usage 超估算记
  overage 并停止新调用；`usage_missing`/`budget_exhausted` 同样终止 run。估算器必须高估：
  旧口径 `utf8-half-v1`（`bytes/2`）实测低估，第一次调用就 overage 并永久锁死 run。
- 上游端点可配置（`JevClientOptions.endpoint`，只接受 https 且不得内嵌凭据）：官方域名按地域
  返回 451，受限网络须经自建网关；响应里的真实 `model` 可能与请求名不同，必须落日志。
- 密钥只从运行时环境注入，不写入数据库、fixture 或日志；`JevLivePolicy` 构造时只校验非空，不记录内容。
- 契约见 [04 Jev 决策协议](../../docs/04-jev-decision-contract.md)，模块边界见 [02 架构](../../docs/02-architecture.md)。

## 尚未完成

- P2-07 真实冒烟已跑通（`scripts/smoke-live.mjs`，经自建网关，`cost=0`，见
  `docs/changes/0030`），但它只是链路验证：规模与视野远低于 07 §8 的验收口径，
  也不是 P6 证据；CI 默认不运行，需显式提供 `JEV_API_KEY`。
- replay 策略已接入 `runSingleWithPolicy`（作为普通 `DecisionPolicy`），但尚未接入
  CLI/批跑入口与预注册 manifest；真实 live 日志的端到端回放待 P2-07 之后验证。
