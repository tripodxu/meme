# 0029：H=0 等价性固化为测试，参数快照生成器接入 Prettier

- 日期：2026-11-04
- 作者：核心/规则负责人
- 关联：rules-v11 占用压力记忆（`changes/0027`）、参数注册表冻结（`changes/0001`）
- 性质：**测试与工具链变更**；不改变规则、参数、默认配置与版本号

## 1. 变更

### 1.1 `H=0 ≡ v10` 从一次性核验变成永久测试

v11 把占用压力从「本 tick 现算」改成「上一 tick 派生进状态」。两者逐位等价依赖一个逐 tick
不变式：

```text
society.occupancyPressure(c) ≡ max(0, share_c / target_c − 1)   （每 tick 期初，H=0）
```

`changes/0027` 记录该等价性「与 v10 golden 逐项相同」，但 v10 的 engine golden 按改名前滚
约定未保留在树里，该声明无法从 HEAD 复现。现改为由 `test/unit/engine/scarcity.test.ts`
新增的两个断言块承担：

- 600 tick × `mock-weighted-v1` / `random-uniform-v1`：每 tick 期初逐位断言上式成立，
  并校验场景非空跑（正压力覆盖超过半数 tick、发生升降阶事件）；
- `H=10` 反向对照：同一断言必须失效（默认配置实测在 tick 41 分叉），证明该等式约束实现而非恒真。

### 1.2 参数快照生成器输出经 Prettier 格式化

`scripts/generate-param-snapshot.mjs` 原先直接写 `JSON.stringify(…, null, 2)`，且已新增
`description`/`source` 两个顶层键但未回写 fixture，导致 `pnpm params:snapshot` 在任何注册表
变更之外也必然产生 diff，随后又被 `pnpm format` 改回。现生成器：

- 使用 `prettier.format(…, { filepath })` 按 `.prettierrc` 输出；
- fixture 同步补上 `description`/`source`（符合 `docs/10` §5「fixture 包含 schema 版本和来源」）。

重复运行 `pnpm params:snapshot` 现在为**空 diff**。

## 2. 版本与兼容性

- `rulesVersion` / `engineVersion` / `configSchemaVersion` / `stateSchemaVersion` / `paramsHash`
  均不变；无参数增删。
- `test/fixtures/config/param-definitions.json` 仅新增两个顶层元数据键，`definitions`
  数组逐字节不变；`test/golden/param-definitions.test.ts` 只读取 `schemaVersion` 与
  `definitions`，断言不变。

## 3. 实验可比性

无影响。本变更不触碰 `src/core`、`src/decision`、`src/runner` 的行为路径，已有基线
（W4/W5/W6、`out/` 全部产物）无需重跑；产品与证据哈希不变。

## 4. 文档更新位置

- `test/fixtures/README.md`：v11 锚点改为指向逐 tick 不变式测试，并登记快照幂等约定。
- `docs/08-testing-quality.md` §5 golden 清单：新增跨版本等价性不变式条目。

## 5. 验证

`pnpm test`（新增 3 项，占用压力文件 13 项全过）、`pnpm test:coverage` 门禁、`pnpm format`、
`pnpm lint`、`pnpm typecheck`、`pnpm typecheck:core`、`pnpm check:docs`、`pnpm params:snapshot`
幂等性检查。
