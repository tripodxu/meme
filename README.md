# Stratify

可交互、可回放、可批量实验的社会结构仿真系统。

Jev 负责从代码枚举的合法行动中做结构化选择，确定性 TypeScript 引擎负责财富、阶级、竞争、寿命、网络与宏观指标的全部结算。浏览器承载交互实验，Cloudflare Workers 承载网站与数据服务，VPS 承载大规模批量实验。

> **当前状态（2026-11-04）：P0/P1 完成；P1.5 只通过一部分闸门；P2 决策层进行中；P3–P7 未开工。**
> 版本轴 `rules-v11` / `engine-v0.9.0` / `stratify-config-v6` / `stratify-state-v3`。
> G1.5 已通过（k=2、两类结构）；W5 在 3650 tick 未通过；W6 在 10950 tick 终态 class-share 得到
> **三类候选**（仅 `mock`、仅单特征，**不是 P6-05 正式验收，也不是参数校准**）。
> 前端、Worker、上传与 P6 校准均未开始；默认参数尚未校准，任何“三类结构已涌现”“Jev 行为有效”
> “性能已达标”“生产可发布”的说法仍不成立。

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

## 4. 规则当前口径（rules-v11）

`rule.md` 仍是社会机制的唯一事实来源（13 章），结算细节以
[docs/03](docs/03-rules-implementation.md) 为准。`rules-v11` 相对 `rules-v3` 的机制线：

- **需求参照系（v6，D-06 A′）**：`'class'` 模式（默认）需求线 = `refIncome[c] × bufferDays × ψ_eff[c]`，
  即「在该阶级按人均水平生活 `bufferDays` 天所需的价值」；`'own'` 逐位保留 v3–v5 语义，仅作消融对照。
  跌落计时改由 `need.graceDays`（默认 30）单独控制，不再与需求线高低耦合。
- **持有裕度（v5 / v7）**：上升资格从「费用可负担」升级为「费用 + 目标阶级持有裕度可负担」，
  `ascent.holdingCushionDays` 默认 30；`'class'` 模式下裕度与需求线共用 `refIncome` 参照系。
- **位移准入（v8 / v9）**：`'class'` 参照系下上升须击败目标阶级在位者，被击败者降级；
  `ascent.displacementShare`（默认 1）控制走位移而非开放准入的份额。
- **占用锚定与压力记忆（v10 / v11）**：壁垒按目标阶级占用压力 `p_c = max(0, P_c/target_c − 1)`
  计费，权重 `ascent.scarcityWeight`；`ascent.occupancyMemoryDays`（默认 0）为该压力的指数记忆，
  `H=0` 时逐位退回 v10。**H 不改变 10950 终态，第三类在 `H=0` 已出现，因此 rules-v11 不作为三类成因。**
- **初始年龄 `initialAgeMode`**：`uniform`（默认）时 `remainingLife = initialLife × (1-u_age)`；
  `newborn` 仅用于演示。两种模式都消费 `init_age` 地址。
- **365 日流动参与率**：`Mup/Mdown` 为过去 365 日内至少发生一次上升/下降的存活者占比，
  不使用 EMA，也不做「单日事件数 × 365」。
- **调整后网络隔离度 `S`**：双侧归一化后恒在 `[-1, 1]`；`edgeCount=0` 时 `S=0` 并单独标记，
  不得用 `S=1` 冒充完全隔离。
- **参数注册表**：所有业务常数集中注册（87 条定义，含单位、域、公式引用与接线测试），
  进入 `paramsHash`；`hardLifeFloor` 标记为 `guardOnly`。
- **P1.5 可达性闸门**：先用 headless 原型与均值场分析证明规则能产生多于一种可归类结构，
  未通过不得启动 P2–P6。当前 G1.5 已过（≥2 类），但 ≥3 类只有 W6 候选。

完整公式、字段、默认值和不变量见 [docs/03-rules-implementation.md](docs/03-rules-implementation.md)；
版本沿革见 [docs/changes/](docs/changes/README.md)。

---

## 5. 施工路线

推荐关键路径：

```text
P0 → P1 → P1.5（Go/No-Go）→ P2 → P5a → P6（G6 校准）
                                      └→ P4 / P5b / P3（云端与产品化并行）→ P7
```

