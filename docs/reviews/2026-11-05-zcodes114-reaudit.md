# zcodes11.4 全提交复审（2026-11-05，第二轮）

- 范围：`main..zcodes11.4`，merge-base `95aa936`，共 **37 个提交**，HEAD `3cea946`。
- 方法：逐提交 `git show`/累计 diff 审查；核对测试、产物哈希、当前门禁；对关键门禁做反例复现。
- 结论先行：**分支主体可用，P6-01 的 1 个确认（needThreshold=0.9）在现有产物下成立**；没有发现需要撤回该确认的现有数据问题。但存在 1 个可导致“假确认”的门禁缺口、若干证据链/运维缺口，以及 2 个历史提交的结论已被 changes/0042 取代、不得再引用。
- **修复状态（2026-11-05）**：三个 High 项已修复并重算分析（changes/0047）；Medium/Low 项仍待处理。

## 1. 当前门禁与证据复核

| 项                                                  | 结果                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                         | 702/702 通过（60 文件）                                                                                                                                                   |
| `pnpm test:integration`                             | 4/4 通过                                                                                                                                                                  |
| `pnpm typecheck` / `lint` / `check:docs` / `format` | 全通过                                                                                                                                                                    |
| `pnpm test:coverage:runner`                         | statements 95.37%（门槛 95）、branches 84.05%（门槛 78）                                                                                                                  |
| artifacts 登记哈希                                  | 25/25 文件存在且 sha256 前缀匹配                                                                                                                                          |
| Stage A 严格候选                                    | 3 个：needThreshold=0.3@40、0.9@40、0.9@200                                                                                                                               |
| Stage B 六单元                                      | 全部 60/60、0 灭绝、w2b/w3 `missingTicks=0`、`minEndTick=3649`                                                                                                            |
| Stage B 判定                                        | 仅 `needThreshold=0.9` 确认（TV 0.1553，CI [0.1494,0.1587]）；其余 5 个未确认                                                                                             |
| 预注册哈希                                          | Stage B 六单元文件内哈希与重算一致；但 `changes/0039` 冻结表 `crossDays=half` 仍写 `c1206246`，实际产物为 `83a1d58a`，差异**仍未关闭**（changes/0041 §2、artifacts 登记） |

## 2. 分级发现

### High：Stage B/A 完整性门禁忽略 `missingTicks`，可产生假确认（已修，changes/0047）

`src/runner/p6-analysis.ts:369-378`（Stage B）与 `:577-586`（Stage A）只把“窗口对象不存在”计为 `missingWindow`，没有检查 `WindowSummary.missingTicks/observedTicks`。`windowIsFinite` 也不检查缺失日。

已复现：构造 30 对 baseline/candidate，`w2b.missingTicks=100, observedTicks=630`、TV=0.20，`evaluateStageB` 返回 `confirmed=true, complete=true`。因此任何被 `maxTicks` 护栏截断、但未标记 extinct 的 run，都可能以部分窗口通过“60/60 + 完整窗口”的确认门禁。

现有六单元产物 `w2bMaxMissing=0`、`w2bMinObserved=730`，所以**当前判定不受影响**；这是门禁的潜在失效，不是已发生的错判。

修复建议：Stage B 要求 `missingTicks === 0` 且 `observedTicks === 730`（w2b/w3）；Stage A 的 w1 是有意部分观测（[365,729]），至少要求 `observedTicks === 365` 并把 `missingTicks` 写入判定产物。补一个 `missingTicks>0 → confirmed=false` 的回归测试。

### High：部署脚本不可执行，systemd 批次会直接失败（已修，changes/0047）

`deploy/check-disk-space.sh` 在 git 中是 `100644`（`git ls-files -s`），但 unit 的 `ExecStartPre` 直接执行它（`deploy/stratify-runner.service`）。安装后没有 `chmod +x` 步骤，systemd 会以 “Permission denied” 拒绝启动。P5-06 的静态测试只检查 unit 文本，未检查文件模式。

修复：`chmod +x` 入库（`100755`），并在 `deploy/README.md` 安装步骤加 `install -m 755`；测试增加模式断言。

### Medium-High：live 批跑的 ledger/summary 不绑定模型与策略版本（已修，changes/0048）

`BatchRunRecord` 只有 `cellKey/seed/configHash/paramsHash/report/elapsedMs`（`src/runner/batch-cli.ts:35-42`）；`runBatchWithPolicy` 的 summary 仍写 `manifest.policy`（`mock-weighted-v1`），不记录 `requestedModel`、`promptStyle` 或实际 policyVersion。live 断点续跑会复用旧 run，即使调用方换了模型；summary 仍标 mock。P6-04 的 Jev/mock 对照会因此丢失关键 provenance。

修复：ledger 增加 `requestedModel/promptStyle/policyVersion`（可选字段用于兼容），恢复时与本次调用比对；summary 增加 live 元数据；测试覆盖“换模型拒绝恢复”。

