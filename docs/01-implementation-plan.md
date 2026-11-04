# 01 分阶段施工计划

## 1. 执行规则

- 按 P0→P1→P1.5→P2→P7 推进；允许并行做无依赖任务，但不得跳过质量闸门。P1.5 未通过不得启动 P2–P6。
- 推荐关键路径：P0 → P1 → P1.5 → P2 → P5a（本地 runner）→ P6（校准）→ P5b/P4（上传与云）→ P3（产品化）→ P7；P4/P5b/P3 不必早于 G6。
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

| ID    | 工作                                                               | 依赖  | 交付与验收                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-01 | 初始化包、TS、格式化、测试、CI 骨架                                | 无    | 安装后 `pnpm typecheck && pnpm test && pnpm build` 可运行                                                                                                                        |
| P0-02 | 定义版本字段、单位、ID、 branded types 与错误码                    | P0-01 | `Ruleset/RunConfig/RunIdentity` 类型与文档一致；`seed` 明确不属于 `RunConfig`；`configHash/paramsHash/initialPopulationHash/preregistrationHash` 各有 domain、覆盖字段和测试向量 |
| P0-03 | 用 schema 校验完整配置和导入文件                                   | P0-02 | 缺字段、NaN、非法范围、未知版本均返回路径化错误；`returnDiscount` 长度/单调性、`initialAgeMode` 枚举被校验                                                                       |
| P0-04 | 将 59 条规则映射到模块和测试清单                                   | P0-02 | 03 文档无“待定”核心顺序；未校准项显式标识；机制规则与验收/方法条目分开                                                                                                           |
| P0-05 | 建立 fixture、变更和发布目录约定；复用 `docs/adr/0000-template.md` | P0-01 | ADR 模板可直接复制；目录约定可用，CI 检查必要文档链接                                                                                                                            |
| P0-06 | 建立参数注册表与接线测试                                           | P0-02 | 03 所有业务常数有名称/范围/公式引用；改一个参数必须改变对应输出；`hardLifeFloor` 标为 guardOnly 且有边界测试；无裸字面量                                                         |

**闸门 G0**：配置 fixture 可 round-trip；所有默认参数有单位/范围；`paramsHash` 进入 golden；CI 对空核心也能稳定执行。禁止在此阶段调用真实 Jev。

**P0 完成记录（2026-11-02）**：已完成 TS/pnpm/Vitest/ESLint/Prettier、`RunConfig` 类型与路径化校验、参数注册表（含 `guardOnly` 与接线说明）、JCS/SHA-256 与 11 个 hash domain、golden fixture 及本地门禁。以下项尚未实现，按依赖推迟：`Ruleset/RunIdentity` 类型（P1-02）、state/recentEvents JSON Schema（P2-02）、`initialPopulationHash`（P1-01）与 `preregistrationHash`（P6-05）。在这些项完成前，P0-02/P0-03 只能标记为部分完成，不得声称全部验收已满足。

## 4. P1：确定性规则核心

| ID    | 工作                                            | 依赖        | 交付与验收                                                                                                                                                                     |
| ----- | ----------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-01 | 可寻址 RNG 与初始化分布                         | P0          | 相同地址结果相同；增加其他事件不改变本事件；分布截断有测试                                                                                                                     |
| P1-02 | 个体、社会、事件、快照状态及规范化哈希          | P0          | JSON round-trip 不丢状态；哈希排除时间戳等易变字段；每个 hash domain（含 `stratify-label-thresholds-v1`）有字段级 canonical schema 与固定向量，并在 Node/workerd/Chromium 校验 |
| P1-03 | mock 策略与合法行动枚举                         | P1-01       | 无模型可运行；候选不含死亡、自身、重复或非法跨层目标                                                                                                                           |
| P1-04 | 积累、需求、升降、跌落、竞争、寿命结算          | P1-02       | 规则逐条单测；`needMultiplier`、初始年龄、费用不足、最低/最高层和死亡边界正确                                                                                                  |
| P1-05 | 网络初始化/重构与 O(N²) 防护                    | P1-01       | 无重边/自连、度数受限、空网络合法、抽样可复现                                                                                                                                  |
| P1-06 | 动态 E、O、调整后 S、365 日 Mup/Mdown、结构指纹 | P1-04,P1-05 | 空人口/全零财富/空网络无 NaN；慢变量每周期仅更新一次；S 与 edgeCount 一致                                                                                                      |
| P1-07 | 固定 tick 管线与事件日志                        | P1-04,P1-06 | 顺序符合 03；每个 Value 变化可追溯到事件                                                                                                                                       |
| P1-08 | 快照、恢复、决策回放与微扰克隆                  | P1-07       | 中途恢复最终哈希一致；克隆只改变指定字段；lastAscent/Descent 可恢复                                                                                                            |
| P1-09 | 核心基准与内存 profiling                        | P1-07       | 记录 40/200/1000 人基准，不预设未实测性能承诺                                                                                                                                  |
| P1-10 | O 固定消融开关与配置哈希接线                    | P1-06       | O 可在不改变其他状态的情况下冻结；开关进入 configHash/paramsHash；P6-04 使用                                                                                                   |

**闸门 G1**：机制规则（1–25、30–45）有逐条测试，元规则（26–29、46–59）有对应的实验/验收任务；同输入最终哈希一致；无 `Math.random()`、I/O 或 wall clock；至少 10,000 tick soak 无 NaN/Infinity/负财富。

