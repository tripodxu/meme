# 0086 — Cloudflare Preview 部署刷新、远程 D1 备份/回滚演练与 `workerd` 全链路回放验证

- 日期：2026-11-18
- 状态：已完成（控制面演练与本地 `workerd` 全链路通过；`*.workers.dev` 公网数据面受当前网络超时阻断）
- 影响范围：`docs/01-implementation-plan.md`、`docs/09-deployment-operations.md`、`docs/reference/known-limitations.md`、`docs/changes/`
- 规则与 Schema 影响：**无**（`rules-v15`、配置/状态 schema 与核心黄金哈希不变；G6 保持未通过）

## 1. 已执行的真实运维与演练项（轨道 B）

1. **Cloudflare Preview 最新版本部署（`P4-07` / `P7`）**
   - 核验远端 `stratify-preview` D1 迁移（`0001`–`0003` 已同步，`No migrations to apply`）；
   - 上传最新双界面前端静态资产（4 个更新静态包）与硬化后的 Worker 代码（含 `/agents`、不可逆验证守卫、`IP+Key` 指纹限流与维护巡检）；
   - 上传体积 `232.68 KiB / gzip 52.55 KiB`，Worker 冷启动 `4–5 ms`，最终活动版本 `eb03896f-3a1d-4257-afe6-6943a4a955e7`。
2. **Cloudflare Preview 真实回滚与前滚演练（`P7` / `docs/09 §4–§5`）**
   - 对 `stratify-preview` 执行 `wrangler rollback 523f516d-c046-477c-afa7-e990f9b6bba6 --env preview`（备注 `P7 rollback rehearsal`），通过 `wrangler deployments status --env preview` 核实 `100%` 流量已切回旧版本且 D1/R2 绑定未受破坏；
   - 随后重新执行 `pnpm deploy:preview` 前滚恢复至最新版本 `eb03896f-3a1d-4257-afe6-6943a4a955e7`。
3. **远端 Preview D1 备份导出与本地隔离恢复演练（`P7` / `docs/09 §7`）**
   - 执行 `wrangler d1 export stratify-preview --remote --env preview` 成功拉取远端 SQL 快照（`5,154` 字节）；
   - 执行 `node scripts/verify-backup.mjs ... --rehearse` 在隔离内存 SQLite 中开启外键完整重放通过（`ok: true`，7 张核心表齐全，`orphanArtifactRefs: 0`）。
4. **生产依赖漏洞审计（`P7`）**
   - 执行 `pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org/`，结果 `No known vulnerabilities found`。
5. **本地真实 `workerd + D1 + R2` 端到端全链路演练（`P4` + `P5b` + `P7`）**
   - 启动 `wrangler dev --local`（`RUNTIME_VERSION=workerd-local`），依次跑通：
     - `smoke-remote.mjs`：`health` 200 → 静态首页 200 → 创建 run 201 → 读取 200 → 取消 200（`ok: true`）；
     - `stratify-batch.mjs --artifact-profile full`：流式分块生成可回放包；
     - `upload-run.mjs`：上传 5 个 gzip 分块 + ticks + agents + `complete`（`run_be316b849018b1136c02f5b9`）；
     - `verify-run.mjs --submit`：从 `workerd` R2 下载解压核验双 SHA-256 与清单哈希，完整确定性回放 10 tick（`40` 决策、`433` 事件、`3` 快照），核对 `replayFinalStateHash === claimedFinalStateHash` 并将服务端状态更新为 `verified`；
     - 导出含真实业务行的 `stratify-local` SQL（`115,228` 字节、`201` 条 INSERT：`5` runs / `53` tick_stats / `121` agent_final / `14` artifacts）并通过 `verify-backup.mjs --rehearse` 隔离恢复校验。

## 2. 外部网络与凭据阻塞边界（如实登记）

- **`*.workers.dev` 公网数据面连通受阻**：本机代理（`127.0.0.1:10898`）可正常访问 Cloudflare 控制面 `api.cloudflare.com`（因此部署、D1 远程导出、迁移与回滚全部成功），但访问 `https://stratify-preview.xd04040212.workers.dev` 在 TCP/TLS 握手阶段连接超时（`curl (28)`）。在从无阻断网络（如启动后的海外 VPS）或绑定自定义域名完成 HTTP 冒烟前，**仍不得声称远程公网端点冒烟已完成**。
- **真实上游 `/api/jev` Live 冒烟未执行**：需在公网端点可达后，由用户提供受控低限额 Jev API Key 执行小额实测。
- **Production 环境未初始化**：`stratify-prod` D1/R2 尚未创建，且账户 Workers Free 计划的 5 个 Cron 槽位已满，正式启用每日自动清理前需释放 1 个槽位或升级计划。
