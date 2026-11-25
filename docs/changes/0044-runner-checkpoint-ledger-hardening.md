# 0044：runner 正确性加固（检查点、ledger baseConfig、live 预算/模型）

- 日期：2026-11-05
- 作者：Runner/实验负责人（严格口径恢复）
- 关联：P5a-03/P5-02、P6-01、05 §存储契约、07 §3、`docs/research/2026-11-05-p6-01-strict-recovery-plan.md` 阶段 2
- 性质：**工程正确性修复**；不修改规则、参数、预注册或既有 run 数据

## 1. 修复内容

| 位置                 | 问题                                                                                    | 修复                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-progress.ts`    | `meta.tickCompleted` 与快照 tick 未交叉校验；stats/flows/decisions 的 tick 可越界或重复 | 加载时要求 `state.society.tick === tickCompleted`；元素 tick 必须在 `[0, tickCompleted-1]` 内且唯一；stats 条数 ≤ tickCompleted；异步加载只读一次 |
| `batch-cli.ts`       | `baseConfig` 未进入 ledger 哈希，换 baseConfig 可误复用旧 run                           | ledger 写入 `baseConfigHash`；读取时与本次 `baseConfig` 比对，不一致拒绝；**旧 ledger 无该字段仍按 legacy 接受**                                  |
| `batch-live.ts`      | live 检查点未接入；预算可选；`requestedModel` 缺省伪装成 `mock`                         | `runCheckpoint` 校验目录/间隔并透传到每个 run；`requireBudget=true` 且缺预算时拒绝启动；缺省模型改为 `'unknown'`，不再冒充 mock                   |
| `preregistration.ts` | `warmupTicks` 放宽为 `number`，任意值可进入预注册哈希                                   | 恢复受限联合类型 `365 \| 1825`；新增档位须先走参数注册表与 changes 记录                                                                           |

## 2. 兼容性

- **ledger**：`batch-ledger-v1` 不变；`baseConfigHash` 为新增可选字段。旧 ledger 可直接恢复；新 ledger 在 baseConfig 不一致时显式失败（要求换输出目录），不静默复用。
- **进度检查点**：`run-progress-v1` schema 不变；更严格的校验把此前会被接受的畸形检查点按「损坏」处理并从头重跑——确定性保证结果不变，只损失恢复加速。
- **配置/规则**：无变更；`configHash`/`paramsHash`/`preRegistrationHash` 均不受影响。
- **实验可比性**：既有 Stage A/B 产物与判定不变；本记录不重算任何 run。

## 3. 测试与验证

新增/更新单测：

- `run-progress.test.ts`：`tickCompleted` 与快照 tick 不一致、stats tick 越界 → 按损坏处理，重跑结果与对照逐字一致。
- `batch-cli.test.ts`：`baseConfigHash` 不一致拒绝恢复；legacy ledger 无字段仍接受并补写新哈希。
- `batch-live.test.ts`：`requireBudget` 缺预算拒绝；`runCheckpoint` 校验与透传（护栏停止后保留检查点）；缺省 `requestedModel` 为 `unknown`。
- `preregistration.test.ts`：warmup 变体改用合法档位 `365`，仍验证哈希敏感性。

门禁：`pnpm typecheck`、`pnpm test`（685 项）、`pnpm lint`、`pnpm check:docs`、`pnpm format` 全部通过。

## 4. 未覆盖

- integration/e2e 套件未在本机运行；真实 Jev live 冒烟仍需密钥与预算。
- live 批跑的跨进程调度、`budget.sqlite` 持久化不在本次范围（docs/09 §6）。
- 检查点文件为单文件全量写；P6 规模可接受，更大规模需改追加式 journal（P5-02 已知取舍）。
