# 0071 P4 Worker/D1/R2 工程落地（MVP）

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0008（P6 停止后转工程轨道）、docs/05、docs/09、docs/11
- 性质：工程交付；不改规则、参数、schema 或实验结论
- 影响范围：`src/worker`、`migrations`、`wrangler.jsonc`、测试与文档

## 1. 交付

### P4-01 统一 HTTP 层

- Hono Worker：`/api/*` 统一 requestId（`X-Request-Id`、`Cache-Control: no-store`）、
  稳定错误码与 `{error:{code,message,details},requestId}` 错误体；404/500 同一结构。
- `/api/health` 只返回 `{status,version,time,db}`，不泄露环境变量。
- 验证错误 `details` 为 `{path,reason}[]`；Jev 上游非 2xx 的 `details` 为
  `{upstreamStatus}`，代理自身 502 时为 `null`（docs/05 §1）。

### P4-02 D1 迁移

- `migrations/0001_init.sql`：`runs`、`tick_stats`、`agent_final`、`experiments`、
  `experiment_runs`、`artifacts`、`rate_limits`，含 CHECK、外键与查询索引。
- 测试用本机 `node:sqlite` 执行同一迁移文件，避免另写一套 schema。
- 迁移只追加；已发布迁移不得修改。

### P4-03 run 创建与状态机

- 浏览器来源可匿名创建（IP 30 次/小时），带 Runner token 时强制 `source=runner`。
- 服务端重算 `configHash/paramsHash/initialPopulationHash`，拒绝自报 roster；
  `rulesVersion/policyVersion/schedule` 必须与 config 一致。
- `writeToken` 仅创建时返回；D1 只存 SHA-256 与 8 字符前缀；后续写接口按 run 校验。
- 状态机 `running -> completed|failed|cancelled`；终态写返回 409，重复取消/失败同态幂等。
- experiment 绑定校验 seed/cellKey 属于已存在 manifest，`(experiment,cell,seed)` 唯一。

### P4-04 批量写入与 complete

- `ticks:batch` 1–100 条、`agents:batch` 1–500 条；`(runId,tick)`/`(runId,agentId)`
  同 hash 幂等、不同 409，不覆盖。
- tick 必须属于计划 stats 序列（含 `totalTicks-1` 与 extinct 提前结束）。
- complete 校验 finalTick 与 stats 计划、tick/agent 计数、`metrics`、`final_state`；
  `full` profile 另需 `decisions/events/snapshot`；相同摘要重试幂等。
- `metrics-only` 不声明可回放；complete 只表示上传技术完整，`verificationStatus=uploaded`。

### P4-05 R2 artifact 与导出

- `PUT /api/runs/:id/artifacts/:chunkId`：kind 枚举、chunkId 字符集、8 MiB 上限、
  压缩 SHA-256 服务端复算、同键同 hash 幂等、不同 409；R2 key
  `runs/<runId>/<kind>/<chunkId>.ndjson.gz`。
- `GET .../artifacts/:kind/:chunkId` 流式返回 R2 body，支持 ETag/304，不把整块合并进内存。
- `GET /api/runs/:id/export.ndjson` 输出 manifest 行 + tick/agent 行（单次上限内）。

### P4-06 列表与限流

- `GET /api/runs` keyset 分页：`(created_at,run_id)` 降序，limit 1–100，
  游标绑定 source/status 过滤，过滤变化拒绝旧游标。
- 固定窗口限流表 `rate_limits`；匿名建 run 30/h、`/api/jev` 60/min；超限 429。
- 所有列表和聚合查询均有硬 LIMIT；stats 单次最多 2000 tick。

### P4-08 同源 BYOK 代理

- `POST /api/jev`：只接受 `state/model/questions` 一个 action choice（1–9 选项）；
  body 256 KiB；模型服务端 allowlist；Key 仅转发为上游 Bearer。
- 超时 30s、网络失败/超时映射 502；429/529 保留状态与 Retry-After；不重试。
- 错误体与日志不含 Key、Authorization 或请求正文；上游 URL 必须 https 且无内嵌凭据。
- 浏览器 `jev_live` 接入仍需 P4-08 的 live 冒烟；本轮未执行真实 Jev 调用。

### 配置与脚本

- `wrangler.jsonc`：Static Assets（`dist-web`，`/api/*` 先走 Worker）、D1/R2 binding、
  local/preview/production 三套环境；远程 D1 ID 用占位符，部署前替换。
- 新增 `dev:worker`、`deploy:worker`、`db:migrate:local/preview/prod` 脚本。
- `RUNNER_TOKEN` 只通过 `wrangler secret put` 配置，不入库。

## 2. 验证

- `pnpm typecheck`、`pnpm lint` 通过。
- 新增 `test/unit/worker/api.test.ts`（14 项）：health、哈希重算拒绝、tick/agent 幂等、
  artifact 哈希与 8 MiB、complete 状态机与幂等、experiment runner 认证与预注册复算、
  keyset 分页/过滤、verification 权限与不可回退、无 token 拒绝、Jev allowlist/透传/不泄密、
  固定窗口限流、404 错误体。
- `wrangler deploy --dry-run` 成功打包 Worker 与静态资源（222.53 KiB / gzip 50.05 KiB），
  绑定名与迁移目录被 Wrangler 识别。

## 3. 未完成 / 边界

- **P4-07 workerd + 本地 D1/R2 集成与 preview 部署冒烟未执行**：本机只做了
  `wrangler deploy --dry-run` 打包验证；没有 Cloudflare 账号资源与 preview 凭据，
  因此不声称 preview 可用、不声称部署完成。
- **保留策略/维护任务**（过期 run 清理、孤儿 artifact 清理、`rate_limits` 清理）未实现，
  P4-06 仅完成列表硬上限与限流。
- `expectedDueDecisions`、`artifactManifestHash` 目前只做格式校验，未做服务端复算。
- `diagnosticsHash` 未持久化；cancel/fail 只记录 reason 与 finalTick。
- 真实 Jev live 冒烟未跑；浏览器 `jev_live` 仍禁用。
- 未改 `rulesVersion`、`schemaVersion`、`promptVersion`；不构成校准或结构证据。
