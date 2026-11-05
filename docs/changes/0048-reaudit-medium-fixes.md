# 0048：第二轮复审 Medium 项修复（ledger provenance、预算默认、CLI/分析/微扰）

- 日期：2026-11-05
- 作者：Runner/实验负责人
- 关联：[第二轮复审](../reviews/2026-11-05-zcodes114-reaudit.md)、changes/0047、04 §7、07 §3/§7
- 性质：**证据链与运行器加固**；不修改规则、参数默认值或实验判定

## 1. live ledger/summary provenance

**问题**：`BatchRunRecord` 只有 config/params/report；live 断点续跑可在换模型后复用旧 run，summary 仍标 `mock-weighted-v1`。

**修复**：

- 新增 `BatchProvenance`（`requestedModel`/`promptStyle`/`policyVersion`），每条 run 记录写入；
- mock 批跑记录 `requestedModel='mock'`、`policyVersion=manifest.policy`；
- `runBatchWithPolicy` 续跑时校验：configHash/paramsHash 一致；provenance 存在；模型/prompt 一致；若调用方提供 `policyVersion`，也必须一致；
- 旧 live ledger 缺少 provenance 时**拒绝续跑**（不静默复用）；旧 mock ledger 无 provenance 仍可读；
- summary 新增 `liveProvenance`（模型、prompt、实际 policyVersions），不再让 live 只靠 `policy` 字段冒充 mock。

## 2. `requireBudget` 默认强制

`runBatchWithPolicy` 缺省要求共享预算：`options.requireBudget !== false` 时缺预算即拒绝启动；只有显式 `requireBudget=false` 才允许无预算（测试/特殊场景）。错误信息明确指向 04 §7。

## 3. ledger 深校验与 config/params 交叉校验

- `assertRunRecord` 现在校验 `report.finalStateHash`、`extinct`/`cancelled`、`endTick`/`aliveAtEnd`、`endReason`、`windows`、`labelsByWindow`，以及 provenance 结构；
- `BatchTask` 增加 `paramsHash`；恢复时逐 run 比对 `configHash`/`paramsHash` 与当前任务，不一致拒绝复用（防损坏/篡改 ledger）。

## 4. CLI stdout 退出

`bin/stratify-batch.mjs` 在写完 summary JSON 后改用 `process.exitCode`，不再立即 `process.exit`；管道/重定向下的异步 stdout 不会被截断。错误路径同样设置 `exitCode=2`。

## 5. 分析脚本哈希硬失败

`scripts/p6-stage-a.mjs --analyze-strict` 与 `scripts/p6-stage-b.mjs --analyze` 在预注册哈希与重算不一致时直接 `exit(2)`，不再输出判定；`p6-factorial` 原有的冻结校验保持不变。

## 6. 微扰字段白名单

`param` 微扰只允许模型参数段：`need/opportunity/ascent/lifespan/network/networkOpportunity/competition/effort/descent/dynamics/openness`。`population/schedule/decision/metrics/attributes` 等拒绝——它们改变初始化、视野、决策节奏或测量口径，不能作为检查点后的微扰变量。

## 7. Stage B slim 与 summary 的 segregation 归一

`slimOne` 与 summary 路径共用 `windowOf`：`networkEmpty` 时 `segregation=null`。重生成六个 slim 与 analysis；slim 保留 `w2bLabels`/`w3Labels`；**判定不变**（仅 `needThreshold=0.9` 确认），analysis 哈希不变，六个 slim 哈希按重生成更新。

## 8. 验证

- `pnpm test`：711/711；`pnpm test:integration`：4/4；
- `pnpm typecheck` / `lint` / `check:docs` / `format`：全通过；
- `pnpm test:coverage:runner`：statements 95.3% / branches 84.13%（门槛 95 / 78）；
- Stage B 六单元重算：`incompleteWindow=0`，confirmed 不变；Stage A 3 候选不变；P6-02 31 cell 完整。

## 9. 未修 Low 项

`warmupDiagnostic` 联合类型、`protocolConflict` 子串检测、旧 `--analyze` 路径的运行时告警、`changes/0039` 冻结表 `c1206246` 与产物 `83a1d58a` 的关闭记录。保留在复审文档中。