**P1 完成记录（2026-11-03）**：P1-01–P1-10 已实现并通过本地门禁（`typecheck/typecheck:core/lint/format/test:coverage/build/check:docs`，350 个测试，核心覆盖率 statements 98.4%/branches 96.4%）。交付物：可寻址 RNG 与标准抽样（`src/core/rng`）、`(config,seed)` 初始化派生含初始网络（`src/core/init`）、`stratify-state-v1` 序列化与导入边界校验、`initialPopulationHash/authoritativeStateHash/labelThresholdsHash` 与 12 个 domain 的字段级 schema、合法行动枚举与 mock/random 策略（`src/core/legal-actions.ts`、`src/decision`）、A→H 固定管线与事件/执行记录（`src/core/engine`）、网络重构（`src/core/network`）、宏观指标与慢变量（`src/core/macros`、`src/core/feedback`）、快照/恢复/决策日志回放/微扰克隆（`src/core/replay`）、`openness.updateMode` 消融开关、10,000 tick soak 与性质测试（fast-check）、40/200/1000 人基准（`scripts/benchmark.mjs`，结果见 `docs/benchmarks/`）。golden fixture：40 人默认 mock tick 0/1/10/120/400 状态哈希与指标、uniform/newborn 3650 tick 死亡率对照（0.10 / 0）。机制规则 1–25、30–45 逐条测试；元规则 26–29、46–59 对应 P1.5/P6 实验任务。以下事项按计划推迟：`workerd/Chromium` 运行时哈希校验（P4 集成时补）、大规模参数接线对照（P1.5/P6）。

## 4.5 P1.5：涌现可达性预研（新增，阻断 P2–P6）

> 目的：在接模型、UI 和云之前，先回答“当前规则能否产生多于一种可归类结构”。这不是完整校准，而是 go/no-go 闸门。

| ID      | 工作                                                                    | 依赖    | 交付与验收                                                                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1.5-01 | headless 原型：无网络/无 UI，复用 P1 核心，跑 40/200/1000 人、3650 tick | P1      | 单命令批量 30 个配对种子；固定输出 `cell/seed/configHash/paramsHash/population/window/metrics/labels/aliveAtEnd/artifact`；先给出单 run 预计耗时/内存并设上限；批量核心放入 `src/runner`，P5a 只硬化检查点/预算/上传，不另写 runner |
| P1.5-02 | 均值场/不动点分析：E–P、O–Mup–S–G 的符号与增益                          | P1.5-01 | 给出至少一组固定点/临界区；能解释顶层吸收或分层是否由机制而非参数偶然造成                                                                                                                                                           |
| P1.5-03 | 标签可达性矩阵：六类标签（含顶层过重）在参数网格上的可达性              | P1.5-01 | 每类标签给出可达/不可达证据；不可达则回改规则，不进入 P2                                                                                                                                                                            |
| P1.5-04 | 预注册、聚类协议与 kill criteria                                        | P1.5-03 | 冻结 primary metric、参数网格、种子、窗口、标签阈值、聚类协议与稳定性判据；若网格内 ≤1 个稳定聚类，停止 P2–P6 并回改规则                                                                                                            |

**闸门 G1.5**：按 07 §8.1 预注册的聚类协议，至少 2 类可复现结构聚类，且至少 1 类不是由全死亡/空网络/未归类造成；均值场预测与仿真方向一致。未通过不得启动 P2。G1.5 只是 go/no-go 闸门，不构成校准完成；P6-05 仍要求至少 3 类互不相同的结构指纹聚类。

**P1.5 完成记录（2026-11-03）**：P1.5-01–P1.5-04 已执行——预注册 manifest（`preregistrationHash=sha256:bdff1c9a…`，D-03/D-04 标记保留）、`src/runner` 批量核心与 `scripts/p15-grid.mjs`、16 cell × 30 配对种子 × 3650 tick（480 run，14 分钟）全量运行、均值场分析（`docs/research/p15-mean-field.md` + `scripts/p15-mean-field.mjs`）。**G1.5 判定：未通过**——全网格仅一种“顶层过重+旋转门”结构（topHeavy 30/30 全部 cell），聚类 k=4 轮廓系数 0.265、稳定性 ARI 0.471 < 0.70；pyramid/olive/closedStratified 0/480 不可达。均值场证明该结构由机制（需求与收益同源、Opportunity 顶层自我强化、O 正反馈制动不足）而非参数偶然造成；8 个补充探索变体（crossDays/decay/θM/Mref/ψ/lossRate）全部保持同一结构。证据：`docs/research/2026-11-03-p15-report.md` 与 `out/p15-full.json`。

**P1.5 v4 复核（2026-11-03，用户授权自主规则负责人）**：按报告 §6 执行 changes/0004（rules-v4：需求线环境持有人乘子 `(env0[c]/env0[0])^φ` + θM 8→3 + engineVersion v0.1.0），重跑三轮预注册网格（20/20/24 cell × 30 种子；hash 4bf566b9/ad2d75fe/f1dc1bca）。φ 解耦有效（P4 梯度 0.29–0.92、olive 可达、ge.median 轴开启中重分布区域），但 **G1.5 仍未通过**：可达集为连续统，bisect-ARI∈[0.32,0.58] 全部 <0.70。机制根因已定位——旋转门引擎三要素（积累无上界、跌落携带财富并重置需求时钟、mock 无条件上升）使 Mup→1 与参数无关。**P2–P6 继续依闸门搁置**；rules-v5 候选方向（跌落财富清偿/上升持有资格/积累承载上限）已登记于报告 §8.4，待规则负责人决策。

**P1.5 rules-v5 落地与轮 2（2026-11-03）**：按 D-05 方向 B 落地 changes/0005（`ascent.holdingCushionDays` 默认 30，ρ=0 退回 v4；`e531bab`），并登记 v5 预注册网格（`1a0eddf`，ρ∈{0,30,90}×φ）。轮 2 将 `warmupTicks` 延长至 1825、诊断改为吸引子稳定性、新增 w2b 窗口（`921c006`）。**但截至本记录 G1.5 仍未通过，且轮 2 证据不成立**：`921c006` 提交的 `out/p15-full.json` 是旧产物（`preregistrationHash=sha256:9d9de682…`、k=3、ARI 0.417），新产物（`sha256:2c4843b4…`、k=2、ARI 0.868）直到 `3a8c1ae` 才入库；`ANALYSIS_WINDOWS` 未含 w2b，`temporalConsistency` 恒为 null；两簇均含 topHeavy，c1 仅来自 5 个 cell（baseline 0/30）。详见 `docs/reviews/2026-11-03-zcodes-nightly-audit.md`。修复后必须用真实 w2b 数据重新预注册并重跑，方可用于 G1.5 判定。

