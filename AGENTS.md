# Stratify 执行约定

开始施工前阅读 `docs/README.md`，按任务类型加载对应契约。

**当前科学状态（2026-11-20，规则负责人审阅后更正）**：P1.5 W4 确认轮已通过 G1.5（2026-11-04），P2 已收口，P5a 五项完成。P6-01 Stage B 六单元按 07 严格口径判读：仅 `needThreshold=0.9` 确认（TV(P)=0.1553，changes/0043），其余五个未确认；P6-02/03/04a/04b/05/05b/05c/05d/05e/06/07 均为未通过或 exploratory，不构成确认。ADR 0008 曾停止 P6；ADR 0009 按其中「新立 ADR、全新预注册与 seed、不追认旧结果」三项门槛重启，并落地 `rules-v16` 代际更替（默认 `none`，与 v15 逐位一致）。

P6-08（代际更替 6 cell）未通过（k=3 ARI 0.565）。ADR 0010 在 P6-06 失败**之后**修订了 07 §8.2 条件 4（该时点已在 ADR 中披露）；P6-09 在该口径下得到 `two-regime-candidate`（N=200、240/240、k=2 [30,150]、ARI 1.000、silhouette 0.613、TV(P)=0.3471；k=3 第三簇仅 1 run）。**适用范围**：P6-09 使用 `generationalMode='none'`，并未检验 ADR 0009 的核心代际假设；其两体制是 `share=1` vs `share<1` 的单轴分裂，「连续统」仅由「无稳定第三簇」这一零结果支撑。`rules-v17`（阶级容量上限）与 P6-10 未通过；`rules-v18`（代际天赋传递）与 R2-B 探针仅 exploratory。

**G6 仍未通过**。R4 的 30 对微扰在 1e-4 财富扰动后结构量逐位吸收（TV(P)=0，D≈1e-10），该部分成立；但按 07 §11 的「结构退化」口径（`median TV(P) ≥ 0.10`）重算，五项消融在两套体制下**全部未达门槛**（最大 0.0740），原先把 `O=openness.initial 固定` 判为「机制有解释力」属同义反复，已撤销（changes/0090 更正）。因此不得声称已校准或结构已涌现，`src/app/presets.ts` 中全部预设（含两体制代表作）均为 `calibrated: false`。

P6-11（真实 Jev 提示词因果对照，`rules-v18`、40 人 ×730 tick、30 对同种子）已完成：90/90 有效、0 剔除、单一服务端模型、最大回退率 0.32%；`passesCausalClaim=true`（ΔO 中位数 −0.3752、ΔS +0.2804、ΔMup −0.4097，置换检验 p 触底）。**证据链边界**：预注册请求 `jev-1.13.0`，服务端实际返回 `jev-1.13-free`（analysis 产物中并列记录，属预注册偏离）；`TV(P)` 是阶级份额距离而非行动概率距离；该实验不关闭 G6。P6-14（扩大到 60 个 live run 的复验）因 Jev 配额耗尽于 2026-11-20 暂停：停止时 30 个 mock + 12 个 live 完成、21 个 live 失败，6 个 seed 的检查点与 ledger 保留，未生成 analysis、不构成任何结论（changes/0099）；恢复需配额。ADR 0014 的 R2-C 探索探针（`explore-r2c-hcg`，90/90、0 灭绝）**未通过消融门槛**（k=2 数值筛选虽过，但 [4,26] 实为 A 单元 `share=1,w=0` 对其余单元的单点分裂、簇 1 仅 4 run）：单参数消融 `g=0` median TV(P)=0.0332、`d=0`=0.0259，均远低于 0.10，判 `stop-mechanism`（changes/0100）；不调 `g/d`、不启动 240-run，`rules-v19` 保留默认关闭。

**工程轨道**：P3 前端 MVP（12 态 RunController + 五工作区 + 图表，changes/0070）、P4 Worker/D1/R2 MVP（changes/0071–0077）、P5b 上传器（changes/0072/0075/0080，流式 full 导出已支持 run 检查点续跑，changes/0096）与 P7 本地硬化（changes/0074）已落地并通过本地测试。preview 于 2026-11-20 部署版本 `95a4fb2f`，完成公网 health/首页/创建读取取消冒烟、匿名上传全链路（`run_1e1d74eabd7f8582d2f72b87`，completed，120 tick 行/40 agent 行）、D1 导出与隔离恢复校验、rollback 到 `bd6cadab` 再前滚演练（changes/0094）。production 的 D1 `stratify-prod` 与 R2 `stratify-artifacts-prod` 已创建，版本 `4b79128b` 部署在 `https://stratify-prod.logicc.top`，health/首页/创建读取取消冒烟全绿，D1 导出 9,020 字节并完成隔离恢复校验，rollback 到 `ac795270` 与前滚均健康（changes/0097）。Cron 保留任务因 Workers Free 槽位上限未注册，`RUNNER_TOKEN`、R2 孤儿清理、真实 Jev live 冒烟与独立回放验证仍未执行；不得声称已发布或 P7 完成。工程产物不得表述为科学验收。

## 强制约束

1. 先实现无 Jev 的确定性核心，再接模型和 UI；核心不得依赖 DOM、fetch、Node、Worker、localStorage 或 wall clock。
2. Jev 只从代码枚举的合法行动中做 Choice；财富、胜率、阶级、寿命和网络均由核心计算。
3. 禁止 `Math.random()` 和全社会共享单随机流；使用 `R(seed,tick,agentId,eventTag,counter)`。
4. 固定 tick 顺序与快照/回放语义；行为变更必须更新规则版本、文档和 golden 测试。
5. 所有业务常数必须来自参数注册表，禁止在结算函数写裸字面量；新参数必须有接线测试并进入 `configHash`。
6. 初始人口、初始网络和初始年龄必须由 `(config, seed)` 纯函数派生，不得接受独立 roster。
7. Cloudflare Worker 不执行大规模长循环；D1 只存可查询元数据/聚合，完整日志进 R2。
8. 真实 Jev 调用必须有超时、有限重试、取消、预算和失败熔断；密钥不得落库或写日志。
9. 不得声称参数已校准或结构已涌现，除非满足 `docs/07-experiment-calibration.md` 的统计验收；P1.5 未通过不得启动 P2–P6。
10. 完成标准为实现+测试+文档+验证证据；CI 未通过不得标记完成。
11. 全部实验（批量仿真、live 对照、聚类/微扰/消融）必须在上海 VPS 上执行；本地只允许编译、单元测试与对已归档产物的离线重算（`--reuse-raw` / `--analyze`）。

## 常用入口

- 任务与依赖：`docs/01-implementation-plan.md`
- 架构与模块边界：`docs/02-architecture.md`
- 规则结算：`docs/03-rules-implementation.md`
- Jev 与回放：`docs/04-jev-decision-contract.md`
- API/存储：`docs/05-api-data-contract.md`
- 前端交互：`docs/06-frontend-contract.md`
- 测试门禁：`docs/08-testing-quality.md`
- 发布运维：`docs/09-deployment-operations.md`
- 编码与评审：`docs/10-engineering-conventions.md`
- 架构决策：`docs/adr/README.md`

规则冲突时暂停并澄清，不得静默选择有利口径。
