# 0032：P5-03 run 内进度检查点接入批跑（run-progress-v1）

- 日期：2026-11-05
- 作者：Runner 负责人
- 关联：P5-03 / P5-01（01 §8.1、G5a）、`changes/0031`、07 §5（窗口唯一算法）
- 性质：**Runner 层实现变更**；不改变规则、参数注册表、默认配置与引擎行为
  （`rules-v11`/`engine-v0.9.0`/`stratify-config-v6`/`stratify-state-v3` 不变）；
  `checkpoint-v1`（P5a-03 纯状态快照）契约原样保留，新增独立 payload 类型

## 1. 结论先行

`batch-ledger-v1`（changes/0031）把 kill 恢复做到了 **run 粒度**：kill 只损失被中断的那个
run（Stage B 1000 人 ≈ 105 s/run）。本变更把恢复粒度推进到 **tick 级**：run 内每 N 个
tick 原子落盘一个 `run-progress-v1` 检查点，kill 后从完整点继续，且恢复 run 的窗口聚合、
标签与最终状态哈希与不中断运行**逐字一致**（单测断言）。

为什么只有 `checkpoint-v1` 快照不够：07 §5 的窗口聚合依赖**全程** tick 数据
（全分辨率 stats、逐 tick 转移矩阵、逐 tick 决策计数），从 tick 1000 的快照无法重算
tick 0–999 的窗口。`run-progress-v1` = 快照 + 部分累计器，恢复时累计器原样接回。

## 2. 语义要点

- **起点歧义禁止**：`initialState` 与 `runCheckpoint` 不得同时给出（CONFIG_INVALID）。
- **恢复校验**：meta 的 `cellKey/seed/configHash` 三元组与本次 run 不匹配一律抛错
  （跨 run 污染是调用方布置错误，不得静默换起点）；**损坏按不存在处理**、从 tick 0
  确定性重跑——检查点只是 kill 恢复的加速件，事实来源是重跑本身。
- **原子性**：与 `CheckpointHost` 相同（临时文件 + fsync + rename）；`.tmp` 残留不是有效点。
- **生命周期**：run 正常结束（引擎 endReason 或到达 `totalTicks`）后移除检查点文件；
  `maxTicks` 护栏触发的异常终止保留检查点供下次恢复。
- **决策日志不重建**：恢复路径的前段 `decisions` 记录不进快照（批量摘要不消费；
  live 决策日志属 P2 管线与 P5b 上传范围）。
- **成本**：单次落盘为 O(已完成 tick) 的 JSON 序列化，`everyTicks` 建议 ≥ 100；
  `--checkpoint-ticks N` 显式开启（缺省关闭，行为与 changes/0031 一致）。
- **同步宿主**：runSingle 的 tick 循环是同步的，新增 `SyncCheckpointHost` 与
  `nodeCheckpointHostSync()`（`node:fs` 同步 API + fsync）；内存宿主修复了
  `tempPath === path` 时 set-后-delete 的自删除边界（测试 helper）。

## 3. 兼容性与实验可比性

- 引擎与规则零改动；恢复等价性由「R(seed,tick,agentId,tag,counter) 无地址状态」保证，
  并以单测固定（kill 恢复 vs 不中断对照逐字一致）。
- `run-progress-v1` 为新增本地格式，无旧产物兼容问题；`checkpoint-v1` 及其测试不变。

## 4. 验证证据

- `test/unit/runner/run-progress.test.ts` 10 项：恢复等价（报告 JSON 逐字一致 + stats/
  flows/decisionsByTick 一致）、损坏重跑一致、meta 污染抛错、磁盘写失败注入（G5a）
  响亮报错且恢复一致、护栏保留/完成移除、模块往返与校验、runBatch 集成（完成后目录清空）。
- 实机：`bin/stratify-batch.mjs --checkpoint-ticks 25` 全部任务成功，
  `run-checkpoints/` 创建并在完成后清空。
- 全套门禁：typecheck/typecheck:core/lint/format/test（615）/test:integration（4）/build 全绿。

## 5. 边界

- 异步 live 路径（`runSingleWithPolicy`）尚未接入 run 内检查点——live 决策为异步 await，
  需配合 P5-02 的共享预算与取消语义一起设计；P6-04 的 Jev 对照开工前必须补齐。
- G5a 的「预算耗尽」故障注入属 P5-02（live 共享预算），不在本变更范围。
