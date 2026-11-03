# 0006 分析层与引擎的实现完整性修复

- 日期：2026-11-03
- 类型：实现缺陷修复 + 契约对齐（`engineVersion: engine-v0.2.0 → engine-v0.3.0`；
  `CONFIG_SCHEMA_VERSION: stratify-config-v1 → stratify-config-v2`）
- 依据：逐提交审查 `71d0d51..HEAD`（见 `docs/reviews/2026-11-03-commit-audit.md`）
- `rulesVersion` 不变（`rules-v5`）：本次不改变任何已登记规则语义

## 一、分析层数据正确性（影响所有结构与标签结论）

**1. 全死亡日污染窗口均值（`runner/window-stats.ts`）**

旧实现用 `Σ(className/aliveCount) / n` 且分母取 `Math.max(aliveCount, 1)`，
把 `aliveCount=0` 的 tick 按 `P=0` 计入均值。实测一个窗口尾部 10 日全死亡时，
`classShares` 之和仅 0.139（应为 1），窗口仍被判 `available` 并进入聚类，
直接违反 07 §5「不得把全死亡后的 P=0 日补入均值」，并使 TV(P) 系统性偏大。

- 结构均值只用 `aliveCount > 0` 的行；`missingTicks = 窗口长度 − 存活行数`；
- 新增 `observedTicks`（实有行数）与 `deadTicks`（其中全死亡行数），区分「未跑到」与「跑到但全死」；
- 死亡暴露量、竞争损耗仍用全部实有行（全死亡 tick 的死亡数属于窗口事件，不得漏计）。

**2. 末 tick 全死亡未标 extinct（`runner/run-cell.ts`）**

引擎在最后一 tick 才全死亡时返回 `scheduled` 而非 `extinct`，但 `finalAliveCount=0`。
旧实现令 `extinct = endReason === 'extinct'`，这类 run 以「存活」身份进入聚类，
07 §8 质量检查第 5 条失效。现抽取 `deriveExtinct(endReason, aliveAtEnd)`，
`aliveAtEnd === 0` 一律判 extinct。

**3. `networkEmpty` 只看末行（`runner/window-stats.ts`）**

改为整窗判定 `structRows.every(r => r.edgeCount === 0)`，并让 `labels.ts` 在
`networkEmpty` 时不产出依赖 S 的 `closedStratified` / `highFlowNetwork`（07 §5）。

**4. 封闭分层未按块判定（`runner/labels.ts`）**

07 §10 要求「O≤0.25、Mup≤0.05、S≥0.50 且 edgeCount>0，在窗口至少 80% 的 30 日块成立」。
旧实现只用整窗均值判一次，再用同一整窗 `Mup/S` 套每个块，等于块级判定失效
（任一块 O 低就通过）。现 `blocks30d` 携带 `mUp/segregation/edgeCountAverage`，
逐块判三条件后统计支持率。

## 二、预注册与证据口径

**5. `preregistrationHash` 覆盖缺口（`runner/preregistration.ts`）**

对照 07 §3 权威口径，旧实现缺 `promptVersion`、`promptStyle`、`baseConfigHash`、
`artifactProfile`、`cells[].fullConfigHash` 与排除规则。最严重的是 `baseConfigHash`：
`buildCellConfig` 固定合并 `DEFAULT_RUN_CONFIG`，默认配置变化会让产物变而哈希不变。
`src/core/hash/schemas.ts` 自身的域声明已列全这些字段，实现未满足自家 schema。

- 新增 `PREREG_PROMPT_VERSION = 'prompt-none-v1'`（mock 不消费 prompt，显式表达「无」）与
  `PREREG_PROMPT_STYLE = 'neutral'`；接入 Jev 时必须替换并重新预注册；
- 新增 `artifactProfile: 'full'`；
- 新增 `buildBaseConfig()`，其 `configHash` 进 manifest 与哈希；
- 每个 cell 的 `fullConfigHash` 在 `buildPreregCells()` 内计算并入哈希；
- 新增 `exclusionRules`（灭绝/不可用窗口/空网络/重试上限）进哈希。

