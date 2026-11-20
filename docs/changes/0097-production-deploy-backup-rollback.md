# 0097 生产环境创建、部署、备份恢复与回滚演练（2026-11-20）

> 状态：工程验证记录，不构成科学验收。生产环境已创建并完成首轮冒烟；
> Cron 保留任务与 R2 孤儿清理仍受平台限制未启用。

## 0. 资源创建

- D1：`stratify-prod`，ID `b3ac7bff-9983-46ee-bfd4-14d1646405cd`
  （2026-11-20T11:34:44Z 创建），`0001_init.sql`、`0002_runtime_authority.sql`、
  `0003_diagnostics_hash.sql` 已通过 `--remote` 应用。
- R2：`stratify-artifacts-prod` 已创建。
- `wrangler.jsonc` 的 production `database_id` 从占位符替换为上述 ID。

## 1. 部署与域名

- 首次部署后发现 `stratify-prod.xd04040212.workers.dev` 返回 1101/超时；
  preview 使用自定义域名正常。production 改为绑定独立自定义域名
  `stratify-prod.logicc.top`（`routes` + `custom_domain`）后恢复。
- 当前版本：`4b79128b-4472-4875-879a-ba352a802b1d`；
  `/api/health` 返回 200（`version: production`、`db: ok`）。
- 生产 Cron 因账户 Workers Free 的 5 个槽位已满（API `10072`）无法注册；
  `env.production.triggers.crons = []` 显式关闭，`runMaintenance`（保留策略与
  R2 孤儿清理）暂不运行，待升级 Workers Paid 或释放槽位后启用。

## 2. 冒烟

`pnpm smoke:worker --base-url https://stratify-prod.logicc.top --runtime-version node-22.21.0`：

- `runId`：`run_44250763d44a1bfa6699b36b`
- `health` / `static-index` / `create-run`（201）/ `read-run` / `cancel-run` 全部 `ok: true`。

## 3. 备份与恢复校验

- `pnpm backup:d1 --database stratify-prod --env production --output out/backup-prod-20261120.sql`
  → 9,020 字节，6 条 `INSERT`，sha256
  `be3ea687e1c2123a3cb04a6d717db85c8ccfc4b6cd88bb1e05976f47b34721da`。
- `pnpm verify:backup out/backup-prod-20261120.sql` → `ok: true`，0 issues，
  7 张表在隔离 SQLite 中完成外键恢复回放。
- 备份文件含真实业务行，按约定不入库。

## 4. 回滚 / 前滚演练

- rollback 到 `ac795270-61c5-4937-b209-6a3be4ed17b0`：成功，
  `https://stratify-prod.logicc.top/api/health` 返回 200。
- 前滚 `pnpm deploy:prod` 至 `4b79128b-4472-4875-879a-ba352a802b1d`：
  健康 200，复跑 `smoke:worker` 全绿。

## 5. 边界与未完成项

- 未配置 `RUNNER_TOKEN`：runner 认证、`/api/runs/:id/verification`（`verified`）
  与正式上传链路未在生产验证。
- Cron 保留任务未注册，R2 孤儿枚举/删除未演练；生产数据目前只有冒烟 run。
- 真实 Jev live 代理冒烟未在生产执行。
- 以上均为工程运行证据，不得表述为科学验收或“P7 已完成”。
