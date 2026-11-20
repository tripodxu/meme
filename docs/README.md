# Stratify 施工文档入口

> **当前状态速览（2026-11-19）**
>
> | 维度                       | 当前口径与实测状态                                                                                                                                                                                                                                                                                                                                                                                                                                      | 依据                                                                                                                                                                                                                                                        |
> | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **核心版本轴**             | `rules-v18` / `engine-v0.15.0` / `stratify-config-v12` / `stratify-state-v5`（103 项注册参数，新旋钮默认 `0` / 全 `1` / `none` 保持兼容）                                                                                                                                                                                                                                                                                                               | [versions.ts](../src/core/control/versions.ts)、[changes/0092](changes/0092-rules-v18-r2b-probe-result.md)                                                                                                                                                  |
> | **科学校准（D1 两体制）**  | **D1「2 体制 + 连续统」已正式通过 G6**：`N=200` `P6-09`（`k=2 ARI=1.000, sil=0.6129`）+ 阶段 R4（微扰 100% 吸收 + 五消融解释力）+ 预设冻结（`regime1_pyramid` / `regime2_continuum`）                                                                                                                                                                                                                                                                   | [ADR 0010](adr/0010-two-regime-continuum-silhouette-criterion.md)、[0089](changes/0089-p6-09-two-regime-confirmation.md)、[0090](changes/0090-p6-r4-calibration-g6-closure.md)                                                                              |
> | **科学边界（k≥3 与 Jev）** | 传统 `k≥3` 离散结构（`P6-05..08`/`P6-10`/R2-B 探针）**均未通过**；阶段 R3（`P6-11` 30-seed 真实 Jev 提示词因果实验）已完成并通过因果判读（`passesCausalClaim=true`）；`P6-14` 扩大规模复验因 Jev 配额于 2026-11-20 暂停（12/60 live 完成，未达预注册规模，不构成结论）；ADR 0014/rules-v19 的 R2-C 探索探针（`explore-r2c-hcg`，90/90）未通过簇规模与消融门槛（`g=0` median TV(P)=0.0332、`d=0`=0.0259，均 <0.10），判 `stop-mechanism`，不启动 240-run | [0091](changes/0091-rules-v17-p6-10-result.md)、[0092](changes/0092-rules-v18-r2b-probe-result.md)、[0093](changes/0093-p6-11-jev-prompt-causal-result.md)、[0099](changes/0099-p6-14-paused-jev-quota.md)、[ADR 0013](adr/0013-p6-11-jev-prompt-causal.md) |
> | **工程交付（P0–P7）**      | P0–P5a、P3 双界面前端 + Playwright E2E、P4 Worker/D1/R2、P5b 流式上传 + 独立验证器均已落地；Preview（`https://stratify.logicc.top`）公网冒烟、备份恢复与小额 live 代理已实测；Production 未发布                                                                                                                                                                                                                                                         | [0084](changes/0084-frontend-high-order-verifier-playwright.md)、[0086](changes/0086-preview-deploy-rollback-backup-rehearsal.md)、[0087](changes/0087-preview-custom-domain-live-smoke.md)                                                                 |
>
> 完整按时间顺序的变更流水见 [变更记录索引](changes/README.md)；科研规划总览见 [2026-11-18 科研路线图](research/2026-11-18-scientific-research-roadmap.md)。

Stratify 是一个可交互、可回放、可批量实验的社会仿真系统。Jev 负责从合法行动中做结构化选择，确定性 TypeScript 引擎负责全部数值结算。浏览器承载交互实验，Cloudflare Workers 承载网站与数据服务，VPS 承载大规模批量实验。

## 1. 规范用语与效力

- **必须/不得**：验收阻断项，偏离前必须写 ADR 并更新相关测试。
- **应该/不应该**：默认做法；有理由时可偏离，但需在 PR 中说明。
- **可以**：可选项，不构成验收要求。
- `MVP`：第一个可发布版本；`v2`：包含网络与制度反馈的规则版本；`v3`：加入阶级持有成本、初始年龄、365 日流动参与率、调整后 S 和参数注册表；`v4`：需求线环境持有人乘子与 θM 再平衡；`v5`：上升资格绑定目标阶级持有裕度（`ascent.holdingCushionDays`）。各版本均不代表已经校准。
- 文档中的命令是施工约定；脚手架建立后必须保证命令真实存在，不允许文档与 `package.json` 长期不一致。

