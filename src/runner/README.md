# src/runner

Node 批量运行器。按 [01 实施计划](../../docs/01-implementation-plan.md) 施工中：P1.5 的 `preregistration`/`run-cell`/`window-stats`/`cluster` 已可用；P5a 的 `batch`/`checkpoint`（含 `checkpoint-fs`）、**P5-01 批跑 CLI（`batch-cli` + `bin/stratify-batch.mjs`，changes/0031）**、**P5-03 run 内进度检查点（`run-progress`，changes/0032）** 与 **P5-04 微扰配对执行入口（`perturbation`，changes/0033）** 已落地；预算限流与上传仍未完成。

已实现模块：`preregistration`、`run-cell`、`window-stats`、`cluster`、`batch`、`checkpoint`、`checkpoint-fs`、`batch-cli`、`run-progress`、`perturbation`。

计划模块：`rate-limit`、`budget`、`uploader`。

## 微扰配对（P5-04）

```ts
import { runPerturbationBatch } from '<dist>/runner/perturbation.js';
const summary = runPerturbationBatch(config, tasks, { policy, checkpointTick });
```

- `param`（相对扰动 value×(1+δ)）与 `wealth_absolute`（存活者 += ΔValue）两种声明；
- baseline/treatment 从同一检查点快照克隆（07 §7.2），叶子路径 diff 强制「只改声明变量」；
- round-trip 后哈希不变 → `invalid=true`（07 §7.4），不报「无敏感性」；
- 产出 `perturbation-summary-v1`（任务回显 + 逐对 `firstDivergenceTick`/两侧报告）。

## 批跑 CLI（P5-01/P5-03）

```bash
pnpm build
node bin/stratify-batch.mjs <manifest.json> --out <dir> [--resume] [--checkpoint-ticks N]   # 或 pnpm batch
```

- manifest 为 `batch-v1`（cells × seeds 笛卡尔；校验在 `batch.ts`）；
- stdout 只输出 `batch-summary-v1` 纯 JSON，进度走 stderr；报告/审计/ledger 三文件落输出目录；
- `--resume` 从 `batch-ledger-v1` ledger 恢复（kill 后续跑，G5a）；技术失败跨 resume 保留（07 §3）；
- `--checkpoint-ticks N` 每 N tick 落 run 内进度检查点（`run-progress-v1`：快照 + 窗口累计器），
  kill 后从 tick 级完整点恢复且窗口聚合与不中断运行逐字一致；长 run 建议开启（如 500）；
- mock/random 批跑不依赖 P2：不读密钥、不发网络请求；
- 同一输出目录不得并发运行两个批跑进程（并发/共享预算属 P5-02）。

## 边界

- 运行在 Node，复用 `src/core`、`src/decision` 与共享契约；Node 专有代码不得被核心反向引用。
- 负责并发上限、速率限制、预算与 checkpoint 续跑；这些能力不得渗入核心结算。
- 与 Worker 使用同一 D1 schema 和 R2 manifest 格式，不新建旁路格式。
- 依赖 Deployment 约束见 [02 架构](../../docs/02-architecture.md) 与 [09 发布与运维](../../docs/09-deployment-operations.md)。
