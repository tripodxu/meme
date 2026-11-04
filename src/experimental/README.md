# src/experimental

**未接入生产路径的实验代码，不参与任何正式实验判定。**

该目录的存在是为了让「已写但未获准启用」的实现在物理上与生产代码分离：它们可以继续演进和测试，
但不可能被 runner/CLI 误当作已完成能力调用。任何模块迁出本目录，必须在变更登记中说明
它对应的闸门（如 G1.5 / G5a）已通过，并补齐接线测试。

## 当前内容

（空）

`p2-decision/` 已于 2026-11-04 P2 启动时迁回 [`src/decision/`](../decision/README.md)：
W4 确认轮通过 G1.5（`changes/0014`），ADR-0002 的「G1.5 通过即迁出」条件触发，
决策见 [ADR-0003](../../docs/adr/0003-p2-decision-layer-production.md) 与 `changes/0015`。

## 约束

- 本目录不得被 `src/core`、`src/runner`、`src/decision`、`scripts` 导入；
  一旦出现这样的导入，说明隔离已被破坏，必须改回生产目录并走正式版本轴。
  该约束由 `test/unit/architecture.test.ts` 机器强制，不依赖人工 review。
- 本目录代码不进入 `pnpm typecheck:core`（该命令只检查 `src/core`）。
- 单元测试可以保留在 `test/unit/experimental/`，用于防止实现腐烂；
  测试通过不代表能力已启用。
