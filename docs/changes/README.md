# 变更记录

记录会改变行为、契约或实验可比性的变更。目录只追加，不修改或删除历史条目。

## 命名

`NNNN-slug.md`，四位编号递增，slug 使用小写短横线。

## 必填内容

- 日期、作者、关联 PR 与 ADR。
- 受影响的 `rulesVersion`、`schemaVersion`、`promptVersion`。
- 兼容性说明：旧配置、旧快照或旧决策日志是否仍可读取。
- 实验可比性影响：已有基线是否需要重跑。
- 对应的 golden 测试与文档更新位置。

规则行为变更必须同时更新 [规则实现](../03-rules-implementation.md)、golden 测试和版本号；历史口径不再保留在契约文档中。

## 索引

| 编号                                                         | 标题                                    | 日期       | 影响                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-p0-validation-and-hash-fixes.md)                 | P0 校验与哈希基础层修复                 | 2026-11-02 | 配置校验域、参数注册表、错误码；默认哈希不变                                                                                                                                                                                                                                                |
| [0002](0002-plan-and-experiment-contract-integration.md)     | 计划、实验与可复现性契约整合            | 2026-11-02 | 阶段拆分、聚类/预注册、runtimeVersion、artifact profile；无代码变更                                                                                                                                                                                                                         |
| [0003](0003-p1-deterministic-core.md)                        | P1 确定性核心落地                       | 2026-11-03 | 新增引擎/快照/策略模块；`openness.updateMode` 进入 configHash，默认哈希更新                                                                                                                                                                                                                 |
| [0004](0004-rules-v4-decoupled-holding-cost.md)              | rules-v4 持有成本解耦                   | 2026-11-03 | 需求线乘子 `(E[c]/E[0])^φ`、θM 8→3；v3 配置不再被接受；P1.5 重跑                                                                                                                                                                                                                            |
| [0005](0005-rules-v5-holding-cushion.md)                     | rules-v5 上升持有裕度                   | 2026-11-03 | `ascent.holdingCushionDays` 进入 configHash；ρ=0 退回 v4；v4 **config** fixture 保留只读（engine golden 按改名前滚约定不保留，见 artifacts §5）                                                                                                                                             |
| [0006](0006-analysis-and-engine-integrity-fixes.md)          | 分析层与引擎实现完整性修复              | 2026-11-03 | 窗口统计/标签/extinct 修正；预注册哈希补 6 字段；`engine-v0.3.0`、`stratify-config-v2` 与 v1 迁移；P2 决策层隔离                                                                                                                                                                            |
| [0007](0007-preregistration-cell-design-and-runner-gates.md) | 预注册格点自描述与证据链门禁            | 2026-11-03 | `cells[].design/changedPaths` 与重复格点拒绝；退化交互 cell 修正；均值场去静默假设；新增 `src/runner` 覆盖率门禁                                                                                                                                                                            |
| [0008](0008-rules-v6-need-reference-frame.md)                | rules-v6 需求参照系（D-06 A′）          | 2026-11-04 | `refIncome` 计价 + `graceDays` 判定计时；`rules-v6`/`engine-v0.4.0`/`stratify-config-v3`/`stratify-state-v2`；own 模式逐位退回 v5（G-D 通过）；config/state fixture 与预注册哈希连锁更新；G-A/G-C 未过记录（W2 未启动）                                                                     |
| [0009](0009-rules-v7-cushion-reference-frame.md)             | rules-v7 裕度参照系统一计价             | 2026-11-04 | cushion class 模式改按 refIncome 计价；G-B 0.307→0.633 通过；G-A P0 仍 0（比例机制无下行流）；own 逐位不变                                                                                                                                                                                  |
| [0010](0010-rules-v8-displacement-admission.md)              | rules-v8 位移准入（D-09）               | 2026-11-04 | 'class' 上升须击败在位者、败者降级（零和下行流）；P0 恢复储水池且分布稳态；mUp 环流饱和 ~0.95 为残余失效（判定树耗尽，决策项登记）                                                                                                                                                          |
| [0011](0011-w2-confirmation-and-g15-verdict.md)              | W2 确认轮与 G1.5 判定                   | 2026-11-04 | rules-v8 位移体制 780 run（p15r3 种子、26 cell）：**G1.5 未通过——无宏观二态**（k=2 ARI median 0.415 < 0.70 硬门槛）；均值场方向全 cell 成立；P2–P6 继续搁置，规则评审证据链齐备                                                                                                             |
| [0012](0012-rules-v9-displacement-share.md)                  | rules-v9 位移准入份额（D-11）           | 2026-11-04 | 新增 `ascent.displacementShare`（默认 1 与 v8 逐位一致）；`rules-v9`/`engine-v0.7.0`/`stratify-config-v4` + v3→v4 迁移；探索结论为**负面**：share<1 导致棘轮与种子噪声主导，不产生稳定第二结构；后续需占用锚定机制或 route C                                                                |
| [0013](0013-rules-v10-occupancy-anchoring.md)                | rules-v10 占用锚定（D-12）              | 2026-11-04 | 新增 `ascent.scarcityWeight`（默认 0 与 v9 逐位一致）；目标阶级超机会隐含份额时抬升上升余额门槛；`rules-v10`/`engine-v0.8.0`/`stratify-config-v5` + v4→v5 迁移；探索得到 A/B/C 三个参数区域（底重金字塔 / 上位中产 / 中产隆起），高权重恢复底层至 P0≈0.10；仍未证明双稳态，不宣布 G1.5 通过 |
| [0014](0014-w4-v10-confirmation.md)                          | W4 确认轮与 G1.5 判定（D-13）           | 2026-11-04 | 预注册 `buildV10ConfirmationManifest()`（prereg `ece0a98b…`，`p15r4-*` 新种子，6 cell × 30 = 180 run）：k=2 ARI median/min **1.000**、temporal 1.000、方向预测过 → **G1.5 通过（≥2 类）**；簇为 A vs B∪C，只有两类，P6-05 的 ≥3 类仍未满足；C-w100 方向余量薄，口径须下轮写死               |
| [0015](0015-p2-decision-layer-production.md)                 | P2 决策层生产化与加固（P2-01/02/05/06） | 2026-11-04 | `policy/serialize/jev-client/live` 迁入 `src/decision/`；`DecisionPolicy` 生产接口、`runSingleWithPolicy`、`RunOutcome.decisions`；P2-06 replay、冻结 JSON Schema、重试/预算/取消/熔断加固、`topK>1` 采样；P2-07 真实冒烟待密钥                                                             |
| [0016](0016-p15-path-dependence.md)                          | P1.5 路径依赖探索（探索层）             | 2026-11-04 | runSingle initialState；up/down/control 路径实验（3 ICs、375 run）；up 锁定 10/10（middle）、down/control 0；mUp gap 26.7–50.0 且长期持续；判为路径依赖锁定候选，不构成 G1.5/P6 证据                                                                                                        |