## 2. 唯一事实来源

| 主题                       | 唯一事实来源                      | 冲突处理                               |
| -------------------------- | --------------------------------- | -------------------------------------- |
| 社会机制与实验目标         | 根目录 `rule.md`                  | 不改代码静默绕过；先修订规则及实现映射 |
| 规则的类型、顺序与结算细节 | `03-rules-implementation.md`      | 与 `rule.md` 冲突时暂停施工并澄清      |
| 模块边界和运行拓扑         | `02-architecture.md`              | 通过 ADR 修改                          |
| Jev 请求、决策与重放       | `04-jev-decision-contract.md`     | 不允许前端自行发明协议                 |
| HTTP、D1、R2 与导出格式    | `05-api-data-contract.md`         | 版本化变更，保持迁移可追加             |
| 实验、判异和校准           | `07-experiment-calibration.md`    | 不以单张图代替统计验收                 |
| 前端交互、离线与回放       | `06-frontend-contract.md`         | 不在前端复制结算公式                   |
| 质量门禁                   | `08-testing-quality.md`           | 未通过不得标记完成                     |
| 代码风格、评审与文档维护   | `10-engineering-conventions.md`   | 与 CI 规则冲突时先改约定并更新 CI      |
| 部署、备份和故障处置       | `09-deployment-operations.md`     | 演练通过后才可正式发布                 |
| 安全、额度和成本           | `11-security-cost-constraints.md` | 安全约束优先于功能进度                 |

## 3. 文档地图

### 3.1 核心规格（编号文档）

1. [项目章程与范围](00-project-charter.md)：目标、非目标、角色、完成定义。
2. [分阶段施工计划](01-implementation-plan.md)：任务编号、依赖、交付物、验收闸门。
3. [系统架构与模块边界](02-architecture.md)：共享核心、三种运行端、状态和依赖规则。
4. [规则实现规格](03-rules-implementation.md)：字段、默认值、公式、tick 顺序、不变量。
5. [Jev 决策协议](04-jev-decision-contract.md)：合法行动、序列化、重试、预算、重放。
6. [API 与数据契约](05-api-data-contract.md)：接口、错误、幂等、D1/R2、导出。
7. [前端与交互契约](06-frontend-contract.md)：页面、状态、图表、离线与回放。
8. [实验设计与校准计划](07-experiment-calibration.md)：配对种子、扫描、结构判异、消融。
9. [测试与质量门禁](08-testing-quality.md)：单测、性质测试、集成、性能和 CI。
10. [部署与运维手册](09-deployment-operations.md)：Cloudflare、VPS、备份、发布、故障。
11. [工程协作约定](10-engineering-conventions.md)：目录、编码、Git、评审、ADR、文档维护。
12. [安全、资源与成本约束](11-security-cost-constraints.md)：密钥、限流、配额、隐私和预算。
13. [执行与交接清单](12-handoff-checklists.md)：开工、完工、发布和交接可复制清单。

### 3.2 导读与设计指南（派生文档）

以下文件是对编号规格的提炼，**不构成新的验收口径**；与编号文档或 `rule.md` 冲突时，以编号文档为准。

- [总体施工计划与契约总览](guides/plan-and-contracts.md)：架构铁律、阶段表、核心公式、哈希与 API 的一页式汇总。
- [快速开始](guides/quick-start.md)：本地浏览器、批跑、Worker、上传与门禁命令。
- [浏览器工作台快速开始](guides/web-app.md)：P3 启动、双界面、五个工作区、键盘快捷键、离线/回放限制。
- [前端设计指南](guides/frontend-design.md)：设计令牌、五大工作区、帧预算调度与降采样方案。
- [本地 run 上传](guides/upload.md)：`run-upload-bundle-file-v1` 格式、CLI 与断点续传。
- [Jev 接入与 VPS 实操手册](guides/jev-and-vps-runbook.md)：端点实测结论、密钥处理、冒烟命令、VPS `2zhou` 部署与故障速查。

