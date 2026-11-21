# 0084 — 高阶前端契约收口、P5b 独立验证器与 Playwright 真实浏览器 E2E

- 日期：2026-11-18
- 状态：已完成（本地全门禁通过）
- 影响范围：`src/app/`、`src/ui/`、`src/runner/verifier.ts`、`src/worker/index.ts`、`scripts/verify-run.mjs`、`playwright.config.ts`、`test/e2e-browser/`、`test/unit/`、`docs/`
- 规则与 Schema 影响：**无**（`rules-v15`、`stratify-config-v9`、`stratify-state-v5` 及全部核心 golden 哈希逐位不变；G6 保持未通过）

## 1. 背景与目标

按 `docs/01`、`docs/05`、`docs/06` 与 `docs/08` 对照梳理，本地工程轨道尚有三块收口项：

1. **阶段 1（`docs/06` 高阶研究控件与持久化细节）**：五阶层向量参数与制度滞回细节编辑、财富对数切换与洛伦兹微图、按原发起方向分组竞争表、存活剩余寿命直方图、观察窗区间缩放与 CSV 导出、周期快照点回滚跳转、脱敏 `rawResponse`/哈希折叠 JSON、`>=30` 配对种子森林图护栏、IndexedDB v3 分块存储与同标签页刷新自动恢复。
2. **阶段 2（`P5b / P4-05` 独立验证器）**：上传 `complete` 只保证清单哈希一致（`verificationStatus=uploaded`），需独立验证器核对压缩/未压缩双 SHA-256、NDJSON schema、单调连续性与完整确定性回放，回写 `verified` 或 `rejected`。
3. **阶段 3（`P3-07` 真实浏览器自动化 E2E）**：仓库此前仅有 jsdom E2E，缺少真实 Chromium 浏览器自动化回归门禁。

## 2. 主要变更

### 2.1 前端高阶契约收口（`src/app/`、`src/ui/`）

- **设置页高阶展开**：在 `src/ui/workspaces/setup.ts` 增加 `05 · 五阶层向量参数与制度滞回细节`（`classShares[0..4]` 实时求和与一键归一化、`env0`、`decay`、`needMultiplier`、`crossDays`、`returnDiscount`、`topK`、`bufferDays`、`graceDays`、`descent.days`、`hardLifeFactor`、`occupancyMemoryDays`、`selfReinforcement`、`regimeMode`、`regimeBias`），并在 `jev_live` 增加 `promptStyle` 选择器；缩短 `totalTicks` 时自动收敛 `statsStride`/`snapshotStride` 防止隐式越界。
- **总览与检查器高阶图表**：`src/ui/workspaces/overview.ts` 增加 `Gini/Top10%` 与 `log10(medianValue+1)` 切换、`renderLorenzChart` 洛伦兹微图、`competitionByDirection` 三方向统计表、`remainingLifeBins` 剩余寿命直方图、区间缩放（`0–50%` / `50–100%` / `末 25%`）与窗口 CSV 下载；`src/ui/workspaces/inspector.ts` 增加递归脱敏（`sanitizeSecrets`）的决策审计 JSON 折叠视图。
- **回放对比森林图护栏与周期快照跳转**：`src/app/run-controller.ts` 维护有界周期快照环并提供 `jumpToSnapshot(tick)` 与同标签页原位恢复 `restoreSessionBundle`；`src/ui/workspaces/replay.ts` 支持导入配对批次摘要 JSON，严格执行 `pairedSeeds >= 30` 才渲染 `renderForestPlot`、`<30` 显式阻断推断图。
- **IndexedDB v3 分块与同标签页恢复**：`src/app/idb-store.ts` 升级至 v3（`runs_meta` + `run_chunks`），按有界块拆分 `snapshots/stats/decisions/events` 并在读取时校验块完整性；`src/ui/app.ts` 对接 `localStorage`（`stratify.settings.v1`、`stratify.lastConfig.v1`、`stratify.recentRuns.v1`，绝不含 API Key）与 `sessionStorage`（`stratify.lastRunId.v1`）刷新自动恢复。

### 2.2 P5b 独立验证器与 Worker 状态守卫（`src/runner/verifier.ts`、`src/worker/index.ts`）

- 新增 `src/runner/verifier.ts`（`verifyUploadBundle` / `verifyRemoteRun`）与 CLI `scripts/verify-run.mjs`（`pnpm verify:run`）：
  - 校验 `RunConfig`、`configHash`、`paramsHash`、`initialPopulationHash`（跨运行时 `non-authoritative` 按 ADR 0001 处理）；
  - 逐块校验远端 gzip `compressed_sha256`、解压后 `uncompressed_sha256` 与 `artifactManifestHash`；
  - 逐行校验 `metrics-v1`、`final-state-v1`、`agent` 的 `payloadHash` 与计划 tick 连续性；
  - `full` 模式从 `tick=0` 初始权威快照逐 tick 调用核心 `step()` 完整回放，核对到期决策集合、每步指标、周期快照 `stateHash`、事件总数与 `finalStateHash`；`metrics-only` 模式诚实标记 `replayable=false`。
- `src/worker/index.ts` 新增只读端点 `GET /api/runs/:id/agents`（硬上限 1000），并在 `POST /api/runs/:id/verification` 严格拦截 `rejected → verified` 洗白与覆盖已确认 `verified`（`409 state_conflict`）。

### 2.3 Playwright 真实浏览器自动化 E2E 与 Windows 守卫测试兼容

- 新增 `playwright.config.ts` 与 `test/e2e-browser/observatory.spec.ts`（`pnpm test:e2e:browser`），覆盖桌面端完整运行、SVG/Canvas 尺寸非空、IndexedDB v3 `page.reload()` 自动恢复、周期快照跳转、沙盒化身命运抉择卡与微扰分叉、`360px` 窄屏零溢出、Firefox UA 非权威运行时提示与 Live 密钥不落盘；`index.html` 补内联 SVG 图标消除浏览器 `/favicon.ico` 404 报错。
- 修复 `test/unit/deploy/systemd-unit.test.ts` 在 Windows 下误命中 WSL 空壳 `bash` 的问题，自动定位可用 POSIX Git Bash 执行 `check-disk-space.sh` 断言。

## 3. 边界声明

- 本次变更纯属工程与验证基础设施收口，**不修改任何核心仿真公式、参数默认值或随机流地址**。
- `G6` 保持未通过（P6 已按 ADR 0008 停止）；独立验证器 `verified` 仅证明数据包哈希与确定性回放自洽，**不构成参数已校准或社会结构已涌现的科学结论**。
- Cloudflare preview/production 公网连通冒烟、真实上游 Jev 计费冒烟与生产监控仍属云端环境待执行项。
