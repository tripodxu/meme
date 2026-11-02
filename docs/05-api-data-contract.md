# 05 API 与数据契约

## 1. 通用约定

- 同源 JSON API 前缀 `/api`；时间戳 ISO 8601 UTC，tick 为整数；ID 为不透明字符串。
- 请求 `Content-Type: application/json`（artifact 原始块除外）；未知字段默认拒绝，避免拼写错误静默失效。
- 写操作需要认证；读取仅提供非敏感实验数据，不宣称私密空间。若未来增加私人实验，必须另做授权 ADR。
- 每响应带 `X-Request-Id`；错误使用统一结构：

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Human-readable summary",
    "details": [{ "path": "ticks[3].gini", "reason": "must be between 0 and 1" }]
  },
  "requestId": "req_..."
}
```

稳定码：`bad_request,validation_failed,unauthorized,forbidden,not_found,conflict,state_conflict,payload_too_large,rate_limited,quota_exceeded,upstream_error,internal_error,unsupported_version`。`/api/jev` 上游非 2xx 保留 HTTP 状态和 Retry-After，但 body 也统一为本结构：`code=upstream_error`，`details.upstreamStatus` 为上游状态；代理自身 502 时 upstreamStatus=null。不得透传未知上游 body 让客户端猜两种错误协议。

## 2. 认证

- `POST /api/runs`：浏览器来源可匿名创建 `source=browser`，受 IP 配额；正式 runner 必须 `Authorization: Bearer <RUNNER_TOKEN>`，服务端强制 `source=runner`。
- 创建成功返回 32 字节以上随机 `writeToken`，仅此一次显示；数据库只存 SHA-256 hash 和可识别前缀。
- 浏览器只把 `writeToken` 存在当前标签页的 `sessionStorage`（键 `stratify.runToken.<runId>`），不写 localStorage；标签页关闭后不再续传，服务器 run 由静默超时清理。刷新后可续传同一 run；关闭标签页后需要重新创建 run。
- 后续 run 写接口：`Authorization: Bearer <writeToken>`。writeToken 仅属于一个 run，不可创建其他 run。
- `/api/jev`：`X-Api-Key: <用户TypeSafeKey>`，Worker 转发为上游 Bearer；不使用 run writeToken。
- 日志不得记录 Authorization、X-Api-Key 或 writeToken；Runner token 只放 Worker secret/VPS 环境。

## 3. Run 状态机

```text
running -> completed | failed | cancelled
```

- 创建时配置即冻结并直接进入 running，不提供配置修正或 start 接口；修改配置必须新建 run。
- running 接受批次和 artifact；complete 原子转 completed。
- `POST /api/runs/:id/cancel` 与 `POST /api/runs/:id/fail` 使用 writeToken，body 为 `{reason,finalTick:null|int,diagnosticsHash:null|string}`；服务端内部错误也可写 failed。
- completed/failed/cancelled 为写终态，后续写入返回 409 `state_conflict`；重复 complete/cancel/fail 且内容相同可幂等返回 200，不同则 409。
- failed/cancelled 保留已上传数据供诊断，不能冒充正式完成实验。completed 只表示技术上传完成，实验质量另见 verificationStatus。

## 4. HTTP 接口

### 4.1 健康与模型代理

`GET /api/health`：返回 `{status,version,time}`，可含 D1/R2 可用性，不返回环境变量。

`POST /api/jev`：

- body 仅 `state/model/questions`，questions 只允许一个 `action` choice；选项最多 **9**（accumulate/ascend/descend 加最多 6 个目标）。
- body 应用层上限 256 KiB；模型必须在服务端 allowlist；Key 必填。
- 同源使用，不开放任意跨域；不转发用户提供的 URL、headers 或其他上游字段。
- 超时、网络失败映射 502 `upstream_error`；429/529 保留状态与 Retry-After，错误 body 按第 1 节统一包装；服务端不重试。

### 4.2 实验与 run 创建/读取

`POST /api/experiments`：仅 RUNNER_TOKEN 可用，body 为 07 的完整 experiment manifest 但省略 experimentId/createdAt（二者由服务端生成），返回 201 `{experimentId,createdAt}`。`preregistrationHash` 由客户端在提交前按 02 §8 计算并随 body 提交；服务端用同一规范重算并校验，不一致返回 422。`GET /api/experiments/:id` 返回 manifest、关联 runs 和派生进度；MVP 不提供覆盖式修改，变更实验定义需新建 experiment。

创建 run 时可带 `experiment:null|{experimentId,cellKey,seed}`。browser 必须为 null；runner 绑定时服务端在同一 transaction 校验 experiment 存在、cell/seed 已声明，并写 experiment_runs，重复 `(experimentId,cellKey,seed)` 返回 409。

`POST /api/runs`

```json
{
  "schemaVersion": "run-v1",
  "source": "browser",
  "experiment": null,
  "config": {},
  "identity": {
    "rulesVersion": "rules-v3",
    "engineVersion": "0.1.0",
    "decisionSchemaVersion": "stratify-decision-v1",
    "policyVersion": "mock-weighted-v1",
    "promptVersion": "prompt-v2",
    "requestedModel": "jev-1.13.0",
    "seed": "seed-001",
    "configHash": "sha256:...",
    "paramsHash": "sha256:...",
    "initialPopulationHash": "sha256:...",
    "codeSha": "git-sha"
  },
  "schedule": { "totalTicks": 3650, "statsStride": 10, "snapshotStride": 100 }
}
```

服务端按 02 第 8 节校验 `configHash`，并用 `(config, seed)` 重算 `initialPopulationHash`；不一致返回 422，防止客户端自报 roster 破坏配对。返回 201 `{runId,writeToken,status:"running"}`。source 由服务端根据认证确定，不能由 runner 伪造 browser 或反之。服务端生成的 `runId` 只允许 `[A-Za-z0-9_-]{1,64}`；任何进入 R2 key 或 `sessionStorage` 键的 id 必须先通过该字符集校验。

离线 run 不属于该接口：MVP 中离线 mock run 使用本地 `runId=local-<ulid>`，只支持导出/回放，不支持直接采纳为服务器 run；需要云端归档时，用同一 `config+seed` 新建服务器 run 并重新执行。该限制必须在前端明确显示，不得让用户误以为离线 run 已上传。

调度字段只认一个来源：`totalTicks/statsStride/snapshotStride` 属于 `RunConfig.schedule`；`flowWindowDays/MupWindowDays` 属于 `RunConfig.metrics`；二者都进 `configHash`。顶层 `schedule` 只镜像前三个字段，必须与 `config.schedule` 完全相等；缺失、多余或数值不同一律 422 `validation_failed`，不得以顶层值覆盖 config。`identity.seed` 不进入 `configHash`/`paramsHash`，服务端把它与 `config` 一起用于重算 `initialPopulationHash`；`identity.configHash` 和 `identity.paramsHash` 必须分别等于服务端对 `config` 算出的值，否则 422。

`GET /api/runs/:id`：返回元数据、状态、endReason、进度、版本、预算用量、逐决策观测去重后的 responseModels、verificationStatus 和 artifact manifest，不返回 writeTokenHash 完整值。

`GET /api/runs?cursor=&limit=50&source=runner&status=completed`：按外部 `(createdAt,id)`（数据库 `(created_at,run_id)`）降序 keyset；limit 默认 50、最大 100。游标只编码排序键和过滤 hash，过滤变化时拒绝旧游标。

### 4.3 聚合 tick 批量写

每行 tick=t 表示**完成 tick t 结算后**的瞬时指标，最终权威状态 tick=t+1。计划 stats 序列唯一为：

```text
statsTicks = {0<=t<totalTicks 且 t%statsStride==0} ∪ {totalTicks-1}
```

若 tick e 末全死亡且 `e < totalTicks-1`（即 `endReason=extinct`），则 finalTick=e，序列只保留 `t<=e` 的项并确保 e 被插入；不再接受 e 之后的 tick。若全死亡发生在 `totalTicks-1`，序列不变，记 `scheduled`。`totalTicks=3650,statsStride=10` 且无提前结束时为 0,10,...,3640,3649，共 366 行。

`POST /api/runs/:id/ticks:batch`

```json
{
  "ticks": [
    {
      "tick": 0,
      "aliveCount": 40,
      "classCounts": [18, 12, 6, 3, 1],
      "gini": 0.28,
      "medianValue": 2,
      "top10Share": 0.42,
      "mUp": 0,
      "mDown": 0,
      "segregation": 0,
      "edgeCount": 0,
      "openness": 0.5,
      "deathCount": 0,
      "competitionLoss": 0,
      "competitionGain": 0,
      "fallbackRate": 0,
      "payloadHash": "sha256:..."
    }
  ]
}
```

- `mUp/mDown` 是 365 日参与率（过去 `MupWindowDays` 日内至少一次上升/下降的存活者占比），不是年化事件率，也不是 EMA；`segregation` 是调整后同层边占比 `S∈[-1,1]`，无网络时 `S=0` 且必须同时写 `edgeCount=0`。
- 1–100 条/run 请求，tick 严格属于计划 stats 序列，单请求内不重复。
- `(runId,tick)` 幂等：同 payloadHash 返回已接受；不同内容返回 409，不覆盖。
- 每 tick 可带完整结构指纹/转移矩阵 JSON，但有单行大小上限 64 KiB；大矩阵/完整事件进 R2。
- 整个批次在 D1 transaction 中完成；任一条失败则整批不接受，客户端可安全重试。

### 4.4 最终个体批量写

`POST /api/runs/:id/agents:batch`：1–500 条，主键 `(runId,agentId)`，同 hash 幂等，不同冲突。字段至少含 id、alive、classIndex/maxClassIndex、value、ge/hard、initialLife/remainingLife、deathTick，与核心命名一致。完整 ties 与历史状态放最终快照 artifact。

### 4.5 Artifact

`PUT /api/runs/:id/artifacts/:chunkId`

Headers：

```text
Content-Type: application/gzip
X-Uncompressed-SHA256: <未压缩NDJSON的sha256 hex>
X-Compressed-SHA256: <请求体sha256 hex>
X-Artifact-Kind: decisions|events|snapshot|final_state|manifest
X-Start-Tick / X-End-Tick: 可选范围
```

- chunkId 只允许 `[A-Za-z0-9._-]{1,128}`；R2 key 为 `runs/<runId>/<kind>/<chunkId>.ndjson.gz`，不能路径穿越。runId 也必须满足 `[A-Za-z0-9_-]{1,64}`，上传与读取前统一校验，非法 id 返回 400 而不是拼出可疑 key。离线 `local-<ulid>` 只存在浏览器，永不进入 R2。
- 压缩请求体最大 8 MiB；NDJSON 每行 schema 校验由生产者保证，消费者仍须逐行校验。
- 同 run/kind/chunkId 且 compressed hash 相同：200 幂等；不同：409。Worker 必须对压缩请求体计算并校验 X-Compressed-SHA256，返回 `{etag,bytes,compressedSha256}`。
- 未压缩 hash 由生产者在有界本地流中计算，消费者下载后必须验证；Worker 不为校验解压大对象，因此 complete 不代表 uncompressed hash 已经服务端内容认证。
- D1 `artifacts` 保存 key、kind、范围、两种 hash、大小和上传时间；R2 为内容权威，D1 为清单。
- 上传未完成不计入 manifest complete；孤儿块由维护任务清理。

`GET /api/runs/:id/artifacts/:kind/:chunkId`：kind 与 PUT 的 X-Artifact-Kind 使用同一枚举，按清单流式返回 R2 内容，支持 ETag/304；不能一次把所有块合并进 Worker 内存。

### 4.6 完成与导出

`POST /api/runs/:id/complete`

```json
{
  "finalTick": 3649,
  "endReason": "scheduled",
  "finalAliveCount": 40,
  "finalStateHash": "sha256:...",
  "summaryHash": "sha256:...",
  "expectedTickRows": 366,
  "expectedAgentRows": 40,
  "expectedDueDecisions": 14600,
  "artifactManifestHash": "sha256:..."
}
```

所有 run 的 manifest 必须列出 config/identity、初始权威快照、最终 final_state、完整 decisions 和 events 范围块；仅声明 `replayable=true` 还要求初始快照加全部到期决策能够逐 `(tick,agentId)` 覆盖。`expectedDueDecisions` 是实际到期决策数 `Σ_{t%decisionInterval=0} aliveAtTickStart(t)`，不是 `initialPopulation×ceil(totalTicks/decisionInterval)` 的理论上界；出现死亡或提前 extinct 时必须用实际值，理论上界只用于预算（04 §7 的 `maxDueDecisions`）。同类范围块不得重叠，决策/事件按 tick/seq 连续；快照必须含 initial/final，周期快照按 schedule 覆盖。

服务端核对 run 状态、stats 计划、agent 数、必需 artifact 类型/范围、上传计数和清单自洽性后原子完成；`manifest hash` 只证明清单未被篡改，不证明内容已由服务端认证，内容认证由独立验证器完成。相同 complete 重试返回 200，不同摘要 409。`endReason=scheduled|extinct`：`extinct` 要求 finalTick 严格小于 `totalTicks-1` 且 finalAliveCount=0；若全死亡恰好发生在最后一个计划 tick，则记 `scheduled`，但 finalAliveCount 必须为 0 并置 `structurallyUsable=false`，该类 run 不参与结构判异。

complete 仅表示上传技术完整，`verificationStatus=uploaded`；独立验证器下载、核对压缩/未压缩 hash、NDJSON schema、连续性和实际回放后，才可把 `verificationStatus` 改为 `verified|rejected` 及报告 hash。正式实验只接受 verified，不能把空 manifest 或未验内容当成可回放证据。

`POST /api/runs/:id/verification`：仅 RUNNER_TOKEN，body `{status:"verified"|"rejected",reportHash,checkedCounts,replayFinalStateHash:null|string}`；只允许 completed run 更新验证元数据，同内容幂等，verified 后不同内容冲突。该接口不能修改 ticks/agents/artifacts 或把 rejected 改为 verified。

`GET /api/runs/:id/stats?from=&to=`：返回聚合序列，范围有硬上限；大数据走 artifact，不通过无界 JSON 响应。

`GET /api/runs/:id/export.ndjson`：首行 manifest，其后按固定类型/范围流式输出；无法流式拼合时返回 manifest 和 artifact URL 清单，不在 Worker 内拼接整个实验。

## 5. D1 逻辑 schema

实际 SQL 以 `migrations/0001_init.sql` 为准，至少包含：

| 表                | 主键/关键索引                                                  | 内容                                                                                                                      |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `runs`            | `run_id`；`(created_at,run_id)`、`source/status`               | 元数据、状态/endReason、完整 config JSON、版本/hash、responseModels、verificationStatus、write token hash、预算与完成摘要 |
| `tick_stats`      | `(run_id,tick)`                                                | 聚合字段与 payloadHash                                                                                                    |
| `agent_final`     | `(run_id,agent_id)`                                            | 最终个体可查询字段                                                                                                        |
| `experiments`     | `experiment_id`                                                | 扫描/消融/微扰定义、状态、创建者来源、预算                                                                                |
| `experiment_runs` | `(experiment_id,run_id)`；唯一 `(experiment_id,cell_key,seed)` | 配对种子和参数单元归属                                                                                                    |
| `artifacts`       | `(run_id,kind,chunk_id)`                                       | R2 清单、hash、范围、大小                                                                                                 |
| `rate_limits`     | `(bucket,window_start)`                                        | 原子固定窗口计数                                                                                                          |

约束：禁止 `agent_ticks`、`raw_decisions` 等每人每 tick D1 表；禁止无索引 LIKE 全表扫描；所有查询硬 LIMIT；迁移上线后只追加。

## 6. R2 NDJSON 类型

- `decision-v1`：一行一次到期决策，形如 `{schemaVersion,runId,tick,agentId,decision:DecisionRecord,execution:ExecutionRecord|null}`。生产者必须先缓冲该 tick 的全部决策，待 tick 结算完成后整批写出；不得先追加 `execution=null` 的行再原地改写 append-only 文件。取消/崩溃导致未结算的 tick 可以写 `execution=null`，但必须标记 `tickSettled=false`；不得补造执行记录。
- `event-v1`：03 的事件，一行一事件。
- `snapshot-v1`：一行一个完整权威快照及 hash。
- `final-state-v1`：最终状态与结构指纹。
- `manifest-v1`：配置、版本、chunk 列表、配对种子、预算和完成状态。

每行含 `schemaVersion/runId`；范围块还需单调 tick/seq。消费者发现未知主版本、hash 不符或重复主键时停止并报告，不跳过损坏数据假装完整。

## 7. 本地与上传一致性

- Runner 本地 manifest 记录服务器已确认的 `(tick,payloadHash)`、artifact ETag 和 complete 响应。
- 网络超时不等于服务器未接收；重试依赖相同主键/hash 幂等，不生成新 runId。
- 本地检查点只在所有权威状态写完后原子替换；上传确认可落后，恢复时按幂等协议重传。
- complete 前必须停止新决策，确保在途上传 settled，核对计数和 hash。

## 8. 保留与删除

- browser run 默认短保留（建议 7 天），正式 runner run 默认较长（建议 90 天），具体值由环境配置并公开。
- `running` run 必须有心跳/静默超时：超过配置窗口无写入的 browser run 由维护任务标 `failed(reason=abandoned_timeout)`，避免永久占用；runner run 的超时阈值更宽，但同样不得静默删除。
- 到期先删 R2 大块，再删 D1 元数据，或同事务不可用时记录待清理清单；定期扫描孤儿。
- 删除接口不属于公开 MVP；由受控维护任务执行。任何法律/隐私删除请求需要运维手册记录。
- 备份不能依赖 R2 清单 alone；D1 导出与 R2 manifest 必须可交叉校验。

## 9. 限流与配额

- `/api/jev`：按 IP+Key 指纹（hash，不存原 Key）限流，另有全局保险丝；匿名 run 创建按 IP。
- run 写：按 runId+IP，限制批频率、总 artifact bytes、最大 ticks 和 agents。
- 429 返回 Retry-After；413 用于 body/chunk 超限；配额耗尽用 429 或 403 `quota_exceeded`，客户端不得无限重试。
- 限流只用于保护资源，不能作为实验速率唯一控制；VPS 仍需共享 token bucket 和预算。
