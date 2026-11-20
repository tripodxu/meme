# 架构决策记录（ADR）

本目录保存不可逆或影响面较大的技术决定。格式与触发条件见 `../10-engineering-conventions.md` 第 8 节。

## 命名与状态

- 文件名：`NNNN-title.md`，四位递增序号，标题用 kebab-case 英文，如 `0001-d1-authoritative-persistence.md`。
- 状态只允许：`proposed` / `accepted` / `superseded by NNNN` / `deprecated`。
- 已接受的 ADR 不重写结论；改变决定时新建一篇并标注取代关系，保留原文供追溯。

## 必须写 ADR 的变更

- 新增基础设施（Durable Objects、Queues、Redis、第二数据库等）。
- 公共协议不兼容变更、存储主键或 schema 语义变更。
- Jev 职责变化（例如让模型参与结算）、模型或 prompt 策略代际切换。
- 核心更新顺序、RNG 地址方案、权威状态或回放语义变化。
- 引入第二规则实现或第二前端框架。

普通函数拆分、样式调整、无行为变化的性能优化不写 ADR，但必须有测试与 golden 证据。

## 与本套文档的关系

ADR 不能静默推翻 `rule.md` 或 `docs/README.md` 的“唯一事实来源”。若 ADR 与现有契约冲突，必须同 PR 更新对应文档、类型、fixture 和版本字段，否则视为未完成。

## 索引

| 编号                                                  | 标题                           | 状态                        | 影响                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-runtime-authority-and-hash-inputs.md)     | 运行时权威与哈希输入 schema    | proposed                    | run identity 增加 `runtimeVersion`；每个 hash domain 需要字段级 schema 与多运行时向量                                                                                                                                                           |
| [0002](0002-p2-decision-layer-stays-experimental.md)  | P2 决策层留在实验目录          | superseded by 0003          | `src/experimental/p2-decision/` 保留但禁止接线；G1.5 通过前生产层不得 import，由架构测试强制                                                                                                                                                    |
| [0003](0003-p2-decision-layer-production.md)          | P2 决策层迁回生产路径          | accepted                    | G1.5 通过后 `policy/serialize/jev-client/live` 迁回 `src/decision/`；保留实现与测试，新增 Policy 接线路径                                                                                                                                       |
| [0004](0004-rules-v12-institutional-bistability.md)   | rules-v12 显式制度双稳态       | accepted                    | 新增 `openness.selfReinforcement` θH（默认 0，域 [0,20]）；θH=0 与 v11 逐位一致；config schema v7、rules-v12；P6-05c 检验                                                                                                                       |
| [0005](0005-rules-v13-institutional-state-machine.md) | rules-v13 显式制度状态机       | accepted（P6-05d 验证失败） | 新增 `society.institutionalRegime`（closed/open）与 `openness.regimeMode/regimeBias/enter/exit`；state v4、config v8、rules-v13；P6-05d 160/160 但 k=3 [76,3,41]、ARI 0.094、silhouette 0.152、同簇率 0.650，θR>0 塌到 closed 单态 → B 方案失败 |
| [0006](0006-target-two-regimes-continuum.md)          | 目标修订：2 体制 + 连续统      | accepted（2026-11-11）      | G6 目标改为“2 体制 + 连续统”（k=2 稳定 + k=3 无稳定第三簇）；旧 k=3 不追认；rules-v14、07 §8.2（changes/0065）                                                                                                                                  |
| [0007](0007-individual-behavioral-heterogeneity.md)   | rules-v15 个体行为异质性（D2） | accepted（2026-11-11）      | 新增不可变 `riskTolerance`/`crossClassOpenness` 与 `mock-weighted-v2`；默认全 0 与 v13/v14 逐位一致；rules-v15 / engine-v0.12.0 / config v9 / state v5；P6-07 仅探索，不构成 G6 确认                                                            |

| [0008](0008-stop-p6-engineering-track.md) | 停止 P6 结构目标，转工程轨道 | accepted（2026-11-11） | 不再新增 P6 确认轮/调参；G6 保持未通过；P3/P4/P5b/P7 解除 G6 前置；保留 rules-v15 与全部证据；未来重启须新 ADR + 全新预注册/seed |
| [0009](0009-rules-v16-generational-succession.md) | rules-v16 代际更替与遗产折算机制 | accepted（2026-11-18） | 新增 `population.generationalMode` / `bequestRate` / `classInheritanceRate`；默认 `none` 与 v15 逐位一致；`rules-v16` / `engine-v0.13.0` / `config-v10`；以全新 P6-08 检验三类结构假说 |
| [0010](0010-two-regime-continuum-silhouette-criterion.md) | 阶段 R1：修正“2 体制 + 连续统”几何判据并立项 P6-09 | accepted（2026-11-18） | 修订 `docs/07` §8.2 条件 4 补齐 `silhouette(k=3) >= 0.35 && >= silhouette(k=2)`（新旧口径同报，不追认 P6-06）；立项 `N=200` 全新 30 种子确认轮 `P6-09` |
| [0011](0011-rules-v17-class-capacity.md) | 阶段 R2-A：`rules-v17` 阶级结构性容量上限与 P6-10 | accepted（2026-11-18） | 新增 `ascent.classCapacity`（默认全 1 与 v16 逐位一致）；`rules-v17` / `engine-v0.14.0` / `config-v11`；以全新 30 种子 `P6-10` 检验三类离散结构 |
| [0012](0012-rules-v18-talent-inheritance.md) | 阶段 R2-B：`rules-v18` 代际人力资本传递与 30-run 探索探针 | accepted（2026-11-18） | 新增 `population.talentInheritanceWeight`（默认 0 与 v17 逐位一致）；`rules-v18` / `engine-v0.15.0` / `config-v12`；30-run 探索探针 `k=3` 未过门槛（`ARI=0.6145`），停止调参 |
| [0013](0013-p6-11-jev-prompt-causal.md) | 阶段 R3：`P6-11` 真实 Jev 提示词规范诱导宏观相变因果实验 | accepted（2026-11-18） | 预注册 30 新种子 × 3 组（`mock`/`live-neutral`/`live-survival_hint`）= 90 run；主指标 `|ΔO|>=0.05`（bootstrap 95% CI + 置换检验 + BH q=0.05）；不改核心规则 |
| [0014](0014-rules-v19-hard-capacity-lineage.md) | 阶段 R2-C：`rules-v19` 岗位容量硬门槛 + 代际出身折损 | proposed（2026-11-20） | 新增 `ascent.hardGateStrength` 与 `population.lineageDiscount`（默认 0 与 v18 逐位一致）；先做 30-run 探索探针，要求至少一个消融的 `median TV(P) ≥ 0.10` 再立项 240-run；不调旧 θH/θR/θS/H/share/w/k |
