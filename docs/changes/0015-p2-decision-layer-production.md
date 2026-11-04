# 0015：P2 决策层迁回生产路径并完成 Policy 接线

- 日期：2026-11-04
- 作者：核心/规则负责人（用户确认「确认并启动 P2」）
- 关联：G1.5（`changes/0014`）、[ADR-0003](../adr/0003-p2-decision-layer-production.md)、P2-01/P2-06
- 前置：W4 确认轮通过 G1.5（k=2 ARI median/min 1.000），`01 §4.5` 的 P2 启动条件成立。

## 1. 变更内容

1. **模块迁回**：`src/experimental/p2-decision/{policy,serialize,jev-client,live}.ts`
   以 `git mv` 迁入 `src/decision/`；测试迁到 `test/unit/decision/p2-decision.test.ts`。
   实现语义不变，import 仅做路径调整。
2. **Policy 接口**：`src/decision/policy.ts` 的 `DecisionPolicy` 成为生产策略接口；
   `DecisionInput` 增补 `simState`（运行时只读状态，供 mock/random 使用；
   `state` 仍是 P2-02 的序列化对象）。`decide` 返回 `DecisionRecord | Promise<DecisionRecord>`。
3. **内置适配器**：新增 `src/decision/policies.ts`（`MockPolicy`/`RandomPolicy`），
   与 `mock.ts`/`random.ts` 的纯函数逐位一致。
4. **runner 接线**：
   - 同步 `runSingle` 改为通过 `DecisionPolicy` 调用（缺省按 `policy` 字符串选择内置实现）；
     `RunOptions.policyImpl` 可注入策略；同步路径拒绝返回 Promise 的策略；
   - 新增异步 `runSingleWithPolicy`（P2-01/P2-06）：为 live/replay 构建真实
     `DecisionState`、`stateHash`、`actionSetHash` 与最近事件，`await policy.decide`；
   - `RunOutcome.decisions` 保存逐决策 `DecisionRecord`（P2-06）；
   - 同步/异步共用 `finalizeRun`，窗口聚合、标签、extinct 与状态哈希口径一致。
5. **文档**：`src/decision/README.md` 重写为生产层说明；`src/experimental/README.md`
   标注当前为空；ADR-0002 标记 superseded；ADR-0003 记录迁移理由。
6. **P2-06 回放**：新增 `src/decision/replay.ts`（`ReplayPolicy`/`buildReplayIndex`）：
   按 `(tick, agentId)` 取原始记录，只重放 `selectedAction`；缺失或当前不合法记
   `replay_invalid` 并回退 accumulate；来源按原始策略标 `jev_replay`/`mock_replay`/
   `random_replay`，原始 fallback 记录保持 `fallback`，不冒充模型判断；同一
   `(tick, agentId)` 重复记录显式失败。
7. **客户端契约修正**（对照 `04 §6/§7` 复核后修复，语义变化）：
   - 超时（`TimeoutError`/`AbortError`，外层 signal 未取消）单独记 `timeout`，
     不再并入 `network_error`；
   - 删除重试循环结束后无条件的 `recordTransportFailure()`：失败已在每次 attempt 内记账，
     原实现会把熔断窗口计数放大一次；
   - `JevCallResult.transportFailure` 对 timeout/network/429/5xx 耗尽返回 `true`
     （原实现恒为 `false`，窗口统计与实际不符）；
   - 回退率窗口改为每次到期决策只记一次：成功记 `recordDue`，回退记 `recordFallback`；
     原实现先 `recordDue` 再回退，模型质量回退会被重复计入；
   - 非法 `Retry-After`（非整数秒，如 HTTP-date）记 `retry_after_invalid` 并立即回退，
     不再当作「无头」继续退避重试；
   - `401/403` 由 `JevLivePolicy` 抛稳定错误码 `jev_auth_failed` 终止 live run
     （04 §5/§6「立即暂停」），不再逐个体静默回退 accumulate；错误消息不含 Key；
   - 熔断打开或回退率超阈值时，`JevLivePolicy` 分别抛 `jev_circuit_open` /
     `jev_fallback_rate_exceeded` 暂停 run（04 §6），不再回退后继续模拟；
   - 退避节奏按契约分型：网络/超时 0.5/1s、429/529 无 Retry-After 1/2/4s、
     其他 5xx 固定 0.5s（原实现共用一条指数公式，429 与 5xx 均偏离）；
   - 400/404/422 记 `http_client_error`（新增回退原因），不再误记为 `invalid_schema`；
   - 删除 `JevClientOptions.maxCalls` 冗余字段：attempt 预算由 `AttemptBudget`
     构造参数强制，避免出现「声明必填但无人校验」的配置。
8. **P2-02 序列化语义修正**：`buildDecisionState` 的 `society.classPopulationShares`
   原实现取 `initialClassShares`，与 04 §3.2 的 `P[c]`（决策时点存活人口份额）不符；
   改为按存活个体实时计算，`promptVersion` 由 `prompt-v2` 升级为 `prompt-v3`。
   影响：决策 state/`stateHash` 与发给模型的社会摘要变化；核心结算、规则版本与
   `configHash` 不变。新增 `p2-decision` 用例覆盖「当前份额≠初始份额」。
9. **P2-02 JSON Schema**：新增 `src/decision/schema.ts` 与冻结副本
   `schema/decision-state.prompt-v3.json`（draft-07，`additionalProperties:false`），
   用 `ajv` 校验 `buildDecisionState` 输出；新增 6 项测试覆盖文件同步、合法实例、
   额外字段/错误类型/事件上限/缺字段拒绝。新增 devDependency `ajv@8.20.0`
   （MIT，解包约 1.5 MiB，维护活跃；仅 Node/Vitest 测试端使用，不进入浏览器、Worker
   或核心运行包）。
