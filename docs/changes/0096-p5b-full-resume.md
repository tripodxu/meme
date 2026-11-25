# 0096 P5b 流式 full 导出支持 run 检查点续跑（2026-11-20）

> 状态：工程能力补强；不改规则、schema 或科学判据。

## 0. 问题

`runSingle` 此前禁止 `artifactSink` 与 `runCheckpoint` 同时启用，因此 `full`
profile 的长 run 一旦被 kill 只能从头重跑；若强行续跑，流式写出器会新建分块，
丢掉断点之前的 decisions/events/snapshots，bundle 不可回放。

## 1. 变更

### 1.1 流式写出器可续写（`src/runner/upload-export.ts`）

- `createStreamingBundleWriter` 新增 `resume` 与 `chunkBytes` 选项。
- 首次创建时写 `full-export.json`（`upload-full-export-v1`：runId、cellKey、
  seed、configHash、chunkBytes），并清理同目录旧分块。
- `resume=true` 时校验 `full-export.json` 与当前任务一致，扫描
  `decisions|events|snapshot-N.ndjson[.stream.tmp]`：
  - 分块序号必须从 0 连续；kill 造成的半行按最后一个换行截断修复；
  - 未封口的最后一个分块继续追加，更早的 `.tmp` 视为已封口并改名为正式分块；
  - 已存在的分块全部计入最终 bundle 的 artifact 清单。
- 初始 snapshot 分块缺失时拒绝 resume（无法重建可回放起点）；decisions/events
  允许为空（例如断点在 tick 0），由独立验证器兜底。
- `abort()` 保留已写分块与 `full-export.json` 供续跑，只删除可能残留的
  `bundle.json` 与零字节临时文件。

### 1.2 run-cell 与批跑接线

- `runSingle` 仅保留「内存模式 `captureArtifacts` 不能与 checkpoint 同用」的限制；
  流式 `artifactSink` + `runCheckpoint` 获准。
- `runBatch` 的 `createArtifactSink` 增加 `{ resume }` 上下文：按
  `run-checkpoints/run-<index>.progress.json` 是否存在决定续写还是重写；
  已完成任务的确定性补导出固定 `resume=false`。
- `bin/stratify-batch.mjs` 将 `resume` 透传给流式写出器。

## 2. 测试

- 新增用例：10 tick、决策间隔 2、128 字节分块；先跑到 tick 4 并留下检查点，
  模拟 kill（不 finalize/abort），再以 `resume=true` 续跑到 tick 10；
  `verifyUploadBundle` 返回 `verified`，`replayFinalStateHash` 与完整运行一致。
- 全套 921 项测试通过，核心分支覆盖 95.18%；无 schema 迁移。

## 3. 边界

- 只影响流式 `full` 导出；`metrics-only` 与既有 bundle 格式不变。
- 续跑可能多写一个断点 tick 的 snapshot；独立验证器按初始/最终/周期覆盖校验，
  不要求快照只在固定 stride 上。
- 仍属工程证据，不构成科学验收。
