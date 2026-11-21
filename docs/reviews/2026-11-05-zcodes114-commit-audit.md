# 2026-11-05 zcodes11.4 逐提交审查

- 审查范围：`main..zcodes11.4` 的 24 个提交（不含生成物逐行展开）。
- 审查对象：`src/runner/*`、`src/decision/live.ts`、`src/core/hash/*`、`scripts/p6-stage-a.mjs`、`scripts/p6-stage-b.mjs`、`bin/stratify-batch.mjs`、`deploy/*`、关键测试与文档声明。
- 未逐行展开：`out/*.json`（约 45 万行生成物）；未运行 integration/e2e；单测 668 项当时全绿。
- 结论：**工程骨架可保留，但实验漏斗在 Stage A 已不合规；Stage B 的 0/3 只是下游症状。**

## 1. 阻断级发现

### 1.1 Stage A 用「任意指标」筛选，候选集本身不合规

`scripts/p6-stage-a.mjs`：

- `thresholdHit` 对 tv/gini/mUp/segregation/openness 做「或」（约 348–353 行）；
- `directionOk` 取各指标方向一致率的最大值（约 341–347 行），与「哪个指标超门槛」解耦；
- 阈值是脚本内硬编码 `THRESHOLDS`（197 行），不读 `manifest.differenceThresholds`；
- `screenedIn = thresholdHit && directionOk`，没有 `paired === 30`、`totals.failed === 0` 的完整性校验；
- `preregistrationHash` 当场重算（374 行），不读取冻结文件校验。

按 07 主指标 TV(P) ≥ 0.10 复核已入库的 `out/p6-stageA-analysis.json`，**12 个入选对只有 1 个达标**：

| 人口 | cell              | TV(P)  | ≥0.10  | 实际触发指标 |
| ---- | ----------------- | ------ | ------ | ------------ |
| 40   | psi=1             | 0.0838 | 否     | mUp 0.107    |
| 40   | env0=compressed   | 0.0573 | 否     | mUp 0.150    |
| 40   | env0=expanded     | 0.0766 | 否     | mUp −0.365   |
| 40   | crossDays=half    | 0.0124 | 否     | mUp 0.080    |
| 40   | crossDays=double  | 0.0123 | 否     | mUp −0.187   |
| 200  | psi=1             | 0.0906 | 否     | mUp 0.139    |
| 200  | needMult=steep    | 0.0193 | 否     | mUp 0.058    |
| 200  | needThreshold=0.9 | 0.1683 | **是** | TV 自身      |
| 200  | env0=compressed   | 0.0560 | 否     | mUp 0.208    |
| 200  | env0=expanded     | 0.0713 | 否     | mUp −0.378   |
| 200  | crossDays=half    | 0.0066 | 否     | mUp 0.114    |
| 200  | crossDays=double  | 0.0046 | 否     | mUp −0.257   |

后果：Stage B 的 6 个候选里，5 个不是按主指标选出的。若强调 Stage B 的 07 严格口径，必须同样回溯到 Stage A；不能筛选用宽松、确认用严格。按现有数据重算，合格候选约只剩 `needThreshold=0.9`（200 人）。

### 1.2 P5-04 微扰：数组字段不可用

`src/runner/perturbation.ts`：

- `resolveNumericField` 只按 `.` 拆分，不解析 `[i]`；`setLeafPath` 与 `diffLeafPaths` 使用 `[i]`。
- 对 `ascent.crossDays`、`need.needMultiplier`、`lifespan.decay` 这类数组字段：整体替换会被 changedPaths 审计拒绝；带下标则解析阶段找不到路径。
- 这些恰是 P6 的主导参数，P5-04 对确认轮最关键的参数不可用。

### 1.3 P5-04 微扰：首次偏离漏判提前结束

`firstDivergenceTick` 只比较 `min(baselineStats.length, treatmentStats.length)`（约 224–237 行）。若 treatment 提前灭绝/结束、公共前缀相同，返回 `null`（全程一致），把最严重的偏离报告成无偏离。

### 1.4 ledger 哈希不含 baseConfig

`computeBatchManifestHash` 只哈希 manifest（`batch-cli.ts:140`）；`buildBatchTasks(manifest, baseConfig)` 却使用 `baseConfig`。两份 baseConfig 不同但 manifest 相同的批跑会命中同一 ledger，按 `(cellKey, seed)` 复用错误记录。P6 的 `--population` 正走这条路径。

### 1.5 live 检查点没有接入批跑

`batch-live.ts` 无任何 `runCheckpoint` 引用。`runSingleWithPolicy` 已支持，但 `runBatchWithPolicy` 未透传，提交 b15346e 声称的「live run 内进度检查点」在主执行器上不可用。

## 2. 高危发现

