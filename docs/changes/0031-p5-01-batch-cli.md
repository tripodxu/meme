# 0031：P5-01 批跑 CLI 与机器可读摘要（batch-cli + bin）

- 日期：2026-11-04
- 作者：Runner 负责人
- 关联：P5-01 / P5-03 / P5-04（01 §8.1、G5a）、`changes/0029`、`docs/07` §3（技术失败保留）
- 性质：**Runner 层实现变更**；不改变规则、参数注册表、默认配置、引擎行为与版本轴
  （`rules-v11`/`engine-v0.9.0`/`stratify-config-v6`/`stratify-state-v3` 不变）

## 1. 结论先行

P5-01 的三个验收点全部落地：

1. **单实验/矩阵/消融可启动**：`validateBatchManifest` + `buildBatchTasks`（`src/runner/batch.ts`，
   已有）经 `runBatch()`（新增 `src/runner/batch-cli.ts`）顺序执行 cells × seeds 笛卡尔任务；
2. **stdout 与报告分离**：`bin/stratify-batch.mjs` 的 stdout 只输出 `batch-summary-v1` 纯 JSON，
   进度走 stderr；报告落 `<out>/batch-summary.json`、审计 manifest 落 `<out>/batch-manifest.json`；
3. **mock 批跑不依赖 P2**：`runBatch` 只走 `runSingle` 同步路径，不 import 决策 HTTP 层，
   不读密钥、不发网络请求。

## 2. 交付面

| 件                   | 位置                                                                                                        | 说明                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 批量执行器           | `src/runner/batch-cli.ts`                                                                                   | `runBatch(manifest, options)`；`batch-summary-v1` 摘要；`runSingleImpl` 故障注入缺口                 |
| CLI 入口             | `bin/stratify-batch.mjs`                                                                                    | `<manifest.json> --out <dir> [--resume]`；退出码 0/1/2；`package.json` 注册 `bin`                    |
| 断点续跑 ledger      | 同上                                                                                                        | `batch-ledger-v1`：成功 run 按完成顺序 + 失败事件跨 resume 累积；逐任务原子替换落盘                  |
| manifest hash domain | `stratify-batch-manifest-v1`                                                                                | 第 13 个语义 hash domain：domains/schema/golden 向量同步（`test/fixtures/hash/domain-vectors.json`） |
| 测试                 | `test/unit/runner/batch-cli.test.ts`（12 项）、`test/integration/batch-cli.e2e.test.ts`（4 项，真实 spawn） | 结构/确定性/失败记录/kill 恢复对照/ledger 校验/stdout-报告分离/防覆盖                                |

## 3. 语义要点（审计口径）

- **确定性**：同一 manifest 重复执行，`configHash/paramsHash/finalStateHash/窗口聚合` 逐字一致；
  resume 后的最终指纹与不中断对照逐字一致（单测断言，G5a 口径）。`elapsedMs/resumed` 不是确定性字段。
- **失败保留（07 §3）**：`failures[]` 是跨 resume 累积的全部技术失败事件，`attempt` 为该
  `(cellKey, seed)` 第几次失败（含已被后续重试成功者）；`totals.failed = due - ok` 是最终仍未
  完成的任务数，退出码以它为准——历史失败被重试成功不阻断（exit 0），记录不删。
- **防覆盖**：不带 `--resume` 且 ledger 已存在时拒绝启动（exit 2），防止静默覆盖既有证据；
  损坏/异版本/异 manifestHash 的 ledger 一律拒绝恢复，不猜测不清洗。
- **原子性**：ledger、报告、审计 manifest 都走「临时文件 + fsync + rename」
  （复用 `CheckpointHost` 语义），kill 不留半截 JSON；`.tmp` 残留不会被当作有效点。
- **单写者**：同一输出目录不得并发运行两个批跑进程；全局队列/限流/共享预算属 P5-02。
- **已知取舍**：ledger 为单文件全量重写（O(N²) I/O）；P6 Stage B 规模（30 run 级）可忽略，
  更大规模如成瓶颈改追加式 journal（随 P5-02）。

## 4. 兼容性与实验可比性

- 不触及引擎与规则；无 golden fixture 变化；hash domain 为**新增**，既有 12 domain 向量不变。
- `batch-v1` manifest 复用 `batch.ts` 既有校验（版本一致性、人口一致性、cell 唯一性、
  overrides 只含 RunConfig 顶层键、不得覆盖 `population.initialPopulation`）。
- P1.5 的 `p15-*.mjs` 冻结实验管线**不迁移**到新 CLI；两者产物口径（窗口聚合字段）一致。

## 5. 验证证据

- `pnpm typecheck / typecheck:core / lint / format / test（605）/ test:integration（4）/ build` 全绿。
- 实机冒烟：`random-uniform-v1` 4 run 全成功；非法 override 在启动前被拒（exit 2）；
  `--resume` 全量复用（resumed=4）且 `finalStateHash` 与首轮一致。

## 6. 边界

- P5-01 不产出 05 §4.5 的 R2 artifact 清单；`metrics-v1` 全分辨率分块与上传属 P5b/P4。
- P5-01 不含并发与共享预算（P5-02）、systemd（P5-06）、微扰执行入口（P5-04 现有
  `buildPerturbationTasks` 任务生成，执行入口待接）。
