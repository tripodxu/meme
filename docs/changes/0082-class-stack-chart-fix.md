# 0082 阶级结构堆叠图跨 tick 累加修复

- 日期：2026-11-12
- 作者：徐鼎（施工代理执行）
- 关联：changes/0070、docs/06 前端契约
- 性质：前端渲染缺陷修复；不改规则、参数、schema 或实验结论
- 影响范围：`src/ui/workspaces/overview.ts`、单测与 jsdom E2E

## 1. 问题

`classChart` 为每个阶级维护一个标量 `running`，在 `stats.map` 中**跨 tick 连续累加**
该阶级的存活占比。结果每条曲线随时间单调上升，数值远超 1；在 `yMax=1`、
高度 220 的图中，多边形坐标出现大幅负值（本地复现到 `-730`），堆叠面积冲出画布，
前端“阶级结构堆叠”显示严重错位。

## 2. 修复

- 新增并导出纯函数 `buildClassStack(rows, classCount)`：
  - 对每个 tick **独立**累加 class `0..i` 的存活占比，得到第 i 层上边界；
  - 结果 clamp 到 `[0,1]`，空数据返回空序列；
  - `classChart` 改为只负责把序列交给 `renderStackedArea`。
- 单测 `test/unit/ui/class-stack.test.ts`：校验逐 tick 累加、层序、边界与空数据。
- jsdom E2E 增加断言：阶级堆叠图所有 `polygon` 的 y 必须落在 SVG `viewBox` 内。

## 3. 验证

- `vitest run test/unit/ui/class-stack.test.ts`：2/2 通过。
- `pnpm test:e2e`：7/7 通过（含新增多边形边界断言）。
- `pnpm typecheck`、`pnpm lint`、Prettier、`pnpm build:web` 均通过。
- 浏览器实测 40 人 × 120 tick：五个 polygon 的 y 范围分别为
  `90.25–188`、`35–111.5`、`18–60.5`、`18–35`、`18–22.25`，全部位于 220 高的画布内；
  修复前同一图表出现 `-730` 级坐标。

## 4. 边界

- 只修正前端堆叠数据与回归测试；核心 `classCounts` 与统计口径未变。
- 该修复不产生校准或结构证据；G6 仍未通过。
