# test/fixtures

测试固定数据目录。现有分组：`config/`、`engine/`、`hash/`、`decision/`。

## 约定

- 每个 fixture 必须包含 schema 版本与来源（文档章节或生成脚本），便于判断何时失效。
- 禁止写入密钥、个人数据，或未经脱敏的上游响应原文。**脱敏后的真实响应样本允许入库**
  （P2-03 要求），但必须在同目录 `README.md` 写明捕获条件、端点、脱敏范围与实测比例；
  `decision/` 是唯一允许存放上游真实响应的分组。
- golden 期望值更新必须附差异原因并人工审查；禁止用环境变量或 `--update` 一键覆盖后直接通过。
- 生成脚本读取已构建的 `dist/` 或 `src/`，不联网；更新后同时提交 fixture 与对应 golden 测试。

## 当前版本锚点

- `config/default-rules-v11.json` + `.hashes.json`：rules-v11 默认配置（config schema v6、state v3）；
  `default-rules-v10.json` 起为只读历史，v10 仍可复现 `configHash`，但 `paramsHash` 因注册表新增
  `ascent.occupancyMemoryDays` 不再可复算。
- `engine/mock-run-rules-v11.json`：rules-v11/engine-v0.9.0 的单文件前滚 golden。
  v10 的 engine golden 按改名前滚不保留，因此 `H=0` 与 v10 的等价性不再由 golden 承担，
  而由 `test/unit/engine/scarcity.test.ts` 的逐 tick 不变式固定：
  `society.occupancyPressure` 必须每期等于当期存活者占比派生的瞬时压力
  （600 tick × mock/random 两种策略逐位断言；H>0 时该等式应失效，作为反向对照）。
- `config/param-definitions.json`：参数注册表契约快照，由 `pnpm params:snapshot` 生成；
  生成器输出经 Prettier 格式化，无注册表变更时重复运行应为空 diff。
- `decision/systemone-{request,response}-2026-11-04.json`：真实 System One 请求/响应
  （P2-03）。来源与脱敏见 `decision/README.md`；用于断言 `parseJevResponse` 可解析真实
  响应，以及**估算器必须保守**（该样本 2170 字节 → 上游 1200 tokens）。
