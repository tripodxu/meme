# 2026-11-03 zcodes 晚间推送审查

- 审查对象：`zcodes` 分支 2026-11-03 05:45–10:27 的提交（`d30080c`…`3a8c1ae`），重点为 `921c006`、`067b1db`、`91be410`、`547ef79`
- 审查依据：`AGENTS.md`、`docs/01-implementation-plan.md`、`docs/03-rules-implementation.md`、`docs/04-jev-decision-contract.md`、`docs/07-experiment-calibration.md`、`docs/08-testing-quality.md`、`docs/10-engineering-conventions.md`
- 结论：**G1.5 仍未通过，不得启动 P2–P6**。本轮提交存在证据链断裂、分析窗口未实现、聚类空间不一致与 P2 越闸门落地；P5a 的“落地”声明高于实际交付。本分支先记录缺陷并实施不改变科学口径的安全修复。

## 1. 证据链与产物

| #   | 缺陷                                                                                                                                                                                                                                                                                                                            | 位置                                                   | 影响                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1   | `921c006` 标题为“v5 轮 2 预注册——延长 burn-in 至 1825 + 吸引子稳定性判据”，提交信息称“w3 窗口 k=2 聚类 ARI 0.868”，但该提交内的 `out/p15-full.json` 仍是旧产物：`preregistrationHash=sha256:9d9de682…`、k=3、ARI 0.417、特征点 1680（w1+w3）。真正的新产物（`sha256:2c4843b4…`、k=2、ARI 0.868、840 点）直到 `3a8c1ae` 才入库。 | `921c006`、`547ef79`、`3a8c1ae` 的 `out/p15-full.json` | 同一次提交无法从仓库复现其声称结果；预注册 hash 与产物 hash 不同，违反 07 §3“完整 manifest + 预注册 hash”要求。 |
| 2   | `547ef79` 标题“落地 P5a-01/03/04”，但其时产物仍为旧 hash，P5a 代码未接入 runner，检查点无真实宿主、无 kill/磁盘失败/预算测试。                                                                                                                                                                                                  | `547ef79`、`src/runner/checkpoint.ts`                  | 交付声明高于证据，G5a 未达成。                                                                                  |

## 2. 科学判定缺陷

| #   | 缺陷                                                                                                                                                                                                                                           | 位置                                                                                       | 影响                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 3   | **w2b 窗口从未计算**。`ANALYSIS_WINDOWS` 只有 w1/w2/w3，`WindowLabel` 不含 `w2b`；`run-cell.ts` 只遍历该常量，因此 1825–2554 从未聚合。`p15-grid.mjs` 读到的 `w2b` 恒为 `undefined`，`temporalConsistency` 恒为 `null`。                       | `src/runner/window-stats.ts:10`、`src/runner/run-cell.ts:129`、`scripts/p15-grid.mjs:65`   | “burn-in 1825 + 吸引子稳定性”未落地；聚类实际只是弃用 w1、单用旧 w3，ARI 0.868 不能证明 G1.5 通过。 |
| 4   | **聚类距离空间不一致**：Ward/轮廓使用 z-score 后的 `points`，但 temporalConsistency 的质心与 w2b 向量使用原始值。                                                                                                                              | `scripts/p15-grid.mjs:140`、`:151-158`、`:176`                                             | 时间一致性度量与聚类不在同一空间，结果不可解释。                                                    |
| 5   | `minClusterRuns`（5）未在脚本中检查；`stabilityStable` 仅依据单次 shuffle 的 ARI。                                                                                                                                                             | `scripts/p15-grid.mjs:142`、`src/runner/preregistration.ts`（`clustering.minClusterRuns`） | 可能把小于 5 run 的簇当成稳定结构。                                                                 |
| 6   | 新 k=2 产物的两簇均含 `topHeavy`（c0 P4=0.648，c1 P4=0.900）；c1 仅来自 5 个 cell（`needMultiplier=flat` 5/30、`ablation:psi=1` 20/30、`v4:envExponent=0` 30/30、`v4:envExponent=0.5` 1/30、`v5:cushionDays=90+phi=0` 30/30），baseline 0/30。 | `out/p15-full.json`（`3a8c1ae`）                                                           | 不能据此声称“至少 2 类可复现、非退化结构”；G1.5 判定应为未通过。                                    |

## 3. 契约与实现缺陷

