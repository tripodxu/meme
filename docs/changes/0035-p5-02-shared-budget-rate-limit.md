# 0035：P5-02 批内共享预算、限流与 live 批跑执行器

- 日期：2026-11-05
- 作者：Runner 负责人
- 关联：P5-02（01 §8.1）、04 §6/§7（熔断与预算）、docs/09 §6（共享记账口径）、
  `changes/0030`–`0034`
- 性质：**Runner 层实现变更**；`AttemptBudget` 增加只读 `usage()` 诊断访问器
  （行为不变）；不改变规则、参数、引擎与决策协议

## 1. 结论先行

P5a 的最后一项 P5-02 落地，**P5a 五项全部完成**（P5-01/02/03/04/06）：

- `SharedBatchBudget`：批内所有并发 live run 共用同一记账对象，总调用数与总
  input token 不随 run 数放大（04 §7 批量口径）；委托 `AttemptBudget` 复用
  fail-closed 语义（overage → 永久 exhausted，估算器低估即全部估算不可信），
  不复制第二套记账逻辑。
- `RateLimiter`：`maxConcurrent`（在途调用上限）+ `minIntervalMs`（相邻调用开始
  最小间隔）双约束；睡眠后回循环头重读状态（另一 acquirer 可能已启动），
  领用动作无 await 原子；`rateLimitedFetch` 包裹 `JevClientDeps.fetchImpl`
  注入缝，client 的重试也在批次限速内。
- `runBatchWithPolicy`：live/replay 批跑执行器——`policyFactory` 注入策略
  （**密钥只进 factory 闭包**，不落参数/日志/摘要）、`concurrency` worker 池、
  共享 ledger（写入串行化）、预算耗尽/认证/熔断/回退率停止批次
  （剩余任务按同因记录，不冒充完成，G5a「预算耗尽」注入口径）、取消传播
  （在途 run cancelled 计入失败）。

## 2. 语义要点

- **MVP 单机单进程**：本进程即调度进程（docs/09 §6「由一个调度进程统一记账」）；
  多进程 `budget.sqlite` WAL 记账与多主机分片明确不在 MVP（§6 排除项）。
- **失败保留**（07 §3）：`failures[]` 跨 resume 累积；致命失败（auth/熔断/回退率/
  预算耗尽）停止批次后，剩余任务以同因 failure 记录，`due - ok` 是真实未完成数。
- **确定性边界**：live run 不可种子复现（04 §4）；resume 只保证已完成的 run
  不重算，恢复后的新 run 是新的真实调用；`finalStateHash` 对照只在 mock/replay
  口径成立。
- **ULID 熵源**：`node:crypto.randomBytes`——ESLint 全仓禁 `Math.random`；
  runId 是标识符熵，不是仿真随机流（AGENTS #3 约束的是结算用随机性）。
- **单元测试确定性**：fake 策略用微任务让出与 abort 门（不依赖真实计时器），
  budget/limiter 用注入时钟。

## 3. 边界（后续归属）

- **live run 内进度检查点**：`runSingleWithPolicy`（异步）尚未接入
  `run-progress-v1`——异步宿主可用，但需与 P2 决策日志的 resume 语义
  （前段 decisions 不重建）一起设计，P6-04 Jev 对照开工前必须补齐；
- 跨进程共享记账（budget.sqlite WAL）与上传队列 → P5b/P4 集成时评估；
- live 批跑 CLI 不在本变更：live run 需要经 Worker 的 run 注册/上传（P4/P5b），
  当前只提供库级入口。

## 4. 验证证据

- `test/unit/runner/batch-live.test.ts` 12 项：共享记账/构造校验/耗尽 fail-closed、
  限流并发峰值/最小间隔/取消不占时隙/fetch 释放、批跑并发峰值/预算耗尽
  （G5a）/致命失败停止/取消传播/ledger resume。
- 全套门禁：typecheck/typecheck:core/lint/format/test（649）/test:integration（4）/build 全绿。
