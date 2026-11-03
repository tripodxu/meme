# 02 系统架构与模块边界

## 1. 架构总览

```text
Browser UI -> RunController -> Pure Core <- DecisionPolicy
                    |              |          |- Mock
                    |              |          |- Replay
                    |              |          '- JevClient -> Worker /api/jev -> TypeSafe
                    |              '- snapshots/events/stats
                    '- localStorage / export / Worker run API -> D1 + R2

VPS Batch CLI -> Same Pure Core + Same DecisionPolicy
              -> checkpoint/SQLite or JSON -> batch uploader -> Worker run API
```

核心结论：核心引擎不依赖任何运行端；Worker 只做轻量请求与数据服务；浏览器和 VPS 是计算执行者。

## 2. 运行端职责

| 运行端 | 负责                                                 | 不负责                                   |
| ------ | ---------------------------------------------------- | ---------------------------------------- |
| 浏览器 | 交互、mock/live 小规模运行、可视化、回放、临时保存   | 大规模扫描、暴露服务端密钥、复制结算逻辑 |
| Worker | 静态资源、同源 Jev 代理、认证、限流、D1/R2 I/O、导出 | 长循环仿真、海量事件入库、保存用户 BYOK  |
| D1     | run 元数据、聚合 tick、最终个体、实验和配额          | 原始决策全文、大事件流、周期快照blob     |
| R2     | gzip NDJSON 决策/事件/快照/最终状态分块              | 高频小范围关系查询                       |
| VPS    | 批量并发、长时运行、检查点、配对实验、上传           | 绕过共享预算、另写一套规则               |

## 3. 依赖方向

```text
core <- decision <- app <- ui
core <- runner
app  <- worker? 否；worker 只复用共享 schemas/types，不导入浏览器 app
shared/contracts -> app, worker, runner
```

- `src/core` 只能依赖标准纯计算库与自身；不得导入 DOM、fetch、localStorage、Node、Cloudflare、Jev SDK。
- `src/decision` 可依赖 core 的只读视图和共享 HTTP schema；不得修改核心状态。
- `src/app` 负责调度、持久化适配和取消；不得实现第二套规则。
- `src/ui` 通过 controller/view model 读取状态，不直接改 agent 字段。
- `src/worker` 只负责协议与存储；统计以 runner 提交的数据为准，不在请求中重放整局。
- `src/runner` 复用 core/decision/contracts；Node 专有代码不得被核心反向引用。

## 4. 核心公共接口

类型名为施工约定，可在不改变语义的情况下调整签名：

**seed 的归属**：`seed` 不是 `RunConfig` 字段，不进入 `configHash`。它是 `createSimulation` 的独立入参，`(config, seed)` 共同决定初始人口、初始网络、初始年龄和全部可寻址随机流；`paramsHash` 也不含 seed。配对实验要求同一 seed 下配置可比，因此 cell 级 `fullConfigHash` 必须在所有 seed 间相同。

```ts
function createSimulation(config: RunConfig, seed: Seed): SimState; // 初始人口由 (config, seed) 纯函数派生
function deriveInitialPopulation(config: RunConfig, seed: Seed): InitialPopulation;

interface SimulationEngine {
  step(state: SimState, decisions: ReadonlyMap<AgentId, Decision>): StepResult;
  snapshot(state: SimState): Snapshot;
  restore(snapshot: Snapshot): SimState;
  fingerprint(state: SimState): StructureFingerprint;
}

interface DecisionPolicy {
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord>;
}

interface RandomSource {
  unit(seed: string, tick: number, agentId: string, eventTag: string, counter: number): number;
}
```

`step` 只接收本 tick 已确定的决策；网络请求不得藏在 `step` 内。`StepResult` 包含新状态、事件和统计，不允许原地修改输入快照。性能优化若引入可变性，必须证明外部语义不变且快照隔离仍成立。

`createSimulation` 不接受独立 roster：初始人口、初始网络和初始年龄必须由 `(config, seed)` 纯函数派生，否则“同 seed 同初始人口”的配对和 `initialPopulationHash` 校验不成立。需要人为指定初始人口时，另立实验协议并升级 schema，不得在 MVP 中混用。

