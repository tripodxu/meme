# 08 测试与质量门禁

## 1. 原则

- 先写规则边界和失败用例，再实现结算；bug 必须有回归测试。
- 核心正确性不依赖真实 Jev；外部模型测试与确定性 CI 分离。
- 不以覆盖率替代语义验收，但核心关键分支应接近全覆盖，目标 statements/branches >=95%。
- 覆盖率门禁覆盖**两层**，两条命令独立，阈值不合并（合并会稀释核心强度）：
  - `pnpm test:coverage` → `src/core`，`statements>=95`、`branches>=95`；
  - `pnpm test:coverage:runner` → `src/runner`（窗口统计、标签、预注册、聚类、均值场、机制门禁），
    `statements>=95`、`branches>=78`。`branches` 为**棘轮**：只允许上调。
  - `src/runner` 长期不在门禁内，直接后果是预注册哈希漏字段、全灭日污染窗口均值、
    均值场漏传观测 E 三类缺陷都没有测试拦截（changes/0007）。
- 每个阶段提供命令、环境、commit、结果和 artifact；截图只能辅助，不能代替机器校验。

## 2. 测试层次

| 层        | 工具/环境                 | 责任                                   |
| --------- | ------------------------- | -------------------------------------- |
| 单元      | Vitest                    | 公式、状态转换、序列化、校验、错误分类 |
| 性质      | fast-check                | 任意合法配置/人口下不变量和 round-trip |
| Golden    | 固定 fixture/hash         | 跨重构行为冻结、版本兼容和回归差异     |
| 集成      | workerd + 本地 D1/R2      | 迁移、transaction、认证、幂等、导出    |
| 契约      | 录制/手工脱敏 Jev fixture | 请求白名单、响应 shape、非法概率、重试 |
| E2E       | 浏览器自动化              | mock/live模拟/回放/导入/移动端关键流程 |
| 性能/soak | Node 基准、长时运行       | 吞吐、内存、事件有界、长周期数值稳定   |
| 真实冒烟  | 独立受控工作流            | 小额 Jev 与预览部署，不进入普通 CI     |

## 3. 核心规则测试矩阵

### 3.1 初始化与 RNG

- 同地址重复调用相同；不同 seed/tick/agent/eventTag/counter 可区分；高 53 位全 1 时 R 仍严格小于 1。
- mock-weighted-v1/random-uniform-v1 的权重、并列、derived 概率和地址与 golden 一致；Jev fallback 不会变成 mock。
- 增加一个竞争随机消费，不改变另一个体网络重构和初始化样本；`init_age` 只影响本个体初始余命。
- 最大余数人数正确，P0 使用实际人数；分布截断边界无越界样本；拒绝采样超过尝试上限时抛 `invariant_violated`，不得无界循环。
- 初始人口是 `(config,seed)` 的纯函数：同 config/seed 在不同运行端得到同一 roster 和 `initialPopulationHash`；不得支持外部独立 roster。
- 初始网络无自连/重边、对称、度限制、无法连边时正常终止；空阶级 `P0[c]=0` 时 Congestion 取 `congestionMin` 而非 NaN，且该阶级可被升入后正常更新。

### 3.2 积累与需求

- ge=hard=1、无网络/反馈时 gain=B×env0[c]。
- hard=0 趋近 0，hard 增加 gain 单调；F(1)=1、F(0)=0；`FShape` 接近 0 时使用稳定实现且不产生 NaN。
- 无邻居 Opportunity=1；邻居中位数/全体中位数偶数规则正确。
- 主动变动后 baseline 清零，新阶级首日 need=0；第 `bufferDays` 日 buffer=1。
- `needMultiplier` 逐阶级生效：`ψ[0]=1`，高阶同 Value/同 baseline 下更易触发跌落；`ψ` 长度/单调性非法时 schema 拒绝。
- E 改变不追溯改写旧 baseline；被动跌落后下一日使用新阶级。
- 低于 `needThreshold` 连续 `belowNeedLimit-1` 日不跌、第 `belowNeedLimit` 日跌；中间恢复清零；最低层不跌。
- 成功主动升降当日跳过被动跌落；stale 行动不错误跳过。
- `initialAgeMode=uniform` 时 `remainingLife<initialLife`；`newborn` 时相等；两种模式都消费 `init_age`，其他属性随机流不变。

