# 12 执行与交接清单

## 1. 当前交接状态（2026-11-06，rev 36）

- rev 36（2026-11-06，搜索验证未通过 / P6-05c 未通过）：P6 参数搜索粗筛 **9,600/9,600**（rules-v11、4 shard、0 失败），top 候选 `c0607`（score 1.352、silhouette 0.352、ARI median 1.000、簇 [6,3,3]）；验证 `p6-search-val-ef550c09` **240/240**，k=3 簇 **[74,97,9]**、silhouette **0.241**、ARI median **0.157**、14600 同簇率 **0.683** → `no-stable-region-found`，不启动 confirm。已把 rules-v12 构建（`4b6cec9`）部署到 VPS `/opt/stratify/current`（v11 的 `dist/scripts` 备份为 `dist-v11-20261105`/`scripts-v11-20261105`）；P6-05c `p6-05c-f7f3cc91` **160/160、0 排除、0 灭绝**，k=3 簇 **[72,39,9]**、ARI median **0.182**、silhouette **0.215**、14600 同簇率 **0.675**；k=2 [111,9]、silhouette 0.505，二簇稳健、第三簇不成立 → **A 方案失败，转 B 方案（显式制度状态机，rules-v13）**。不得声称双稳态、三簇或已校准。

> **接手先读**：本节的 rev 11–30 是当前有效口径。更早的 rev 3–10 是历史沿革，
> 其中「G1.5 未通过、P2–P6 搁置」等表述**已被 rev 11 取代**，不要据此判断当前状态。
> Jev 与 VPS 的实操细节（端点、密钥、命令、踩坑）见
> [Jev 接入与 VPS 实操手册](guides/jev-and-vps-runbook.md)。

