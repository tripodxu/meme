# 0001 运行时权威与哈希输入 schema

- 状态：proposed
- 日期：2026-11-02
- 决策者：架构/核心负责人
- 相关任务：P1-02、P1-07、P5a
- 取代/被取代：无

## 背景

语义 hash 用于配置、初始人口、决策、快照、实验预注册和 artifact 校验。当前契约只声明“权威 hash 在受支持的 V8 运行时承诺一致”，但没有记录具体运行时版本，也没有为每个 domain 定义字段级 canonical 输入 schema。核心大量使用 `Math.exp/log/pow/cos`；即使同为 V8，不同版本也可能出现 1 ulp 差异。独立实现若只依赖“覆盖 X”的文字描述，可能对可选字段、`null`、数组顺序或排除字段产生不同理解。

## 决策

1. 每个 run 的 identity 记录 `runtimeVersion`（如 `node@22.21.0`、`workerd@<version>`、`chromium@<version>`）；`runtimeVersion` 不改变 `rulesVersion`，但决定哈希是否权威。
2. 只有 `runtimeVersion` 相同，或已注册对应跨运行时测试向量时，两个 hash 才可声称相等；否则标记 `nonAuthoritativeRuntime`，不得混入同一正式对照。
3. 每个 hash domain 必须在文档与代码中定义 canonical 输入 schema：字段名、可选性、`null` 语义、数组顺序、排除字段和版本。仅写“覆盖 X”不合格。
4. P1-02 为每个 domain 交付 schema、固定向量与预期 hash；CI 至少在 Node 与 workerd 上校验，记录实际版本；Chromium 在 E2E 中校验。
5. 浮点差异不得静默归一化或 clamp；发生哈希不一致时 fail closed，按版本分组或停止正式对照。

## 备选方案

| 方案                         | 优点       | 代价                              | 未采用原因                     |
| ---------------------------- | ---------- | --------------------------------- | ------------------------------ |
| 只支持单一 Node 版本         | 实现最简单 | 浏览器/workerd 无法作为权威运行端 | 违背三端同源目标               |
| 立即实现 fdlibm 级确定性数学 | 跨引擎一致 | P1 成本高、性能风险               | 先记录版本并验证，必要时再引入 |
| 只保留文字覆盖说明           | 文档成本低 | 独立实现易漂移，无法审计          | 不能作为可复现性契约           |

## 后果

- 正面：哈希差异可归因到版本；domain schema 可独立实现和审计；正式对照不会混用不同运行时。
- 负面/限制：identity 增加字段；CI 需要多运行时矩阵；跨版本比较需额外注册向量。
- 需要新增或修改的测试：每个 domain 的 schema/向量测试；Node/workerd/Chromium 版本记录；版本不匹配时的 `nonAuthoritativeRuntime` 路径。
- 需要同步的文档与版本字段：02 §8/§10、05 run identity、08 测试矩阵；不改变 `rulesVersion`。

## 兼容性

P0 的 `configHash/paramsHash` 向量不受影响；尚无已发布 run/artifact。新增 `runtimeVersion` 属于 identity 扩展，旧本地文件可缺失该字段但不得标为权威。

## 验证

待 P1-02 实现。验证证据必须包含各 domain 的字段级 schema、固定向量、Node 与 workerd 的实际版本，以及版本不匹配的拒绝/标记测试。