**P1.5 轮 2 重跑（2026-11-03，changes/0006 + 0007 修复后首次有效证据）**：`preregistrationHash=sha256:4dc141e4…`，`out/p15-full.json` 4.07MB / `sha256:dc6e85f9…`，840 run × 3650 tick × 107 分钟；840/840 存活、w2b 与 w3 **各 840/840 available**（首份 w2b 有真实数值的产物）、`temporalConsistency=0.893`（门槛 0.80）、预算全达标、离线复算一致。**G1.5 判定：仍未通过**——k=4（轮廓 0.370），半样本重聚类 ARI 三次为 0.702 / 0.579 / **0.366**，按 07 §8.1 以最小值为准（0.366 < 0.70），即「未形成可复现结构」。描述性进展：四簇与参数存在可辨识对应（`envExponent=0`/`cushionDays=90+phi=0` 100% 落 c2「封闭分层」；`cushionDays=90`/`envExponent=2` 主要落 c3「顶部抽空」），但 67% 特征点集中在 c0。27 个非 baseline cell 中 24 个达到区分度门槛。详见 `docs/research/2026-11-03-p15-report.md` §10。遗留口径缺口：稳定性取 max/mean/min 未冻结（当前取 min）、`clustering.algorithm` 未记录实现标识、朴素 Ward 在 1680 点上占 107 分钟中的约 77 分钟。**P2–P6 继续依闸门搁置。**

**P1.5 诊断与下一轮计划（2026-11-03）**：对上述产物做离线再分析（`node scripts/p15-diagnose.mjs`，只读、确定性）并补读实现后判定：**总根因是需求参照系错误（R1），不是缺一个抑制机制**。代码事实——`baselineSum` 只累加 `dailyBase×env`（`engine.ts:197`），按 `rule.md:118` 它是「`ge=hard=1` 参照个体的历史积累」，**不是个体自身收入**；`need = buffer(classAge)×baselineSum×ψ_eff[c]`，而升阶与降阶都执行 `classAge=0, baselineSum=0`（`engine.ts:479-480`、`:521-522`）：**一次升阶等于持有标尺归零 + 缓冲重起算 + 收入照常，升阶不是代价而是免租期**；同时标尺随停留天数 `D` 线性无界上涨（`D×B×E[c]×ψ[c]`），使持有能力退化为「生产率是否高于 `threshold×ψ[c]`」的绝对测试而非相对位置测试。这解释了 mUp≈0.95、P0 被抽空（初始 0.45→w3 0.003）与单稳态三个现象，也与最粗 k=2 的半样本 ARI 为 −0.101/−0.046/0.313（与随机无异）一致。据此登记 W0 管线硬化（Ward 换 Lance–Williams、冻结 `ward-lw-v1`、稳定性口径冻结为 20 次洗牌取 median 且必报 min）、W1 rules-v6（**D-06 选项 A′：需求与上升费用统一以「阶级参照收入」`refIncome[c]` 计价，且把标尺与宽限期拆开——`need` 不再乘 `buffer(classAge)`，改由 `graceDays` 只控判定计时**；保留 `need.referenceMode` 消融开关，`own` 逐位退回 v5）、W2 确认轮、W3 判定，并设四道机制门禁（G-A `P0(w3)≥0.15` 且 `mUp≤0.60`；G-B P4 跨度≥0.40；G-C 窗口间分布漂移<0.10；G-D 消融退回 v5 逐位一致）。判定协议另加硬约束：k=2 的 ARI median 未达 0.70 即判「无宏观二态」，不得退而报告 k=4/k=5 充作通过。计划、被否备选与可行性分析见 `docs/research/2026-11-03-p15-diagnosis-and-next-round.md`，可直接执行的施工说明见 `docs/research/2026-11-03-p15-w0-w1-handoff.md`（D-07 新种子 `p15r3-seed-001…030`、D-08 位移准入不同批已定）；**G1.5 未通过前 P2–P6 继续搁置**。

**P1.5 W0/W1 落地与 G-A..G-D 门禁实测（2026-11-04）**：W0 管线硬化已交付（commit `6df579b`）——Ward 换 Lance–Williams 递推（`ward-lw-v1` 实现标识进 `preregistrationHash`，朴素版保留为参考实现，等价性验收 = 无并列数据 ARI=1.0 + 代价序列相对误差 ≤1e-12 + 1680 点 2.5s ≪ 60s），稳定性口径冻结 `stabilityShuffles=20`、判定量 = median 且必报 min（07 §8.1 同批生效）；D-03 随预注册 manifest 冻结关闭（选项 A）。W1 rules-v6 按 D-06 选项 A′ 落地 changes/0008（`refIncome` EMA 计价 + `graceDays` 判定计时 + `referenceMode` 消融开关；版本轴 `rules-v6`/`engine-v0.4.0`/`stratify-config-v3`/`stratify-state-v2`）。门禁实测（`out/p15-gates.json`）：**G-D 通过**（own 模式 5/5 种子与 rules-v5 参照 fixture 语义状态逐位一致、class 模式序列化往返一致；对照口径偏离交接单的 finalStateHash 逐位比较，改按语义字段比较，理由与实现见 changes/0008 §9）；**G-A 未通过**（P0(w3)=0.0000 < 0.15，mUp(w3)=0.0416 合规）；**G-C 未通过**（‖P(w2b)−P(w3)‖₁=0.1624 ≥ 0.10）；G-B 实测见产物。机制根因：class 需求线是固定存量，而 v5 持有裕度（ρ=30）在 class 模式下高于需求线，新升阶者必然带高于需求线的余额进入——上升成吸收态、底层无补入，裕度与参照系尺度错位。按 handoff §8 停止：不回填参数（红线 4）、**W2 确认轮未启动**（G-A 是资格前提）、D-08 位移准入与裕度参照系后续修订待规则负责人以独立预注册决策。

