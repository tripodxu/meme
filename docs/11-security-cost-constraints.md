# 11 安全、资源与成本约束

## 1. 安全基线

- 默认所有外部输入不可信：配置、快照、NDJSON、Jev 响应、run 写入、chunkId、游标和请求头均校验。
- 最小权限：Worker 只访问指定 D1/R2；VPS 用非 root；token 按环境/用途隔离。
- 实验不包含真实个人资料；agentId 是合成 ID。不得把真实姓名、联系方式、地址或敏感属性放入 Jev state。
- 公开读取不代表私密存储；未来需要私人实验时先增加授权模型，不能靠 obscure runId 宣称安全。

## 2. 秘密管理

| 秘密 | 存储 | 禁止 |
|---|---|---|
| 浏览器 TypeSafe BYOK | 当前页面内存、请求 X-Api-Key | localStorage、D1/R2、日志、URL、导出 |
| VPS TypeSafe Key | 权限600 env/秘密管理 | manifest、journal、checkpoint、命令行参数 |
| RUNNER_TOKEN | Worker secret + VPS env | 前端 bundle、仓库、普通日志 |
| run writeToken | 创建时返回一次；服务端只存 SHA-256 | 数据库明文、跨 run 复用、URL |
| 备份凭据 | 独立秘密管理 | 与普通实验导出一起公开 |

日志只记录 keySource、Key 指纹（如确需限流且使用不可逆 hash）和 token 前缀，不记录可还原值。秘密泄漏立即轮换并检查费用。

## 3. 威胁与控制

| 威胁 | 强制控制 |
|---|---|
| 开放 Jev 代理被盗用 | 固定上游、模型 allowlist、Key 必填、body/options 限制、IP+Key指纹和全局保险丝 |
| SSRF/任意转发 | 不接受上游 URL 或自定义 headers；只转发白名单字段 |
| 匿名 run/存储滥用 | IP 配额、总 ticks/agents/bytes 限制、保留清理、维护开关 |
| 写令牌越权 | 每 run 独立、hash 存储、状态检查、constant-time 鉴权比较适用时使用 |
| 批次重放/重复计费 | 主键+payloadHash 幂等；重试不生成新 run；Jev 请求重试有限且不重复 topK |
| R2 路径穿越/覆盖 | chunkId 白名单、固定 key 模板、同键不同 hash 409 |
| 大 body/zip bomb | body/chunk 硬限制；Worker 不为验证解压巨块；消费者限制行/块大小 |
| XSS | rawResponse/state 只作为文本渲染，禁止 innerHTML；依赖最小化、CSP |
| 数据损坏被标完成 | hash、manifest、计数、complete 校验、核心 invariant 即停 |
| 供应链 | lockfile、依赖审查、更新测试、密钥扫描、CI 最小权限 |

生产添加合理安全头：CSP、X-Content-Type-Options、Referrer-Policy、frame-ancestors 等；同源 API 不返回宽松 CORS credentials。静态资源与 API 错误不泄漏堆栈/env。

## 4. 成本预算

静态调度上界（全局最多 4 次重试时）：

```text
maxDueDecisions = initialPopulation × ceil(totalTicks / decisionInterval)
maxHttpAttempts = maxDueDecisions × 4
inputTokenBudget = 逐 attempt 预留、按实际 usage 核销，不等同于到期决策数
```

实际存活减少可降低调用，但不能用预计平均值替代硬上限。live run 必须有：

- `maxCalls`：到达后不再发新请求；
- `maxInputTokens`：按实际 usage 累计，未知单独报告；
- `maxRunMinutes`：包含限流等待，防止无人值守挂起；
- VPS 批次 `maxRuns/maxCostUsd`（成本可得时）和共享并发/token bucket。

并发不是预算。每个 HTTP attempt（含重试）都计入 maxCalls，并在发请求前原子预留 call 和版本化估算 token；成功按 usage 核销，失败保留预留，usage 缺失按预留结算并暂停正式 run。预算预留考虑全部在途请求；实际 usage 超估或上游不可预知可能产生 overage，必须停止新调用并记录，不能宣称账单绝对硬上限。达到预算标 `budget_exhausted`，不得标正常完成。

## 5. 资源约束

### 5.1 Cloudflare Worker

- 不执行人口长循环；每请求只做校验、代理和有限数据库/对象 I/O。
- 免费/不同套餐 CPU 和 body 限制会变化，发布前查官方；应用层默认 Jev body 256 KiB、artifact 8 MiB。
- 不在 Worker 合并全部 run 日志、解压巨大 NDJSON 或计算全人口指标。
- 列表硬 LIMIT、导出流式/清单化、批写 transaction；重试由客户端控制。

### 5.2 D1/R2

- D1 仅存 run、聚合 tick、最终个体和清单；不存每人每 tick 原始事件。
- tick 批 100、agent 批 500，单行 tick <=64 KiB；不在循环中逐行独立提交。
- R2 原始 gzip NDJSON 分块，目标块大小应小于 8 MiB 上限以利重试；大实验按 tick 范围切块。
- 保留策略和备份同时设计，禁止无界 browser run 占用。

### 5.3 浏览器/VPS

- 浏览器默认 40 人；大规模需明确警告并建议 VPS。图表降采样、事件缓冲有界、存储配额可诊断。
- VPS 先基准再定并发；内存不足时降低并发/快照频率，不牺牲权威状态。
- 网络默认最大度 6、目标候选 6，禁止无界 O(N²) 全连接/全候选。
- 磁盘达到运维阈值停止新批次；检查点原子写入并保留至少一个上一完整点。

## 6. 实验完整性与信任边界

- `source=browser` 的结果不进入正式基准；正式 runner 必须 RUNNER_TOKEN，服务端不可信任其自报 source。
- 即便 runner 已认证，服务端仍校验范围/hash/版本；不能防止恶意 runner 伪造全部结果，因此正式结论还需要代码签名 commit、manifest 和可重跑抽查。
- 规则/prompt/model/code/config 任一变化都要区分对照组；禁止覆盖旧 run 让结果看似一致。
- mock/random 不得标为 Jev；replay 不得标为 live；fallback/cancelled/budget exhausted 分开统计。
- 不删除失败种子，不用额外随机噪声制造敏感，不用现实社会断言包装仿真。

## 7. 数据保留与隐私

- browser 建议 7 天、runner 建议 90 天，实际环境公开配置；重要校准 artifact 另标长期保留和备份。
- 原始 Jev 响应可能含完整合成状态，只按实验需要保存，不附真实用户信息。
- 删除时同步处理 D1 清单、R2 对象和本地导出；备份中的到期数据按备份轮换删除。
- 运维日志最小化，requestId/runId 足以排查即可；不记录完整请求体。

## 8. 紧急停止

必须提供两层停止：

1. Runner：停止新任务、abort 在途、保存检查点和 usage，等待上传达到一致状态。
2. Worker：维护开关禁用 `/api/jev` 和匿名创建/写入，只保留健康/读取；必要时轮换 Runner token。

恢复前确认故障原因、预算和限流已修复，先做小额 preview/生产冒烟。不得通过删除 run 或修改统计掩盖异常成本。
