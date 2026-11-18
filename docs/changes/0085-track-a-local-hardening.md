# 0085 — 轨道 A 本地工程硬化收口（维护巡检、指纹限流、流式导出/续跑补齐与隔离恢复演练）

- 日期：2026-11-18
- 状态：已完成（本地全门禁通过）
- 影响范围：`src/worker/`、`src/runner/`、`src/ops/backup.ts`、`bin/stratify-batch.mjs`、`scripts/verify-backup.mjs`、`test/`、`docs/`
- 规则与 Schema 影响：**无**（`rules-v15`、配置/状态 schema 与核心黄金哈希逐位不变；G6 保持未通过）

## 1. 变更摘要

按计划完成轨道 A 四项本地工程硬化，清理代码层遗留技术债：

1. **Worker 维护巡检补齐（`P4-06` / `src/worker/maintenance.ts`）**
   - 新增 `running` 状态静默超时巡检（`idleTimeoutCutoffs`，默认 browser 60 分钟、runner 720 分钟），将超期无写入的悬挂运行原子标记为 `failed`（`error_code = 'abandoned_timeout'`）；
   - 新增 R2 `runs/` 前缀分页枚举清理（`cleanOrphanR2Objects`，默认 120 分钟宽限期避开在途上传），自动删除在 D1 `artifacts` 清单中无对应记录的孤儿对象。
2. **指纹限流与标准 `Retry-After` 响应头（`P4-06` / `P4-08` / `src/worker/index.ts`、`src/worker/http.ts`）**
   - `/api/jev` 升级为 `IP + sha256(apiKey)` 前缀桶限流（D1 `rate_limits` 永不存储明文 Key），先鉴权后记账；
   - 为 run 批写端点（`ticks:batch`、`agents:batch`、`PUT artifacts`）补充按 `runId + IP` 的固定窗口频控，并在全部 `429 rate_limited` 响应统一返回 `Retry-After` 秒数头。
3. **流式 `full` 导出与 `--resume` 缺失包确定性补导出（`P5b` / `src/runner/run-cell.ts`、`upload-export.ts`、`batch-cli.ts`、`bin/stratify-batch.mjs`）**
   - 新增 `ArtifactStreamSink` 与 `createStreamingBundleWriter`：逐 tick 将 `decision-v1`、`event-v1`、`snapshot-v1` 追加至磁盘 4 MiB 滚动临时块，收尾时原子 `rename`，消除长周期 `full` 导出在 V8 堆内累积全量日志的内存峰值；
   - `runBatch` 新增 `shouldBackfillResumedTask`：当 `--resume` 搭配 `--upload-bundles` 时，自动识别缺失 `bundle.json` 的历史已完成任务，确定性重算补导出并严格核对 `finalStateHash` 与 ledger 记录一致。
4. **D1 备份本地隔离 SQLite 恢复演练（`P7` / `src/ops/backup.ts`、`scripts/verify-backup.mjs`）**
   - 新增 `rehearseD1Restore(sqlText, { r2Keys })` 与 CLI `--rehearse` 选项：在全新内存 `node:sqlite` 实例中开启外键真实执行 SQL dump，统计 7 张核心表行数并交叉核验悬挂引用与 R2 对象清单覆盖。

## 2. 边界声明

- 本次变更不触碰任何核心仿真规则或随机源地址；`G6` 保持未通过，不声称参数已校准或社会结构已涌现。
- 云端 Cloudflare preview/production 公网连通冒烟、线上 Cron 触发、真实上游 Jev 计费冒烟与云端隔离库恢复演练仍属轨道 B 待执行项。
