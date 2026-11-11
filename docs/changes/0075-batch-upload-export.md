# 0075 批跑自动导出上传 bundle

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：changes/0072/0073/0074、docs/guides/upload.md、docs/05 §4.6
- 性质：工程交付；不改规则、参数、schema 或实验结论
- 影响范围：`src/runner/upload-export.ts`、`src/runner/batch-cli.ts`、`bin/stratify-batch.mjs`、测试与文档

## 1. 交付

- 新增 `writeUploadBundle`：把 `runSingle` 的 `RunOutcome` 导出为
  `run-upload-bundle-file-v1`（仅 `metrics-only`）：
  - `metrics.ndjson`：全分辨率 tick 行（含 `top10Share`、`eByClass`、flow matrix
    等窗口字段），每行带 `schemaVersion/runId/payloadHash`；
  - `final-state.ndjson`：`final-state-v1` + 完整最终状态；
  - `agents.json`：最终个体行（与 Worker `agents:batch` 同字段，含 payloadHash）；
  - `bundle.json`：config/identity/seed/最终 tick/存活数/`expectedDueDecisions`/
    `finalStateHash`/`summaryHash`/artifact 引用。
  - 文件先写 `.tmp` 再 rename；输出目录按 `<cellKey>-<seed>` 清洗路径字符。
- `runBatch` 新增可选 `onRunComplete` 回调；回调抛错按该任务技术失败处理，
  不写 ledger 成功记录，避免上传半个 bundle。
- `bin/stratify-batch.mjs` 新增 `--upload-bundles <dir>`：每个成功 run 自动导出，
  打印 `runtimeVersion`（当前 `process.version`）；`codeSha` 可取
  `STRATIFY_CODE_SHA`，缺省 `local-batch`。
- 只导出 metrics-only：`full` profile 所需的 decisions/events/snapshot 未被
  `runSingle` 保留，不能在这里假装可回放。

## 2. 验证

- `test/unit/runner/upload-export.test.ts` 3 项：
  1. 20 tick demo run 导出 → `loadUploadBundle` → 上传到真实 Hono Worker
     （node:sqlite + 内存 R2）→ complete；run 详情 `tickRows=3`、`agentRows=40`、
     `runtimeAuthority=authoritative`；
  2. metrics 20 行、含完整字段与 `sha256` payloadHash；路径字符清洗；
  3. extinct run 的 `endReason/finalTick` 与 complete 规则一致。
- 批跑 CLI 冒烟（本地）：
  `node bin/stratify-batch.mjs manifest.json --out out --upload-bundles bundles`
  → 2/2 完成、0 失败，生成两个 bundle 目录。
- 本地上传冒烟：`upload-run.mjs bundles/baseline-batch-smoke-1/bundle.json`
  → `run_5584186953cb342006da0917` completed（2 chunks）；重跑同 ledger 返回
  `chunksSkipped=2, duplicateComplete=true`，未新建 run。

## 3. 未完成 / 边界

- 仍未导出 `artifactProfile=full`（decisions/events/snapshot）；需要批跑层保留
  全量事件和周期快照后才能实现。
- 未在 preview/production 执行批跑导出与上传；本冒烟仅本机 workerd。
- 未实现自动 `complete` 前的压缩/未压缩内容复核与独立验证器。
- 不改 `rulesVersion`、`schemaVersion`、`promptVersion`；不构成校准或结构证据。
