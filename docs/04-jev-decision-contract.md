# 04 Jev 决策协议

## 1. 职责边界

Jev 是 System One 判断模型，不是结算引擎。MVP 只使用 `choice`：每个到期个体一次请求，行动键直接包含竞争目标，禁止串联“先选竞争再选目标”。

Jev 不得计算或决定：Value、胜率、成本、阶级变更、寿命、网络连边、宏观指标、随机数和结构标签。`noul/score` 不进入 MVP 结算；后续研究只能作为独立实验字段。

## 2. Policy 统一输出

```ts
type DecisionSource =
  'mock' | 'random' | 'jev_live' | 'jev_replay' | 'mock_replay' | 'random_replay' | 'fallback';

interface DecisionRecord {
  schemaVersion: string;
  runId: string; // 服务器 run 或 local-<ulid>；离线 run 不得伪装 server run
  tick: number;
  agentId: string;
  stateHash: string;
  actionSetHash: string;
  legalActions: string[];
  policyVersion: string;
  promptVersion: string | null;
  promptStyle: 'neutral' | 'survival_hint' | null;
  requestedAction: string | null; // 模型原始首选；mock/random为null
  selectedAction: string; // 决策层校验/topK/回退后的最终选择，核心仍可能stale_invalid
  source: DecisionSource;
  probabilitySource: 'exact' | 'derived' | 'none';
  requestedModel: string | null;
  responseModel: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  topK: number;
  usage: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  attempts: number;
  fallbackReason: string | null;
  rawResponse: unknown | null; // live artifact；mock 可为 null
}
```

模型未返回概率时不得编造均匀概率并标为 exact。随机/mock 基线使用 derived。核心实际执行结果（含实际主动行动、stale_invalid/replay_invalid）另写执行记录，不覆盖 DecisionRecord 的 requested/selected 字段。

### 2.1 默认 mock 与 random 策略

`policyVersion` 纳入 run identity 和实验 manifest；任何权重、排序或采样地址变化都升级版本。

**`mock-weighted-v1`**：

1. 从当次 legalActions 构造权重：`accumulate=1`；每个 compete=0.10；ascend 仅当 `Value>=1.5×ascendCost` 时权重 0.8，否则 0；descend 仅当 `belowNeedStreak>=7` 时权重 1.2，否则 0。
2. 即使 ascend/descend 在核心合法集合中，不满足上述策略条件也把权重置 0。无正权重的非 accumulate 行动时只选 accumulate。
3. 按 legalActions 请求顺序做加权抽样，使用 `R(seed,tick,agentId,"mock_action",0)`，概率字段为归一化权重、probabilitySource=derived。
4. 不读取 Jev、不额外生成属性，不使用 topK。Jev 失败回退不是 mock，而是独立 `fallback/accumulate`。

**`random-uniform-v1`**：对全部 legalActions 等概率，使用 `R(seed,tick,agentId,"random_action",0)` 均匀选择；概率为 `1/legalActions.length`、probabilitySource=derived，不使用 topK。非法/空合法集属于核心错误，不由 random 猜测。

### 2.2 执行记录

决策层输出与实际结算结果必须分开保存，禁止用执行结果回写 `requestedAction/selectedAction`：

```ts
interface ExecutionRecord {
  schemaVersion: string;
  runId: string;
  tick: number;
  agentId: string;
  selectedAction: string;
  executedAction: string | null; // 实际生效行动；未执行为 null
  status: 'executed' | 'stale_invalid' | 'replay_invalid' | 'skipped_dead';
  reason: string | null; // 稳定码，如 target_taken/insufficient_value
  eventSeq: number | null; // 对应核心事件序号，便于回查账本
}
```

- `executed` 表示核心已按该行动结算；`stale_invalid`/`replay_invalid` 表示跳过了主动行动但个体仍进入日常积累；`skipped_dead` 表示决策后、执行前已死亡，仅作为防御性枚举保留：当前管线只在 E 阶段（C 积累之后）标记死亡，B/C 阶段仍存活者必然执行或失效，因此正常运行不得产生 `skipped_dead`；性质测试必须断言其为 0，若未来调整死亡时机再启用。
- 一次到期决策对应一条执行记录；竞争结果、费用和阶级变化仍以核心事件为准，不在执行记录中复制数值。
- 回放时按新世界重新生成执行记录，旧记录只用于对比，不得覆盖。
- 回放来源按原始策略区分：`jev_replay` 只表示重放 Jev 决策；重放 mock/random 日志分别标 `mock_replay`/`random_replay`，不得统一冒充 `jev_replay`。只有 `jev_replay` 计入“模型重放”统计，mock/random 重放属于确定性核心回归。