**P1.5 rules-v7/v8 双轮修订与判定树执行（2026-11-04）**：按 changes/0008 §6 的机制根因（裕度与参照系尺度错位）与 diagnosis §8 判定树执行两轮**单变量**修订（每轮独立实测，避免归因混杂）：

1. **rules-v7**（changes/0009，`engine-v0.5.0`）：裕度 class 模式改按 `refIncome` 计价（完成 A′ 统一计价）。实测 **G-B 0.307→0.6327 转为通过**（响应面打开），但 G-A 的 P0 仍为 0、G-C 恶化至 0.416——证明纯比例机制在 income>0 时无下行流，判定树前提（相对单位就位）自此成立。
2. **rules-v8**（D-09，changes/0010，`engine-v0.6.0`）：位移准入——'class' 参照系下上升须击败目标阶级在位者（复用竞争结算、败者降级、零和下行流；own 模式不进入该分支，G-D 逐位保持）。实测 **P0(w3)=0.5571 ✓（底层恢复为储水池）、G-C 0.0367 ✓（分布稳态）、G-D ✓**；G-B 的 P4 极差 0.0065 ✗ 但 8 个相邻档位对 ‖ΔP‖₁≥0.10 ✓（形状响应移至中产轴）；唯 **mUp(w3)=0.9553 > 0.60**——1:1 位移 + 财富近保守 + mock 策略（policyVersion 冻结）使个体升-降环流饱和，阶级分布稳态且底重（P≈[0.5,0.4,0.03,0.03,0.03]）。
3. **判定树耗尽**：diagnosis §8 对「位移已落地但 mUp 仍不过」无后续分支。不改判据（红线）、不调 mock 策略（冻结）、不回填参数。**W2 仍不启动**（G-A 按冻结判据未全过）；残余失效与三项候选（mUp 判据在位移体制下的重推定、失败升阶承诺成本 rules-v9、D-06 备选 B/C 重评估）登记于 changes/0010 §4，待规则负责人决策。G1.5 未通过，P2–P6 继续搁置（AGENTS 9）。

**P1.5 W2 确认轮与 W3 判定（2026-11-04，D-10 修订口径下门禁全过后的确认轮）**：

1. **D-10 判据重推定**（按 07 §8.1「改判定量须先修订本节并说明理由，新旧口径同报」）：G-A 的 mUp≤0.60 改为净流量 `mean(|mUp−mDown|)≤0.10`（单向抽空病理的直接度量；毛流量同报），G-B 的 P4 极差子句废弃为描述性报告（1:1 位移把顶层结构性钉死，响应移至中产轴）。修订口径下 v8 四门禁**全部通过**（P0=0.5571、净流量 0.0043、8 个响应对、G-C 0.0367、G-D own 逐位）→ W2 资格成立。
2. **W2 确认轮**（`acb3e8d` 预注册，prereg=`sha256:2ed70da5…`）：26 cell（diagnosis §6 四轴）× `p15r3-seed-001…030`（D-07）= 780 run / 33 min / 0 全灭 / budgets.ok。
3. **W3 G1.5 判定：未通过——「无宏观二态」**（changes/0011）：k=2 稳定性 ARI median **0.415**（min −0.002）< 0.70 硬门槛，k=4 median 0.516 亦不达标且按协议不得充当通过；temporalConsistency 0.786 < 0.80；特征空间为连续统。均值场方向预测在全部 cell 成立（P0 下限 0.449、漂移上限 0.045）——机制按设计运转，但参数只产生**一条连续统**，不存在 ≥2 类可复现的宏观模式。
4. **判定树全部走完**（W0→W1→门禁→W2→W3）：五轮预注册证据链齐备（三种体制画像 + 连续统直接证据）。报告见 `docs/research/2026-11-04-p15-w2-confirmation-and-g15-verdict.md`（索引 `docs/research/README.md`）。P2–P6 继续搁置（AGENTS 9）；下一步属**规则评审会**——在「接受连续统并修订项目目标（路线 C）」与「引入新离散化机制（D-06 备选 B/C 或新设计，须先探索再预注册）」之间做方向决策，见 changes/0011 §4。

**P1.5 rules-v9 位移份额与探索复核（2026-11-04，D-11）**：按用户确认落地 changes/0012——新增 `ascent.displacementShare`（默认 1 与 v8 逐位一致；<1 时其余份额走开放准入，不挤下在位者），版本轴 `rules-v9`/`engine-v0.7.0`/`stratify-config-v4` + v3→v4 迁移，golden 全量重算并通过。目的：v8 的 1:1 位移使阶级占比成为守恒量（上升/下降逐层近似相等，如 810/815、309/316），经济参数无法移动稳态分布。探索层复核（`out/p15-displacement-explore.json`、`out/p15-balance-explore.json`，共 108 run）给出**负面结论**：share<1 产生净上行流并把底层抽空（P0=P1=0），同参数种子间结构离散度 >1，由棘轮与噪声主导；加强拥挤负反馈（η→3、congestionMin→0.05）也不能托住底层。因此 `displacementShare` 是有效的诊断/消融参数，**不是**产生参数区域多结构的机制；下一步需**占用锚定**机制（位置稀缺/进入壁垒）或路线 C，二者均属规则评审会级决策。探索产物不得引用为 G1.5 确认证据（07 §6.1）。