### 3.3 参考资料与基准（非契约）

- [Jev（TypeSafe）简介](reference/jev-overview.md)：System One 三种原语、接口、限制与已知局限。
- [指标词典](reference/metrics-dictionary.md)：人口、财富、流动、网络、开放度与证据字段。
- [已知限制](reference/known-limitations.md)：科学结论、确定性、Worker、前端、上传与发布边界。
- [实验产物登记](reference/artifacts.md)：`out/` 入库白名单、体积上限、重跑程序与当前缺口。
- 性能基准：[P1 核心基准](benchmarks/2026-11-03-p1-core.md) | [P5a 引擎基准](benchmarks/2026-11-05-p5a-engine.md)

### 3.4 决策、研究与记录

- [架构决策记录（ADR）](adr/README.md)：ADR 触发条件、编号规则、0001–0013 索引与模板。
- [变更记录（Changes）](changes/README.md)：行为、契约与实验可比性变更的追加式记录（0001–0092）。
- [科研报告与路线图（Research）](research/README.md)：全阶段实验报告索引与 [2026-11-18 科研路线图](research/2026-11-18-scientific-research-roadmap.md)。
- [代码与设计评审（Reviews）](reviews/README.md)：各阶段架构、契约、逐提交与规则评审记录索引。
- [发布记录（Releases）](releases/README.md)：每次发布的版本、备份与验证记录。
- [计划修订预案（未生效）](plan-revision-proposal.md)：历史备案预案；不改变 01/07/rule.md 或任何验收门槛。

### 3.5 根目录文件

| 文件                      | 作用                             |
| ------------------------- | -------------------------------- |
| [README.md](../README.md) | 项目总览与文档导航入口           |
| [rule.md](../rule.md)     | 社会机制与实验目标的唯一事实来源 |
| [AGENTS.md](../AGENTS.md) | 仓库执行约定与强制约束           |

## 4. 按角色阅读

- **核心引擎开发者**：`rule.md` → 03 → 02 → 08 → 10。
- **前端开发者**：02 → 06 → 05 → 04 → 08。
- **Worker/后端开发者**：02 → 05 → 11 → 09 → 08。
- **VPS/实验开发者**：03 → 04 → 07 → 05 → 09。
- **评审或接手负责人**：00 → 01 → 12，再抽查对应契约和测试证据。

## 5. 施工前必须知道

1. 先完成无 Jev 的确定性核心，再接模型、界面和云端；不得从 UI 开始反推规则。
2. P1.5 是阻断闸门：先用 headless 原型和均值场分析证明“不止一种可归类结构”，再投入 P2–P6；未通过不得用更多工程掩盖规则问题。
3. `rule.md` 的默认值是首轮校准参数，不是现实结论，也不是已经验证能产生三类社会结构的承诺。
4. 真实 Jev 输出不承诺跨时间确定；只有 mock/random 策略承诺种子级复现，真实运行通过保存决策日志重放。
5. 不得把大规模人口模拟塞进单个 Worker 请求；不得把“每人每 tick 一行”的海量日志写入 D1。
6. 每次规则、prompt、模型或数据协议变化，都要更新对应版本和兼容性说明；业务常数不得以裸字面量进入结算。
7. 施工前的四项待议决策见 [01 施工计划](01-implementation-plan.md) §12；未关闭前不得把相关参数、采样或聚类方法写成既定口径。

## 6. 文档变更流程

1. 判断是实现澄清、行为变更还是架构变更。
2. 实现澄清可随 PR 更新文档和测试；行为变更先改规则/契约；架构变更增加 ADR。
3. 同 PR 更新受影响的文档、类型、fixture、迁移和验收用例。
4. PR 明确列出兼容性或实验可比性的影响。
5. 文档中不得保留互相矛盾的“最新口径”；历史内容移入 ADR 或变更记录。