## 3. 输入序列化

### 3.1 原则

- 使用紧凑英文 JSON 和英文完整选项描述；不依赖中文键名让模型推断含义。
- state 只含决策相关字段，键集合固定，排除 API Key、run 写令牌、其他实验原始回答和无关人口全量。发给模型的 JSON 使用固定构造顺序以保证 prompt 稳定；`stateHash` 按 02 第 8 节对同一对象做 JCS 排序后计算，二者不得混用。字段增删或含义变化升级 `promptVersion`。
- 每个数值附明确字段名/单位；比率用 `[0,1]`，剩余寿命和 classAge 用 days。
- 最近事件最多 5 条，只保留类型、tick、关键数值；竞争目标最多 `competition.candidateCount` 个。
- `promptVersion` 随任何字段含义、选项描述、指令或排序语义变化而升级。

### 3.2 state 形状

```json
{
  "schema": "stratify-decision-v1",
  "tick": 120,
  "decisionIntervalDays": 10,
  "self": {
    "id": "a-0001",
    "classIndex": 1,
    "highestClassEver": 2,
    "value": 83.2,
    "talent": 1.04,
    "effort": 1.21,
    "remainingLifeDays": 20110,
    "daysInClass": 18,
    "needRatio": 0.72,
    "belowNeedDays": 0,
    "neighborCount": 4
  },
  "society": {
    "openness": 0.48,
    "gini": 0.31,
    "classPopulationShares": [0.4, 0.32, 0.17, 0.09, 0.02]
  },
  "costs": { "ascend": 140.5, "descend": 28.0 },
  "targets": [{ "id": "a-0008", "classIndex": 1, "value": 61.0, "isNeighbor": true }],
  "recentEvents": []
}
```

`society.classPopulationShares` 是**决策时点存活人口**的阶级份额 `P[c]`（不是初始份额）。`needRatio` 唯一定义为 `need===0 ? null : Value/need`，结果必须有限；最高/最低层不可用的 `costs.ascend/descend` 使用 `null`，该行动也不进入 legalActions。`costs` 是当前状态下实际应付的净额：已包含重返减免与开放度动态乘子；legalActions 的可用性与引擎扣费必须使用同一净额，不得让模型看到与结算不同的价格。`recentEvents` 每项固定为 `{tick,type,actorId,targetId:null|string,deltaValue:null|number,fromClass:null|int,toClass:null|int}`，按 `(tick,seq)` 取最近 5 项，不保留自由文本。目标只暴露代码允许的信息，不临时增加全人口隐私视图。`state` 与 `recentEvents` 的正式 JSON Schema 由 P2-02 随 `promptVersion` 生成并冻结
（当前 `prompt-v3` 副本：`schema/decision-state.prompt-v3.json`，由 `src/decision/schema.ts`
生成）；`stateHash/actionSetHash` 按 02 第 8 节计算。

### 3.3 System One 请求

上游端点：默认 `https://api.typesafe.ai/v1/systemone`，**必须可配置**（`JevClientOptions.endpoint`）。浏览器经同源 `POST /api/jev`，VPS 可直连。直连使用 `Authorization: Bearer <key>`；Worker 代理接收 `X-Api-Key` 并转成上游鉴权。Worker 代理在 P4-08 交付；P2 的真实冒烟走 VPS 直连，不依赖 Worker。

端点可配置的现实原因（2026-11-04 实测）：官方域名按来源地域返回 `451 Typesafe is not available in your region`，受限网络只能经自建网关转发；网关会把请求的模型名归一化成它实际提供的档位（请求 `jev-1.13.0` → 响应 `model` 为 `jev-1.13-free`）。因此**响应中的真实 `model` 必须落日志**，不得用请求名冒充。端点与 `tokenEstimatorVersion` 一样进入 run manifest：端点不同不改变决策语义，但影响可达性、实际模型名与计费单位。

```json
{
  "state": { "schema": "stratify-decision-v1" },
  "model": "jev-1.13.0",
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "Choose exactly one action for this agent for the next decision cycle. Use only the supplied state; do not calculate outcomes. Facts: competition moves value between agents and may destroy part of the transferred value; the engine determines the result.",
      "criteria": {
        "accumulate": "Take no active class or competition action; receive normal daily accumulation.",
        "ascend": "Pay 140.5 value to move one class upward if still affordable.",
        "descend": "Pay 28.0 value to move one class downward and reset class tenure.",
        "compete:a-0008": "Compete with agent a-0008 in class 1 with current value 61.0; the engine determines the result and wealth loss."
      }
    }
  }
}
```