- 已有（截至 rev 12）：`rule.md` **rules-v11 13 章 59 条**、本施工文档套件（`docs/` 13 篇编号文档 + `docs/README.md` + `docs/adr/` + `docs/guides/` 3 篇 + `docs/reference/` 参考资料 + `docs/changes/` 30 篇 + `docs/research/`）、根目录 `AGENTS.md` 与 `README.md`；P0/P1 工程骨架（TS/pnpm/Vitest/ESLint/Prettier、配置类型与校验 v1→v6 迁移链、**87 条**参数注册表、JCS 与 **12 个** hash domain、golden 与 **590 个**测试），以及 P2 决策层（Policy 接口、Choice 序列化、超时重试熔断、预算、决策日志与重放、真实冒烟）。
- 已完成交叉复核与首轮修订：阶级持有成本 `needMultiplier`、初始年龄分布、365 日流动参与率、调整后 S、参数注册表、P1.5 可达性闸门、契约洞与统计口径已写入对应文档；未校准项均标注为待验证。
- rev 3（P0 定稿前修订）：`S` 改为双侧归一化保证 `[-1,1]`；`returnDiscount[0]` 接入 `d=1`；`seed` 明确不进入 `configHash`，补齐 `paramsHash/preregistrationHash` 域与排除字段；`initialAgeMode`、`hardLife*/returnDiscount` 进入注册表与扫描表；P0-02/P0-03/P0-06 验收同步。
- rev 4（P0 落地前补齐）：P5 拆为 P5a（本地批跑，G6 前）/P5b（上传云，G6 后），P6 只依赖 P5a；`P0[c]=0` 空阶级机会语义在 03/rule.md 对齐；回放来源区分 `jev_replay/mock_replay/random_replay`，`skipped_dead` 标为防御性枚举；state 固定构造顺序与 JCS 哈希分离；runId 字符集与 R2 key 校验；行动类型显式排序；`deathReason` 枚举；标准命令补 `format/coverage`；`docs/README` 与 `AGENTS.md` 入口补 02/06/10。
- rev 5（P0 评审后修复）：修复 JCS 稀疏数组、竞争转移上限、`guardOnly` 误分类、嵌套配置合并、参数注册表单一来源、无界分布/反馈参数；并补充核心纯度类型检查、参数定义快照与 CI 依赖审计；评审记录见 `docs/reviews/2026-11-02-p0-review.md`。
- rev 6（第二轮契约整合）：P2-07 拆为 VPS 冒烟与 P4-08 Worker 代理；P1.5 批量核心、报告字段、聚类协议与两阶段扫描；新增 `runtimeVersion`、hash 输入 schema、`labelThresholdsHash`、`O` 固定消融开关 P1-10、`artifactProfile/metrics-v1`；统一参数简写并清理硬编码；评审记录见 `docs/reviews/2026-11-02-contract-architecture-review.md`。
- rev 7（待议决策登记）：`hardLifeFloor` 配置面、sigma 上界、聚类默认算法、P6 预算数字登记为 01 §12 的 D-01–D-04；未关闭前不得写成既定口径。
- rev 8（2026-11-03，P1 落地）：P1-01–P1-10 已实现（RNG、初始化派生、状态/序列化/哈希、合法行动与 mock/random、A→H 管线、事件/执行记录、重构、宏观与慢变量、快照/回放/克隆、`openness.updateMode`）；10,000 tick soak 与 fast-check 性质测试通过；40/200/1000 人基准见 `docs/benchmarks/`；完成记录见 01 §4。变更详情见 `docs/changes/0003-p1-deterministic-core.md`。
- rev 9（2026-11-03，P1.5 判定）：P1.5 已按预注册流程执行完毕，**G1.5 未通过**——单一“顶层过重+旋转门”结构、聚类不稳定（ARI 0.471<0.70）、pyramid/olive/closedStratified 全网格不可达；机制级根因与 rules-v4 修订建议见 `docs/research/2026-11-03-p15-report.md`。**P2–P6 依闸门搁置；规则修订须规则负责人批准后重开 rules 版本并重跑 P1.5。**
- rev 10（2026-11-03，rules-v4 复核）：用户授权自主规则负责人执行 changes/0004（rules-v4：φ 解耦 + θM 再平衡 + engine v0.1.0）并重跑三轮预注册网格（共 1920 run）。φ 解耦与 ge.median 轴有效拓宽了可达集（P4∈[0.29,0.92]、olive 可达），但可达集仍为连续统，bisect-ARI∈[0.32,0.58] 全部 <0.70——**G1.5 仍未通过，P2–P6 继续搁置**。旋转门引擎三要素已定位（积累无上界/跌落携带财富+时钟重置/mock 无条件上升），rules-v5 候选方向（跌落财富清偿、上升持有资格、积累承载上限）登记于报告 §8.4。
- rev 11（2026-11-03/04，rules-v5→v11 与 G1.5 通过）：经 changes/0005–0028 九轮规则迭代（v5 跌落清偿/v6 需求参照系/v7 持有裕度/v8–v9 位移准入与位移份额/v10 占用锚定/v11 占用记忆），**G1.5 已在 W4 确认轮通过**（rules-v10，180 run，k=2 ARI median/min **1.000**，两类 A vs B∪C）。W5 在 3650 tick 未通过（temporal 0.789<0.80）；W6 在 10950 tick 终态得到**三类候选**（120 run，轮廓 0.638、ARI 0.997/0.938、A/B/C 各 30/30/30、B/C 质心 L1 0.513、14600 同簇 29/30），但**仅 mock、仅 class-share 单特征、仅 3 cell**，不是 P6-05 正式验收也不是校准。版本轴 `rules-v11`/`engine-v0.9.0`/`stratify-config-v6`/`stratify-state-v3`。证据：`docs/changes/0015`–`0029`、`docs/research/2026-11-04-*`。
- rev 12（2026-11-04，P2 收口与 Jev/VPS 实测）：**P2 已完成 7/7**——P2-03 真实响应 fixture 入库（`test/fixtures/decision/`，脱敏后），P2-07 真实冒烟跑通。三条决定实现的实测事实：(1) 官方 `api.typesafe.ai` 在开发机返回 `451` 地域限制、在 VPS 上网络可达但该 Key 返回 `401`，**现有 Key 只对自建网关 `https://jev.logicc.top` 有效**，故 `JevClientOptions.endpoint` 改为可配置（只接受 https、禁内嵌凭据，默认值不变）；(2) 网关把模型名归一化为 `jev-1.13-free`，`usage.cost=0`、`billing_source=free`，该免费档不代表生产免费；(3) 冒烟暴露**预算估算器低估**（`utf8-half-v1` 对真实请求估 1085 / 实际 1200），`AttemptBudget` overage 后永久 `exhausted`，使 live run 第一次调用后自锁——已升级 `utf8-three-quarter-v1` 并用真实 fixture 固定「估算必须 ≥ 实测」的回归断言。冒烟结果：8 人/30 tick/24 决策全成功、0 回退、p50 1.30 s；VPS `2zhou` 同一命令 6/6 成功且 `finalStateHash` 与本地逐字相同，**跨机器确定性成立**。证据：`docs/guides/jev-and-vps-runbook.md`、`changes/0030`、`out/p2-07-smoke.json`。
- rev 13（2026-11-04，P5-01 收口）：**P5a 的 P5-01 批跑 CLI 已完成**——`src/runner/batch-cli.ts`（`runBatch` + `batch-summary-v1` 机器可读摘要）与 `bin/stratify-batch.mjs`（`<manifest.json> --out <dir> [--resume]`，`package.json` 已注册 `bin`/`batch`）。stdout 纯 JSON 与报告分离；`batch-ledger-v1` ledger 逐任务原子落盘，`--resume` 跳过已完成 run，恢复后确定性指纹与不中断对照逐字一致（单测断言，G5a kill 口径）；技术失败跨 resume 保留（07 §3）；不带 `--resume` 且 ledger 已存在时拒绝启动防覆盖。新增第 13 个 hash domain `stratify-batch-manifest-v1`（golden 向量同步）。测试 605 单测 + 4 集成（真实 spawn CLI）+ 门禁全绿。证据：`changes/0031`、`src/runner/README.md`、01 §8.1 完成记录。
- rev 14（2026-11-05，P5-03 收口）：**run 内进度检查点接入批跑**——`run-progress-v1`（`src/runner/run-progress.ts`）= `checkpoint-v1` 快照 + 部分窗口累计器（07 §5 窗口聚合依赖全程 tick 数据，纯状态快照无法重算前段窗口）；`runSingle` 启动自动恢复 meta 三元组（cellKey/seed/configHash）匹配的检查点（不匹配抛错防跨 run 污染、损坏按不存在重跑）、每 `everyTicks` tick 原子落盘、正常结束移除（护栏停止保留）；恢复 run 的窗口/标签/终态哈希与不中断运行逐字一致（单测）；G5a 磁盘写失败注入已演练。CLI `--checkpoint-ticks N`（缺省关闭）。测试 615 单测 + 4 集成全绿。证据：`changes/0032`、01 §8.1 完成记录。**至此 P6-01 mock 路径的工程前置（P1.5/P5-01/P5-03）全部满足**；G5a 三项故障注入已覆盖 kill（ledger+run 内检查点）与磁盘写失败，「预算耗尽」属 P5-02。
- rev 15（2026-11-05，P5-04 收口）：**微扰配对执行入口**——`src/runner/perturbation.ts`：param（相对扰动 value×(1+δ)）与 wealth_absolute（存活者 += ΔValue，Value=0 也加）声明扰动；baseline/treatment 从同一预注册检查点快照克隆（07 §7.2 哈希一致由构造保证 + 单测）；「实验只改变声明变量」由叶子路径 diff 强制（`changedPaths` 恰为声明 field，违反即 INVARIANT_VIOLATED；`population.*` 拒绝）；round-trip 吸收标 invalid 不报「无敏感性」（07 §7.4）；产出 `firstDivergenceTick` 与 `perturbation-summary-v1`；同配对重复执行逐字一致。测试 626 单测 + 门禁全绿。证据：`changes/0033`、01 §8.1 完成记录。**边界**：幅度阶梯、≥30 配对种子、事件级首次翻转与结构指纹偏离属 P6-03；固定决策日志重放（07 §7.7）接进微扰入口待 P5-02。
- rev 17（2026-11-05，P5-02 收口，**P5a 全部完成**）：SharedBatchBudget（批内共享记账，委托 AttemptBudget fail-closed）+ RateLimiter（并发上限+最小间隔，rateLimitedFetch 注入缝）+ runBatchWithPolicy（policyFactory 密钥只进闭包、并发池、共享 ledger 串行化、预算耗尽/致命失败停止批次且剩余任务按同因记录、取消传播）；AttemptBudget 增加只读 usage()。G5a 三项故障注入（kill、磁盘写失败、预算耗尽）全部有实现与测试。测试 649 单测 + 4 集成全绿。证据：changes/0035。**边界**：live run 内进度检查点（异步）须在 P6-04 前补齐；跨进程 budget.sqlite 与 live 批跑 CLI 归 P4/P5b。
- rev 35（2026-11-05，ADR 0004 起草，**proposed**）：P6-05/P6-05b 均未产生稳定第三簇后，起草 `docs/adr/0004-rules-v12-institutional-bistability.md`——rules-v12 给开放度目标加入自反馈项 `θH×(O_prev−0.5)`，新参数 `openness.selfReinforcement`（默认 0、域 [0,20]），θH=0 与 v11 逐位一致；config schema v6→v7、rules-v12；P6-05c 用 θH∈{0,6,10,14} × 30 新 seed 检验，失败则转方案 B（显式制度状态机）。**ADR 尚未接受，未改规则、未调参**；等待确认后才能实现与重跑。
- rev 34（2026-11-05，P6-05b 机制筛选**未通过**）：`p6-05b-4ba8dc0a`，θS∈{4,8,12} × H∈{0,180} 六 cell，30 新 seed × 10950 tick（40 人）+ 60 个 14600；240/240 完成、0 排除、0 灭绝。k=3 簇 [136,17,27]，**三簇都混合全部 6 个 cell**；ARI median **0.291**、silhouette **0.297**、14600 同簇率 **0.550**，均未过线；H1（提高 θS）与 H2（H=180）均不成立，非 A 区域只剩 S/O 连续细分。按预注册决策规则**停止参数扫描，转 rules-v12 ADR**（显式制度双稳态）；不得继续换 seed/调 k/事后挑 cell（changes/0058）。
- rev 33（2026-11-05，P6-05 规则评审完成）：评审把三簇失败诊断为“非 A 体制内沿 S/O 的相位漂移”，不是第三吸引子；证据：k=2 silhouette 0.649、第三簇 S 0.366 vs 0.049 / O 0.192 vs 0.553、14600 20/60 换簇；P6-04a 的 β=0 次要效应最大、P6-04b `survival_hint` 同轴强分离但属行为处理。提出 H1 开放度–网络迟滞、H2 占用记忆锁定的 6-cell P6-05b 预注册草案（θS 4/8/12 × H 0/180，30 新 seed，10950 + 60×14600），并约定若 6 cell 均无稳定第三簇则停止调参、转 rules-v12 ADR。评审未改规则（docs/reviews/2026-11-05-p6-05-rule-review.md）。
- rev 32（2026-11-05，P6-05 全特征聚类**未通过**）：`p6-05-9718860c`，6 个参数区域 × 30 新 seed × 10950 tick（40 人），终端 11 维全特征（P0..P4/G/top10/Mup/Mdown/S/O）；240/240 run 完成、0 排除、0 灭绝。k=3 簇大小 **[30,118,32]**（A 单独一簇；其余 118 run 跨 B–F；第三簇 32 run 跨 B–F）；ARI median **0.491**、min 0.242、silhouette **0.344**、14600 同簇率 **0.667**，均未过线；`antiPreset=true`。二簇结构稳健（k=2 silhouette **0.649**），三簇不成立；W6 的 class-share 三类候选在加入 G/top10/Mup/Mdown/S/O 后未复现。`verdict=not-accepted-return-to-rule-review`，**G6 仍未通过**；不得改用 k=4/k=5 或事后挑选指标（changes/0057）。
- rev 31（2026-11-05，P6-04b 正式 live 对照完成）：`p6-04b-formal-9a8febe2`，10 个新 seed × {mock, random, live-neutral, live-survival_hint} = 40 run，**40/40 完成、0 失败、0 剔除**；live 19,799 决策、8 次 `upstream_5xx` 回退（0.04%）、0 缺失 usage、单一模型 `jev-1.13-free`；input 37.48M / output 2.45M，max 25.9 s。TV(P) 中位数：neutral vs mock **0.0175**（CI 0.0106–0.0288）、vs random **0.3781**；survival vs mock **0.0248**、vs random **0.3839**；survival vs neutral 0.0311。baseline D95 mock 0.2156 / random 0.1183。五个比较均未同时满足 07 §8（方向一致率 0.50–0.90、BH 最小 p=0.1577），`verdict=no-structural-evidence`；`survival_hint` 的 Mup→0、S→0.354、O→0.143 强信号仅 exploratory，未通过预注册主指标。单 seed 集不构成确认或校准（changes/0056）。
- rev 30（2026-11-05，VPS `2zhou` runner 标准部署）：按 `deploy/README.md` 装好非正式实验环境——`/opt/stratify/current` 为 `d30aa08` 的 `git archive`（root:root 只读，158 MiB）；`stratify-runner` 系统用户 + `/var/lib/stratify/{checkpoints,manifests,exports}`（750）；`/etc/stratify/runner.env`（600 root:stratify-runner，Key 经 stdin 写入、未打印）；systemd unit 与 journald drop-in 已装，`disabled` + oneshot，无 manifest 时 `ConditionPathExists` 正确跳过；磁盘守卫实测 10,275 MB 通过。VPS 上 `pnpm install --frozen-lockfile`/`build`/`typecheck`/741 单测全绿；mock 基线 `mockVsRandom` TV 0.3074 与本地一致；live 冒烟 6/6、0 回退、usage 6772/660、p50 1001 ms、`finalStateHash=sha256:c3129c4d…` 与本地逐字相同；`systemd-run --property=EnvironmentFile=…` 验证 runner 用户拿到 `JEV_API_KEY` 与网关端点。**正式 live/mock 对照仍未运行**；provider 侧旧 Key 吊销仍未独立核验。
- rev 29（2026-11-05，P6-04b 1-seed live pilot）：40 人 × 730 tick × interval 30；993/993 成功、0 回退、993 exact，wall 18.6 min，p50 1048 ms、max 12.8 s；usage 1.87M/123K；liveVsMock TV 0.0152/D 0.0186、liveVsRandom TV 0.3226/D 0.1619（mockVsRandom 0.3074/0.1582）。harness 通过，live 描述性接近 mock、远离 random；1 seed 不构成正式对照或结构证据（changes/0055）。
- rev 28（2026-11-05，P6-04b 重测信度通过）：Key 轮换后，同一 state（tick 365、a-0010、9 个合法行动）连续 live 20 次；20/20 有效、0 回退、20 exact；top-1 **0.70**（accumulate 6 / ascend 14，临界）、ICC(2,1) **0.9886**、平均 TV **0.0565**；响应模型 `jev-1.13-free`；usage input 30520 / output 2546；verdict=`reliable`。仅支持进入正式 live/mock 对照，不构成结构证据（changes/0054）。
- rev 27（2026-11-05，Jev Key 轮换验证）：用户报告新 Key 已写入；`check:secrets` 418 文件通过；live 冒烟 6 人/1 tick 6/6、8 人/30 tick 24/24，0 回退/0 缺失 usage，响应模型 `jev-1.13-free`；P6-04b live 链路可用，下一步 20 次重测信度；provider 侧旧 Key 吊销状态未独立核验（changes/0053）。
- rev 26（2026-11-05，Jev Key 轮换守卫）：新增 `check:secrets`（418 个入库文件扫描，CI 接入）+ 3 项测试 + runbook §2.3.1 轮换清单；仓库与历史未发现真实 Key；本机 `.env`（mtime 2026-11-04 23:21）仍为泄露前 Key，provider 侧吊销/换发与 `.env`/VPS `/etc/stratify/runner.env` 更新仍待执行；轮换完成前 P6-04b live 继续阻塞（changes/0052）。
- rev 25（2026-11-05，P6-04a 完成）：五个必跑消融（`p6-ablation-c46c2aff`，prereg `sha256:c46c2aff…`）——baseline + `β=0`/O 固定/`η=0`/`κ=0`/`ψ=1` × 30 新种子 × 200 人 × 730 tick，180/180 完成、0 失败/灭绝/回退，wall 10.2 min；D-04 消融预算按 6 cell 重冻结为 200/240 min/512 MiB。baseline D95 0.0668；TV(P) 中位数 beta=0 0.0195（超带 0.800）、openness=fixed 0.0080、eta=0 0.0063、kappa=0 0.0106、psi=1 0.0824（0.367）；**五消融均未达 `mechanismExplained`（TV<0.10）**。β=0 的 ΔG -0.0596/ΔMup +0.1382 仅次要指标信号；ψ=1 的 P4 下降预测不成立（+0.0045、同号率 3.3%）。**仅 exploratory；P6-04b Jev/mock 因旧 Key 未轮换未运行；G6 未通过。**（changes/0051）
- rev 24（2026-11-05，P6-03 完成）：微扰克隆与正常波动区间（`p6-perturbation-6bd61532`，prereg `sha256:6bd61532…`）——stable（默认）与 critical（P6-02 top 联合条件）两体制 × 10 个扰动 cell（control、wealth 1e-6/1e-4/1e-2、`need.threshold`/`need.needMultiplier[1]` 相对各三档）× 30 新种子 × 200 人 × 730 tick；60 任务/720 run 完成，600 对全部有效（0 invalid/0 extinct/0 fallback），wall 16.6 min；control 两体制 30/30 逐位一致。正常波动区间：stable 窗口 TV p95 0.0477、D95 0.0855；critical 0.0423、0.0766。**无 cell 达到结构证据**：最大 TV 0.00727、最大 D 0.0299；唯一 30/30 翻转事件的 `needMultiplier[1]×1e-2` 仍为 trajectory-only，其余 cell 零事件翻转 → absorbed（07 §7.5）。**仅 exploratory，不构成确认/校准；G6 未通过。**（changes/0050）
- rev 23（2026-11-05，P6-02 完成）：多参数 factorial 32 cell × 30 新种子 × 200 人 × 730 tick 完成 **960/960、0 失败/灭绝**，wall 52.9 min；31 个非 baseline cell 全部 30 配对；baselineD95=0.0928；top 联合条件 `threshold=0.9+psi=flat+env0=expanded+crossDays=half` TV(P)=0.2484（CI [0.2376,0.2555]），不含 threshold 最高 0.0988；`crossDays=half`/`decay=steeper` 单轴被吸收（0.0058/0.0064）。**仅 exploratory，不构成确认/校准**（changes/0045/0046）。P6-01 仍 1 个确认；G6 未通过。
- rev 22（2026-11-05，P6-01 严格收口）：按 07 主指标 `TV(P) ≥ 0.10` 重算 Stage A，旧任意指标筛选的 12 个入选对中 11 个不达标；严格候选 3 个，TV 方向按「每对主导阶级 + 同号 ≥90%」淘汰 `needThreshold=0.3`（changes/0043）。Stage B 六单元全部 60/60 判读：仅 `needThreshold=0.9` **确认**（TV 0.1553，CI [0.1494,0.1587]）；env0 两个旧「确认」、crossDays 两个与 psi=1 均未确认/exploratory（changes/0042/0043）。runner 阶段 2 修复完成：检查点交叉校验、ledger `baseConfigHash`、live 检查点/预算强制、`warmupTicks` 受限类型（changes/0044，提交 `6e9fc0a`）。门禁：685 单测 + 4 integration + typecheck/lint/docs/format 全绿。**P6-01 现有 1 个确认效应；G6 仍未通过。**
- rev 21（2026-11-05，文档与证据链收口）：**实验进度暂停于 P6-01 Stage B**。6 个确认单元已判读 3 个——`env0=expanded` / `env0=compressed` 确认通过（changes/0040/0041）、`crossDays=half` 未确认（效应随人口规模消失，诚实负结果）；`crossDays=double` ledger 仅 30/60（全为 baseline，待 `--resume` 续跑），`psi=1` / `needThreshold=0.9` 未开跑。补登 changes/0041；`crossDays-half` 预注册标识在 0039 冻结表为 `c1206246`、实际产物为 `83a1d58a`，差异登记为待裁决（按产物为准，未改判读、未重跑）；6 个 v2 manifest 全部入库并登记 sha256；research 索引、状态栏、01 §9/§12、AGENTS.md 同步；修复 `pnpm format`（3 份 Markdown）与 `pnpm lint`（unused `signal`）。证据：changes/0041、`docs/reference/artifacts.md`。**G6 仍未通过，默认参数未校准。**
- rev 20（2026-11-05，P6-01 Stage B 首个确认）：**env0=expanded 确认通过**（07 §8 全条件：w2b ΔG +0.0339 CI 不跨 0、方向 1.00、100% 超波动带、0 伪影；wall 111.6 min）；D-04 v2 重冻结（Stage B 480 min，实测触发）；live run 内检查点实现（P6-04 前置就绪）。其余 5 候选已按 v2 冻结待跑。证据：changes/0039/0040、research/2026-11-05-p6-01-stage-b-env0-expanded.md。
- rev 19（2026-11-05，P6-01 Stage A 执行）：预注册冻结（changes/0037，experimentId p6-stageA-40-b9cd2fd9 / p6-stageA-200-366198c5）后执行 840 run 全成功（0 失败/灭绝，wall 2.8+20.5 min）；判读：env0 最强轴（expanded d>band 0.57/0.97）、crossDays 双向与 ψ=1 跨人口一致入选、needThreshold=0.9 仅 200 人口、decay 本视野未达门槛；12 个 (cell,人口) 对入选 → Stage B 候选 6 cell。证据：changes/0038、research/2026-11-05-p6-01-stage-a-result.md、out/p6-stageA-*（artifacts §2 已登记）。**Stage A 仅筛选，不构成结构结论（AGENTS #9）**。
- rev 18（2026-11-05，D-04 冻结）：P6 预算按 VPS `2zhou` 实测冻结 v1（Stage A 1200 run/180 min/256 MB、Stage B 60/240/512、微扰 240/120/256、消融 120/240/512；换预算=新 experimentId）；基准记录 `docs/benchmarks/2026-11-05-p5a-engine.md`（开发机+VPS 双环境，VPS 1000 人×3650tick=120s）；批跑人口实验级化（`--population`，200 人×730tick 实机验证）。证据：`changes/0036`、`docs/research/2026-11-05-d04-p6-budget-freeze.md`。**至此 P6-01 的全部前置（工程 P5a + 预算 D-04）满足**。
- rev 16（2026-11-05，P5-06 收口）：`deploy/` 三工件——stratify-runner.service（oneshot、ConditionPathExists、专用用户、Restart=on-failure+StartLimit、ExecStart 固定 manifest+--resume+checkpoint-ticks 500、ProtectSystem=strict）、check-disk-space.sh（磁盘守卫 2048MB）、journald drop-in（200M/1G/14d）；11 项静态契约测试；docs/09 §6 加 deploy/ 指引，docs/01 §2 目录树补 deploy/。证据：changes/0034。**边界**：VPS systemctl 实装演练归发布前；常驻调度/budget.sqlite 归 P5-02。
- 尚无：UI（P3，0/7）、Worker/D1/R2（P4，0/8，需 Cloudflare 账号）、上传对接（P5b，0/2）、Jev Key 轮换（provider 侧吊销确认）、P6-05 验收与 G6 校准验收、rules-v12 ADR、发布（P7；P5-06 的 VPS systemctl 安装演练归发布前）。P5a 五项、P6-01/P6-02/P6-03/P6-04a、重测信度、1-seed live pilot、VPS 标准部署、P6-04b 正式 live 对照、P6-05/P6-05b 聚类尝试（均未通过）与 live run 内进度检查点已完成（changes/0031–0035、0040 前置、0050–0058）。
- 下一唯一入口：**ADR 0004 评审确认（proposed）**——P6-05/P6-05b 均未产生稳定第三簇（changes/0057/0058），已起草 rules-v12 自反馈方案（`openness.selfReinforcement` θH、默认 0、config schema v7）；需科学负责人确认接受/拒绝。接受后实现参数/测试/golden 并跑 P6-05c（θH∈{0,6,10,14} × 30 新 seed）；拒绝则讨论方案 B（显式制度状态机）。G6 仍未通过，不得调 k/换指标/事后挑 seed。P3/P4/P5b 按 01 §9 在 G6 后并行。
- 不得提前声称：三类结构已出现（目前只有 class-share 单特征候选）、Jev 行为有效、性能已达标、生产可发布、网关免费即生产免费。

