# 0081 preview 远程资源与首次部署（远程冒烟未执行）

- 日期：2026-11-12
- 作者：徐鼎（施工代理执行）
- 关联：docs/09 §2.3/§3、docs/reference/known-limitations.md
- 性质：运维配置；不改规则、参数、schema、Worker 代码或实验结论
- 影响范围：`wrangler.jsonc`（preview D1 ID、preview Cron 置空）、部署文档与已知限制

## 1. 完成项

- 使用本机已登录的 Cloudflare OAuth 凭据执行远程配置；凭据未写入仓库、
  命令参数、日志或本记录。
- 创建 preview D1：`stratify-preview`（region `WNAM`，
  `database_id=3db883f2-c44a-4f30-8884-bbf5f7c3bddf`），并把
  `wrangler.jsonc` 的 preview `REPLACE_WITH_PREVIEW_D1_ID` 替换为该 ID。
- 对 preview D1 执行 `wrangler d1 migrations apply stratify-preview --remote --env preview`：
  `0001_init.sql`、`0002_runtime_authority.sql`、`0003_diagnostics_hash.sql`
  全部 ✅；随后远程 SQL 查询 `sqlite_master` 确认 `runs`、`tick_stats` 等表存在。
- 账户开通 R2 后创建 `stratify-artifacts-preview`（Standard）。
- `pnpm build:web` 通过后执行 `wrangler deploy --env preview` 成功：
  `https://stratify-preview.xd04040212.workers.dev`，
  当前版本 `83be6ffa-e94c-47b8-ac89-97fdc91e2dc6`。
- 首次 deploy 的 Cron 注册失败：账户 Workers Free 的 5 个 Cron 槽位已被占用
  （API `10072`）。preview 现在显式 `triggers.crons = []`，重新 deploy 无部分失败；
  production 仍保留每日 Cron 配置，但在槽位释放或升级计划前无法注册。

## 2. 远程可达性与平台故障（2026-11-12）

本机网络无法直连 `*.workers.dev`：本地 DNS 返回污染地址（`75.126.33.156` 与
Facebook 段 IPv6），经 DoH 取得真实地址后 TLS 仍被重置，WebFetch 安全校验被阻止。
随后通过本机代理访问，观察到：

- preview 的 `/api/health`、`/`、静态资源与 `/api/does-not-exist` 全部返回
  HTTP 500（`error code: 1101`），版本预览 URL 同样；
- 账户内其他无关 Worker（`film-sort`、`jev-piano`、`vocab`）也返回 1101，
  `zhouyi-hexagram` 返回自身 404；说明不是 `stratify-preview` 独有；
- Cloudflare Status 同期显示 Workers 组件 `degraded_performance`
  （D1、R2、Workers Assets 为 operational，2026-11-12T12:50Z）；
- 已创建 tail 会话并触发请求，但没有任何 tail 事件，符合启动/平台层失败，
  而非业务路由异常；
- 本地 `wrangler dev --env preview`（local bindings）health 返回 200、`db=ok`；
  从 API 下载的部署脚本与本地 dry-run bundle 一致，且不含 `node:` 内置依赖；
- `wrangler dev --remote` 仍报 `ProxyWorker ... internal error`，与本机到
  workers.dev 的网络限制及平台降级一致；
- VPS `2zhou` SSH 返回 “machine ... is stopped”。

结论：部署上传成功，但平台恢复前无法验证 preview 的公开行为。
health → 静态首页 → 创建/读取/取消 run 的远程冒烟**未执行**，
不得声称冒烟通过，也不把 1101 归因于本仓库代码。

## 3. 未完成 / 边界

- 需在能访问 `workers.dev` 的网络（或给 Worker 绑定可达的自定义域）执行：
  `node scripts/smoke-remote.mjs --base-url https://stratify-preview.xd04040212.workers.dev --runtime-version node-v22.21.0`
- production D1/R2、部署、Cron、备份/恢复与回滚演练均未执行。
- 本记录不改变 `rulesVersion`/`schemaVersion`/`promptVersion`，不构成校准或结构证据。