10. **P2-05 预算估算**（04 §7）：

- 新增 `TOKEN_ESTIMATOR_VERSION='utf8-half-v1'` 与
  `estimateInputTokens = max(1, ceil(UTF8/2))`，按完整请求体估算；
- `JevBudget` 改为 `reserve(estimate)` / `settle(reserve, actual)` /
  `keepReserved(reserve)`：在途预留与已核销之和不得超上限（fail-closed）；
- 实际 usage 超出估算时记 `overage` 并立即停止新调用；失败/取消/usage 缺失
  保留预留并计入消耗；
- `usage_missing` 与 `budget_exhausted` 由 `JevLivePolicy` 抛
  `jev_usage_missing` / `jev_budget_exhausted` 暂停 run，不再整轮静默回退；
- `AttemptBudget` 增加 `usageUnknownCount`，供 server 侧记录；
- 修复 429/5xx 重试路径的预留泄漏：每次 retryable failure 都调用
  `keepReserved(estimate)`，无论随后重试还是达到上限退出；新增用例断言
  `inFlightTokens` 归零（原实现会残留额度并提前触发 `budget_exhausted`）；
- `JevClientOptions.deadlineMs` 承接 `maxRunMinutes`：到达 run 截止时间后不再发起
  attempt，按 `budget_exhausted` 回退并由 `JevLivePolicy` 暂停 run。

11. **取消语义**：`runSingleWithPolicy` 在 tick 边界检查 `AbortSignal`，取消后停止结算新 tick
    并置 `RunWindowReport.cancelled=true`；被取消 tick 的部分决策从 `decisions` 中回滚，
    不再出现「已决策未执行」的悬空记录。新增 2 项接线测试（运行中取消、启动前取消）。

12. **topK>1 采样**：`selectTopK` 取概率前 K（并列按 legalActions 顺序），按非负概率
    归一化后用 `R(seed,tick,agentId,"jev_topk",0)` 采样；`topK<=1` 仍走稳定 top1，
    不消费随机地址。`runSingleWithPolicy` 默认从 `config.decision.topK` 读取，
    `PolicyRunOptions.topK` 仅作显式覆盖。新增单元、`callJev` 集成与 runner 接线用例，
    兑现 `decision.topK` 的接线测试。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion` **不变**（`rules-v10`/`engine-v0.8.0`/
  `stratify-config-v5`）：决策层迁移不改变核心结算语义。
- `policyVersion` 不变：`mock-weighted-v1`/`random-uniform-v1`/`jev-choice-v1`。
- `RunOutcome.decisions` 与 `RunOptions.policyImpl` 为**增量字段**，现有脚本/测试无需修改；
  `runSingle` 的签名与同步语义保持不变。
- 预注册 hash 与 P1.5 产物不受目录移动影响（策略版本与配置未变）。

## 3. 测试

- `test/unit/decision/p2-decision.test.ts`（随模块迁移，16 项）：
  序列化/状态哈希/非法响应/预算/熔断/live 适配，以及本轮新增的客户端契约用例：
  超时 `timeout` + transport 记账、网络重试次数与 transport 计数一致、非法
  `Retry-After`→`retry_after_invalid`、回退率窗口 success/fallback 各记一次、
  401/403 抛 `jev_auth_failed`、熔断/回退率暂停、退避节奏分型、4xx 记
  `http_client_error`、token 估算与 overage、usage_missing/budget_exhausted 暂停；
  `policy-wiring` 新增认证失败终止 run 用例。
- 新增 `test/unit/decision/decision-schema.test.ts`（6 项）：JSON Schema 冻结文件与生成
  常量一致、合法状态通过、额外字段/错误类型/事件上限/缺字段被拒绝。
- 新增 `test/unit/decision/replay.test.ts`（6 项）：mock 日志重放终态一致、缺失/非法
  `replay_invalid`、requestedAction 不复活、原始 fallback 来源保持、重复记录失败。
- 新增 `test/unit/runner/policy-wiring.test.ts`（6 项）：
  1. 同步 run 通过接口决策并收集 `DecisionRecord`；
  2. 异步 `MockPolicy` 与同步 mock 路径逐位等价（决策序列 + 终态哈希）；
  3. `RandomPolicy` 同种子两次运行终态一致；
  4. 更换 Policy 会改变决策与终态（策略不是装饰）；
  5. fallback 来源计入 `decisionsByTick.fallbacks`。

## 4. 未完成（P2 剩余）

- **P2-07** 真实冒烟：需要独立低预算密钥、VPS 直连、成本上限；未在 CI 运行，
  未在本轮执行。客户端与预算/熔断已就绪，只差受控的真实调用。
- **P2-06 replay**：回放策略已实现并通过单测，但尚未接入 CLI/批跑入口与预注册 manifest；
  真实 live 日志的端到端回放仍待 P2-07 之后验证。
- **P2-02** 的 prompt 预算与 **P2-03** 的真实响应 fixture 仍需在 P2 后续任务中补验收证据；
  本轮只证明接口与接线可运行，不宣称 P2 完成。

## 5. 兼容性影响

- 旧实验产物（`out/p15-*.json`）不因本变更失效：它们记录的是 `policyVersion` 与配置哈希，
  不是决策层文件位置。
- 旧测试 `test/unit/experimental/p2-decision.test.ts` 已迁移；`test/unit/architecture.test.ts`
  的 `src/experimental` 隔离守卫保留，用于未来实验代码。