### Medium：`requireBudget` 是 opt-in，live 缺省仍可无预算运行（已修，changes/0048）

`src/runner/batch-live.ts:135-140` 只有 `requireBudget === true` 才拒绝缺预算。注释称“live 必须提供”，但 API 默认允许无预算。调用方漏传即可绕过 04 §7。

修复：默认 `true`（或要求 policyFactory 声明 live 时强制），并让 CLI 显式传预算；测试改为“缺预算默认拒绝”。

### Medium：ledger 的 run 记录只做浅校验（已修，changes/0048）

`assertRunRecord`（`src/runner/batch-cli.ts:150-172`）只要求 `report` 是对象；不校验 `windows/finalStateHash/extinct/endTick`，也不把 `configHash/paramsHash` 与当前 task 的配置重算结果比对。损坏或被手工修改的 ledger 可注入任意报告并被当作已完成 run 复用。

修复：补 report 必需字段校验；恢复时对每个 run 重算 `computeConfigHash(task.config)`/`computeParamsHash` 并比对。

### Medium：CLI 在 `process.stdout.write` 后立即 `process.exit`，管道输出可能被截断（已修，changes/0048）

`bin/stratify-batch.mjs:215-230` 先写几 MB 的 summary JSON 到 stdout，再 `process.exit(...)`。在管道/重定向下 Node 的 stdout 写入是异步的，立即退出可能截断尾部 JSON，破坏“stdout 纯 JSON”契约。

修复：改为 `process.exitCode = ...` 并自然返回，或用 `process.stdout.write(text, () => process.exit(code))`。

### Medium：分析脚本在预注册哈希不一致时仍输出判定（已修，changes/0048）

`scripts/p6-stage-a.mjs` 的 `analyzeStrict` 与 `scripts/p6-stage-b.mjs` 的 `analyze` 都只是把 `preregistrationHashConsistent` 写进产物，仍继续输出 `confirmed/screenedIn`。如果 manifest 与产物来自不同设计，读到的“确认”没有证据链意义。

修复：不一致时 `process.exit(2)`，不写判定产物（或写 `refused` 记录）。

### Medium：微扰 `param` 字段校验只禁止 `population.*`（已修，changes/0048）

`src/runner/perturbation.ts` 的 `resolveNumericField` 只拒绝 `population.*`，仍接受 `schedule.totalTicks`、`schedule.statsStride`、`schedule.snapshotStride`、`decision.topK` 等。它们改变视野/采样/决策数，不是模型参数；作为“param 微扰”会产生不可比的对照。

修复：白名单允许的模型参数命名空间（need/opportunity/ascent/lifespan/network/…），显式拒绝 schedule/decision/population。

### Low/Medium：Stage B slim 与 summary 两条分析路径对 segregation 的处理不一致（已修，changes/0048）

`scripts/p6-stage-b.mjs:170-176` 在 summary 路径把 `networkEmpty` 的 `segregation` 置 null；`slimOne`（`:233-247`）直接原样保存。因此同一 run 用 slim 或 summary 分析，次要指标 S 的结果可能不同。TV 主指标不受影响，但违背“产物可互换”的证据一致性。

修复：`slimOne` 复用同一个 `windowOf` 转换，或让 `evaluateStageB` 统一按 `networkEmpty` 归一。

### Low

> 修复状态（2026-11-05）：以下 Low 项已修（changes/0049）。

- `src/runner/preregistration.ts:114` 把 `warmupDiagnostic` 从两值联合类型放宽为 `string`，失去预注册诊断文本的编译期约束。
- `src/runner/batch-live.ts:36` 注释仍写 runId 尾部用 `Math.random`，实际用 `randomBytes`（标识符熵，允许）。
- `scripts/p6-stage-a.mjs --analyze` 的旧“任意指标”判读仍可运行并写 `p6-stageA-analysis.json`；文档已标历史口径，但无运行时警告，仍有误用风险。
- `protocolConflict` 用 hypothesis 子串 `'或其他预注册指标'` 检测，脆弱；应改为 manifest 显式协议字段。
- `changes/0039` 冻结表 `crossDays=half` 为 `c1206246`，实际预注册/分析产物为 `83a1d58a`，两者不一致；当前产物内部自洽，但冻结记录未关闭（changes/0041 §2、artifacts 仍标“待裁决”）。应追加一条关闭记录，说明为何以实际产物为准、冻结表为何写错；不得静默改历史条目。
- `changes/0041` 的旧差异记录本身不是错误，错误的是把它当作“已过期”：它仍准确描述了冻结表与产物的冲突。

## 3. 提交逐一结论