## 2. 新接手者开工清单

- [ ] 阅读 `AGENTS.md` 和 `docs/README.md`，理解文档效力。
- [ ] 按角色阅读对应契约；核心开发必须读完 `rule.md` 与 03。
- [ ] 确认当前分支/commit、任务 ID、依赖任务已验收。
- [ ] 安装 Node >=22.18 和锁定 pnpm；脚手架存在后执行冻结安装。
- [ ] 运行现有 lint/typecheck/test/build，记录接手时基线；失败先区分既有问题与本任务。
- [ ] 检查是否涉及规则、API、prompt、RNG、迁移或安全；若是，先读对应版本/ADR要求。
- [ ] 确认不需要真实 Key 即可完成普通开发；live 工作另领低预算。

## 3. 任务卡模板

```text
任务ID：P阶段-编号
标题：
负责人/评审者：
目标与非目标：
依赖及已验收证据：
涉及契约/规则条目：
计划修改文件：
行为与兼容性影响：
测试（先列失败边界）：
性能/成本/安全影响：
验证命令：
回滚或前滚方式：
未完成项与阻塞：
```

## 4. Definition of Ready

- [ ] 任务目标和验收可观察，不是“优化一下/完善功能”。
- [ ] 依赖接口和版本已明确，没有未决核心语义。
- [ ] 已列测试数据、异常路径和文档影响。
- [ ] 真实模型/部署任务的预算、环境和回滚已明确。
- [ ] 工作量可进入一个可回滚 PR；过大先拆分。