实际 state 必须包含 3.2 的完整内容，上例为请求结构缩写。模型名通过配置和 Worker 允许列表管理；`jev-1.13.0` 是当前基线，不得假设永远最新。请求前复核官方模型文档，响应中的真实 model 必须落日志。

`promptStyle` 是实验处理变量：默认 `neutral` 只描述任务与事实，不提供“偏好长期生存/可持续流动”等规范性建议；`survival_hint` 才加入该建议，用于对照。`instructions` 中的事实必须由当前 config 生成：当 `baseTransferEfficiency×directionMultiplier<1` 时才说“会损耗”，等于 1 时必须说“总财富守恒”。`promptVersion` 覆盖 `promptStyle`、事实生成器和选项排序语义；任何变化都升级版本，不得在同一 `promptVersion` 下静默改变提示。

## 4. 响应校验与选择

预期响应含 `answers.action.probabilities`、可选 confidence、usage 和 model。处理顺序：

1. HTTP 成功且 JSON/schema 合法；否则走错误/回退流程。
2. 仅保留同时存在于 `legalActions` 的选项；忽略未知键并记录。
3. 概率必须为有限非负数；负值、NaN、Infinity 或全空不进入归一化。
4. 默认 `topK=1`，选合法概率最高者；并列时按 legalActions 稳定顺序。
5. 实验 `topK>1` 时，取前 K，按非负概率归一化，用 `R(seed,tick,agentId,"jev_topk",0)` 采样。
6. 合法概率总和<=0 或没有合法选项，回退 `accumulate`，记录 `empty_legal_probability`。
7. 执行前再次校验 state/actionSet hash 和核心合法性；过期响应不得用于新状态。

不得按字符串包含关系解析 `compete:<id>`；使用精确行动键到结构化行动的映射。

## 5. 回退原因

稳定枚举至少包括：

```text
timeout, network_error, http_401, http_403, http_429, upstream_5xx,
http_client_error, invalid_json, invalid_schema, no_legal_option, empty_legal_probability,
non_finite_probability, stale_state, stale_action_set, budget_exhausted,
usage_missing, retry_after_exceeded, retry_after_invalid,
cancelled, replay_invalid, stale_invalid
```

- 决策层失败默认回退 accumulate，并记录原始原因。
- 核心执行阶段失效只跳主动行动，不伪造新的 Jev 请求/响应。
- `cancelled` 不应当成一次模型质量失败；预算耗尽也不计入模型无效回答率。
- 认证失败持续发生时应停止 live run，而不是让全部个体默默 accumulate。

## 6. 超时、重试、取消与熔断

| 项                  | 默认约束                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 单次请求超时        | 30s，可配置并进入 run manifest                                                                                                               |
| 全局尝试上限        | 每个到期决策全部 HTTP attempt 合计最多 4 次，混合错误也共享此计数                                                                            |
| 网络/超时           | 分类最多 3 次；退避 0.5/1s，加由适配层注入且不消耗模拟 RNG 的抖动                                                                            |
| 429/529             | 分类最多 4 次；无 Retry-After 时退避 1/2/4s                                                                                                  |
| Retry-After         | 只接受整数秒；`0<=value<=20` 时按值等待，>20 或非法 HTTP-date 不等待重试，记 `retry_after_exceeded/invalid` 并回退                           |
| 其他 5xx            | 分类最多 2 次，退避 0.5s；仍受全局 4 次限制                                                                                                  |
| 400/401/403/404/422 | 不重试；401/403 立即暂停 live run 并提示 Key/权限问题                                                                                        |
| 取消                | AbortSignal 贯穿 fetch 和 sleep；已取消不再发新请求，run 在 tick 边界停止并置 `RunWindowReport.cancelled=true`；未结算 tick 的决策不进入产物 |
| 失败熔断            | 按请求完成顺序记录；最近 20 次 live 中 transport 失败>=10 或连续 transport 失败>=5，暂停 run                                                 |
| 回退率闸门          | 最近 100 个到期决策回退率>20% 时标记实验无效并暂停，配置可更严格                                                                             |

transport 失败只含 timeout/network/429/529/5xx；invalid schema 计入模型质量回退但不计 transport 熔断，cancelled 不计任一失败窗口，401/403 走立即暂停。每次响应完成时追加窗口记录，并发开始顺序不影响熔断。

Worker `/api/jev` 不在服务端再次重试上游，避免客户端重试叠加放大费用。VPS 的所有 worker 共享一个速率限制器和熔断/预算视图，不能每个线程各自一套额度。

## 7. 预算

启动前区分到期决策与 HTTP 调用：

