# Stratify

可交互、可回放、可批量实验的社会结构仿真系统。

Jev 负责从代码枚举的合法行动中做结构化选择，确定性 TypeScript 引擎负责财富、阶级、竞争、寿命、网络与宏观指标的全部结算。浏览器承载交互实验，Cloudflare Workers 承载网站与数据服务，VPS 承载大规模批量实验。

> **当前状态（2026-11-19）：P0–P5a、P3/P4/P5b 工程交付与 Preview（[`https://stratify.logicc.top`](https://stratify.logicc.top)）公网冒烟已落地；D1「2 体制 + 连续统」已通过 G6 校准（`P6-09` + 阶段 R4，冻结 `regime1_pyramid` 与 `regime2_continuum`）。**
> 版本轴：`rules-v18` / `engine-v0.15.0` / `stratify-config-v12` / `stratify-state-v5`（103 项注册参数）。
> 科学边界：传统 `k≥3` 离散结构（`P6-05..08`/`P6-10`/R2-B 探针）仍未通过；阶段 R3（`P6-11` 30-seed 真实 Jev 提示词因果实验）正在执行中；Production 尚未发布。

---

## 1. 快速了解

### 1.1 项目要做什么

- 配置规则、初始人口和决策策略，运行并单步观察仿真；
- 回答“个体为何这样行动、财富如何变化、阶级如何流动”；
- 从同一检查点做微扰、配对和消融实验；
- 浏览器完成小规模交互，VPS 完成批量扫描；
- 导出足以复核结论的配置、版本、决策、事件和聚合指标；
- 在 Cloudflare 部署公开界面与受控数据服务，而不让 Worker 做重计算。

### 1.2 明确不做什么

生育与家庭、地理空间、多国家、现实政策预测；让 Jev 生成代码、财富或社会标签；在未校准前宣称结构已经稳定出现。

---

## 2. 核心设计约束

1. **先核心后外围**：先完成无 Jev 的确定性核心，再接模型、UI 和云端；不得从 UI 反推规则。
2. **模型不做算术**：Jev 只用 System One `choice` 从合法行动中选择，所有后果由引擎计算。
3. **可寻址随机**：禁止 `Math.random()` 和全社会共享单随机流，使用 `R(seed, tick, agentId, eventTag, counter)`。
4. **固定管线**：每 tick 顺序固定为 `主动行动 → 日常积累 → 被动跌落 → 寿命与死亡 → 网络重构 → 宏观指标 → 慢变量更新`。
5. **参数注册表**：所有业务常数必须来自 `ParameterRegistry`，有单位、合法域、公式引用和接线测试，并进入 `paramsHash`；结算函数禁止裸字面量。
6. **纯函数派生初始世界**：初始人口、网络和年龄由 `(config, seed)` 派生，不得接受独立 roster；`seed` 不进入 `configHash`。
7. **存储分层**：Worker 不执行大规模长循环；D1 只存可查询元数据/聚合；完整日志进 R2。
8. **真实 Jev 调用必须有边界**：超时、有限重试、取消、预算和失败熔断；密钥不得落库、写日志或进入 URL。
9. **证据先于标签**：未满足实验统计验收前，不得声称参数已校准或结构已涌现。
10. **完成 = 实现 + 测试 + 文档 + 验证证据**；CI 未通过不得标记完成。

---

## 3. 系统架构

```text
Browser UI ──> RunController ──> Pure Core <── DecisionPolicy
                    │               │            ├─ mock / random
                    │               │            └─ jev_live / replay
                    │               └─ snapshots / events / stats
                    └─ localStorage / IndexedDB / export
                                   │
                                   └─ Worker run API ──> D1（元数据/聚合）+ R2（分块 artifact）

VPS Batch CLI ──> 同一 Pure Core + 同一 DecisionPolicy
              └─ 原子检查点 / 共享预算 ──> 分批上传 Worker
```

| 运行端 | 负责                                                 | 不负责                                   |
| ------ | ---------------------------------------------------- | ---------------------------------------- |
| 浏览器 | 交互、mock/live 小规模运行、可视化、回放、临时保存   | 大规模扫描、暴露服务端密钥、复制结算逻辑 |
| Worker | 静态资源、同源 Jev 代理、认证、限流、D1/R2 I/O、导出 | 长循环仿真、海量事件入库、保存用户 BYOK  |
| D1     | run 元数据、聚合 tick、最终个体、实验与配额          | 每人每 tick 原始事件、完整决策全文       |
| R2     | gzip NDJSON 决策/事件/快照/最终状态分块              | 高频小范围关系查询                       |
| VPS    | 批量并发、长时运行、检查点、配对实验、上传           | 绕过共享预算、另写一套规则               |

依赖方向：`core <- decision <- app <- ui`，`core <- runner`；`shared/contracts` 供 app/worker/runner 共用。`src/core` 不得依赖 DOM、`fetch`、`localStorage`、Node、Worker 或 wall clock。

---

## 4. 规则当前口径（rules-v18）

`rule.md` 仍是社会机制的唯一事实来源，结算细节以 [docs/03-rules-implementation.md](docs/03-rules-implementation.md) 为准。`rules-v18` 相对 `rules-v3` 的核心机制线：

- **需求参照系与持有裕度（v5–v7）**：`'class'` 模式（默认）需求线 = `refIncome[c] × bufferDays × ψ_eff[c]`；`need.graceDays`（默认 30）与 `ascent.holdingCushionDays`（默认 30）解耦跌落与上升裕度；`'own'` 逐位保留 v3–v5 语义作消融对照。
- **位移准入与占用锚定（v8–v11）**：`'class'` 参照系下上升须击败目标阶级在位者；`ascent.displacementShare`（默认 1）控制位移份额，`ascent.scarcityWeight` 与 `ascent.occupancyMemoryDays` 控制占用压力壁垒。
- **制度反馈与行为异质性（v12–v15）**：`openness.selfReinforcement`（θH=0）、显式制度状态机（`regimeMode='continuous'`, θR=0）及不可变个体特质 `riskTolerance`/`crossClassOpenness`（默认 `sigma=0`）均默认关闭以保持向后逐位一致。
- **代际更替、阶级容量与天赋传递（v16–v18）**：新增 `population.generationalMode`（默认 `'none'`）、`bequestRate`（0）、`classInheritanceRate`（0）、`ascent.classCapacity`（默认全 `1`）与 `population.talentInheritanceWeight`（默认 `0`）；默认配置与 `rules-v15` 保持逐位兼容。
- **参数注册表**：全部 103 项业务常数集中注册（含单位、域、公式引用与接线测试），进入 `paramsHash`；`hardLifeFloor` 标记为 `guardOnly`。
- **科学校准状态**：D1「2 体制 + 连续统」已由 `N=200` `P6-09` 与阶段 R4（微扰 100% 吸收 + 五消融）正式通过 G6（`regime1_pyramid` / `regime2_continuum` 已冻结）；传统 `k≥3` 离散结构仍未通过。

完整公式、字段、默认值和不变量见 [docs/03-rules-implementation.md](docs/03-rules-implementation.md)；版本沿革见 [docs/changes/](docs/changes/README.md)。

---

## 5. 施工路线

推荐关键路径：

```text
P0 → P1 → P1.5（Go/No-Go）→ P2 → P5a → P6（G6 校准）
                                      └→ P4 / P5b / P3（云端与产品化并行）→ P7
```

| 阶段     | 目标                                                       | 闸门                                                              | 当前状态                                                                         |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **P0**   | 规格冻结、TS 骨架、配置校验、12 个 hash domain、参数注册表 | G0：配置可 round-trip；`paramsHash` 入 golden；零裸字面量         | 完成                                                                             |
| **P1**   | 确定性核心：RNG、8 阶段结算、快照、微扰克隆                | G1：机制规则逐条测试；同输入最终哈希一致；10,000 tick soak 无 NaN | 完成（含 10,000 tick soak）                                                      |
| **P1.5** | 涌现可达性预研（**阻断层**）                               | G1.5：至少 2 类非退化、可复现结构聚类；否则回改规则               | 部分：G1.5 过（2 类）；≥3 类仅 W6 候选                                           |
| **P2**   | Jev 决策层：Choice 协议、重试、预算、重放                  | G2：故障注入覆盖超时/401/403/429/5xx/非法 JSON；预算与取消有效    | 完成 7/7：P2-07 冒烟经自建网关跑通（官方域名 451）                               |
| **P3**   | 前端交互双界面（沙盒剧场 + 科研试验台）                    | G3：离线 mock、live 小额、导入回放、Chromium Playwright E2E 通过  | 完成（含 IndexedDB v3、LTTB 与 Playwright E2E）                                  |
| **P4**   | Cloudflare Worker / D1 / R2 数据服务与同源 BYOK 代理       | G4：幂等、并发、越权、超限测试通过；无密钥泄漏                    | 完成（Preview `stratify.logicc.top` 公网冒烟与 live 代理通过）                   |
| **P5a**  | 本地批量 Runner 与检查点                                   | G5a：kill 后恢复最终哈希一致；不依赖云端                          | 完成 5/5：CLI、tick 级检查点、微扰配对、共享预算、systemd 工件                   |
| **P5b**  | 分批流式上传、断点续传与独立确定性验证器                   | G5b：断网/重复上传不产生虚假 complete；回放篡改可拦截             | 完成（含 `full` 流式导出与公网 `verified` 闭环）                                 |
| **P6**   | 校准与科学验收                                             | G6：D1「2 体制 + 连续统」(`07 §8.2`) 与消融/微扰收口              | **D1 已通过 G6**（`P6-09` + R4）；`k≥3` 未通过；**R3（`P6-11` Jev 因果）进行中** |
| **P7**   | 发布硬化                                                   | 备份/回滚演练、安全扫描、渐进发布                                 | Preview 硬化演练完成（D1 恢复/回滚/审计）；Production 资源与监控待立项           |

任务编号、依赖与验收标准见 [docs/01-implementation-plan.md](docs/01-implementation-plan.md)。

---

## 6. 文档导航

### 6.1 入口与根目录文件

| 文件                             | 作用                                             |
| -------------------------------- | ------------------------------------------------ |
| [docs/README.md](docs/README.md) | 文档入口：效力规则、唯一事实来源、按角色阅读路径 |
| [rule.md](rule.md)               | 社会机制与实验目标的唯一事实来源（13 章 59 条）  |
| [AGENTS.md](AGENTS.md)           | 仓库执行约定与强制约束                           |
| [README.md](README.md)           | 本文件：项目总览与文档导航                       |

### 6.2 核心规格（`docs/` 编号文档）

| 文档                                                  | 内容                                      |
| ----------------------------------------------------- | ----------------------------------------- |
| [00 项目章程](docs/00-project-charter.md)             | 目标、范围、角色、里程碑完成定义、风险    |
| [01 施工计划](docs/01-implementation-plan.md)         | P0–P7 任务编号、依赖、交付、闸门          |
| [02 系统架构](docs/02-architecture.md)                | 模块边界、运行拓扑、状态机、规范化哈希    |
| [03 规则实现](docs/03-rules-implementation.md)        | 规则字段、默认值、公式、tick 顺序、不变量 |
| [04 Jev 决策协议](docs/04-jev-decision-contract.md)   | 合法行动、请求/响应、重试、预算、回放     |
| [05 API 与数据契约](docs/05-api-data-contract.md)     | HTTP 接口、D1/R2、幂等、导出、保留策略    |
| [06 前端契约](docs/06-frontend-contract.md)           | 页面、状态、图表、离线存储、回放          |
| [07 实验与校准](docs/07-experiment-calibration.md)    | 配对种子、窗口、结构判异、消融、校准      |
| [08 测试与质量](docs/08-testing-quality.md)           | 单测、性质、集成、E2E、性能与 CI 门禁     |
| [09 部署与运维](docs/09-deployment-operations.md)     | Cloudflare、VPS、备份、发布、故障 runbook |
| [10 工程约定](docs/10-engineering-conventions.md)     | 命名、编码、Git、评审、ADR、文档维护      |
| [11 安全与成本](docs/11-security-cost-constraints.md) | 密钥、威胁模型、限流、配额、成本          |
| [12 交接清单](docs/12-handoff-checklists.md)          | 开工/完工/发布/故障/交接清单              |
| [ADR 索引](docs/adr/README.md)                        | 架构决策记录触发条件、编号规则与模板      |

### 6.3 导读、设计与参考资料

以下文件是对编号规格的提炼或外部资料整理，**不构成新的验收口径**；与编号文档或 `rule.md` 冲突时，以编号文档为准。

| 文件                                                        | 内容                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| [总体施工计划与契约总览](docs/guides/plan-and-contracts.md) | 架构铁律、阶段表、核心公式、哈希与 API 的一页式汇总（派生导读） |
| [前端设计指南](docs/guides/frontend-design.md)              | 设计令牌、五大工作区、帧预算调度与降采样方案（派生指南）        |
| [Jev 简介](docs/reference/jev-overview.md)                  | TypeSafe System One 三种原语、接口、限制与已知局限（参考资料）  |

### 6.4 冲突处理

| 主题                     | 以谁为准                                     |
| ------------------------ | -------------------------------------------- |
| 社会机制与实验目标       | [rule.md](rule.md)                           |
| 规则类型、顺序与结算细节 | [docs/03](docs/03-rules-implementation.md)   |
| 模块边界与运行拓扑       | [docs/02](docs/02-architecture.md)           |
| Jev 请求/决策/重放       | [docs/04](docs/04-jev-decision-contract.md)  |
| HTTP / D1 / R2 / 导出    | [docs/05](docs/05-api-data-contract.md)      |
| 实验与校准               | [docs/07](docs/07-experiment-calibration.md) |
| 前端交互                 | [docs/06](docs/06-frontend-contract.md)      |
| 质量门禁                 | [docs/08](docs/08-testing-quality.md)        |

规则冲突时暂停并澄清，不得静默选择有利口径。

### 6.5 按角色阅读

- **核心引擎开发者**：`rule.md` → 03 → 02 → 08 → 10
- **前端开发者**：02 → 06 → 05 → 04 → 08
- **Worker/后端开发者**：02 → 05 → 11 → 09 → 08
- **VPS/实验开发者**：03 → 04 → 07 → 05 → 09
- **评审或接手负责人**：00 → 01 → 12，再抽查对应契约与测试证据

---

## 7. 工程结构

```text
src/core/          model, config, engine, competition, life, network, macros, feedback, stats, rng, replay, hash, init, control
src/decision/      policy, policies, serialize, schema, jev-client, live, mock, random, replay
src/app/           （占位）run-controller, api-client, experiment, local-store
src/ui/            （占位）setup, dashboard, agent-inspector, charts, replay
src/worker/        （占位）routes, db, middleware, maintenance, index
src/runner/        batch, run-cell, checkpoint, checkpoint-fs, cluster, distance, gates, labels, window-stats, mean-field, preregistration
migrations/        D1 追加式迁移（当前只有迁移约定说明）
test/              unit, property, integration, fixtures, golden, e2e
scripts/           check-doc-links, params/config fixture 生成, benchmark, p15-* 实验脚本
docs/              施工文档（编号规格 + guides/ + reference/ + research/ + changes/ + adr/）
```

技术基线：Node.js >=22.18、pnpm（版本锁定）、TypeScript strict、Vitest、fast-check、
ESLint/Prettier。Vite、Hono、workerd/Wrangler 尚未引入（P3/P4 才需要）；图表库需经 ADR 引入。

---

## 8. 标准验证命令

> 下列命令均已在 `package.json` 中真实存在。真实 Jev 冒烟用
> `JEV_API_KEY=... node scripts/smoke-live.mjs`（不进 `package.json`，CI 默认不跑）；
> `test:integration` / `test:e2e` 目前没有测试文件，
> 以 `--passWithNoTests` 放行，P3/P4 开工后才有实质覆盖。

```bash
pnpm install --frozen-lockfile
pnpm check:docs    # Markdown 相对链接
pnpm format        # prettier --check
pnpm lint
pnpm typecheck
pnpm typecheck:core  # core 不含 Node 类型的纯度检查
pnpm test
pnpm test:coverage # 核心 statements/branches >= 95%
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm params:snapshot  # 参数注册表契约快照，diff 需人工审查
node scripts/benchmark.mjs  # 40/200/1000 人基准
```

实验脚本按轮次单独运行（`node scripts/p15-w6-longhorizon.mjs` 等），清单见
[scripts/README.md](scripts/README.md)。CI 默认不运行真实 Jev 调用，不保存真实 Key，
不因外部模型不稳定阻断纯核心测试。

---

## 9. 当前限制与已知风险

- **产品端为零**：`src/app`、`src/ui`、`src/worker` 只有占位 README；`migrations/` 只有说明文档。
  没有可运行的界面、Worker、D1/R2 与上传链路。
- **科学验收未达成**：G1.5 只证明 ≥2 类（k=2 ARI 1.000）；≥3 类仅有 W6 候选
  （10950 tick、class-share 单特征、仅 `mock`）。P6-05 要求的全特征向量、五个消融与
  Jev/mock 对照均未执行。
- **未校准**：默认参数是首轮校准起点，不是现实结论，也不承诺产生三类结构。
- **3650 视野内只有两类**：若要短视野三类，需正反馈机制（占用优势 / 网络闭锁），
  继续增大 `occupancyMemoryDays` 无效（H=0/90/180/365 终态几乎重合）。
- **`rule.md` 修订注记已补齐到 v11（2026-11-04）**：v9 位移份额、v10 占用锚定、v11 占用记忆
  已在规则 9 与规则 55（期末派生占用压力）落地，头部沿革按 v4–v8 体例记录了各自实测结论
  （v9 负面、v10 给出三个参数区域但无多吸引域、v11 只延迟不钉住且 W6 三类全部 `H=0`）。
- **Jev 非确定性**：真实 Jev 输出不承诺跨时间确定；只有 mock/random 承诺种子级复现，
  live 运行通过保存决策日志重放。
- **决策层已实测但仅限链路**：P2-07 冒烟 8 人 / 30 tick / 24 决策全部成功、0 回退、
  `cost=0`、p50 1.30 s，但规模与视野远低于 07 §8 的验收口径，**不是 P6 证据**。
  官方域名在本机返回 451，该密钥只对自建网关有效；响应模型被归一化为 `jev-1.13-free`。
  预算估算器 `utf8-half-v1` 经此暴露为**低估**（会永久锁死 live run），已升为
  `utf8-three-quarter-v1`，见 [changes/0030](docs/changes/0030-p2-07-live-smoke-endpoint-and-estimator.md)。
- **权威哈希仅承诺 V8**：Node >=22、workerd、Chromium；Safari/Firefox 标记 `nonAuthoritativeRuntime`。
- **外部服务限制会变化**：Jev 模型名、价格、限流、Cloudflare 配额在接线和发布前必须复核官方文档。
- **待议决策未全关闭**：`docs/01` §12 的 D-01/D-02 仍开放（不得把 `hardLifeFloor`/sigma 当前域写成不可变契约）；
  D-04 已按 VPS 实测关闭（v1；Stage B 预算按 changes/0039 重冻结为 v2：480 min）；
  D-05 的 `rule.md`/`03` 修订部分已补齐，是否关闭须由规则负责人按 §12 的证据要求判定。

---

## 10. 下一步

1. 阅读 [AGENTS.md](AGENTS.md) 与 [docs/README.md](docs/README.md) 的效力规则。
2. **P6-01 Stage B 剩余 3 单元**：用 `--resume` 续跑 `crossDays=double`（ledger 30/60、仅 baseline），
   再逐个执行已冻结的 `psi=1`、`needThreshold=0.9`（D-04 v2：480 min/单元）。
3. **P6-01 收口 → P6-02**：全部确认后写收口记录，再进入多参数扫描与临界区定位。
4. **P6-05 前不得跳步**：按 [docs/07](docs/07-experiment-calibration.md) §8.1 用全特征向量重做三类判定，
   补五个消融与 Jev/mock 对照，才谈校准；G6 未通过不得启动 P3/P4/P5b 产品化。
5. 外部依赖：Jev 自建网关可用但**旧 Key 已泄露须先轮换**；Cloudflare 账号仍缺；
   P5-06 的 VPS `systemctl` 安装演练归发布前；`crossDays-half` 预注册标识差异待裁决（changes/0041 §2）。