## 5. Definition of Done

- [ ] 实现满足对应契约，未复制第二套规则。
- [ ] 新参数已进参数注册表，并有接线测试；无裸业务字面量。
- [ ] 新行为有单测/性质/集成/E2E 中合适的测试，bug 有回归。
- [ ] lint/typecheck/test/build 通过，必要基准无未解释退化。
- [ ] 文档、类型、fixture、版本和迁移同步；无密钥/大生成文件。
- [ ] 实验类变更附 `preregistrationHash`、primary metric、种子和窗口。
- [ ] PR 说明兼容性和实验可比性，golden 差异经评审。
- [ ] 验证证据可复现，未把未运行命令写成通过。
- [ ] 未决项明确记录，不用“基本完成”关闭阻断任务。

## 6. 核心规则变更清单

- [ ] 先修改 `rule.md` 或说明仅为实现澄清。
- [ ] 更新 03 的字段/默认值/顺序/不变量/映射。
- [ ] 新参数进注册表并补接线测试；无不进 configHash 的隐式参数。
- [ ] 评估 rulesVersion、engineVersion、schemaVersion 和旧结果可比性。
- [ ] 更新 RNG eventTag/顺序影响（含 `init_age`）；必要时 ADR。
- [ ] 添加边界、性质、快照恢复和 golden 测试。
- [ ] 检查前端指标、Jev state、导出和旧回放兼容。
- [ ] 若改动 `needMultiplier/Congestion/Mup/S/initialAgeMode`，重跑 P1.5 可达性分析并更新标签阈值版本。
- [ ] 重新校准受影响预设，不沿用旧“已校准”标签。

