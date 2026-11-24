# Stratify 执行约定

开始施工前阅读 `docs/README.md`，按任务类型加载对应契约。

**当前科学状态（2026-11-24，策略回落审计与真 `mock-weighted-v1` 收口）**：P1.5 W4 确认轮已通过 G1.5（2026-11-04），P2 已收口，P5a 五项完成。P6-01 Stage B 六单元按 07 严格口径判读：仅 `needThreshold=0.9` 确认（TV(P)=0.1553，changes/0043），其余五个未确认；P6-02/03/04a/04b/05/05b/05c/05d/05e/06/07 均为未通过或 exploratory。ADR 0008 曾停止 P6；ADR 0009 按三项门槛重启并落地 `rules-v16`（默认 `none`），后续 `rules-v17/v18/v19`（阶级容量/天赋传递/HCG）的 `k≥3` 探索（P6-08/P6-10/R2-B/R2-C）均未通过（changes/0088/0091/0092/0100）。

**策略回落审计（2026-11-24，changes/0106）**：审计发现 `src/runner/run-cell.ts` 原缺省三元链在 `.mjs` 脚本漏传 `options.policy` 时会静默回落到 `RandomPolicy()`，导致 2026-11-18 起 `P6-08`/`P6-09`/`P6-10`/`R2-B`/`R2-C`/`P6-12`、R4 与 `P6-13` 的 Part B 消融、以及 2026-11-22 启动的 `R5` 批次实跑了 `random-uniform-v1`（且 `r5-pert` 因 `kind==='pert'` 与 `'pair'` 失配未跑配对）；`R4` Part A / `P6-13` Part A 微扰配对与 `P6-11`/`P6-14` 主因果对照 `live-vs-live` 不受影响。现已把 `runSingle` 改为缺省即抛错（fail-closed）并修复脚本，历史 `RandomPolicy` 批次均不追认为 `mock-weighted-v1` 证据。

**G6（D1「2 体制 + 连续统」）已收口（2026-11-24，changes/0107–0108，校准报告 `docs/research/2026-11-24-p6-15-g6-d1-calibration-report.md`）**：在真实 `mock-weighted-v1`（运行期逐决策校验）与 `rules-v19` 默认配置下，用全新独立种子集在上海 VPS 完成 `P6-15`（`p6-15-983b3698`，`N=40`，`660/660`，0 灭绝/排除/回退）与 `P6-15b`（`p6-15b-ea8fbe20`，`N=600`，`60/60`，官方 `evaluateStageB`）：

- **聚类（`07 §8.2`）**：`P6-15` `240/240` 得 `k=2 [30,150]`（`A` vs `B–F`，`antiPreset=true`）、`ARI=1.000`（min `1.000`）、`silhouette=0.6602`、`14600` 同簇率 `1.000`、`TV(P)=0.7279` / `|ΔS|=0.3044` / `|ΔO|=0.5687`；`k=3 [30,93,57]` `ARI=0.6115 < 0.70`、`silhouette=0.3163 < 0.35` → **旧条件 4（ADR 0006）与新条件 4（ADR 0010）双口径均通过**。
- **微扰吸收（`07 §7`）**：两体制在 `N=40`（`P6-15`）、`N=200`（`R4` Part A）与 `N=1000`（`P6-13` Part A）均实现 `30/30` 轨迹分叉、末端结构量逐位吸收（`TV(P)=0`、`median D≈4.36e-11–2.23e-10`、`100%` 落入 `D95`）。
- **五消融与独立确认（`07 §11` + `§8`）**：`P6-15` 全五消融中仅阶级持有成本 `ψ=1` 突破 `median TV(P) ≥ 0.10`（R1 `0.1110`、R2 `0.1790`）；`P6-15b` 在 `N=600` 独立确认种子集上经官方 `evaluateStageB` 确认 `w2b TV(P)=0.2425`（95% CI `[0.2358, 0.2502]`、`p=0.00008`）、`beyondBandRate=1.000`（`30/30` 超 `D95=0.0576`）、五阶级 `30/30` 全同向（`ΔP[1]=-0.2085, ΔP[4]=+0.1358`），`strictConfirmed=true`（同时披露旧 `07 §11` 文本「`P4` 下降」注记不成立，且 `β=0/O=fixed/η=0/κ=0` 四项 `<0.10`）。
- **预设与适用边界**：`src/app/presets.ts` 仅冻结两体制代表预设 `regime1_pyramid` 与 `regime2_continuum`（`calibrated: true`，`N=40`, `T=10950`，与 `P6-15` 哈希逐位一致），其余预设保持 `calibrated: false`。**严守边界**：仅适用于 D1 两体制目标、`rules-v19`（`generationalMode='none'`）与 `mock-weighted-v1`；传统 `k≥3` 离散三态仍未通过，禁止声称「三态涌现」「社会结构已涌现」或现实因果。

**真实 Jev 提示词因果对照（`P6-11` / `P6-14`，changes/0093/0104）**：`P6-11`（30 对，存在请求 `jev-1.13.0` vs 实返 `jev-1.13-free` 模型名偏离）与 `P6-14`（60/60 live ok、统一 `jev-1.13-free`、最大回退率 `4.51%`）确认 `survival_hint` vs `neutral` 因果诱导 `ΔO = −0.3943`（95% CI `[−0.4394, −0.3523]`）、`ΔS = +0.2579`、`ΔMup = −0.4124`、`TV(P) = 0.0262`、`passesCausalClaim = true`。该实验与 G6 相互独立。

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