### 3.3 成本与竞争

- 首次升至历史新高 d=0 无减免；d=1/2/>=3 分别读取 `returnDiscount[0]/[1]/[2]`，默认 0/20/40%；用非零测试值证明 `returnDiscount[0]` 可观测；动态乘子只与减免后 base 相乘，费用>0。
- Value 恰好等于费用可行动，使用固定 fixture 让 Value 略低于费用则不可；一次只变一层。
- 同层/跨层 power 系数正确；pA 在 [0,1]，极端 Value 不产生 Infinity/NaN；power 以 log 空间比较或等价稳定实现。
- 高打低/低打高/防守胜方向系数正确；所有方向 gain<=loss。
- 目标已被作为目标、死亡或费用被前序竞争消耗时 stale_invalid；A→B 后 B→C 合法，再次以 B 为目标非法，仅作为发起方不占用 targetedAgents。
- Value=0 竞争转移为 0，无负数；每目标每 tick 最多一场。

### 3.4 寿命、网络与慢变量

- hard 寿命因子在合法 hard 域内不低于 `hardLifeFloor`（由 `hardLifeFactor` 与 `attributes.hard.min` 的配置约束保证），`hardLifeFloor` 只作数值护栏，不得写成可达的业务分支；阶级变化只影响后续；remainingLife=0 当天死亡且不可复活。
- `initialAgeMode=uniform` 的默认 3650 tick 实验死亡率 `>=0.05`；`newborn` 对照在 3650 tick 内死亡率 `<=0.01`；两种模式都要覆盖快照恢复。该阈值是机制可观测性下限，不是现实死亡率承诺。
- 死亡者 ties 被移除，不参与下一 tick 任何候选/中位数/竞争。
- 重构无候选恢复旧边；每 agent 每周期最多一条；O 改变权重符合公式。
- 全零财富 G=0；无网络时 `S=0` 且 `edgeCount=0`；空阶级/全死亡无 NaN。
- 调整后 S：随机混合时接近 0；全部同层时为 1；无同层边时为 -1；跨层多于随机时在 `(-1,0)`；改变阶级分布不得单独把 S 推高；极端分布（如 `P=[0.9,0.1,0,0,0]`、`expectedShare` 接近 1）仍满足 `S∈[-1,1]`。
- Mup/Mdown 为 `metrics.mobilityWindowDays` 窗口参与率，只统计存活者；边界 tick、窗口不足、死亡日、主动降阶/被动跌落都要覆盖；不使用 EMA。
- E 每 tick 只更新一次，O 仅决策周期按真实 Δt 更新；不得同 tick 二次结算。

## 4. 性质测试

对随机生成但 schema 合法的配置、初始人口、行动序列运行至少数百 tick：