## 7. API/存储变更清单

- [ ] 更新 05 的请求/响应/错误/状态机和示例。
- [ ] 认证、限流、body/行/批/分页硬限制仍有效。
- [ ] 重复请求、并发、同键不同 hash、complete 冲突有测试。
- [ ] D1 迁移只追加，包含前滚与旧代码兼容分析。
- [ ] R2 key、schemaVersion、manifest、导出和保留策略同步。
- [ ] preview 备份→迁移→部署→冒烟→恢复验证完成。

## 8. Jev/真实调用清单

> 端点、密钥、模型名归一化、冒烟命令与已知坑见
> [Jev 接入与 VPS 实操手册](guides/jev-and-vps-runbook.md)；此处只列每次 live 前必须逐条确认的门禁项。

- [ ] 只使用合法 Choice，模型不做结算；promptVersion 已判断。
- [ ] Key 来源安全，不落盘/日志/URL；模型在 allowlist。
- [ ] **端点已确认**：当前只有自建网关 `jev.logicc.top` 可用，官方域名返回 451/401；报告中须注明「经自建网关，非官方端点」。
- [ ] **估算器仍为 `utf8-three-quarter-v1`**：若改比例，`real-response-fixture.test.ts` 的「估算 ≥ 实测」断言必须先通过。
- [ ] maxCalls/maxInputTokens/maxRunMinutes 已设置且足够小。
- [ ] 超时、有限重试、Abort、共享限流、失败熔断已验证。
- [ ] 原始响应、usage、真实 model、回退和延迟可审计。
- [ ] live/replay/mock/random 标识正确，失败批次不会冒充完成。
- [ ] 记录实际成本与剩余预算，结束后无残留任务。

