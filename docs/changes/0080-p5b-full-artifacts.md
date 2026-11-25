# 0080 P5b full profile 上传 artifact

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：docs/05 §4.5–§4.6、changes/0072/0075
- 性质：工程交付；不改规则、参数、schema 或实验结论
- 影响范围：`src/runner/run-cell.ts`、`src/runner/upload-export.ts`、`src/runner/batch-cli.ts`、CLI、测试与文档

## 1. 交付

- `runSingle` / `runSingleWithPolicy` 新增可选 `captureArtifacts`：
  - 收集全部 `TickEvent`、每 tick `ExecutionRecord` 与周期快照（`snapshotStride`，
    缺省 `config.schedule.snapshotStride`）；
  - 结束时确保 final snapshot 存在；
  - `captureArtifacts` 与 `runCheckpoint` 禁止组合（恢复段缺少 events/snapshots），
    本地直接报配置错误，不产生半套 full artifact。
- `writeUploadBundle` 支持 `artifactProfile='full'`：
  - `decision-v1`：一行一次到期决策，关联同 tick/agent 的 execution；已结算 tick
    的 `execution` 非 null、`tickSettled=true`；未结算才写 null/false；
  - `event-v1`：一行一事件；
  - `snapshot-v1`：一行一个完整快照 + stateHash（含 initial/final）；
  - decisions/events/snapshot 按未压缩 4 MiB 分块，避免触及 Worker 单块 8 MiB 上限；
  - 缺少 capture 数据时本地抛错，不伪造可回放。
- `bin/stratify-batch.mjs` 新增：
  - `--artifact-profile metrics-only|full`（full 必须与 `--upload-bundles` 同用）；
  - `--snapshot-stride N`；
  - full 与 `--checkpoint-ticks` 同时给出时提前退出 2。

## 2. 验证

- `test/unit/runner/upload-export.test.ts` 新增 full 用例：20 tick demo 捕获
  events/snapshots，导出 5 类 artifact，decision 行 `tickSettled=true` 且有
  execution；上传到真实 Hono Worker（full profile）并 complete 成功。
- 批跑 CLI 冒烟：`--upload-bundles ... --artifact-profile full` 2/2 完成，
  生成 metrics/final-state/decisions/events/snapshot 文件。
- 本地上传冒烟：full bundle → workerd（本地 D1/R2）`run_894fccc8653d9f6613b95c23`
  completed，5 chunks，0 skipped。

## 3. 未完成 / 边界

- full 捕获会显著增加内存（events + 每 tick executions + 周期快照）；长 run 需
  评估内存，暂未分块写盘。
- `--resume` 复用的已完成 run 不会重新触发 `onRunComplete`，不会补生成 bundle；
  full 导出应使用新输出目录或上游单独导出。
- 未在 preview/production 执行 full 上传；未做独立验证器/回放验证。
- 不改 `rulesVersion`/`schemaVersion`/`promptVersion`；不构成校准或结构证据。