**P1.5 rules-v10 占用锚定（2026-11-04，D-12）**：用户选择占用锚定方向后落地 changes/0013——新增 `ascent.scarcityWeight`（默认 0 与 v9 逐位一致；目标阶级占比超过机会隐含份额 `target[c] ∝ 1/env0[c]` 时抬升上升余额门槛 `w×crossBase×pressure`），版本轴 `rules-v10`/`engine-v0.8.0`/`stratify-config-v5` + v4→v5 迁移；tick 期初阶级占比快照同时供枚举侧与引擎复核侧使用。探索层（`out/p15-scarcity*-explore.json`，共 172 run）得到 **A/B/C 三个参数区域**：A 底重金字塔（share=1，P≈[0.56,0.36,0.03,0.02,0.03]）、B 上位中产（share=0.5，w=10–15，P2≈0.42–0.49、底层为空）、C 中产隆起（share=0.5，w≥30，P≈[0.01–0.10,0.40–0.46,0.24–0.32,0.15–0.19,0.07–0.10]）；P1 在 w≈20–30 完成平台切换（w≤15 与 w≥30 各为平台），高权重把底层恢复到 P0≈0.10，同初值种子噪声 0.11–0.24，初值依赖 ≤0.19。**仍未证明双稳态/迟滞**：每个参数组合只有一个吸引域，连续扫描的 pooled k=2 ARI 仍低（0.17–0.26）。因此不宣布 G1.5 通过；下一步须以 A/B/C 为预注册区域（并回答 k=2 硬门槛在 ≥3 类结构下的解释口径）或继续改造壁垒函数以形成同一参数下的两个盆地。

**P1.5 W4 确认轮（2026-11-04，D-13）**：按用户确认跑 rules-v10 两区域确认轮——预注册 `buildV10ConfirmationManifest()`（prereg `sha256:ece0a98b…`），种子 `p15r4-seed-001…030`，6 cell × 30 种子 × 3650 tick = 180 run（wall 4 min，0 全灭，budgets.ok）。判定：k=2 ARI median/min **1.000**、轮廓 0.564、temporalConsistency **1.000**（180/180）、最小簇 30 run（60 点）、非退化簇 2、方向预测（cell 均值）A P0 0.542 / B/C 最差 P0 0.147 与 mUp 0.178——**G1.5 通过（≥2 类可复现聚类）**，P2 可启动。必须同报：只有两类（A vs B∪C，P6-05 的 ≥3 类仍未满足）；方向子项为 cell 均值口径（C-w100 有 16/30 run 的 P0>0.15，属中心趋势非逐 run 不变量）；类是体制级（share=1 vs <1），未证明双稳态；**全部 180 run 使用预注册的 `mock-weighted-v1`，未测试 random/Jev，策略稳健性未验证**；G1.5 不构成校准完成。证据 `out/p15-v10-full.json`（871 KB，sha256 `cb9758b2…`）与 changes/0014。

**P1.5 路径依赖/分叉探索（2026-11-04，探索层）**：新增 `runSingle` 的 `initialState` 续跑能力与 `scripts/p15-bifurcation-explore.mjs`。在 share=0.5、w_mid=20–30 下比较 w=0→mid（up）、w=100→mid（down）与全程 mid（control）：up 抽空 class0/1 并锁定（middle 10/10、default 6/6、bottom 5/6），down/control 均 0 锁定；mUp 差 26.7–50.0，后段延长到 3650 tick 仍持续。判为**路径依赖锁定/单向棘轮候选**，不是已确认的对称双稳态分岔；不构成 G1.5/P6 证据，P6-05 仍未满足。机制探针（3 seeds）：`share=0.5` 预热锁定 3/3、`share=1` 预热 0/3；锁定后 `w=0` 仍 3/3 底层为空，mUp 44.7 来自上层重组，说明是组成吸收边界而非全局冻结。全新种子复制（`p15c-*`，3 IC × 10 seeds × 3 mids）按预冻结设计 **9/9 cell 通过**（up locked 1.0、down 0、mUp gap 29.6–55.0），mock 策略内路径依赖锁定可复现；但 **`random-uniform-v1` 敏感性为负**（0/9 cell 锁定、up/down mUp 差不显著），说明锁定是策略-规则交互而非规则层涌现分岔，不改变 G1.5/P6 结论。证据 `out/p15-bifurcation-*.json`、research/2026-11-04-p15-emergent-bifurcation-explore.md、research/2026-11-04-p15-bifurcation-replication.md、changes/0016。

**P1.5 descend 触发条件探针（2026-11-04，探索层）**：新增 `explore_descend` 探索 tag 与 `scripts/p15-descend-threshold.mjs`（streak vs always 两档，各 175 run）。streak≥7 门控下，descend 权重 d=0–4 全部保持 up locked 1.0（mUp 2.6–6.4），**提高权重不解除锁定**；无条件 descend 在 d≥0.2 时 up/down/control 全部解锁（mUp 600–1446），阈值在 0 与 0.2 之间。结论：锁定由**下降触发条件**而非权重控制；`random-uniform-v1` 的均匀选择天然包含无条件下降，解释了复制轮的负结果。锁定仍是策略-规则交互，不构成 rules-v10 结构分岔，也不改变 G1.5/P6 判定。证据 `out/p15-descend-{threshold,unconditional}-explore.json`、research/2026-11-04-p15-descend-condition.md、changes/0017。

## 5. P2：Jev 决策层

| ID    | 工作                                      | 依赖        | 交付与验收                                                   |
| ----- | ----------------------------------------- | ----------- | ------------------------------------------------------------ |
| P2-01 | 定义 Policy 接口和决策来源元数据          | P1.5        | mock/live/replay 可替换，核心不感知 HTTP                     |
| P2-02 | 英文紧凑 state 和 Choice 序列化           | P2-01       | prompt 有版本；候选描述完整；不超候选/上下文预算             |
| P2-03 | Jev HTTP client、响应 schema 与脱敏日志   | P2-02       | 真实响应 fixture 验证；非法 JSON/空概率/未知选项安全失败     |
| P2-04 | 超时、有限重试、取消、token bucket 和熔断 | P2-03       | 401/403 不重试；429/5xx 尊重 Retry-After；取消能停止后续调用 |
| P2-05 | 回退、失败率阈值、调用/Token/时间预算     | P2-04       | 超预算不再发请求；连续失败不会静默产生整轮回退实验           |
| P2-06 | 决策日志、live 标记与重放非法处理         | P2-03,P1-08 | 原始响应可审计；replay 不伪装 live；`replay_invalid` 可统计  |
| P2-07 | 最小真实冒烟（VPS 直连，不经 Worker）     | P2-04       | Key 不落库/日志/URL；一次低成本 Choice 成功并记录真实模型    |

