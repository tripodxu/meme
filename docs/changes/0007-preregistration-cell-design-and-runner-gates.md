# 0007 预注册格点自描述与证据链测试门禁

- 日期：2026-11-03
- 范围：`src/runner`（预注册、均值场）、`src/core/config`（新增差异工具）、测试与 CI 门禁
- 前置：[0006](0006-analysis-and-engine-integrity-fixes.md)

## 1. 为什么还要改一轮

0006 修完后重跑预注册时发现两件事：

1. **cell 名会谎报。** `v5:geMedian=0.7+cushion30` 声称同时改「裕度」与「生产力」，
   但 `ascent.holdingCushionDays` 的默认值就是 30——这个 cell 实际只改
   `attributes.ge.median` 一项，`fullConfigHash` 与 `v4:geMedian=0.7` **完全相同**。
   它既不是交互格点，也不是新信息，只是白耗 30 个种子预算的重复格点。
   `5c518ef` 的审查结论「双变量 cell 违反单变量原则」方向反了：问题不是改了两个，
   而是一个都没多改。
2. **证据链不在覆盖率门禁内。** `vitest.config.ts` 只覆盖 `src/core/**`。
   `src/runner` 承载窗口统计、标签、预注册、聚类、均值场，实测 statements 87.65% /
   branches 73.1%，其中 `mean-field.ts` **0%**、`preregistration.ts` 33%。
   0006 漏 6 个哈希字段、全灭日污染窗口均值、均值场漏传观测 E，
   三类缺陷都没有任何测试拦截——根因就是这条门禁缺口。

## 2. 改动

### 2.1 预注册 cell 增加设计声明（`src/runner/preregistration.ts`）

`PreregCell` 新增两个字段：

| 字段           | 语义                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `design`       | `baseline` / `single` / `interaction`，声明该格点属于 §6.2 单轴扫描还是 §6.3 小型 factorial |
| `changedPaths` | base 与该 cell 合并后配置的差异叶子点路径，**由代码派生**，不得手写                         |

构造期 `assertCellDesign()` 校验数量自洽：`baseline=0`、`single=1`、`interaction≥2`，
不自洽直接抛错。同一网格内两个 cell 的 `fullConfigHash` 相同也抛错（重复格点）。

`design` 与 `changedPaths` 均进入 `preregistrationHash`，因此「哪些格点能单轴归因」
本身是被冻结的预注册内容，不是运行后的解释。

### 2.2 新增 `src/core/config/diff.ts`

`diffConfigPaths(base, variant)` 返回差异叶子点路径。数组视为**单个叶子**——
`needMultiplier`/`env0`/`decay` 是向量参数，按下标展开会把「改一个向量」误判成 5 个变量。
`undefined` 与「键不存在」等价，避免可选字段写法差异制造伪差异。

### 2.3 修正退化的交互 cell

| 旧                                                                    | 新                                                      | 差异                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `v5:geMedian=0.7+cushion30`（实为 1 项，且与 `v4:geMedian=0.7` 重复） | `v5:cushionDays=90+geMedian=0.7`（`interaction`，2 项） | `ascent.holdingCushionDays`、`attributes.ge.median` |

保留假设「裕度×生产力双约束 ⇒ 封闭分层可达」，但让它真正成立：裕度取 90（非默认值）。
格点数不变（28：1 baseline / 25 single / 2 interaction），预算不变。

### 2.4 均值场两处「静默假设」改为显式失败（`src/runner/mean-field.ts`）

- `topClassMargin()`：`envExponent≠0` 且调用方未传观测 `E[c]` 时**抛错**。
  旧实现静默取 `envMultiplier=1`，即悄悄退回 v3 语义——`changes/0004` 的 4.5× 高估
  （0.2857 vs 真值 0.0635）就是这么产生的。「不含环境乘子」必须由 `envExponent=0` 表达。
- `checkCongestionSigns()`：新增 `floorBound` / `clampBound`。当 `P[c]` 跌破
  `emptyClassPopulationFloor=0.02` 时 `Congestion` 被钉在 1，或结果被
  `[congestionMin,congestionMax]` 截断，此时观测值不再反映 `P` 的变化，
  旧实现仍判 `applicable` 并记 `signMatches=false`，制造伪不匹配。
  例：`classShares[4]=0.02` 减半后 `P=0.01<floor`，旧实现上报「该降没降」。

### 2.5 哈希预像可检视

`buildPreregHashInput()` 从 `computePreregistrationHash()` 中拆出并导出。
理由：`hashValue` 不校验字段，漏一个字段不报错，只会让「设计变了而 hash 不变」静默存在。
预像可被测试直接枚举字段清单并与 07 §3 权威口径比对。

### 2.6 新增运行层覆盖率门禁

`vitest.coverage-runner.config.ts` + `pnpm test:coverage:runner`：
`src/runner` statements ≥95、branches ≥78。两条门禁**分开**执行而非合并阈值——
合并会稀释 core 的强度（core branches 95.08%、runner 79.91%，合并 89.82%）。
`branches=78` 是当前实测地板并作为**棘轮**（只升不降），目标与 core 对齐 95，
缺口是防御性 throw 分支与 I/O 失败路径。CI 已加对应步骤。

## 3. 兼容性

**不兼容**：`PreregCell` 新增必填字段、`checkCongestionSigns` 返回值新增字段、
`topClassMargin` 在缺 `E` 时改为抛错。三者都在 `src/runner`，无对外发布承诺。

`CONFIG_SCHEMA_VERSION`、`ENGINE_VERSION`、`RULES_VERSION` **不变**：
本次没有改动任何结算公式或配置字段，只是分析层的格点声明与校验。

`preregistrationHash` 变更：

```text
旧 sha256:ba64e87f13a84e82e14326f0cd181460d788ffd46e9dd60289e1f917778fccf6
新 sha256:4dc141e4b7bce47e5686f227daa5967236fed2b8e24e3b8899e123efef16722a
```

`baseConfigHash` 保持 `sha256:ff00821e…` 不变（base 设计未动）。

## 4. 实验可比性

- 本次**改变了预注册设计**（一个 cell 的覆盖值），不是口径修正。
  按 07 §3「任何预注册内容变化必须新建 `experimentId`」，P1.5 全量重跑必须使用新 id。
- `out/p15-full.json`（`sha256:2c4843b4…` 时代产物）与
  `out/p15-screen.json`（`sha256:ba64e87f…` 时代的 `503f535d…`）都只作历史存档。
- screen 产物已按新口径重跑，登记见 `docs/reference/artifacts.md` §2。

## 5. 记录修正

- `docs/reviews/2026-11-03-commit-audit.md` §4：`5c518ef` 的结论方向被推翻
  （不是「改了两个参数」而是「实际只改一个且与既有 cell 重复」）。
- `docs/reference/artifacts.md` §5 新增 fixture 版本约定：config fixture 累加式、
  engine golden 改名前滚；`changes/0005`「v4 配置 fixture 保留只读」本就正确，
  此前把它套用到 engine golden 上才是错的。
- `test/golden/engine-mock.test.ts` 删除「v3 fixture 保留只读」的虚假注释。
- 决策入档：`docs/adr/0002`（P2 决策层保留在 `src/experimental/`，附删除条件）。

## 6. 验证

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm typecheck:core
pnpm test                     # 38 文件 / 459 测试
pnpm test:coverage            # src/core  statements 97.71  branches 95.08
pnpm test:coverage:runner     # src/runner statements 95.16  branches 79.91
pnpm check:docs
```

新增测试：`test/unit/runner/preregistration.test.ts`（20）、
`test/unit/runner/mean-field.test.ts`（19）。