| 提交                                               | 结论                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `c12eb71` P5-01a batch-cli                         | 可用；ledger 浅校验、O(N²) 写已知                                         |
| `914c90e` P5-01b CLI                               | 可用；stdout/exit 截断风险                                                |
| `fc6ad35` P5-01c 自审查修复                        | 通过：失败保留、原子报告、退出码                                          |
| `90c7121` P5-01 收口文档                           | 文档一致                                                                  |
| `6ea4684` P5-03 run-progress                       | 设计正确；与 `p6-analysis` 的 missingTicks 缺口需联动修复                 |
| `9a6a60e` P5-03 文档                               | 文档一致                                                                  |
| `4c8ce57` P5-04 perturbation                       | 主路径正确；param 字段白名单过宽                                          |
| `d8f86bb` P5-04 文档                               | 文档一致                                                                  |
| `a2185d4` P5-06 deploy                             | 内容正确；脚本权限 100644 是阻断项                                        |
| `e72a72f` P5-06 文档                               | 文档一致                                                                  |
| `01233f7` P5-02 预算/限流/live                     | 可用；requireBudget/provenance 需补                                       |
| `75f339b` P5-02 文档                               | 文档一致                                                                  |
| `3762237` `--population`                           | 通过：人口实验级化                                                        |
| `1ab68d3` D-04 v1 文档                             | 文档一致                                                                  |
| `22c9c3d` Stage A 构建器                           | 通过：14 cell × 30 种子、哈希冻结                                         |
| `c63774c` Stage A 执行                             | 数据产物；严格重算已由 `7637afe` 覆盖                                     |
| `3f2529f` Stage B 基础设施                         | 通过：6 个 manifest 冻结                                                  |
| `b15346e` live 检查点                              | 可用；缺 snapshot config 校验（见下）                                     |
| `1a95da4` D-04 v2                                  | 文档与预算一致                                                            |
| `e6db218` env0=expanded “确认”                     | **已被 changes/0042 取代，不得引用**                                      |
| `9890337` env0=compressed “确认”                   | **已被 changes/0042 取代，不得引用**                                      |
| `f7d0fcd` crossDays=half 未确认                    | 通过：诚实负结果                                                          |
| `0f2ad20` Stage B 证据链收口                       | 大部分有效；crossDays-half 哈希待办已过期                                 |
| `f76b813` Stage B 严格重算                         | 通过：TV 主指标纠正，关键修复                                             |
| `ee9548b` 审查 + P5-04 修复                        | 通过：数组字段/首次偏离/快照哈希                                          |
| `46f96f2` RateLimiter 清理                         | 通过：abort 监听器释放                                                    |
| `7637afe` Stage A 严格 + Stage B 判定              | 通过；missingTicks/哈希一致性门禁需补                                     |
| `e7ac2a3` 恢复计划状态                             | 文档一致                                                                  |
| `6e9fc0a` runner 加固                              | 通过：tick 交叉校验、baseConfigHash、warmup 类型；requireBudget 仍 opt-in |
| `a8a1ff8` / `3802a55` / `3befc08` / `a8c4708` 文档 | 文档一致                                                                  |
| `469c7ac` P6-02 factorial                          | 通过：32 cell、独立种子、预算进哈希                                       |
| `ada0d4e` 哈希敏感性测试                           | 通过                                                                      |
| `de14057` 覆盖率补齐                               | 通过：95.37/84.05                                                         |
| `3cea946` 分析标注                                 | 通过：critical 仅 interaction、stable 参照 baselineD95                    |

## 4. 补充发现：检查点恢复未校验快照内 config（已修，changes/0047）

`runSingle`（`src/runner/run-cell.ts:166-185`）与 `runSingleWithPolicy`（`:407-440`）只校验 `meta.configHash`（来自检查点 meta），随后直接 `state = loaded.state`。没有验证 `computeConfigHash(state.config) === computeConfigHash(config)`，也没有验证 `state.paramsHash`。

正常写入路径二者一致；但损坏/被篡改的检查点可以保留匹配的 meta 而快照内 config 不同，恢复后以不同规则续跑，且 `finalizeRun` 仍用调用方 config 计算摘要。建议加一行断言并补测试；成本极低。

## 5. 建议修复顺序

1. `p6-analysis` missingTicks 门禁 + 回归测试（防假确认）；
2. `deploy/check-disk-space.sh` 可执行位 + 安装文档/测试；
3. live ledger/summary provenance（模型/策略）与 `requireBudget` 默认强制；
4. 检查点 snapshot config/params 校验；
5. ledger report 深校验；
6. CLI stdout 退出方式；
7. 分析脚本哈希不一致硬失败；
8. 其余 Low 项与文档收尾（crossDays-half 关闭记录、旧 `--analyze` 警告）。

## 6. 当前不能说的话

- 不能说 `rules-v11` 已校准或结构已涌现（G6 未通过）。
- 不能引用 `e6db218`/`9890337` 的 env0“确认”——严格 TV 口径下未确认。
- 不能把 P6-02 的 intermediate 数字当作结论；该批跑仍在执行，`summary/slim/analysis` 尚未生成。