## 5. RunController 状态机

| 事件                          | 前置状态       | 后置状态                   | 副作用                                       |
| ----------------------------- | -------------- | -------------------------- | -------------------------------------------- |
| validate                      | idle           | validating/ready           | 校验成功冻结配置；失败回 idle 并显示字段错误 |
| start/resume                  | ready/paused   | running                    | 创建唯一推进循环                             |
| pause                         | running        | paused                     | 停止新决策，abort/settle 在途请求            |
| step                          | ready/paused   | paused                     | 仅完成一个 tick，中间可等待决策              |
| finish scheduled/extinct      | running/paused | completed                  | 写最终状态与 endReason                       |
| stop                          | running/paused | cancelling→cancelled       | abort 在途并保存诊断                         |
| invariant/budget/auth failure | running/paused | failed                     | 保存 reason 和诊断，不得自动转 mock          |
| reset                         | 任意非空闲状态 | idle                       | generation+1，旧响应全部失效                 |
| start replay                  | ready/paused   | replaying                  | 只读决策日志，禁止 live 请求                 |
| replay pause/resume/finish    | replaying      | paused/replaying/completed | 与 live 共用视图，不改来源标识               |

`uploadLagging` 是 running/paused/completed 可叠加的持久化标志，不是核心状态；`budget_exhausted` 映射 failed 并保留独立 reason。`cancelling` 完成前不得启动新 run。

约束：

- 每次 run 有单调递增 `generation`；重置后旧异步响应必须因 generation 不符被丢弃。
- 一个 run 同时最多一个推进循环；暂停先停止调度，再等待在途决策 settled/aborted。
- Jev 调用按 tick/agent 关联，响应只可用于对应 `configHash + stateHash + actionSetHash`。
- completed/cancelled/failed 为终态；重新开始必须新建 run 或显式 fork。
- 浏览器长任务分片调度，每片后可响应 UI；不得一次同步执行数千 tick。

## 6. 决策与结算流

1. 引擎从期初只读快照生成到期个体及合法行动。
2. 序列化器生成 `stateHash/actionSetHash`，策略返回 `DecisionRecord`。
3. 决策层再次校验行动；非法时按契约回退并记录原因。
4. 引擎按 03 的每 agent `action_order` 随机键确定顺序结算，每发起方一次、每目标每 tick 最多一场竞争。
5. 引擎完成固定管线，写事件、聚合指标、必要快照。
6. controller 推送视图模型；存储适配器异步持久化，不反向改变结果。
7. live run 保存全部决策；replay run 只读日志，非法原行动执行回退并标记。

## 7. 状态、快照和事件

- **权威状态**：完成某 tick 后的 `SimState`；快照包含 RNG 所需的 seed/counter 语义、慢变量、网络、baselineSum、死亡状态等全部未来所需字段。rules-v6 起 SocietyState 增补 `refIncome[C]`（需求参照系宏观状态，`stratify-state-v2`）：初值 `B×env0[c]` 由 `(config, seed)` 纯函数派生，阶段 C 全部 gain 算完后按 EMA 更新（先算后用），`'own'` 模式保持初值不更新。
- **事件**：用于解释和审计，不作为唯一权威状态；事件 schema 版本化。
- **聚合指标**：用于图表和查询，可由权威状态/事件重算；冲突时重算并报告。
- **决策日志**：live 复现的必需输入，包含原始响应、合法行动集哈希和回退原因。
- **配置**：保存完整 JSON 与 canonical hash；不能只存 UI 预设名。

快照写入必须原子：先临时文件/临时对象，校验后替换；未完成块不能作为恢复点。R2 artifact 清单记录每个块的 hash、大小、压缩和范围。

## 8. Canonical JSON 与哈希

所有语义 hash 使用 RFC 8785 JSON Canonicalization Scheme（JCS）和 SHA-256：

