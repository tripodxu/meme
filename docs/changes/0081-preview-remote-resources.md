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

## 2. 未执行：远程冒烟

`scripts/smoke-remote.mjs` 需要本机向公开 URL 发起 HTTP 请求。本机网络无法到达
`*.workers.dev`，以下路径均已尝试且失败：

- 本地 DNS 返回 `75.126.33.156` 与 Facebook 段 IPv6，属污染结果；
- 经 DoH（1.1.1.1）取得 `172.67.128.254` / `104.21.2.89` 后用 `curl --resolve`
  直连，TLS 握手被重置；
- WebFetch 对该域名的安全校验被网络策略阻止；
- `wrangler dev --remote` 启动后所有请求报 `ProxyWorker ... internal error`；
- `wrangler dev` + D1/R2 remote bindings 启动成功，但 health 的 `SELECT 1` 超时；
- VPS `2zhou` SSH 返回 “machine ... is stopped”。

因此 health → 静态首页 → 创建/读取/取消 run 的远程冒烟**未执行**，
preview 的公开可达性与 API 行为均未验证，不得声称冒烟通过。

## 3. 未完成 / 边界

- 需在能访问 `workers.dev` 的网络（或给 Worker 绑定可达的自定义域）执行：
  `node scripts/smoke-remote.mjs --base-url https://stratify-preview.xd04040212.workers.dev --runtime-version node-v22.21.0`
- production D1/R2、部署、Cron、备份/恢复与回滚演练均未执行。
- 本记录不改变 `rulesVersion`/`schemaVersion`/`promptVersion`，不构成校准或结构证据。