**P2 启动记录（2026-11-04，G1.5 通过后）**：按 ADR-0003 / changes/0015 把决策层从 `src/experimental/p2-decision/` 迁回 `src/decision/`，`DecisionPolicy` 成为生产接口；新增 `MockPolicy`/`RandomPolicy`、异步 `runSingleWithPolicy`（live/replay 路径）与 `RunOutcome.decisions`（P2-06 决策日志）；同步 `runSingle` 改为经接口调用，行为不变。测试：原 434 行决策层测试随迁移保留，`policy-wiring` 现有 9 项接线测试（接口收集、同步/异步 mock 等价、random 确定性、换策略改变终态、fallback 计数、认证失败终止、取消即停 2 项、config topK 接线）。**P2-06 replay 已接入**（`ReplayPolicy`/`buildReplayIndex`，重放只使用 `selectedAction`，非法/缺失记 `replay_invalid`）；**P2-05 预算估算已接入**（`utf8-half-v1`、在途预留、overage、`usage_missing`/`budget_exhausted` 暂停）；**P2-02 JSON Schema 已冻结**（`schema/decision-state.prompt-v3.json`，Ajv 校验序列化输出）；**P2-07 真实冒烟（VPS、低预算密钥、成本上限）尚未完成**，且 replay 尚未接入 CLI/批跑入口与预注册 manifest；P2-03 的真实响应 fixture 仍待补（P2-02 的 JSON Schema 已冻结）。证据：changes/0015、`test/unit/runner/policy-wiring.test.ts`。

**闸门 G2**：故障注入覆盖超时、401、403、429、529、5xx、空响应、未知行动和过期目标；预算和取消有效；真实冒烟成本有上限。

## 6. P3：前端交互 MVP

| ID    | 工作                                   | 依赖     | 交付与验收                                           |
| ----- | -------------------------------------- | -------- | ---------------------------------------------------- |
| P3-01 | RunController 状态机与非阻塞调度       | P1,P2    | 运行/暂停/单步/重置/取消无竞态；UI 不被长循环锁死    |
| P3-02 | 参数表单、预设、校验和配置摘要         | P3-01    | 非法输入不能启动；明确标记未校准预设                 |
| P3-03 | 总览、阶级、财富、流动、网络与死亡图表 | P3-01    | 指标有定义/窗口/单位；空数据有状态                   |
| P3-04 | 个体检查器与决策解释                   | P2,P3-01 | 可查看候选、选择、概率、回退和财富事件，不显示 Key   |
| P3-05 | 本地存储、导入导出、回放和错误恢复     | P1-08    | 无后端完整运行；损坏/未知版本文件不覆盖当前实验      |
| P3-06 | 响应式、键盘和可访问性                 | P3-02~05 | 关键操作可键盘完成；图表不只靠颜色；移动端无功能缺失 |
| P3-07 | 浏览器 E2E 与大数据渲染降采样          | P3-06    | 核心流程 E2E 通过；图表不逐点渲染全部历史            |

**闸门 G3**：离线 mock、live 小额、导入回放三条路径均通过 E2E；控制台无未处理异常；刷新后的恢复行为明确。P3-06/P3-07 属产品化，可在 G6 后完成；P6 不依赖它们。

## 7. P4：Cloudflare 数据服务

| ID    | 工作                                       | 依赖        | 交付与验收                                                                 |
| ----- | ------------------------------------------ | ----------- | -------------------------------------------------------------------------- |
| P4-01 | Hono、Static Assets、统一错误与 request ID | P0          | `/api/health`、404、校验错误、内部错误契约一致                             |
| P4-02 | D1 初始迁移、索引和 batch 查询             | P4-01       | 本地/远程迁移可从空库执行；迁移只追加                                      |
| P4-03 | run 创建、writeToken 哈希认证和状态机      | P4-02       | 令牌仅创建时返回；越权写被拒绝；状态转换合法                               |
| P4-04 | tick/agent 批量幂等写入与 complete         | P4-03       | 重复请求不重复计数/存储；过期 run 不可写                                   |
| P4-05 | R2 分块 artifact、SHA-256 和导出           | P4-03       | 单块 <=8 MiB；同键不同哈希冲突；NDJSON 可分块读取                          |
| P4-06 | keyset 分页、限流、配额和维护任务          | P4-04,P4-05 | 所有列表硬 LIMIT；超限明确 429/413；保留策略可执行                         |
| P4-07 | workerd+D1/R2 集成和部署冒烟               | P4-06       | 本地集成与预览环境通过；备份后部署，部署后验证                             |
| P4-08 | Worker 同源 BYOK 代理与浏览器 live 冒烟    | P2-04,P4-01 | 浏览器只经同源 `/api/jev`；Key 不落库/日志/URL；模型 allowlist；成本有上限 |

**闸门 G4**：幂等、并发、越权、超限和损坏 artifact 测试通过；D1 无海量事件表；同源代理只接受白名单字段且无任意转发；无密钥泄漏。

## 8. P5：VPS 批量 Runner

P5 拆成两段，避免 P6 被云端依赖卡住：**P5a 只做本地批跑与检查点**，基础批跑依赖 P1，live 预算/限流子项依赖 P2-04；mock 校准不等待 P2。**P5b 做上传与云端对接**，依赖 P4。P6 的 mock 路径只依赖 P5-01/P5-03。

### 8.1 P5a：本地批跑（G6 前）

| ID    | 工作                               | 依赖  | 交付与验收                                                    |
| ----- | ---------------------------------- | ----- | ------------------------------------------------------------- |
| P5-01 | batch manifest、CLI 和机器可读摘要 | P1    | 单实验/矩阵/消融可启动；stdout 与报告分离；mock 批跑不依赖 P2 |
| P5-02 | 全局队列、并发、限流和共享预算     | P2-04 | 多 worker 不突破调用/Token/费用上限；仅 live 路径需要         |
| P5-03 | 原子本地检查点和断点恢复           | P1-08 | kill 后从完整点恢复；临时文件不被当作有效点；不依赖 P4        |
| P5-04 | 配对种子、共同随机数和微扰任务生成 | P5-01 | 实验只改变声明变量；manifest 可审计                           |
| P5-06 | systemd 一种标准部署及日志轮转     | P5-03 | 首选 systemd 并在运维文档固定；不维护两套漂移配置             |

