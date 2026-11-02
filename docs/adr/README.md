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

| 编号 | 标题 | 状态 | 影响                                    |
| ---- | ---- | ---- | --------------------------------------- |
| —    | 暂无 | —    | 施工前规格阶段尚未产生需 ADR 的既成决定 |
