# src/runner

Node 批量运行器。按 [01 实施计划](../../docs/01-implementation-plan.md) 施工中：P1.5 的 `preregistration`/`run-cell`/`window-stats`/`cluster` 已可用；P5a 的 `batch`/`checkpoint`（含 `checkpoint-fs`）与 **P5-01 批跑 CLI（`batch-cli` + `bin/stratify-batch.mjs`，changes/0031）** 已落地；预算限流与上传仍未完成。

已实现模块：`preregistration`、`run-cell`、`window-stats`、`cluster`、`batch`、`checkpoint`、`checkpoint-fs`、`batch-cli`。

计划模块：`rate-limit`、`budget`、`uploader`。

## 批跑 CLI（P5-01）

```bash
pnpm build
node bin/stratify-batch.mjs <manifest.json> --out <dir> [--resume]   # 或 pnpm batch
```

- manifest 为 `batch-v1`（cells × seeds 笛卡尔；校验在 `batch.ts`）；
- stdout 只输出 `batch-summary-v1` 纯 JSON，进度走 stderr；报告/审计/ledger 三文件落输出目录；
- `--resume` 从 `batch-ledger-v1` ledger 恢复（kill 后续跑，G5a）；技术失败跨 resume 保留（07 §3）；
- mock/random 批跑不依赖 P2：不读密钥、不发网络请求；
- 同一输出目录不得并发运行两个批跑进程（并发/共享预算属 P5-02）。

## 边界

- 运行在 Node，复用 `src/core`、`src/decision` 与共享契约；Node 专有代码不得被核心反向引用。
- 负责并发上限、速率限制、预算与 checkpoint 续跑；这些能力不得渗入核心结算。
- 与 Worker 使用同一 D1 schema 和 R2 manifest 格式，不新建旁路格式。
- 依赖 Deployment 约束见 [02 架构](../../docs/02-architecture.md) 与 [09 发布与运维](../../docs/09-deployment-operations.md)。
