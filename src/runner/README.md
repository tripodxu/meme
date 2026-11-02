# src/runner

Node 批量运行器。按 [01 实施计划](../../docs/01-implementation-plan.md) 预留，当前尚未实现。

计划模块：`batch-cli`、`checkpoint`、`rate-limit`、`budget`、`uploader`。

## 边界

- 运行在 Node，复用 `src/core`、`src/decision` 与共享契约；Node 专有代码不得被核心反向引用。
- 负责并发上限、速率限制、预算与 checkpoint 续跑；这些能力不得渗入核心结算。
- 与 Worker 使用同一 D1 schema 和 R2 manifest 格式，不新建旁路格式。
- 依赖 Deployment 约束见 [02 架构](../../docs/02-architecture.md) 与 [09 发布与运维](../../docs/09-deployment-operations.md)。
