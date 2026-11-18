# 0087 — 自定义域名 `stratify.logicc.top` 远程全链路冒烟与真实 `/api/jev` 代理验证

- 日期：2026-11-18
- 状态：已完成（Cloudflare Preview 公网数据面、R2 流式上传与独立回放验证、真实 Jev System One 同源代理冒烟及带数据 D1 恢复演练全部通过）
- 影响范围：`wrangler.jsonc`、`src/worker/index.ts`、`src/app/live-policy.ts`、`src/app/run-controller.ts`、`src/ui/app.ts`、`src/ui/workspaces/setup.ts`、`test/unit/app/live-policy.test.ts`、`test/unit/worker/api.test.ts`、`docs/`
- 规则与 Schema 影响：**无**（`rules-v15`、参数默认值、RNG 地址与核心黄金哈希逐位不变；G6 保持未通过）

## 1. 协议对齐与代码修复

1. **浏览器 `jev_live` ↔ Worker `/api/jev` ↔ System One 协议贯通（`P4-08` / [04](../04-jev-decision-contract.md) §3.3 / [05](../05-api-data-contract.md) §2, §4.1）**
   - `src/app/live-policy.ts`：浏览器端经同源 `/api/jev` 调用时严格通过请求头 `X-Api-Key` 传递内存密钥（移除浏览器→代理跳点的 `Authorization` 头），默认请求模型统一对齐基线 `jev-1.13.0`（`src/ui/app.ts`、`src/app/run-controller.ts`）。
   - `src/worker/index.ts`：`/api/jev` 严格校验顶层白名单键（仅允许 `state/model/questions`）与真实 System One `questions.action = { type: "choice", instructions?, criteria }` 结构（选项数 `1..9`），同时兼容 `X-Api-Key` 与 `Authorization: Bearer` 提取密钥并按 `IP + sha256(Key)` 指纹限流，向配置的上游 `JEV_UPSTREAM_URL` 转发 `Bearer` 鉴权。
   - 新增 `test/unit/app/live-policy.test.ts` 端到端接线单测，直接把 `createBrowserLivePolicy` 接入 Hono `workerApp.request('/api/jev')`，锁死客户端与 Worker 代理的真实线协议一致性。
2. **自定义域名与真实网关固化（`wrangler.jsonc`）**
   - 在 `env.preview` 中固化 `"routes": [{ "pattern": "stratify.logicc.top", "custom_domain": true }]`，防止后续 `wrangler deploy` 抹除自定义域名触发器；
   - 将 `JEV_UPSTREAM_URL` 指向真实网关 `https://jev.logicc.top/v1/systemone`，`JEV_ALLOWED_MODELS` 增补 `jev-1.13.0`；重新部署 `stratify-preview`（版本 `bd6cadab-53b9-4b8e-a7a6-0df5c9dd3e7e`，Worker 启动耗时 `2 ms`）。

## 2. 公网远程实测证据（`https://stratify.logicc.top`）

1. **公网 HTTP 与真实浏览器冒烟（`P4-07` / `P7`）**
   - `node scripts/smoke-remote.mjs --base-url https://stratify.logicc.top --runtime-version node-22.21.0`：`health` 200（`db: "ok"`）→ 静态首页 200 → 创建 run 201（`run_009b2f5ac7f9aaf98aafe8c1`）→ 读取 200 → 取消 200，全项 `ok: true`；
   - Playwright Headless Edge Chromium 直接访问 `https://stratify.logicc.top/`：双界面顶栏渲染正常，在线执行 `N=10, T=6` 模拟至 `已完成` 且同源 `fetch('/api/health')` 返回 200，`consoleErrors: []`。
2. **公网 R2 流式 `full` 上传、幂等重放与独立回放验证（`P4-05` / `P5b`）**
   - 使用 `createStreamingBundleWriter` 生成 `full` 可回放包（`N=12, T=20`），经 `scripts/upload-run.mjs --base-url https://stratify.logicc.top` 上传至远端 Cloudflare D1 + R2（`run_4b4964b3daa853b4e772efb0`，`chunksUploaded: 5`，`status: "completed"`）；
   - 二次重跑同一 `upload-run.mjs` 验证断点账本与服务端幂等：`chunksUploaded: 0, chunksSkipped: 5, duplicateComplete: true`；
   - 执行 `scripts/verify-run.mjs --run-id run_4b4964b3daa853b4e772efb0 --base-url https://stratify.logicc.top` 从远端 R2 下载解压全部 5 个 gzip 分块，核验双 SHA-256 与 20 tick 确定性重放：`replayFinalStateHash === claimedFinalStateHash`（`sha256:4900dc77...`），核对 `24` 决策、`283` 事件、`3` 快照，输出 `status: "verified"`。
3. **真实同源 `/api/jev` BYOK 代理小额冒烟（`P4-08`）**
   - 通过 `createBrowserLivePolicy` 向 `https://stratify.logicc.top/api/jev` 发起受控小额运行（`N=5, T=2, maxCalls=8, maxInputTokens=20000`）：**5/5 次决策成功、0 回退**，来源全部为 `jev_live`，真实响应模型记录为 `jev-1.13-free`，消耗 `callsUsed: 5, tokensSpent: 5126, tokensReserved: 0, overageDetected: false`，耗时 `8.50 s`，产物零密钥残留（`keyLeakedInOutcome: false`）。
4. **带真实业务数据的远端 D1 备份导出、隔离恢复与零明文密钥审计（`P7`）**
   - 执行 `pnpm backup:d1 --database stratify-preview --env preview` 导出含真实业务行的远端快照（`27,743` 字节、`35` 条 `INSERT`：`runs=3, tick_stats=5, agent_final=12, artifacts=5, rate_limits=6`）；
   - `node scripts/verify-backup.mjs ... --rehearse` 隔离内存 SQLite 外键回放通过（`ok: true, orphanArtifactRefs: 0`）；
   - 审计导出 SQL 中的 `rate_limits` 表：确认记录为哈希指纹桶 `ip:<ip>:jev:<24hex>`、`jev:global`（计数 `5`）与 `runwrite:<runId>:ip:<ip>`，全文检索明文 API Key 结果为 `hasPlainKey: false`。

## 3. 剩余边界（如实登记）

- **科学结论边界不变**：`rules-v15` 未通过 [07](../07-experiment-calibration.md) 统计验收，G6 仍未通过，全部工程与云端能力不得表述为“已校准”或“结构已涌现”。
- **Production 与线上 Cron 未启用**：`stratify-prod` 生产 D1/R2 资源尚未创建；账户 Workers Free 计划的 5 个 Cron 槽位已被占用，线上自动定时清理与生产发布后监控（告警/成本看板）待立项上线生产环境时开启。