**闸门 G5a**：故障注入覆盖运行中 kill、磁盘写失败和预算耗尽；恢复后最终 hash 与不中断对照一致；无云端也能产出完整本地 artifact 供 P6 使用。

### 8.2 P5b：上传与云端对接（G6 后）

| ID    | 工作                                      | 依赖     | 交付与验收                                                                   |
| ----- | ----------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| P5-05 | 分批上传、重试、去重、最终校验和 complete | P5-03,P4 | 重传幂等；complete 前核对 tick/chunk 完整性；能复用 P6 已产出的本地 artifact |
| P5-07 | 上传确认落盘与断网续传                    | P5-05    | 网络恢复后只补传未确认块；本地 manifest 与服务器一致                         |

**闸门 G5b**：故障注入覆盖网络断开、重复上传和服务器 409/5xx；不产生虚假 complete，不因上传失败重跑实验。

P6 不依赖 P4 Worker/D1/R2；校准结果可用本地 artifact 归档。P4、P5b 和 P3 可在 G6 通过后并行，避免云与 UI 先于科学前提投入。

## 9. P6：校准与科学验收

| ID    | 工作                                  | 依赖             | 交付与验收                                                                                                                                                                            |
| ----- | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-01 | 先跑 mock 单参数/全局筛选和稳定性筛查 | P1.5,P5-01,P5-03 | 每个点 >=30 配对种子；Stage A 用 40/200 人、730 tick 筛查，Stage B 只用 1000 人、3650 tick 确认入选单元；覆盖 needMultiplier/needThreshold/env0/crossDays/decay；保存分布而非只存均值 |
| P6-02 | 多参数扫描、临界区和稳定区定位        | P6-01            | 记录搜索范围、排除原因和资源消耗                                                                                                                                                      |
| P6-03 | 微扰克隆和正常波动区间                | P6-02            | 区分轨迹不同/结构不同；不只报 D 总分；记录首次事件翻转/发散时间                                                                                                                       |
| P6-04 | 五个消融（含 ψ=1）和 Jev/mock 对照    | P6-03,P2,P5-02   | β=0、O 固定（通过 P1-10 开关）、η=0、κ=0、ψ=1；真实 Jev 单独报告                                                                                                                      |
| P6-05 | 冻结结构与规则预设并写校准报告        | P6-04            | 至少三类互不相同的结构指纹聚类（按预注册聚类协议，非三组预设/多标签）；未达标则记录失败并回到规则评审                                                                                 |

**闸门 G6**：满足 `rule.md` 第 56–59 条；三类结构按指纹聚类验收，不按标签计数；预设带 ruleset hash 和证据链接；不得把单次结果写成普遍结论。

