# 0098 rules-v19 岗位容量硬门槛与代际出身折损（ADR 0014 实现）

- 日期：2026-11-20
- 关联：[ADR 0014](../adr/0014-rules-v19-hard-capacity-lineage.md)、[0078](../changes/0090-p6-r4-calibration-g6-closure.md)、[0092](0092-rules-v18-r2b-probe-result.md)
- 影响：`src/core`（`rules-v19` / `engine-v0.16.0` / `stratify-config-v13`）、`ascent.hardGateStrength`、`population.lineageDiscount`、`legal-actions.ts`、`engine.ts`、`decision/serialize.ts`、`app/view-model.ts`、`ui/arena/living-canvas.ts`
- 不改变：状态 schema 保持 `stratify-state-v5`；两个新参数为 `0` 时与 `rules-v18` 运行轨迹逐位一致

## 实现

1. 参数与版本
   - 注册 `ascent.hardGateStrength ∈ [0,4]`、`population.lineageDiscount ∈ [0,0.8]`，默认均为 `0`；
     绑定 `ascent.hardGateStrength`、`population.lineageDiscount` 计算式，进入 `configHash/paramsHash`。
   - `RULES_VERSION=rules-v19`、`ENGINE_VERSION=engine-v0.16.0`、`CONFIG_SCHEMA_VERSION=stratify-config-v13`。
   - `validate.ts` 新增 `v12R2C` 迁移默认（两项补 0），v12→v13 自动迁移；人口/上升字段白名单与域校验接线。

2. 岗位容量硬门槛
   - `computeAscendCost` 增加可选 `classShares` 入参：`o=min(P_c/classCapacity[c],1−1e−6)`，
     `M_gate=1+g·o²/(1−o)`，成本乘上 `M_gate`。
   - `enumerateLegalActions` 在计算费用前取 tick 期初占比，并把同一快照传给执行前复核
     （`engine.ts`）、决策序列化（`decision/serialize.ts`）、前端视图模型与剧场画布；
     避免按行动顺序逐次重算。`g=0` 时 `M_gate=1`，逐位退回 v18。

3. 代际出身折损
   - `spawnSuccessorsForDeaths` 在 v18 天赋传递之前按亲代阶级折损：
     `ge_base=clamp(ge_raw·(1−d·(1−c_parent/(C−1))), min, max)`；再叠加 v18 传递式。
   - `d=0` 时直接沿用 `ge_raw`（不做乘法），与 v18 逐位一致；公式不读取 O。

## 验证

- 新增/更新测试：
  - v12→v13 迁移补 0；默认配置新增字段断言；
  - 门槛：`g=0` 恒等、凸增公式、容量非正/占比缺项防御分支、枚举层面同一余额失去 `ascend`；
  - 折损：同一亲代与开放度下 `d=0.8` 压低新生儿 `ge` 且受 `ge.min` 钳制。
- `pnpm test`：933/933 通过；`pnpm test:coverage` 核心语句 98.68%、分支 95.04%
  （门槛 95%）；`pnpm test:coverage:runner` 语句 95.19%；`pnpm format`、`pnpm lint`、
  `pnpm typecheck`、`pnpm typecheck:core` 全绿。
- Golden 前滚：`test/fixtures/config/default-rules-v19.json` 与
  `default-rules-v19.hashes.json` 新增；`test/fixtures/engine/mock-run-rules-v19.json`
  由 v18 `git mv` 后就地重算（stats 逐位一致，`configHash/paramsHash/stateHash` 因
  schema 版本与新增字段变化）。历史 v18 config fixture 保留为只读累加证据。
- `param-definitions.json` 快照经 `pnpm params:snapshot` 重生成（105 个参数定义）。

## 边界

- 本轮只实现机制与默认关闭的逐位一致性；**未做任何实验、未调 `g/d`**。
- ADR 0014 阶段 1 的 30-run 探索探针（`explore-r2c`）尚未执行；执行前须在上海 VPS
  冻结预注册（6 cell × 5 全新 seed × 40 人 × 10950 tick，含单参数消融），
  门槛为至少一个消融 `median TV(P) ≥ 0.10`。
- 不构成校准，不改变 G6 未通过的结论，也不追认任何旧结果。