**6. 聚类特征窗口无法包含 w2b（`runner/preregistration.ts`、`scripts/p15-grid.mjs`）**

类型写死 `readonly ('w1'|'w3')[]`，值 `['w3']`，导致 07 §5 v5 修订要求的
「同一 run 的 w2b/w3 特征点落入同一簇」无法实现；旧脚本用「w2b 投影到 w3 质心」近似，
且 `sameClusterRate` 没有判据阈值。

- 类型改为 `readonly WindowLabel[]`，值 `['w2b', 'w3']`：两个窗口的特征点在同一
  z-score 空间各自入簇，直接比较簇号；
- 新增 `clustering.temporalConsistencyMinRate = 0.8`，脚本输出 `met` 布尔结论，
  不再只给统计量。

**7. 均值场顶层 margin 未传 E（`scripts/p15-mean-field.mjs`）**

`topClassMargin` 支持 `eByClass`，但脚本调用点不传 → `envMultiplier=1`，
等于用 v3 需求线算「顶层可持续性裕度」。实测同配置下无乘子 0.2857、
按 w3 观测 E 计算 0.0635（4.5 倍差）。现先跑 baseline 取 `w3.eByClass` 逐阶级均值，
再分别报告 `marginNoEnv`（v3 对照）与 `marginWithEnv`（真实口径）。

**8. 预注册字段无人执行（`scripts/p15-grid.mjs`）**

`budgets`、`warmupTicks`、`differenceThresholds` 进了哈希却从未被读取。现接线：

- `warmupTicks` 必须 `<=` 首个分析窗口起点，否则中止（防 burn-in 混入排序暂态）；
- `cells × seeds` 预计 run 数必须 `<= budgets.maxRuns`，实际 `wallMinutes`/`storageBytes`
  在产物 `budgets` 块中登记，超限时 `exitCode=2`；
- full 阶段对每个 cell 与 baseline 的 w2b 计算 `meetsInitialDifference`，
  输出 `cellDistinctness`（无信息量的 cell 必须可见）。

## 三、引擎健壮性

**9. `parseActionKey` 校验恒真式（`core/legal-actions.ts`）**

`target` 由 `key` 切片而来，`key !== \`compete:${target}\``恒为 false，等于没校验。`compete: a-0001`、`compete:../x`均可进入执行端。改用`AGENT_ID_PATTERN` 校验。

**10. 自竞争可执行（`core/engine/engine.ts`）**

执行端不校验目标是否属于本 agent 的合法行动集。`compete:<self>` 会先扣后加，
造成净损失（Value 1000 → 982.88）。新增自目标守卫，记
`stale_invalid(reason=self_target)`，不进入竞争结算。

**11. 费用复核的 NaN 方向与枚举侧相反（`core/engine/engine.ts`）**

枚举侧 `value >= cost + cushion`（NaN 拒绝），复核侧 `value < cost + cushion`（NaN 放行）。
统一为 `!(value >= cost + cushion)`；`computeAscendCushion` 增加非有限值断言。

**12. 重连权重下溢崩溃（`core/network/rewire.ts`）**

`exp(-H×(1−O)×|Δclass| − hV×|ΔlogValue|)` 在 `classWeight` 较大时可整体下溢为 0，
`weightedSampleIndex` 返回 -1 后 `candidates[-1].id` 抛 `TypeError`，此时旧边已从双方移除。
现按「无候选」恢复旧边并 `restored=true`。

**13. 跨层乘子为 0 时概率为 NaN（`core/engine/settlement.ts`、`core/params.ts`）**

两个乘子进 log 域，合法域为 `[0,1.25]` 且允许 0：同时为 0 时 `-Inf − (−Inf) = NaN`，
`r < NaN` 恒 false ⇒ 发起方恒败，NaN 还流入事件与指标。
注册域改为 `[1e-6, 1.25]`（排除端点），运行期再加正数断言。

## 四、配置版本轴

**14. 必填字段未升 schema 版本（`core/control/versions.ts`、`core/config/validate.ts`）**

`f7ac25f` 给 `openness` 加了必填 `updateMode`，但 `CONFIG_SCHEMA_VERSION` 仍是 v1，
新旧语义共用一个版本号，读取器无法分流（02 §10 要求按版本分派）。