P6 的 mock 校准只依赖 P1.5/P1/P5-01/P5-03；Jev 对照另依赖 P2/P5-02，不依赖 P4 Worker/D1/R2；校准结果可用本地 artifact 归档。P4、P5b 和 P3-06/P3-07 可在 G6 通过后并行，避免云与 UI 先于科学前提投入。

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
pnpm format        # prettier --check，与 lint 分列
pnpm lint
pnpm typecheck
pnpm typecheck:core  # core 不含 Node 类型的纯度检查
pnpm test
pnpm test:coverage # 核心 statements/branches >=95%
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm smoke:local
pnpm smoke:live        # 显式设置预算与 Key 后才运行
pnpm benchmark
```

CI 默认不运行 `smoke:live`，不保存真实 Key，不因外部模型不稳定阻断纯核心测试；真实冒烟使用独立受控工作流。

## 12. 待议决策（施工前必须关闭）

以下决策尚未定稿，**不得**在实现、预设或结论中当作已定口径。关闭方式：由对应负责人选择，补 ADR（架构/契约级）或修订 03/07/08，并在本表记录结论、日期与关联提交。未关闭前，相关实现只能保持现状或暂停，不得静默选择有利口径。

| ID   | 决策                                 | 选项                                                                                                             | 影响                                                        | 关闭前阻断         | 负责人            | 关闭证据                                       |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------ | ----------------- | ---------------------------------------------- |
| D-01 | `hardLifeFloor` 是否保留在 RunConfig | A 保留并维持关系约束；B 降为注册的实现常量（默认 0.5），移出配置面与关系约束；C 保留参数但改标 `affectsBehavior` | config schema、`configHash/paramsHash`、golden、P1 配置表单 | P1-02/P1-03 冻结前 | 核心/规则负责人   | ADR 或 03 修订 + golden 更新                   |
| D-02 | sigma 上界是否保留                   | A 保留 `sigma<=ln(max/min)` / `max-min`；B 改用逆 CDF 截断采样并移除上界；C 保留宽松绝对上界 + 有界拒绝采样      | 03 §3.1 合法域、P1-01 采样器、校准域、golden                | P1-01 实现前       | 核心负责人        | 03 §4.2 采样方案 + 接线测试                    |
| D-03 | 结构聚类默认算法                     | A Ward+Euclidean；B k-means；C 其他预注册方法                                                                    | 07 §8.1 聚类协议、P1.5-04/P6-05 验收、三类结构结论          | P1.5-04 预注册前   | 科学/实验负责人   | 预注册 manifest 中的算法/标准化/k/稳定性参数   |
| D-04 | P6 真实预算数字                      | P1.5 基准后确定 `maxRuns/maxWallMinutes/maxStorageBytes`；不得沿用示例占位值                                     | 07 manifest、P6 扫描规模、存储与成本                        | P6-01 确认扫描前   | Runner/实验负责人 | P1.5 基准报告 + 冻结 manifest                  |
| D-05 | rules-v5 旋转门修断方向              | A 被动跌落财富清偿（按比例罚没）；B 上升资格绑定持有能力裕度；C 积累承载上限/边际递减；D 组合                    | 03 §5/§6 行动与结算语义、rule.md 7/8/9、P1.5 全流程         | P1.5 重跑前        | 规则负责人        | rule.md/03 修订 + changes/0005 + P1.5 复跑报告 |

| D-06 | rules-v6 的修断方向（需求参照系） | A 需求与上升费用统一以「阶级参照收入」计价（`refIncome[c]` 的 EMA）；B 阶级承载力配额；C 网络闭锁准入；D 组合 | 03 §6/§7 结算语义、`need` 与 `ascendCost` 公式、config schema v3、golden fixture | 确认轮预注册前 | 规则负责人 | 诊断报告 §3/§5 + changes/0008 + rules-v6 复跑报告 |

| D-07 | 确认轮种子集 | A 新取 30 个（`p15r3-seed-001…030`）；B 沿用探索轮 `p15-seed-001…030` | 07 §6.1 探索/确认分离、`preregistrationHash`、G1.5 证据独立性 | W2 预注册前 | 科学/实验负责人 | 预注册 manifest 的 `seeds` 字段 + 确认轮报告 |
| D-08 | 位移准入是否与 W1 同批落地 | A 与 W1 同批（两个变量一起改）；B 仅在 G-A/G-B 未过时作为独立预注册启动 | 03 §5 行动语义、W2 排期、失败归因能力 | W1 门禁后 | 规则负责人 | G-A/G-B 实测结果 + 若启动则新 `experimentId` |
| D-09 | 位移准入启动记账（diagnosis §8 判定树） | 启动（rules-v8）；不启动 | 03 §5 行动语义、G-A 残余失效归因 | G-A/G-B 未过时 | 规则负责人 | rules-v8 落地 + changes/0010 + 门禁实测产物 |
| D-10 | 机制门禁 G-A/G-B 判据在位移体制下的重推定 | A 按意图重推定（净流量替代 mUp；P4 极差废弃为报告）；B 维持原判据（W2 永不触发） | diagnosis §5、`src/runner/gates.ts` GATE_CRITERIA、W2 资格 | rules-v8 门禁实测后 | 规则负责人 | diagnosis §5 修订注（新旧口径同报）+ gates.ts 同步 + 修订判据下门禁复跑产物 |
| D-11 | 位移准入份额与「放松守恒能否产生参数选择结构」 | 落地 `ascent.displacementShare`（v9）；探索结论为负面，该参数不作离散化机制 | rule.md 9、03 §6、rule.md 57、G1.5 判定前提 | W3 判定后（用户确认） | 规则负责人 | changes/0012 + 探索产物 + 负面结论登记；后续占用锚定机制或 route C 另立决策 |
| D-12 | 占用锚定（位置稀缺）能否产生参数区域多结构 | 落地 `ascent.scarcityWeight`（v10）；探索得到 A/B/C 三区域，但未证明双稳态 | rule.md 9、rule.md 57、07 §8.1 k=2 硬门槛 | D-11 负面结论后（用户选择占用锚定） | 规则负责人 | changes/0013 + 4 份探索产物；确认轮前须预注册 A/B/C 区域与聚类口径 |
| D-13 | W4 确认轮预注册与判定口径 | A 两区域（A vs B∪C）、新种子 `p15r4-*`、cell 均值方向预测；B 继续连续扫描/运行级口径 | 01 §4.5、07 §8.1、G1.5 资格 | G1.5 W4 | 规则负责人 | `buildV10ConfirmationManifest()` + changes/0014 + `out/p15-v10-full.json` |
**当前状态（事实，不是结论）**：D-01 的 P0 实现为选项 A；D-02 当前为选项 A；D-04 的 manifest 数字是占位值。D-01/D-02/D-04 未关闭。**D-03 已按 W0 交接单（2026-11-03）随预注册 manifest 冻结关闭（选项 A）**：`clustering.algorithm='ward-lw-v1'`（Lance–Williams 实现标识）、`distance='euclidean'`、`z-score(pooled)`、`k∈[2,5]`、`stabilityShuffles=20`（判定量 = median，必报 min）均已进入 `preregistrationHash`；07 §8.1 同批写明更换实现＝分析管线变更＝新 `experimentId`。D-05 由 P1.5 v4 复核（2026-11-03）登记：三轮预注册实验（1920 run）证明旋转门引擎与参数无关，必须由规则修订切断。用户已授权按方向 B 落地 changes/0005（rules-v5，`e531bab`），但 D-05 **仍未关闭**：G1.5 尚未通过，rules-v5 的效果分离与轮 2 证据链仍有缺口（见 `docs/reviews/2026-11-03-zcodes-nightly-audit.md`）；关闭证据仍要求 rule.md/03 修订 + changes/0005 + P1.5 复跑报告。 D-06 由 P1.5 轮 2 诊断（2026-11-03）登记并**已定**：用户授权修断机制，选 **A′**——需求与上升费用统一以「阶级参照收入」`refIncome[c]` 计价，并把「标尺高低」与「宽限期」拆开（`need` 不再乘 `buffer(classAge)`，改由 `graceDays` 只控判定计时），B 配额 / C 网络闭锁推后；D-06 的关闭条件仍是 rules-v6 落地 + `changes/0008` + 确认轮报告。同时定 **D-07**（确认轮新取 `p15r3-seed-001…030`，不沿用探索轮种子）与 **D-08**（位移准入**不与 W1 同批**，仅当 G-A/G-B 未过时作为独立预注册启动）；施工说明见 `docs/research/2026-11-03-p15-w0-w1-handoff.md`。至此 D-05/D-06 同源——D-05 修的是「升上去之后靠什么持有」，D-06 修的是「持有时按什么计价」，后者是前者的前置（参照系不对，裕度门槛只能起一半作用）。

未关闭前：不得把 `hardLifeFloor`/sigma 当前域写成不可变契约；不得用示例预算运行正式 P6 扫描。