| #   | 缺陷                                                                                                                                                                                                                                                   | 位置                                                                                     | 影响                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 7   | **P2 越闸门落地**：`067b1db` 以“清理未用变量”为标题，新增 `policy.ts`/`serialize.ts`/`jev-client.ts`/`live.ts` 与 434 行测试；`src/decision/README.md` 仍写“当前尚未实现”。                                                                            | `067b1db`、`src/decision/*`、`src/decision/README.md:3`                                  | 违反 AGENTS #9“P1.5 未通过不得启动 P2–P6”；提交标题掩盖了功能范围。                              |
| 8   | `callJev` 在 `cancelled` 时仍调用 `recordFallback()`；`maxCalls` 声明后从未读取；`topK>1` 仍只做 argmax；`promptVersion` 使用常量而非 `input.promptVersion`；预算只累计 input token。                                                                  | `src/decision/jev-client.ts:244`、`:30`、`:363`、`:384`                                  | 与 04/08 契约不符；取消被计为模型质量失败，预算与 topK 语义未实现。                              |
| 9   | `validateBatchManifest` 不校验 `rulesVersion/engineVersion`（空串也通过）、不拒绝重复/空 `cellKey`、不校验 `overrides` 类型、不核对 `populationSize` 与 config；`buildBatchTasks` 用 `seed as Seed` 强转；`mergeCellOverrides` 为死代码且忽略 `base`。 | `src/runner/batch.ts:39`、`:99`、`:105`、`:123`                                          | manifest 可对版本撒谎；非法种子/重复 cell 不被拒绝；07 §3 的 `fullConfigHash` 约束未落实。       |
| 10  | 检查点无 fsync/真实 fs 宿主，未接入 runner；`meta` 直接 `as CheckpointMeta` 且 `void meta`；不校验期望 cellKey/seed；`saveCheckpointWithHistory` 会把损坏的 primary 原样提升为 `.prev`，污染回退链。                                                   | `src/runner/checkpoint.ts:50`、`:68`、`:82`、`:96`、`:110`                               | 与注释“fsync 后 rename”不符；损坏主点可覆盖好的回退点；G5a 的 kill/磁盘失败/预算耗尽恢复未验证。 |
| 11  | 文档状态过期：`docs/README.md` 仍称 P0 完成/P1 未开始/规则 v3；`01` 只记录到 v4 复核，无 v5 轮 1/2；`changes/README.md` 缺 0005 索引；`07 §5` 仍写 burn-in 365 与 w1/w2/w3，未记录 1825/w2b 修订；`src/runner/README.md` 称未实现。                    | 对应文件                                                                                 | 与代码和实验记录矛盾，违反“文档与实现同步”。                                                     |
| 12  | `changes/0005` 声称“v4 golden fixture 保留只读”，但 git 显示 `mock-run-rules-v4.json` 被重命名为 `mock-run-rules-v5.json`（R066）；`test/golden/engine-mock.test.ts:22` 又称保留 v3 fixture，但仓库中不存在。                                          | `docs/changes/0005-rules-v5-holding-cushion.md:43`、`test/golden/engine-mock.test.ts:22` | 历史 golden 不可复核；版本轴证据链断裂。                                                         |
| 13  | 生成大文件入库：`out/p15-full.json` 2.7MB、`out/p15-full-v4draft.json` 1.1MB、`out/p15-screen.json` 32KB；10 §7 要求自检“无生成大文件”。                                                                                                               | `out/`                                                                                   | 仓库膨胀，且报告引用的体积/统计已过期。                                                          |

## 4. 本分支已实施的修复

1. **窗口**：`ANALYSIS_WINDOWS` 增加 `w2b (1825–2554)`，使每次 run 的 `windows` 含 w1/w2/w2b/w3。
2. **聚类**：`p15-grid.mjs` 按 `clustering.featureWindows` 建点；z-score 只拟合一次并用于 w2b 质心分配；多次确定性 shuffle 报告最小/平均 ARI；检查 `minClusterRuns`；`stabilityStable` 仅在 ARI 与簇规模同时满足时为真。
3. **batch**：校验 `rulesVersion/engineVersion` 与当前版本一致、`cellKey` 非空且唯一、`overrides` 为对象、`populationSize` 与 config 一致且 cell 不得改人口；`asSeed` 校验；删除死代码 `mergeCellOverrides`。
4. **checkpoint**：校验 `meta` 结构；增加期望 `cellKey/seed/minTickCompleted`；损坏 primary 不再覆盖好的 `.prev`；新增 Node fs/fsync 宿主 `src/runner/checkpoint-fs.ts`；补对应单测。
5. **文档**：更新 `docs/README.md`、`01` 的 P1.5 记录、`07 §5` 的 v5 窗口修订、`changes/README.md` 的 0005 索引、`src/runner/README.md`、`src/decision/README.md`；新增本审查记录。

## 5. 未在本分支处理（需单独决策）

- **P2 代码归属**：`067b1db` 的决策层应移出或显式标记 experimental，待 G1.5 通过后再按 P2-01…P2-07 修正并合入。本分支不继续实现 P2。
- **v4/v3 golden**：从历史提交恢复只读 fixture，或在 `changes/0005` 更正兼容性说明；两者择一，不得含糊。
- **out/ 入库策略**：改为证据摘要 + 外部/R2 artifact，或 `.gitignore`；需确认后执行，避免再次提交数 MB 生成文件。
- **G1.5 重跑**：修复后必须用真实 w2b 数据重新预注册并重跑；在结果满足 07 §8.1（≥2 类、ARI≥0.70、每簇≥5 run、非退化）前，不得声称通过。

## 6. 验证

- `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm check:docs` 全绿后方可提交本分支。
- 本记录只陈述事实与修复，不构成校准完成或结构涌现的结论。