1. 03 的全部不变量始终成立。
2. `decode(encode(state))` 与权威状态 hash 相同。
3. 任意快照点恢复后与连续运行最终 hash 相同。
4. 同配置+初始状态+mock 决策重复运行完全相同。
5. 任意无效行动不会导致负 Value/非法阶级，且有明确失效事件。
6. 克隆不改变原世界；只修改指定字段时其他权威字段 hash 相同。
7. 全人口死亡后以 extinct 技术完成，finalTick/finalState.tick 和 stats 最后一行符合 05；恰在最后一 tick 全死亡时记 scheduled 且 finalAliveCount=0、不可用于结构判异；继续 step 必须返回明确终态错误。
8. 任意 schema-valid 配置都满足 03 的合法域和 gain<=loss，零值消融及 decay=0 可运行，负 decay 被拒绝；`needMultiplier` 非法长度/非单调/ψ[0]≠1 被拒绝。
9. 参数接线：对注册表中每个业务参数做最小扰动，必须改变对应输出；明确标记为 no-op 的参数要有理由和测试。
10. 初始人口只由 `(config,seed)` 决定；相同输入跨运行端得到同一 `initialPopulationHash`，不同 seed 得到不同 roster。
11. S 在 `[-1,1]`、edgeCount 一致；Mup/Mdown 在 `[0,1]` 且只统计存活者；空网络/空人口不产生 NaN。
12. `seed` 不改变 `configHash`/`paramsHash`，但改变 `initialPopulationHash`；`initialAgeMode=uniform|newborn` 在同 seed 下产生不同 `initialPopulationHash` 且都消费 `init_age`。
13. `preregistrationHash` 在提交 experiment 前后、以及服务端生成 `experimentId/createdAt` 后重算一致；运行后填充 `observedResponseModels` 不改变该 hash。
14. `hardLifeFloor` 在合法 `hard` 域内不改变输出（配置违反关系上界时被拒绝），且在 `hard` 超出合法域时阻止非正寿命。
15. `openness.updateMode=fixed` 时 O 在所有 tick 保持 `openness.initial`；开关变化改变 `configHash/paramsHash`，dynamic 与 fixed 的其它状态可按配对比较。

失败时输出最小化 seed、配置和 fixture，加入永久回归集。

## 5. Golden 与兼容测试

至少冻结：

- 40 人默认 mock 的 tick 0/1/10/120/400 状态与指标（`rules-v11`）；
- 含主动升降、被动跌落、四种竞争方向、死亡和网络重构的人工小世界；
- 初始年龄 uniform/newborn 两种模式的初始化与 3650 tick 死亡率对照；
- 365+ tick 的反馈 fixture，验证 E/O、调整后 S、365 日 Mup/Mdown；
- 快照恢复、微扰克隆、live 决策回放及 replay_invalid；
- 空网络、全零财富、全死亡边界；
- 每个参数注册项的接线 fixture；
- 每个 hash domain 的字段级 canonical schema、固定向量与预期 hash；不同 `runtimeVersion` 的 `nonAuthoritativeRuntime` 路径；
- 参数注册表定义快照 `test/fixtures/config/param-definitions.json`（名称、单位、公式引用、域与 `guardOnly/affectsBehavior`）。

golden 包含版本、`paramsHash`、输入、输出 hash 和必要可读差异；参数定义快照由 `pnpm params:snapshot` 生成，更新必须人工审查 diff。另为 02 每个 hash domain（含 `configHash/paramsHash/initialPopulationHash/preregistrationHash`）在受支持的 V8 运行时（Node/workerd/Chromium）校验同一 RFC 8785 测试向量。更新必须人工审查，不得用环境变量一键无说明接受。声称无行为重构时 hash 必须一致；行为变化升级版本并保留旧 fixture 读取测试。

## 6. Jev 契约测试

- 请求只含白名单字段，action criteria 与 legalActions 一致，最多 9 个选项。
- prompt 中的成本、转移损耗和“是否摧毁总财富”描述由当前 config 生成，不得写死；当 `baseTransferEfficiency×directionMultiplier=1` 时不得声称有损耗。`promptStyle=neutral|survival_hint` 必须进入 `promptVersion`。
- 响应：正常概率、缺 answers、空概率、未知选项、负/NaN 字符串、超界 confidence、缺 usage、真实 model 不同。
- 每个到期决策有且仅有一条执行记录；`executed/stale_invalid/replay_invalid/skipped_dead` 与核心事件和账本一致，执行记录不改写 requested/selected。`skipped_dead` 在现有死亡时机下必须恒为 0；重放 mock/random 日志分别标 `mock_replay`/`random_replay`，不得冒充 `jev_replay`。
- topK=1 并列稳定；topK>1 使用地址 RNG，重试不重复采样。
- 同一 state 重复 20 次的重测信度脚本可运行，输出选项分布、top-1 一致率、ICC(2,1) 和重复间平均 TV 距离；未达 07 §11 门槛（一致率>=0.70、ICC>=0.50、TV<=0.15）时报告 `model_unstable`，不得进入正式结构对照。
- 401/403/400/422 不重试；429/529 尊重 Retry-After；5xx/网络次数正确。
- Abort 能中断 fetch 和等待；重置后的响应因 state/generation 不符被丢弃。
- 混合错误共享全局 4 次上限；Retry-After>20s 不再重试；熔断按完成顺序分类。
- 每次 HTTP attempt 前预留 call/token，实际 usage 核销，失败保留预留；usage 缺失按预留结算并暂停正式 run，预算超量停止新请求。
- 连续失败与回退率触发暂停；cancelled 不计模型质量失败。
- Worker 不存 Key、不二次重试、不转发任意 URL/headers。