```text
maxDueDecisions    = initialPopulation × ceil(totalTicks / decisionInterval)   # 预算上界
expectedDueDecisions = Σ各决策tick期初存活人数                                  # 实际值；早死/提前结束会降低
maxHttpAttempts    = maxDueDecisions × 4                                      # 静态预算上界
```

`maxDueDecisions` 只用于预算和完成前上界检查；`expectedDueDecisions` 用于 complete 的记录数核对，二者不得混用。真实 live run 必须设置：`maxCalls`（按 HTTP attempt 计，含重试）、`maxInputTokens`、`maxRunMinutes`；VPS 另设批次级 `maxCostUsd`（若上游返回可靠成本）和 `maxRuns`。

共享 BudgetManager 在**每次 HTTP attempt 前**原子预留 1 call 和本请求估算 input tokens；估算器使用版本化 `tokenEstimatorVersion`，输入为完整上游 body。无官方 tokenizer 时使用保守估算 `max(1,ceil(UTF8(body).byteLength*3/4))`（`utf8-three-quarter-v1`），该值用于调度预算，不冒充上游账单。**估算器必须严格高估**：`AttemptBudget` 一旦 `overageDetected` 就永久 `exhausted`，低估会让 live run 在第一次调用后自锁。先前的 `utf8-half-v1`（`bytes/2`）经 P2-07 实测为低估（真实请求 2170 字节 → 上游 `input_tokens=1200`，估算仅 1085），已废弃；样本与回归断言见 `test/fixtures/decision/`。成功响应按实际 usage 做 `actual-reserved` 核销；失败/abort 保留预留以覆盖可能的上游消耗。usage 缺失按预留量结算、增加 usageUnknownCount，并暂停正式 live run（`usage_missing`），不伪报 0。

在途请求不能超过剩余预留额度。实际 usage 超出估算时记录 budgetOverage 并立即停止新调用；由于上游 tokenizer 和在途响应不可预知，maxInputTokens 是 fail-closed 调度阈值，不宣称数学上保证供应商账单绝不越界。达到任一预算先停止新调用，等待在途 settled 后标记 `budget_exhausted`，不得标正常 completed。价格、上下文与速率限制接线前以官方文档为准，配置外置。

## 8. 并发与顺序

- 核心结果不依赖网络完成顺序；同一 tick 的决策全部基于同一期初快照。
- 每个 agent 同 tick 最多一个在途请求；响应按 tick/agent 归档，执行顺序由 03 的 action_order 随机键决定。
- 浏览器默认并发 2–4，VPS 默认从 4 开始压测；实际上限取配置、上游限制和配额的较小值。
- 限流等待不改变 RNG 地址；重试不得重新抽取 topK 或重新生成候选。
- 同一请求内容可计算 requestHash 用于诊断，但不得跨不同 run 自动复用模型回答；requestHash 若作为语义 hash 使用，必须先在 02 §8 注册独立 domain。

## 9. 回放与微扰

1. live 运行保存每次完整 DecisionRecord、合法行动、state/actionSet hash 和 rawResponse，以及独立的核心实际执行记录。
2. 回放按 `(tick,agentId)` 找记录并核对当前合法行动集；标准回放**只使用决策层最终的 `selectedAction`**，不得使用 requestedAction 让原本被回退的非法模型回答在新世界“复活”。
3. selectedAction 仍合法则交给核心重新执行前校验；不得重新调用 Jev。原核心是否曾 stale 只作审计，新世界按当前状态重新判断。
4. 不再合法则记 `replay_invalid`，回退 accumulate，继续用可寻址随机流。requestedAction 重放属于另一实验协议，MVP 不支持。
5. 回放来源标 `jev_replay`，report 与 `jev_live` 分开；mock/random 日志重放分别标 `mock_replay`/`random_replay`。三者都不得称重新获得了同样模型判断，只有 `jev_replay` 属于模型重放。
6. 微扰实验从同一权威检查点克隆，只改声明字段；模型行为对比与决策回放对比分报告，因为前者会重新调用模型，后者不会。

## 10. 代理与隐私

- Worker 仅接受白名单 state/model/questions，限制 body、问题数、选项数和模型 allowlist；不得成为任意 URL 开放代理。
- BYOK 只存在用户请求内存和上游 Authorization 头，不写 D1/R2/localStorage/日志/URL。
- MVP 不使用服务端公共 TypeSafe Key 为匿名访客付费。
- 原始响应属于实验 artifact，遵循保留策略；HTTP 访问日志不记录请求体。
- 官方接口文档：<https://docs.typesafe.ai/introduction/quickstart>；模型版本：<https://docs.typesafe.ai/models>。
