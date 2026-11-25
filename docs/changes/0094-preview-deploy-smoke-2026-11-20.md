# 0094 preview 部署、上传链路、D1 备份恢复与回滚演练（2026-11-20）

> 状态：工程验证记录，不构成科学验收。preview 环境演练；production 资源仍未创建。

## 0. 背景

P0 的 CI 门禁修复已合入 `zcodes11.4`（PR [#2](https://github.com/tripodxu/meme/pull/2)）。
GitHub Actions 运行 `44719618731` 在 `ubuntu-24.04` 上完成全部步骤：文档链接、
密钥扫描、格式、Lint、typecheck（含 core）、依赖审计、单元/覆盖率（核心分支
95.18%）、运行层覆盖率、集成、jsdom E2E、Playwright、构建、前端构建与
Worker dry-run，全部通过。

本次按 `docs/09-deployment-operations.md` 在 preview 补做真实运行证据。

## 1. 部署与 API 冒烟

- 构建：`pnpm build:web` + `pnpm deploy:preview`，2026-11-20T10:34:40Z 部署
  `0b308371-8f45-4210-9d67-54a38876a478` 到 `https://stratify.logicc.top`。
- 迁移：`wrangler d1 migrations apply stratify-preview --remote --env preview`
  返回 `No migrations to apply!`（0001–0003 已应用）。
- `/api/health`：`HTTP 200`，`{"status":"ok","version":"preview","db":"ok"}`。
- `pnpm smoke:worker --base-url https://stratify.logicc.top --runtime-version node-22.21.0`：
  `health` / `static-index` / `create-run`（`run_bb61ea7463496a342fb71776`）/
  `read-run` / `cancel-run` 全部 `ok: true`。

## 2. 完整上传链路（匿名 browser run）

在 `lhsh` 上用一条 120 tick、40 人的 mock run 生成 `metrics-only` bundle
（`/tmp/p1-bundles/smoke-p1-smoke-seed-001/`），通过 `scripts/upload-run.mjs`
以匿名通道上传（不写任何 `RUNNER_TOKEN`）：

- `runId`：`run_1e1d74eabd7f8582d2f72b87`
- `status=completed`、`endReason=scheduled`、`source=browser`
- `finalTick=119`、`finalAliveCount=40`
- `progress`：`tickRows=120`、`agentRows=40`
- artifacts：`metrics`、`final_state`
- `verificationStatus=uploaded`

**未执行独立回放验证**：`POST /api/runs/:id/verification` 仅 `RUNNER_TOKEN`
可用；preview 的 `wrangler secret list --env preview` 为空，且 Secret-Store
写入被当前权限策略拒绝。因此不得声称该 run 已达到 `verified`。

## 3. D1 备份与恢复校验

- `pnpm backup:d1 --database stratify-preview --env preview --output out/backup-preview-20261120.sql`
  → 120,623 字节，sha256 `6c52e46095f7b7dab89da287b08942224664619ebf3ade106df2053e5e0b6264`。
- `pnpm verify:backup out/backup-preview-20261120.sql` → `ok: true`，0 issues，
  7 张表（`runs/tick_stats/agent_final/experiments/experiment_runs/artifacts/rate_limits`），
  203 条 `INSERT`，在隔离 SQLite 中完成外键恢复回放。
- 备份文件含真实业务行，按既有约定不入库（`out/*` 忽略）。

## 4. 回滚 / 前滚演练

- `wrangler rollback bd6cadab-53b9-4b8e-a7a6-0df5c9dd3e7e --env preview`
  成功，`/api/health` 返回 200（`db: ok`）。
- `pnpm deploy:preview` 前滚到 `1117ab11-db1d-4f25-94d5-0da855b40970`；
  切换后首次健康检查 30s 超时（版本传播窗口），随后 3/3 次返回 200、
  约 2–3s；再次 `smoke:worker` 全绿。

## 5. 边界与未完成项

- 仅 preview；`stratify-prod` 的 D1/R2 尚未创建，production 部署与生产备份
  恢复演练未执行。
- preview 的 Cron 保留任务因 Workers Free 5 槽上限显式不注册
  （`triggers.crons = []`）；R2 孤儿对象枚举与删除演练未执行。
- 真实 Jev live 代理冒烟本次未执行；P6-14 的 live 段受上游 429 阻塞另行记录。
- 以上均为工程运行证据，不得表述为科学验收或“已发布”。