## 7. Worker/D1/R2 集成

- 空库应用全部迁移；重复执行部署流程不修改旧迁移。
- 匿名 browser 与 Runner token 来源正确；无/错/跨 run writeToken 均拒绝。
- tick/agent/artifact/complete 重复请求幂等；同键不同 hash 409。
- 批次中一条失败整批回滚；并发 complete 只有一个成功状态转换。
- stats stride 缺口、agent 数、初始/最终快照、决策/事件范围或 manifest 不符不能 complete；extinct finalTick 和 `expectedDueDecisions`（实际到期数，不是理论上界）正确。
- complete 后仅 verificationStatus=uploaded；独立验证器核对 uncompressed hash、schema、连续性和回放后才 verified。
- artifact 8 MiB 超限、非法 chunkId/kind、压缩 hash 不符、R2 丢失有明确错误；Worker 不解压巨块。
- `metrics-v1` 与 `metrics-only` profile 可完成窗口统计复算；`replayable=false` 不被误标为可回放；`full` profile 缺 decisions/events 不得 complete。
- keyset 分页无重复/遗漏，过滤改变使游标失效；所有列表 LIMIT 生效。
- 导出 NDJSON 可逐行解析，未知版本/损坏行会停止。
- 限流原子递增、Retry-After、配额与保留清理任务有效。

## 8. 前端 E2E

覆盖 06 的全部场景，并增加：

- 运行中快速暂停/继续/单步无重复 tick；重置无旧响应污染。
- 配置冻结，修改下一场配置不影响当前 configHash。
- 图表窗口与导出数据一致；标签旁可查看原始指标。
- localStorage/IndexedDB 配额不足可诊断，不丢失已导出文件。
- 360px 和键盘流程；控制台无未处理 rejection。

## 9. 性能与稳定性门禁

先在固定 VPS/CI 记录 40/200/1000 人、120/3650 tick 的 mock 基准，再冻结预算。报告：ticks/s、决策序列化耗时、峰值 RSS、事件/快照大小、D1/R2 上传量。相对基线退化>20%需解释和评审。

至少一次 10,000 tick mock soak 和一次包含真实 artifact 大小的长批次恢复测试。Worker 使用本地 workerd 和线上冒烟检查请求资源，不假设浏览器基准代表 Worker。Cloudflare 限额发布前复核官方文档。

## 10. CI 与发布证据

PR 必跑：format、lint、typecheck、`typecheck:core`（不含 Node 类型）、unit/property、core golden、build、Worker 集成（契约相关时）、依赖审计 `pnpm audit --prod --audit-level high`。覆盖率门禁在 unit/property 任务中执行两条命令：`pnpm test:coverage`（`src/core`，statements/branches >=95%）与 `pnpm test:coverage:runner`（`src/runner`，statements>=95、branches>=78，棘轮只升不降）；主分支增加 E2E 和基准；live 冒烟仅手动/受控计划，使用独立低预算 secret。密钥扫描在 P7 发布门禁与仓库 secret scanning 执行，不阻塞每个 PR。

发布证据包：

```text
commit + CI URL + test summary + migration diff + benchmark +
backup location + restore drill result + preview smoke + known issues
```

任一核心不变量、迁移恢复、认证/幂等、安全或预算测试失败为绝对阻断；不允许以“外部模型不稳定”为由跳过纯核心失败。
