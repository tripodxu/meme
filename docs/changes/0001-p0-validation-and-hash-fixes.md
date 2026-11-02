# 0001 P0 校验与哈希基础层修复

- 日期：2026-11-02
- 作者：徐鼎（评审与修复执行：Claude Code）
- 关联：评审记录 [2026-11-02 P0 评审](../reviews/2026-11-02-p0-review.md)；主要修复提交范围 `af4712f..7134617`（本记录为追加文档）
- 受影响版本：`rulesVersion`/`engineVersion` 不变（尚未进入 P1 结算）；`CONFIG_SCHEMA_VERSION` 仍为 `stratify-config-v1`

## 变更

1. **JCS 稀疏数组**：`canonicalize` 拒绝稀疏数组，不再输出 `[1,,3]` 这类非法 JSON。
2. **竞争转移上限**：`baseTransferEfficiency` 收紧为 `[0,1]`，并把同层/防守的隐含乘子 1 纳入 `gain<=loss` 校验。
3. **guardOnly 修正**：`emptyClassPopulationFloor` 改标为影响行为；`hardLifeFloor` 增加 `<= 1+hardLifeFactor×(attributes.hard.min-1)` 关系约束。
4. **配置合并**：`mergeConfig` 递归合并纯对象，数组整体替换，嵌套分布覆盖不再丢字段。
5. **注册表单一来源**：配置校验的标量/数组范围改为从 `ParameterRegistry` 读取，删除重复常量；新增参数定义快照。
6. **参数域收紧**：截断分布 sigma 受截断跨度约束；power 指数上限 4、`hardLifeFactor` 上限 10、开放度权重上限 100。
7. **错误模型**：ID 与哈希错误统一为 `StratifyError`，新增 `id_invalid/hash_invalid/hash_domain_invalid`。
8. **契约与文档**：统一 `metrics.mobilityWindowDays` 等命名；明确窗口统计的全分辨率数据来源、实验 overrides 寻址、identity 一致性校验，以及 P0 推迟项。

## 兼容性

- 默认配置的 `configHash` 与 `paramsHash` 不变。
- 此前能通过校验、但超出新域（如 `baseTransferEfficiency>1`、过大 sigma/指数、非法 `hardLifeFloor` 关系）的配置现在会被拒绝；前端表单与 runner manifest 必须使用 03 §3.1 的新范围。
- 未发布任何迁移、artifact 或回放格式，因此不涉及旧数据升级。

## 实验可比性

仓库尚无仿真结果或校准基线，不触发已有实验重跑。P1 开始后，这些参数域与校验规则将进入 `configHash` 覆盖和 golden 证据。

## 验证与文档

- 本地：`format`、`lint`、`typecheck`、`typecheck:core`、`build`、`check:docs`、`test:coverage`、`test:integration`、`test:e2e` 通过；160 个测试，statements 98.36%、branches 96.68%。
- 同步文档：[03 规则实现](../03-rules-implementation.md)、[04 Jev 契约](../04-jev-decision-contract.md)、[05 API 契约](../05-api-data-contract.md)、[07 实验校准](../07-experiment-calibration.md)、[08 测试门禁](../08-testing-quality.md)、[10 工程约定](../10-engineering-conventions.md)、[12 交接清单](../12-handoff-checklists.md)。
- 新增 golden：`test/fixtures/config/param-definitions.json` 与 `test/golden/param-definitions.test.ts`；生成命令 `pnpm params:snapshot`，更新须人工审查 diff。
