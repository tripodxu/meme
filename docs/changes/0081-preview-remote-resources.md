# 0081 preview 远程资源初始化（D1 完成，R2 未开通）

- 日期：2026-11-12
- 作者：徐鼎（施工代理执行）
- 关联：docs/09 §2.3/§3、docs/reference/known-limitations.md
- 性质：运维配置；不改规则、参数、schema、Worker 代码或实验结论
- 影响范围：`wrangler.jsonc`（preview D1 ID）、部署文档与已知限制

## 1. 完成项

- 使用本机已登录的 Cloudflare OAuth 凭据执行远程配置；凭据未写入仓库、
  命令参数、日志或本记录。
- 创建 preview D1：`stratify-preview`（region `WNAM`，
  `database_id=3db883f2-c44a-4f30-8884-bbf5f7c3bddf`），并把
  `wrangler.jsonc` 的 preview `REPLACE_WITH_PREVIEW_D1_ID` 替换为该 ID。
- 对 preview D1 执行 `wrangler d1 migrations apply stratify-preview --remote --env preview`：
  `0001_init.sql`、`0002_runtime_authority.sql`、`0003_diagnostics_hash.sql`
  全部 ✅；远程 `d1_migrations` 记为已应用。
- `pnpm build:web` 通过：`dist-web` 4 个静态资源（index.html、CSS、JS、map），
  gzip 后 JS 55.16 kB。

## 2. 阻塞项

- 账户未开通 R2。`wrangler r2 bucket create stratify-artifacts-preview` 与
  `wrangler r2 bucket list` 均返回 API `10042`：
  “Please enable R2 through the Cloudflare Dashboard.”
- 因 bucket 不存在，`wrangler deploy --env preview` 在脚本上传阶段返回 API
  `10085`（`R2 bucket 'stratify-artifacts-preview' not found`）并中止；
  静态资源虽已 staging，但 Worker 脚本未上传。`wrangler deployments list --env preview`
  无记录，**preview 未发布**。
- production D1/R2 未创建，`database_id` 仍为 `REPLACE_WITH_PROD_D1_ID`。

## 3. 未完成 / 边界

- 需账户所有者在 Cloudflare Dashboard 开通 R2（账户级订阅/条款确认）后，
  创建 `stratify-artifacts-preview`，再重新 deploy 并执行
  `scripts/smoke-remote.mjs`；在冒烟通过前不得声称 preview 已部署。
- 远程 Cron、保留删除、备份/恢复与回滚演练均未执行。
- 本记录不改变 `rulesVersion`/`schemaVersion`/`promptVersion`，不构成校准或结构证据。