```text
hash(domain,value) = "sha256:" + lowercaseHex(SHA-256(UTF-8(domain + "\0" + JCS(value))))
```

- 输入只含 JSON 数据；对象键按 JCS 排序，数组顺序具有语义，不得随意排序。非有限数、undefined、bigint、函数在 canonicalization 前拒绝；`-0` 统一为 0，Unicode 不先做不兼容的本地化转换。
- `configHash`：domain `stratify-config-v1`，覆盖完整冻结 RunConfig，排除 `seed`、Key/token、wall-clock 和上传状态。注意该域前缀是**哈希契约**，与配置字段的 `CONFIG_SCHEMA_VERSION`（如 `stratify-config-v3`）是两条独立的轴：配置加字段只升后者，改前者会作废全部历史向量。
- `paramsHash`：domain `stratify-params-v1`，覆盖参数注册表解析后的全部业务参数名、值与单位；同样排除 seed、Key/token 和 wall-clock。用于 golden fixture 和“参数变化是否影响行为”的对照。
- `initialPopulationHash`：domain `stratify-initial-population-v1`，覆盖按 id 排序的初始 agents、初始 ties 和 seed。
- `stateHash`（决策）：domain `stratify-decision-state-v1`，覆盖 04 定义的完整序列化 state，不是整个 SimState。
- `actionSetHash`：domain `stratify-action-set-v1`，覆盖按请求顺序排列的 legalActions 字符串数组。
- `payloadHash`：domain `stratify-tick-row-v1` 或 `stratify-agent-row-v1`，覆盖除 payloadHash 自身外的完整行。
- `finalStateHash`：domain `stratify-authoritative-state-v1`，覆盖权威快照，排除日志、缓存和 wall-clock。
- `summaryHash/artifactManifestHash`：分别使用 `stratify-summary-v1/stratify-artifact-manifest-v1`；manifest chunks 按 `(kind,chunkId)` 排序，hash 字段自身排除。
- `preregistrationHash`：domain `stratify-preregistration-v1`，覆盖 07 定义的假设、primary metric、窗口、种子列表、标签阈值、排除规则和 base config；必须排除服务端生成的 `experimentId/createdAt` 与运行后观测字段（`observedResponseModels`、结果、失败次数），否则创建 experiment 后无法复算预注册 hash。
- `labelThresholdsHash`：domain `stratify-label-thresholds-v1`（P1-02 注册），覆盖 07 §10 的完整标签阈值表与 tolerance；与 `preregistrationHash` 同时覆盖，避免只记录版本字符串。

实现必须为上述每个 domain 定义**字段级 canonical 输入 schema**（字段名、可选性、`null`、数组顺序、排除字段）并固定 JSON 测试向量及预期 hash；仅写“覆盖 X”不足以支持独立实现。MVP 的权威 hash 只在受支持且 **`runtimeVersion` 相同**的 V8 运行时下承诺一致（记录 Node/workerd/Chromium 的完整版本）：核心大量使用 `Math.exp/log/pow/cos`，即使同为 V8，不同版本也可能出现 1 ulp 差异。Safari/Firefox 及版本不匹配的运行时必须标记 `nonAuthoritativeRuntime`，导出时警告，不得声称与权威 hash 相同。若不同 V8 版本产生不同 hash，必须按 `runtimeVersion` 分组，不得混入同一对照；若产品必须跨版本一致，先在 P1 实现 fdlibm 级确定性数学或注册跨运行时向量。任何 domain 覆盖字段或 schema 变化都升级 domain 版本，不复用旧 hash 含义。决策见 [ADR-0001](adr/0001-runtime-authority-and-hash-inputs.md)。

## 9. 数据规模策略

