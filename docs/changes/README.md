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

| 编号                                                         | 标题                         | 日期       | 影响                                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-p0-validation-and-hash-fixes.md)                 | P0 校验与哈希基础层修复      | 2026-11-02 | 配置校验域、参数注册表、错误码；默认哈希不变                                                                                                    |
| [0002](0002-plan-and-experiment-contract-integration.md)     | 计划、实验与可复现性契约整合 | 2026-11-02 | 阶段拆分、聚类/预注册、runtimeVersion、artifact profile；无代码变更                                                                             |
| [0003](0003-p1-deterministic-core.md)                        | P1 确定性核心落地            | 2026-11-03 | 新增引擎/快照/策略模块；`openness.updateMode` 进入 configHash，默认哈希更新                                                                     |
| [0004](0004-rules-v4-decoupled-holding-cost.md)              | rules-v4 持有成本解耦        | 2026-11-03 | 需求线乘子 `(E[c]/E[0])^φ`、θM 8→3；v3 配置不再被接受；P1.5 重跑                                                                                |
| [0005](0005-rules-v5-holding-cushion.md)                     | rules-v5 上升持有裕度        | 2026-11-03 | `ascent.holdingCushionDays` 进入 configHash；ρ=0 退回 v4；v4 **config** fixture 保留只读（engine golden 按改名前滚约定不保留，见 artifacts §5） |
| [0006](0006-analysis-and-engine-integrity-fixes.md)          | 分析层与引擎实现完整性修复   | 2026-11-03 | 窗口统计/标签/extinct 修正；预注册哈希补 6 字段；`engine-v0.3.0`、`stratify-config-v2` 与 v1 迁移；P2 决策层隔离                                |
| [0007](0007-preregistration-cell-design-and-runner-gates.md) | 预注册格点自描述与证据链门禁 | 2026-11-03 | `cells[].design/changedPaths` 与重复格点拒绝；退化交互 cell 修正；均值场去静默假设；新增 `src/runner` 覆盖率门禁                                |