| 阶段     | 目标                                                       | 闸门                                                              | 当前状态                                       |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| **P0**   | 规格冻结、TS 骨架、配置校验、12 个 hash domain、参数注册表 | G0：配置可 round-trip；`paramsHash` 入 golden；零裸字面量         | 完成                                           |
| **P1**   | 确定性核心：RNG、8 阶段结算、快照、微扰克隆                | G1：机制规则逐条测试；同输入最终哈希一致；10,000 tick soak 无 NaN | 完成（含 10,000 tick soak）                    |
| **P1.5** | 涌现可达性预研（**阻断层**）                               | G1.5：至少 2 类非退化、可复现结构聚类；否则回改规则               | 部分：G1.5 过（2 类）；≥3 类仅 W6 候选         |
| **P2**   | Jev 决策层：Choice 协议、重试、预算、重放                  | G2：故障注入覆盖超时/401/403/429/5xx/非法 JSON；预算与取消有效    | 进行中：接口/预算/重放已实现，P2-07 真实冒烟缺 |
| **P3**   | 前端交互 MVP                                               | G3：离线 mock、live 小额、导入回放三条路径 E2E 通过               | 未开始（`src/ui` 仅占位）                      |
| **P4**   | Cloudflare 数据服务                                        | G4：幂等、并发、越权、超限测试通过；无密钥泄漏                    | 未开始（`src/worker` 仅占位）                  |
| **P5a**  | 本地批量 Runner 与检查点                                   | G5a：kill 后恢复最终哈希一致；不依赖云端                          | 部分：batch/检查点/cluster 已实现，CLI 入口缺  |
| **P5b**  | 分批上传与断点续传                                         | G5b：断网/重复上传不产生虚假 complete                             | 未开始（依赖 P4）                              |
| **P6**   | 校准与科学验收                                             | G6：满足 `rule.md` 56–59 条；至少 3 类互异结构指纹聚类            | 未开始：需全特征向量 + 消融 + Jev/mock 对照    |
| **P7**   | 发布硬化                                                   | 备份/回滚演练、安全扫描、渐进发布                                 | 未开始                                         |

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

> 下列命令均已在 `package.json` 中真实存在。`smoke:local` / `smoke:live` 尚未提供，
> 真实 Jev 冒烟（P2-07）尚无 CLI 入口；`test:integration` / `test:e2e` 目前没有测试文件，
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
- **`rule.md` 与实现存在口径差**：`rule.md` 的修订注记停在 v8，v9/v10/v11 的机制
  （位移份额、占用锚定、占用记忆）目前只记在 `docs/03` 与 `docs/changes/`，
  `rule.md` 尚未同步——这是 D-05 关闭条件的一部分，需规则负责人确认后补齐。
- **Jev 非确定性**：真实 Jev 输出不承诺跨时间确定；只有 mock/random 承诺种子级复现，
  live 运行通过保存决策日志重放。
- **决策层依赖尚未验证**：P2-07 真实冒烟未跑（需独立低预算密钥 + VPS 直连），
  实际模型行为、成本与延迟均无实测数据。
- **权威哈希仅承诺 V8**：Node >=22、workerd、Chromium；Safari/Firefox 标记 `nonAuthoritativeRuntime`。
- **外部服务限制会变化**：Jev 模型名、价格、限流、Cloudflare 配额在接线和发布前必须复核官方文档。
- **待议决策未全关闭**：`docs/01` §12 的 D-01/D-02/D-04 仍开放（manifest 含占位值），
  D-05 关闭条件未满足。

---

## 10. 下一步

1. 阅读 [AGENTS.md](AGENTS.md) 与 [docs/README.md](docs/README.md) 的效力规则。
2. **P2 收口**：跑 P2-07 真实冒烟（VPS 直连、独立低预算密钥、成本上限），
   补 P2-03 真实响应 fixture，把 `ReplayPolicy` 接入批跑入口。
3. **P5-01**：交付 batch CLI 与 manifest（`src/runner` 已有 batch/检查点核心，缺命令行入口），
   这是 P6「每点 ≥30 配对种子」的前提。
4. **P6**：按 [docs/07](docs/07-experiment-calibration.md) §8.1 用全特征向量重做三类判定，
   补五个消融与 Jev/mock 对照，再谈校准。
5. P3/P4/P5b 在 G6 通过后并行，不要用更多工程掩盖规则与统计问题。