- 关系上限由 `network.maxDegree`、竞争候选由 `competition.candidateCount` 控制；禁止默认构造全人口两两候选。
- 宏观统计可按阶级/分位聚合；前端长序列按像素宽度降采样，导出保留原始聚合。
- D1 每批最多 100 tick；artifact 单块应用层上限 8 MiB，实际分块目标应更小以便重试。
- 定期快照而非每 tick 全量快照；默认间隔由配置决定并纳入 manifest。
- 1000 人长周期只由 VPS 执行；浏览器给出规模和预计 Jev 调用量警告。
- VPS 多 worker 的共享预算/限流必须由单协调进程或同机 SQLite WAL 原子预留在实现；MVP 不支持多主机分片，否则 `maxCalls/maxCostUsd` 只能各线程各自计数，无法作为硬约束。

## 10. 版本与兼容性

每个 run 创建时必须固定：

```text
schemaVersion, rulesVersion, engineVersion, decisionSchemaVersion,
policyVersion, promptVersion, requestedModel, seed, runtimeVersion,
configHash, paramsHash, initialPopulationHash, codeSha
```

`runtimeVersion` 记录实际执行运行端与版本（如 `node@22.21.0`、`workerd@<version>`、`chromium@<version>`）；它不改变 `rulesVersion`，但决定哈希权威性。

`responseModel` 是逐决策观测值，无法创建时固定；run 聚合保存去重 `responseModels[]`。若集合超过一个，按模型分组并标记模型漂移，正式对照默认判为质量无效，不能静默混样。

- 规则结算变化：`rulesVersion` 升级，旧结果不可直接并入同一对照组。
- prompt/合法行动描述变化：`promptVersion` 或 `decisionSchemaVersion` 升级。
- API 向后不兼容：URL/Schema 主版本升级；D1 迁移只追加。
- 重构若声称不改变行为，必须用 golden fixtures 证明哈希一致。
- artifact 读取器按 schemaVersion 分派；无法识别时拒绝，不猜测字段。

**配置 schema 迁移**：`CONFIG_SCHEMA_VERSION` 当前为 `stratify-config-v3`。v3 相对 v2 的差异是
`need.referenceMode/referenceSmoothing/graceDays` 为必填（rules-v6 需求参照系，changes/0008）。
v2 相对 v1 的差异是 `openness.updateMode` 由隐式变为必填（P1-10 开放度消融开关）。
迁移链由 `validateRunConfig` 入口按序执行，**不默认开新机制**：
v1 → v2 缺失的 `updateMode` 补 `dynamic`（v1 时期 O 恒为动态更新）；
v2 → v3 缺失的参照系参数补 `referenceMode:'own'`/`graceDays:0`/`referenceSmoothing:0.2`
（v2 时期 need 即 'own' 公式，宽限期 0 才与 v5 判定计时逐位一致）；
未知版本拒绝。

由于 `encodeSimState` 把完整 `config` 纳入权威状态（§8 `finalStateHash`），
配置 schema 升版会让**所有历史 `finalStateHash` 失效**——这是刻意的：哈希必须能区分
"哪个 schema 下产生的状态"。`restoreSnapshot` 只校验结构，不要求 `schemaVersion` 相等，
因此旧快照仍可恢复，但恢复后的状态哈希不得与新产物直接比较，必须按 schema 版本分组。

## 11. 故障边界

| 故障                | 系统行为                                              |
| ------------------- | ----------------------------------------------------- |
| 单个 Jev 失败       | 有限重试；按契约回退并记录，达到失败率阈值后暂停/失败 |
| 非法模型行动        | 不执行，回退 accumulate，保留候选和原因               |
| 上传失败            | 本地继续到安全上限或暂停；指数重试；不得重复完成 run  |
| 本地快照损坏        | 使用上一完整点，记录丢失区间并重跑                    |
| 配置/日志版本不兼容 | 拒绝导入，保留原文件，不自动改写成未知语义            |
| 核心不变量失败      | 立即终止 run，保存诊断快照；禁止 clamp 后假装正常     |

## 12. 架构变更触发 ADR 的情况

新增服务端实时推进、Durable Objects/Queues、替换权威数据库、改变 Jev 职责、改变 RNG 地址方案、引入第二结算引擎、改变权威状态或回放语义，均必须先写 ADR。普通函数拆分、UI 样式和无行为变化的性能优化不需要 ADR，但需要测试。
