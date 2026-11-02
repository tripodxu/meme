# 01 分阶段施工计划

## 1. 执行规则

- 按 P0→P1→P1.5→P2→P7 推进；允许并行做无依赖任务，但不得跳过质量闸门。P1.5 未通过不得启动 P2–P6。
- 推荐关键路径：P0 → P1 → P1.5 → P2 → P5（本地 runner）→ P6（校准）→ P3/P4（产品化与云）→ P7；P4/P3b 不必早于 G6。
- 每个任务必须引用本文任务 ID，提交包含实现、测试、文档和验证证据。
- 一个 PR 只做一个可回滚主题；公共契约变更单独 PR。
- 未完成验收不得写“完成”；受阻时记录阻塞、复现命令和下一步。
- 每个阶段结束更新 `12-handoff-checklists.md` 中的交接记录副本或项目跟踪系统，不篡改历史实验。

## 2. 推荐目录与脚手架

```text
src/core/          model, config, engine, competition, life, network, macros, feedback, stats, rng, replay
src/decision/      legal-actions, serialize, policy, jev-client, mock, replay, fallback
src/app/           run-controller, api-client, experiment, local-store
src/ui/            setup, dashboard, agent-inspector, charts, replay
src/worker/        routes, db, middleware, maintenance, index
src/runner/        batch-cli, checkpoint, rate-limit, budget, uploader
migrations/        D1 追加式迁移
test/              unit, property, integration, fixtures, golden, e2e
scripts/           smoke-live, verify-backup, benchmark, export-d1
docs/              本施工文档与 adr/
```

技术基线：Node.js >=22.18、pnpm（版本锁定）、TypeScript strict、Vite、Hono、Vitest、fast-check、workerd/Wrangler。前端默认原生 DOM/SVG；确需图表库时通过 ADR，不引入第二套规则实现。

## 3. P0：规格冻结与工程骨架

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P0-01 | 初始化包、TS、格式化、测试、CI 骨架 | 无 | 安装后 `pnpm typecheck && pnpm test && pnpm build` 可运行 |
| P0-02 | 定义版本字段、单位、ID、 branded types 与错误码 | P0-01 | `Ruleset/RunConfig/RunIdentity` 类型与文档一致；`seed` 明确不属于 `RunConfig`；`configHash/paramsHash/initialPopulationHash/preregistrationHash` 各有 domain、覆盖字段和测试向量 |
| P0-03 | 用 schema 校验完整配置和导入文件 | P0-02 | 缺字段、NaN、非法范围、未知版本均返回路径化错误；`returnDiscount` 长度/单调性、`initialAgeMode` 枚举被校验 |
| P0-04 | 将 59 条规则映射到模块和测试清单 | P0-02 | 03 文档无“待定”核心顺序；未校准项显式标识；机制规则与验收/方法条目分开 |
| P0-05 | 建立 fixture、变更和发布目录约定；复用 `docs/adr/0000-template.md` | P0-01 | ADR 模板可直接复制；目录约定可用，CI 检查必要文档链接 |
| P0-06 | 建立参数注册表与接线测试 | P0-02 | 03 所有业务常数有名称/范围/公式引用；改一个参数必须改变对应输出；`hardLifeFloor` 标为 guardOnly 且有边界测试；无裸字面量 |

**闸门 G0**：配置 fixture 可 round-trip；所有默认参数有单位/范围；`paramsHash` 进入 golden；CI 对空核心也能稳定执行。禁止在此阶段调用真实 Jev。

## 4. P1：确定性规则核心

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P1-01 | 可寻址 RNG 与初始化分布 | P0 | 相同地址结果相同；增加其他事件不改变本事件；分布截断有测试 |
| P1-02 | 个体、社会、事件、快照状态及规范化哈希 | P0 | JSON round-trip 不丢状态；哈希排除时间戳等易变字段 |
| P1-03 | mock 策略与合法行动枚举 | P1-01 | 无模型可运行；候选不含死亡、自身、重复或非法跨层目标 |
| P1-04 | 积累、需求、升降、跌落、竞争、寿命结算 | P1-02 | 规则逐条单测；`needMultiplier`、初始年龄、费用不足、最低/最高层和死亡边界正确 |
| P1-05 | 网络初始化/重构与 O(N²) 防护 | P1-01 | 无重边/自连、度数受限、空网络合法、抽样可复现 |
| P1-06 | 动态 E、O、调整后 S、365 日 Mup/Mdown、结构指纹 | P1-04,P1-05 | 空人口/全零财富/空网络无 NaN；慢变量每周期仅更新一次；S 与 edgeCount 一致 |
| P1-07 | 固定 tick 管线与事件日志 | P1-04,P1-06 | 顺序符合 03；每个 Value 变化可追溯到事件 |
| P1-08 | 快照、恢复、决策回放与微扰克隆 | P1-07 | 中途恢复最终哈希一致；克隆只改变指定字段；lastAscent/Descent 可恢复 |
| P1-09 | 核心基准与内存 profiling | P1-07 | 记录 40/200/1000 人基准，不预设未实测性能承诺 |

