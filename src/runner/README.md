# src/runner

Node 批量运行器。按 [01 实施计划](../../docs/01-implementation-plan.md) 施工中：P1.5 的 `preregistration`/`run-cell`/`window-stats`/`cluster` 已可用，P5a 的 `batch`/`checkpoint`（含 `checkpoint-fs`）已落地基础实现；CLI、预算执行与上传仍未完成。

已实现模块：`preregistration`、`run-cell`、`window-stats`、`cluster`、`batch`、`checkpoint`、`checkpoint-fs`。

计划模块：`batch-cli`、`rate-limit`、`budget`、`uploader`。

## 边界

- 运行在 Node，复用 `src/core`、`src/decision` 与共享契约；Node 专有代码不得被核心反向引用。
- 负责并发上限、速率限制、预算与 checkpoint 续跑；这些能力不得渗入核心结算。
- 与 Worker 使用同一 D1 schema 和 R2 manifest 格式，不新建旁路格式。
- 依赖 Deployment 约束见 [02 架构](../../docs/02-architecture.md) 与 [09 发布与运维](../../docs/09-deployment-operations.md)。
