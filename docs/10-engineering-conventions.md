# 10 工程协作约定

## 1. 工具链与安装

- Node.js >=22.18；pnpm 版本写入 `packageManager`，CI 使用 lockfile 冻结安装。
- 全仓 TypeScript ESM、`strict: true`；构建目标明确区分浏览器与 workerd/Node。
- 新增依赖必须说明用途、体积、维护状态和运行端；核心优先零依赖。
- 不把 API Key、writeToken、Runner token 或真实个人数据写入仓库/fixture。

## 2. 命名与单位

- 文件：`kebab-case.ts`；类型/类：`PascalCase`；函数/变量：`camelCase`；常量：`UPPER_SNAKE_CASE`。
- 社会阶级字段在代码中用 `classIndex`，避免与语言关键字和 UI class 混淆；财富沿用 `value`，不用含糊的 `money`。
- 时间字段带单位：`tick`、`days`、`timeoutMs`、`retentionDays`；比率用 `[0,1]`，百分数仅在显示层转换。
- ID 带类型：`RunId/AgentId/ChunkId`；外部模型字符串不得直接当合法行动。
- 事件名用过去式 snake_case，如 `class_ascended`、`competition_resolved`；API 用 camelCase JSON。

## 3. TypeScript 与数值

- 禁止 `any` 逃逸公共边界；外部输入先 schema 校验，再转内部类型。
- 外部 JSON 不得直接断言为 `RunConfig/Snapshot/DecisionRecord`。
- 核心状态字段只读暴露；结算通过明确函数返回新结果。
- 所有非有限数在产生处报错；禁止用 `value || 0` 掩盖 NaN，使用 `Number.isFinite`。
- 金额/Value 使用 number 但不得负值；只在文档明确规定处使用容差（如配置比例和），费用/财富比较默认直接比较，禁止随处自行取整或引入 epsilon。
- 禁止在核心调用 `Math.random()`、`Date.now()`、`new Date()`、`crypto.randomUUID()`；ID 和时钟由适配层注入。
- 所有业务常数来自 `src/core/params.ts` 的 `ParameterRegistry`；禁止在结算函数写裸字面量。新参数必须有名称、单位、合法域、公式引用和接线测试。
- `src/core` 必须通过 `pnpm typecheck:core`（`tsconfig.core.json` 不含 Node 类型）；新增依赖不得让该检查失败。
- 初始人口/网络/年龄由 `(config,seed)` 纯函数派生；不得在核心接受独立 roster 或隐式全局状态。
- 权威哈希的跨运行时承诺只覆盖 V8（Node >=22、workerd、Chromium）；使用 `Math.exp/log/pow/cos` 时不得声称跨引擎 1 ulp 一致，除非已实现确定性数学层。
- 不使用对象键遍历顺序决定结算；候选人、阶级和行动均显式排序。

## 4. 核心与随机数

- 所有随机行为必须带 `seed/tick/agentId/eventTag/counter`；eventTag 注册在中央常量表。
- 初始化使用保留 tick/地址空间，不与运行期事件混用；新增 tag 不改旧 tag 字符串。
- 不得为了减少代码把多个随机消费合并为含义不明的通用 tag。
- 重构不得改变随机调用次数或顺序；确需改变时升级规则/引擎版本并更新 golden。
- Jev topK 采样、竞争判定、网络重构和初始化使用不同 tag。

## 5. 错误与日志

- 公共错误包含稳定 `code`、可读 `message`、可选 `details` 和 `requestId`；堆栈只进受控服务端日志。
- 核心不变量错误立即失败，不静默修正；用户输入错误返回字段路径。
- 日志字段化，不拼接敏感大文本；禁止记录 Authorization、X-Api-Key、writeToken、完整原始 Key。
- Jev 原始响应可存实验 artifact，但需遵循保留策略；HTTP 访问日志不记录请求体。
- 前端错误界面保留可复制 runId/requestId，不暴露服务端环境变量。

## 6. 测试约定

- 测试名描述行为和边界，不写“test1”或只镜像函数名。
- fixture 包含 schema 版本和来源；golden 更新必须附差异原因，禁止直接批量覆盖后通过。参数注册表定义由 `test/fixtures/config/param-definitions.json` 冻结，变更时运行 `pnpm params:snapshot` 并人工审查 diff。
- 单元测试不访问真实网络；集成测试用本地 workerd/D1/R2；live 测试独立且有预算。
- 每个 bug 修复先添加可失败的回归测试；每个规则改动同步更新映射测试。
- 测试不得依赖本机绝对路径、当前时间或未固定 locale。

## 7. Git 与评审

推荐 trunk-based 短分支；提交使用 Conventional Commits：

```text
feat(core): implement historical need baseline
fix(replay): reject decisions for stale action sets
test(network): cover isolated agents
docs(plan): clarify calibration gate
```

PR 必须包含：

1. 目的、关联任务 ID、行为/兼容性影响。
2. 实现摘要、测试证据、性能或成本影响。
3. 规则/API/prompt/存储变更对应文档和版本更新。
4. 若改 golden，列出前后指标和原因；若改迁移，说明回滚/前滚策略。
5. 自检无密钥、无生成大文件、无不相关格式化。实验产物的入库白名单与 5 MiB 体积上限见
   [产物登记](reference/artifacts.md)，表外文件一律不入库。

至少一名非作者评审公共契约、核心结算和安全变更。不得自行合并失败 CI 的 PR。

## 8. ADR 约定

存放 `docs/adr/NNNN-title.md`，包含：状态、背景、决策、备选、后果、兼容性、验证。状态为 proposed/accepted/superseded/deprecated。

以下必须 ADR：新基础设施、公共协议不兼容、Jev 职责变化、核心更新顺序变化、RNG 地址变化、权威状态/回放语义变化、新增第二前端框架或第二规则实现。

## 9. 文档与版本

- 文档和代码同 PR 更新；不接受“先实现，文档以后补”作为完成状态。
- 已发布迁移只追加；已发布 event/artifact schema 通过新版本扩展，不复用旧版本改变含义。
- `rulesVersion` 管社会结算，`promptVersion` 管 Jev 输入，`schemaVersion` 管序列化，三者不得混用。
- 校准预设包含配置全文、hash、证据和校准日期；代码里不得只写“recommended”。
- 每次阶段结束记录：完成任务、验证命令、未决问题、下一任务和已知风险。

## 10. 禁止事项

- 禁止从 UI 或 Worker 复制财富/竞争/寿命公式。
- 禁止通过额外随机噪声伪造结构敏感性。
- 禁止只挑成功种子展示结论。
- 禁止为让测试通过而吞掉不变量错误、关闭 schema 校验或无限重试外部 API。
- 禁止无预算真实 Jev 批量运行、明文密钥落库、跨实验复用 writeToken。
- 禁止在未阅读 `docs/README.md` 的效力规则时自行选择冲突口径。
