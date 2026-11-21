# 0062 实验基础设施审查修复（ledger/版本闸门/检查点/NDJSON/统计口径）

- 日期：2026-11-06
- 作者：徐鼎（施工代理执行）
- 关联：2026-11-05 逐提交审查结论、P5-01/02/03/04、P6-03/05、P6-04b、参数搜索
- 性质：**基础设施缺陷修复**；不改变规则、配置 schema、预注册设计或任何实验结论
- 影响范围：`src/runner/`、`scripts/p6-*.mjs`、相关单测；历史 artifact 仍可读

## 1. 断点续跑 ledger 截断（High）

**缺陷**：`runBatch` / `runBatchWithPolicy` 的 `persistLedger` 只写“当前已累积”的
`runs`。resume 时若 manifest 前面的任务再次失败，持久化会先把 ledger 覆盖成
不含后续已完成 run 的集合；live 场景会因此重复付费调用。

**修复**：新增 `ledgerRuns`（从已有 `completed` 初始化），持久化写
`[...ledgerRuns.values()]`；新 run 完成时写入 map；批次结束再无条件持久化一次。
summary 的 `runs` 仍按任务/完成顺序累积，不改变对外摘要语义。

**回归测试**：`batch-cli.test.ts` / `batch-live.test.ts` 各新增
“早期任务再次失败不会抹掉已完成 run”；临时复现用例在修复前确认
`ledger.runs` 从 1 变 0。

## 2. 实验脚本版本闸门（High）

**缺陷**：`p6-search`、`p6-05-cluster`、`p6-04b-formal` 的设计硬编码
`rules-v11`/`rules-v12`，但 `runOne` 用当前 `RULES_VERSION` 建配置；
`loadPrereg` 只校验设计哈希，不校验代码版本。部署 rules-v12 后继续跑 v11
预注册会静默混版本。

**修复**：`preregistration.ts` 新增 `assertFrozenVersions(expected)`（rulesVersion/
engineVersion 存在才校验，兼容只记录 rulesVersion 的历史 manifest）。
脚本在 **run/validate-run** 路径调用；`analyze` 不调用，保证历史产物可在新代码上
离线复算。搜索验证必须在 rules-v11 快照上完成，这是守卫的预期行为。

## 3. 进度检查点覆盖校验（Medium）

**缺陷**：`parseProgress` 只拒绝 `stats.length > tickCompleted`，截断的
stats/flows/decisions 会被当作有效检查点，恢复后的窗口均值与不中断运行不一致。

**修复**：三组累计器都必须恰好覆盖 `0..tickCompleted-1`（长度相等且
`entries[i].tick === i`）；中间行损坏仍按损坏处理。测试改用
`completeProgress()` 构造生产形态的最小合法行。

## 4. 容错 NDJSON 读取（Medium）

**缺陷**：实验脚本逐行 `JSON.parse`，kill 留下的末尾半行会让整个 shard 无法恢复。

**修复**：新增 `src/runner/ndjson.ts` 的 `readNdjsonTolerant`：只容忍文件末尾
半行（中间行损坏仍抛错）；`repairTail=true` 时截断残行，避免后续 append 粘行。
`p6-05-cluster`、`p6-search`、`p6-04b-formal` 的 ledger/analyze 读取全部接入。
新增 5 项单测。

## 5. 统计与基线口径（Medium/Low）

- **最近秩分位**：新增 `nearestRankPercentile`（`rank=ceil(p*n)`），替换
  `floor(p*n)` 的 0-based 下标；修复 `p*n` 为整数时多取一位（如 120 对
  D95 取第 115 个而非第 114 个）。`p6-live-comparison`、`p6-analysis`、
  `p6-perturbation` 共用。
- **ARI median**：`p6-05-cluster` 与 `p6-search` 改用共享 `median()`（偶数个
  取中间两值平均），不再取上中位数。
- **baseConfig**：`buildCellConfig` 接受可选的实验级 base；`buildBatchTasks`
  传入 `resolveBatchBaseConfig`，使 ledger 的 `baseConfigHash` 与实际运行基线一致
  （此前非人口字段被静默忽略）。

## 6. 微扰与 ledger 校验（Low）

- `applyWealthPerturbation` 在任一存活者 `value + delta < 0` 时拒绝，避免把
  违反“财富不得为负”的状态带入续跑。
- `assertRunRecord` 深校验 `report.windows`（非空、label、start/end/observed/
  missing、classShares）与 `labelsByWindow`（字符串数组），防止空窗口 ledger
  被当作完成 run 复用。

## 7. 兼容性与边界

- 规则版本、config schema、参数注册表、预注册哈希、golden 均未改变。
- 旧 ledger/checkpoint/artifact 的读取路径保持；更严格的校验只拒绝结构损坏的
  记录，不改变合法历史数据。
- 搜索粗筛正在 VPS 的 rules-v11 快照上运行；**验证阶段必须继续使用同一快照**，
  版本闸门会阻止在 rules-v12 代码上误跑 v11 验证。
- 本变更不构成任何 P6 实验结论或校准声明。

## 8. 验证

- 定向：`batch-cli`、`batch-live`、`run-progress`、`run-progress-live`、
  `ndjson`、`p6-live-comparison`、`perturbation`、`preregistration` 全部通过。
- 全量门禁：`pnpm typecheck && pnpm lint && pnpm test && pnpm check:docs`
  （结果见提交说明；若 CI 未通过不得标记完成）。