1. `BatchWithPolicyOptions.budget` 可选，注释明确「不提供则不做批级预算拦截」，违反 AGENTS #8；`requestedModel ?? 'mock'` 会把真实 Jev run 记成 mock。
2. `RateLimiter.defaultSleep` 正常计时结束不移除 abort 监听器；长批次对同一 signal 累积监听器。
3. `run-progress.ts`：`parseProgress` 只检查数组，元素 `as unknown as`；不校验 `meta.tickCompleted === state.society.tick`；异步加载读同一文件两次。
4. `runPerturbationPair` 未校验 `maxTicks > checkpointTick`；`restoreSnapshot(snapshot)` 后未断言哈希等于 `checkpointStateHash`。
5. `preregistration.ts` 把 `warmupTicks`/`warmupDiagnostic` 从字面量联合放宽为 `number`/`string`，拆掉预注册的编译期闸门。
6. Stage A `w1` 窗口 `end=1094` 超出 730 tick 运行；元数据与「观测段 [365,729]」不一致。
7. `elapsedMs` 文档称 resumed 计 0，实现把复用记录的原耗时也算进去。
8. `bin/stratify-batch.mjs` 只检查 dist 存在，不检查新鲜度。
9. Stage B 旧判读（e6db218/9890337/f7d0fcd/0f2ad20）用任意指标/窗口与 `[min,max]` 冒充 95% 区间；f76b813 已修正，但 Stage A 漏斗未修。
10. f7d0fcd 遗留的 `c1206246` vs `83a1d58a` 预注册哈希差异仍未裁决。
11. f76b813 的 TV(P) 方向一致率恒为 1.00（TV 为非负距离），方向条件对主指标是真空真；当前结论不受影响（门槛未达），但应标 N/A 或改用分量方向。

## 3. 中低发现

- ledger 单文件全量重写 O(N²)；重复 `(cellKey, seed)` 记录未拒绝；`report` 只校验为对象。
- `batch-live` 停止后未启动任务按技术失败记 attempt，口径易误导。
- `batchUsage` 用 `instanceof SharedBatchBudget` 判定，其他 `JevBudget` 实现的用量被丢弃。
- 生成物约 45 万行入库，虽在白名单/体积限制内，仓库显著过重。
- `newLocalRunId` 注释仍写 `Math.random`，代码实际用 `crypto.randomBytes`。
- Stage A `--slim` 未出现在用法提示中。

## 4. 逐提交速览

| 提交组                                                | 结论                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| c12eb71 / 914c90e / fc6ad35（P5-01）                  | 执行器可靠（原子 ledger、失败保留、退出码清晰）；baseConfig 漏进哈希、elapsedMs 注释矛盾、CLI 不校验 dist |
| 6ea4684（P5-03）                                      | 断点续跑主链路可用；检查点校验弱、双读、O(N²) 写                                                          |
| 4c8ce57（P5-04）                                      | 配对设计正确；数组字段不可用、首次偏离漏判、护栏可空跑                                                    |
| a2185d4（P5-06）                                      | systemd/磁盘守卫基本合格，未见阻断问题                                                                    |
| 01233f7（P5-02）                                      | 共享预算与限流方向正确；预算可选、模型默认 mock、监听器泄漏、live 检查点未接线                            |
| 3762237（人口实验级化）                               | 功能可用；baseConfig 与 ledger 哈希缺口被放大                                                             |
| 22c9c3d / c63774c（Stage A）                          | **根因：任意指标筛选，12 个入选对仅 1 个满足主指标**                                                      |
| 3f2529f（Stage B 基础设施）                           | manifest 结构完整；hypothesis 的「或其他指标」与 07 冲突，warmup 类型放宽                                 |
| b15346e（live 检查点）                                | 纯函数与单测在；批跑执行器未接入                                                                          |
| 1a95da4（D-04 v2）                                    | 预算重冻结记录合理                                                                                        |
| e6db218 / 9890337 / f7d0fcd / 0f2ad20（Stage B 结果） | 判读逻辑与 07 不符；f76b813 已改判，候选集仍受 Stage A 污染                                               |
| f76b813（本次修正）                                   | Stage B 判读已修正；Stage A 未触及                                                                        |

## 5. 建议顺序

1. 用现有 Stage A 数据按 TV(P) 重算筛选，重定 Stage B 候选集（约只剩 needThreshold=0.9@200）。
2. 修 P5-04：数组路径、首次偏离长度、maxTicks 护栏、快照哈希断言。
3. ledger 加入 baseConfig 哈希；live 检查点接线；预算与模型元数据强制。
4. 检查点 meta/tick 交叉校验与元素结构校验。
5. 之后再谈 P6-02 及后续；剩余 Stage B 单元在候选集重定前只能标 exploratory。

## 6. 本次优化落地

- P5-04：数组下标字段（如 `ascent.crossDays[0]`）、首次偏离的一侧提前结束、`maxTicks` 护栏、检查点快照 round-trip 哈希断言已修复；新增 5 项测试，perturbation 单测 15 项通过。
- 其余 P0/P1（Stage A 主指标重算、`baseConfig` 入 ledger 哈希、live 检查点接线、检查点 meta/tick 交叉校验、限流监听器清理）按第 5 节顺序继续。