## 9. 实验记录模板

```text
实验ID/假设：
类型：规则敏感性 / 微扰重放 / 微扰重跑 / Jev行为 / 消融
preregistrationHash（运行前）：
代码commit与全部版本（rules/prompt/policy）：
人口规模与基础configHash、覆盖字段：
配对种子列表（运行前冻结）：
burn-in平稳性诊断与分析窗口（运行前冻结）：
primary metric、实际差异门槛、功效与区间方法：
labelThresholdVersion 与标签重叠审计：
预算和资源（请求/token/工时/费用）：
失败/排除（含技术原因，不能静默删种子）：
结果分布、区间、D及分项：
稳定区/临界区证据、事件翻转/发散时间：
消融/Jev对照（promptStyle、重测信度）：
结构指纹聚类与“三种结构”判定：
结论与不能推出的结论：
manifest和artifact位置/校验hash：
```

## 10. 发布清单

- [ ] G0–G6 有证据；当前发布范围对应阶段已完成。
- [ ] preview 与 production 资源/secrets 隔离，迁移和配置经 diff。
- [ ] D1 备份和 R2 manifest 核对完成，恢复演练可读。
- [ ] CI、E2E、workerd 集成、性能和真实小额冒烟通过。
- [ ] 安全头、CORS、配额、限流、保留、预算和紧急停止已检查。
- [ ] 回滚版本与当前 schema 兼容，数据库采用前滚策略。
- [ ] 生产部署后验证健康、页面、完整 run、artifact 和导出。
- [ ] 记录版本、操作者、时间、备份、验证和已知问题；持续观察告警。

## 11. 故障交接模板

```text
发生时间/发现人：
影响环境、runId/requestId、版本：
当前状态：运行中 / 已暂停 / 已回滚 / 已隔离
症状与最近变更：
已执行操作及结果：
数据影响与是否可能重复/丢失：
预算/密钥是否受影响：
备份、checkpoint、日志和诊断快照位置：
下一安全动作与禁止动作：
需要谁决策：
```

事故中优先停止新写入/调用并保留证据；不要为了“恢复绿色”删除异常 run、无限重试或直接覆盖生产备份。

## 12. 阶段交接模板

```text
阶段/任务ID及完成度：
当前commit和部署版本：
已实现与明确未实现：
验证命令、最近通过时间和证据：
配置/规则/API/schema版本：
校准状态和可用预设：
未决问题（按阻断程度排序）：
下一建议任务及依赖：
运维状态、备份位置、预算消耗：
文档或代码已知冲突：
```

交接必须如实区分“代码已写”“测试通过”“preview 验证”“生产验证”“统计校准通过”，这些不是同一完成状态。