- `CONFIG_SCHEMA_VERSION = 'stratify-config-v2'`，保留 `CONFIG_SCHEMA_VERSION_V1`；
- `validateRunConfig` 入口做 v1→v2 迁移：缺失 `updateMode` 补 `dynamic`
  （v1 时期 O 恒为动态更新，迁移保持原语义），未知版本仍被拒绝；
- **注意**：`HASH_DOMAINS.config = 'stratify-config-v1'` 是哈希域前缀，不是 schema 版本，
  不随之改变（改它会作废全部历史 `configHash` 向量）。

## 五、模块治理

**15. P2 决策层隔离（`src/experimental/p2-decision/`）**

`policy`/`serialize`/`jev-client`/`live` 由「清理未用变量」的提交夹带进 `src/decision/`
（`3ec7bab`，+1284 行），生产路径零引用，且 P1.5 未通过前不得启动 P2（01 §1）。
现迁入 `src/experimental/`，附 README 说明闸门与迁出条件；
新增 `test/unit/architecture.test.ts` 守住边界：生产目录不得 import `experimental`，
`src/core` 不得运行时 import 外层模块（唯一例外是 `ExecutionRecord` 的 type-only 依赖）。

## 六、性能

- `window-stats.ts` 的 `stats.find`（730 次线性扫描/窗口）改为 `Map<tick, row>` 索引；
- `decision/mock.ts` 的 `agents.find` 改为 `agentIndexFromId` O(1) 定位
  （P1.5 每 tick 对全部存活个体调用，原本是 O(N²)）；
- `scripts/p15-grid.mjs` 删除与 `distance.featureVector` 重复的实现，复用库函数。

## 兼容性

- **旧配置**：v1 仍可读（自动迁移补 `updateMode=dynamic`）；`configHash` 因
  `schemaVersion` 变化而改变，历史 `configHash` 不再匹配，需登记新值。
- **旧快照**：`encodeSimState` 内含 `config`，`schemaVersion` 变化使所有历史
  `finalStateHash` 失效；`restoreSnapshot` 只校验结构，不校验 `schemaVersion` 相等，
  故旧快照仍可恢复，但恢复后的状态哈希与新产物不可直接比较。
- **旧产物**：`out/p15-*.json` 的 `preregistrationHash` 全部作废
  （`2c4843b4…` → `ba64e87f…`，见 §实验可比性）。
- **golden**：`mock-run-rules-v5.json` 重新生成。**已逐点核对：5 个检查点的全部指标
  与死亡率逐位不变，只有 `finalStateHash` 随 `config.schemaVersion` 改变**，
  证明本次未改变合法输入下的结算语义。新增 `engineVersion` 字段，使「规则相同、
  实现不同」的产物可区分。

## 实验可比性

- `preregistrationHash` 从 `sha256:2c4843b4…` 变为
  `sha256:ba64e87f13a84e82e14326f0cd181460d788ffd46e9dd60289e1f917778fccf6`
  （`engineVersion`、`baseConfigHash`、`artifactProfile`、cell `fullConfigHash`、
  排除规则、`featureWindows` 均为哈希输入）。
- 这是**一次性口径修正**：旧哈希覆盖不全，无法用其证明产物与 manifest 一致。
  按 07 §3「任何预注册内容变化必须新建 experimentId」，`out/p15-full.json`
  原有的 w2b 全 null 产物不得继续用于 G1.5 判定。
- 重跑命令：`pnpm build && node scripts/p15-grid.mjs --stage full`（约 46 分钟起）。

## 未覆盖项（需决策，不在本次改动内）

- `067b1db` 的 P2 决策层归属：已隔离，但「移出仓库」还是「保留 experimental」需负责人确认。
- v3/v4 历史 mock fixture 缺失（`mock-run-rules-v4.json` 在 `e531bab` 被重命名覆盖）：
  恢复历史提交还是改兼容性说明，二者择一。
- `out/` 三份 JSON 仍为纯文本入库；迁 LFS/R2 属于策略变更，见 `docs/reference/artifacts.md`。