**闸门 G1**：机制规则（1–25、30–45）有逐条测试，元规则（26–29、46–59）有对应的实验/验收任务；同输入最终哈希一致；无 `Math.random()`、I/O 或 wall clock；至少 10,000 tick soak 无 NaN/Infinity/负财富。

## 4.5 P1.5：涌现可达性预研（新增，阻断 P2–P6）

> 目的：在接模型、UI 和云之前，先回答“当前规则能否产生多于一种可归类结构”。这不是完整校准，而是 go/no-go 闸门。

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P1.5-01 | headless 原型：无网络/无 UI，复用 P1 核心，跑 40/200/1000 人、3650 tick | P1 | 单命令输出 P/G/S/Mup/Mdown/O/死亡率和结构标签；30 个配对种子可批量 |
| P1.5-02 | 均值场/不动点分析：E–P、O–Mup–S–G 的符号与增益 | P1.5-01 | 给出至少一组固定点/临界区；能解释顶层吸收或分层是否由机制而非参数偶然造成 |
| P1.5-03 | 标签可达性矩阵：五类标签在参数网格上的可达性 | P1.5-01 | 每类标签给出可达/不可达证据；不可达则回改规则，不进入 P2 |
| P1.5-04 | 预注册与 kill criteria | P1.5-03 | 冻结 primary metric/种子/窗口/标签阈值 hash；若 3 个参数格×30 种子只得到 ≤1 个结构聚类，停止 P2–P6 并回改规则 |

**闸门 G1.5**：至少 2 类可复现结构聚类，且至少 1 类不是由全死亡/空网络/未归类造成；均值场预测与仿真方向一致。未通过不得启动 P2。

## 5. P2：Jev 决策层

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P2-01 | 定义 Policy 接口和决策来源元数据 | P1.5 | mock/live/replay 可替换，核心不感知 HTTP |
| P2-02 | 英文紧凑 state 和 Choice 序列化 | P2-01 | prompt 有版本；候选描述完整；不超候选/上下文预算 |
| P2-03 | Jev HTTP client、响应 schema 与脱敏日志 | P2-02 | 真实响应 fixture 验证；非法 JSON/空概率/未知选项安全失败 |
| P2-04 | 超时、有限重试、取消、token bucket 和熔断 | P2-03 | 401/403 不重试；429/5xx 尊重 Retry-After；取消能停止后续调用 |
| P2-05 | 回退、失败率阈值、调用/Token/时间预算 | P2-04 | 超预算不再发请求；连续失败不会静默产生整轮回退实验 |
| P2-06 | 决策日志、live 标记与重放非法处理 | P2-03,P1-08 | 原始响应可审计；replay 不伪装 live；`replay_invalid` 可统计 |
| P2-07 | Worker 同源 BYOK 代理和最小真实冒烟 | P2-04 | Key 不落库/日志/URL；一次低成本 Choice 成功并记录真实模型 |

**闸门 G2**：故障注入覆盖超时、401、403、429、529、5xx、空响应、未知行动和过期目标；预算和取消有效；真实冒烟成本有上限。

## 6. P3：前端交互 MVP

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P3-01 | RunController 状态机与非阻塞调度 | P1,P2 | 运行/暂停/单步/重置/取消无竞态；UI 不被长循环锁死 |
| P3-02 | 参数表单、预设、校验和配置摘要 | P3-01 | 非法输入不能启动；明确标记未校准预设 |
| P3-03 | 总览、阶级、财富、流动、网络与死亡图表 | P3-01 | 指标有定义/窗口/单位；空数据有状态 |
| P3-04 | 个体检查器与决策解释 | P2,P3-01 | 可查看候选、选择、概率、回退和财富事件，不显示 Key |
| P3-05 | 本地存储、导入导出、回放和错误恢复 | P1-08 | 无后端完整运行；损坏/未知版本文件不覆盖当前实验 |
| P3-06 | 响应式、键盘和可访问性 | P3-02~05 | 关键操作可键盘完成；图表不只靠颜色；移动端无功能缺失 |
| P3-07 | 浏览器 E2E 与大数据渲染降采样 | P3-06 | 核心流程 E2E 通过；图表不逐点渲染全部历史 |

**闸门 G3**：离线 mock、live 小额、导入回放三条路径均通过 E2E；控制台无未处理异常；刷新后的恢复行为明确。P3-06/P3-07 属产品化，可在 G6 后完成；P6 不依赖它们。

