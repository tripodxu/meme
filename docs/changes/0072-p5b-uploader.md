# 0072 P5b 上传器与断点续传

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：changes/0071（P4 Worker）、docs/05 §4.3–§4.6、docs/guides/upload.md
- 性质：工程交付；不改规则、参数、schema 或实验结论
- 影响范围：`src/runner/uploader.ts`、`src/runner/upload-bundle.ts`、`scripts/upload-run.mjs`、测试与文档

## 1. 交付

### P5-05 上传器

- `run-upload-bundle-v1` → Worker：创建 run、artifact 分块 PUT、tick/agent 批次、complete。
- artifact 在本地 gzip 后计算压缩/未压缩 SHA-256；服务器复算压缩 hash，返回不一致即终止。
- `metrics.ndjson` 提供 tick 行；上传器按 config 重算计划 stats 序列，覆盖不全在本地拒绝。
- `agents` 必须与 `finalAliveCount` 一致；agent/tick 批次按服务器主键幂等。
- complete 的 `expectedTickRows`/`expectedAgentRows` 由上传器从实际行数计算，
  不信任调用方声明；`artifactManifestHash` 由已确认块清单重算。
- 409 与不可重试 4xx 终止；429/5xx/网络错误按指数退避重试（默认 3 次）。
- 创建 run 时网络失败标记 `create_ambiguous`，不自动重试，避免复制实验。
- Key/token 只进 Authorization header；测试断言 token 不出现在 URL。

### P5-07 上传确认落盘与断网续传

- `upload-ledger-v1` 记录 `baseUrl`、bundleHash、runId、writeToken、逐块压缩/未压缩
  hash、字节数与确认时间；每次确认后 `writeTemp + promote` 原子替换。
- 重跑同一 bundle/ledger：跳过 hash 相同的已确认块；若 run 已 complete 且 summary
  相同，直接返回 `duplicateComplete=true`。
- bundle 或 baseUrl 改变时拒绝复用 ledger（`ledger_mismatch`），避免把新实验传到旧 run。
- ledger 损坏/未知版本不当作恢复点，直接报错。

### CLI

- `scripts/upload-run.mjs` + `pnpm upload`：加载 `run-upload-bundle-file-v1`，
  路径引用限制在 bundle 目录内；`RUNNER_TOKEN` 只从环境变量读取。
- `src/runner/upload-bundle.ts`：相对路径 artifact/agent 加载器，拒绝 `..` 逃逸。

## 2. 验证

- `test/unit/runner/uploader.test.ts` 7 项：真实 Hono Worker（node:sqlite + 内存 R2）
  完整上传/complete、同 ledger 重跑不新建 run、单块网络失败重试、bundle 改变拒绝
  ledger、本地行数/存活数/kind 校验、plannedStatsTicks 口径、创建失败不重试。
- `test/unit/runner/upload-bundle.test.ts` 3 项：相对路径加载、`..` 逃逸与缺失文件拒绝、
  未知 schemaVersion 拒绝。
- `pnpm build` 后 `node scripts/upload-run.mjs --help` 可运行。

## 3. 未完成 / 边界

- `pnpm batch` 尚未自动产出上传 bundle；需要上游导出器或手工准备 artifact 目录。
- 未执行真实 Cloudflare preview/workerd + D1/R2 集成冒烟（P4-07）。
- 上传成功只表示 `verificationStatus=uploaded`；独立验证器、内容 hash 复核与回放
  验证仍属后续工作。
- 未改 `rulesVersion`、`schemaVersion`、`promptVersion`；不构成校准或结构证据。