## 7. P4：Cloudflare 数据服务

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P4-01 | Hono、Static Assets、统一错误与 request ID | P2-07 | `/api/health`、404、校验错误、内部错误契约一致 |
| P4-02 | D1 初始迁移、索引和 batch 查询 | P4-01 | 本地/远程迁移可从空库执行；迁移只追加 |
| P4-03 | run 创建、writeToken 哈希认证和状态机 | P4-02 | 令牌仅创建时返回；越权写被拒绝；状态转换合法 |
| P4-04 | tick/agent 批量幂等写入与 complete | P4-03 | 重复请求不重复计数/存储；过期 run 不可写 |
| P4-05 | R2 分块 artifact、SHA-256 和导出 | P4-03 | 单块 <=8 MiB；同键不同哈希冲突；NDJSON 可分块读取 |
| P4-06 | keyset 分页、限流、配额和维护任务 | P4-04,P4-05 | 所有列表硬 LIMIT；超限明确 429/413；保留策略可执行 |
| P4-07 | workerd+D1/R2 集成和部署冒烟 | P4-06 | 本地集成与预览环境通过；备份后部署，部署后验证 |

**闸门 G4**：幂等、并发、越权、超限和损坏 artifact 测试通过；D1 无海量事件表；无密钥泄漏。

## 8. P5：VPS 批量 Runner

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P5-01 | batch manifest、CLI 和机器可读摘要 | P1,P2 | 单实验/矩阵/消融可启动；stdout 与报告分离 |
| P5-02 | 全局队列、并发、限流和共享预算 | P2-04 | 多 worker 不突破调用/Token/费用上限 |
| P5-03 | 原子检查点、上传确认和断点恢复 | P1-08,P4 | kill 后从完整点恢复；临时文件不被当作有效点 |
| P5-04 | 配对种子、共同随机数和微扰任务生成 | P5-01 | 实验只改变声明变量；manifest 可审计 |
| P5-05 | 分批上传、重试、去重和最终校验 | P5-03,P4 | 重传幂等；complete 前核对 tick/chunk 完整性 |
| P5-06 | Docker 或 systemd 一种标准部署及日志轮转 | P5-05 | 首选 systemd 或 Docker 并在运维文档固定；不维护两套漂移配置 |

**闸门 G5**：故障注入覆盖运行中 kill、网络断开、磁盘写失败、重复上传和预算耗尽；不产生虚假 complete。

## 9. P6：校准与科学验收

| ID | 工作 | 依赖 | 交付与验收 |
|---|---|---|---|
| P6-01 | 先跑 mock 单参数/全局筛选和稳定性筛查 | P1.5,P5 | 每个点 >=30 配对种子；覆盖 needMultiplier/needThreshold/env0/crossDays/decay；保存分布而非只存均值 |
| P6-02 | 多参数扫描、临界区和稳定区定位 | P6-01 | 记录搜索范围、排除原因和资源消耗 |
| P6-03 | 微扰克隆和正常波动区间 | P6-02 | 区分轨迹不同/结构不同；不只报 D 总分；记录首次事件翻转/发散时间 |
| P6-04 | 四个消融、ψ=1 对照和 Jev/mock 对照 | P6-03 | β=0、O 固定、η=0、κ=0、ψ=1；真实 Jev 单独报告 |
| P6-05 | 冻结三组预设与校准报告 | P6-04 | 至少三类互不相同的结构指纹聚类（非三组预设/多标签）；未达标则记录失败并回到规则评审 |

**闸门 G6**：满足 `rule.md` 第 56–59 条；三类结构按指纹聚类验收，不按标签计数；预设带 ruleset hash 和证据链接；不得把单次结果写成普遍结论。

P6 只依赖 P1.5/P1/P2/P5，不依赖 P4 Worker/D1/R2；校准结果可用本地 artifact 归档。P4 和 P3-06/P3-07 可在 G6 通过后并行，避免云与 UI 先于科学前提投入。

## 10. P7：发布硬化

- 全量 CI、E2E、性能和长时 soak；检查 Worker 请求资源，不以本机结果推断 Worker 限额。
- 备份恢复演练、回滚演练、限流/配额/密钥扫描、依赖漏洞检查。
- 完成用户端快速开始、指标词典、运维 runbook 和已知限制。
- 用预览环境做小额真实 Jev 冒烟，再渐进发布；生产 budgets 默认保守。
- 发布后核对错误率、Jev 回退率、D1/R2 增长、Runner 失败率和成本。

**最终发布闸门**：G0–G6 均有可复现证据；P7 不设独立编号闸门，其验收即本节各项。若某非关键项豁免，必须记录负责人、理由、到期日和回滚条件。

## 11. 标准验证命令

脚手架建立后统一提供：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm smoke:local
pnpm smoke:live        # 显式设置预算与 Key 后才运行
pnpm benchmark
```

CI 默认不运行 `smoke:live`，不保存真实 Key，不因外部模型不稳定阻断纯核心测试；真实冒烟使用独立受控工作流。
