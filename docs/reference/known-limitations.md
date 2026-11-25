# 已知限制

本页列出当前版本**明确未完成或未验证**的事项。不要把工程完成度当成科学验收：
当前规则版本为 `rules-v19`（新机制默认关闭，与 `v15–v18` 逐位一致）。**G6 在 D1（「2 体制 + 连续统」，`07 §8.2`）目标下已收口**（changes/0106–0108，校准报告 `docs/research/2026-11-24-p6-15-g6-d1-calibration-report.md`）：真实 `mock-weighted-v1` 下的 `P6-15`（`N=40`, 660/660）聚类在新旧条件 4 双口径均通过，微扰跨 `N=40/200/1000` 均 100% 吸收，`P6-15b`（`N=600`, 60/60）经官方 `evaluateStageB` 独立确认体制 II `ψ=1` 消融结构退化（`w2b TV(P)=0.2425`、`100% > D95`）；`src/app/presets.ts` 仅冻结 `regime1_pyramid` 与 `regime2_continuum` 为 `calibrated: true`，其余全部预设仍为 `calibrated: false`。阶段 R3（`P6-11` 与 `P6-14` 60/60 live，changes/0093/0104）确认了 Jev 提示词因果效应（`passesCausalClaim: true`）。

## 1. 科学结论

- **G6 适用边界与未通过目标**：本次 G6 收口严格限定于 D1「2 体制 + 连续统」、`rules-v19` 默认配置（`generationalMode='none'`）与 `mock-weighted-v1` 策略。**传统全特征 `k≥3` 离散结构（`P6-05..08`/`P6-10`/R2-B/R2-C）仍未通过**；不得声称「三类离散结构涌现」「社会结构已涌现」或现实因果。
- **消融覆盖边界**：五项必跑消融中仅阶级持有成本 `ψ=1` 达到 `TV(P) ≥ 0.10` 并通过 `P6-15b` 独立确认（且方向为 `P4` 上升而非旧文本注记的 `P4` 下降）；`β=0`、`O=fixed`、`η=0`、`κ=0` 四项反馈消融的 `median TV(P)` 均 `<0.10`，不得声称全部反馈轴均获结构消融支持。
- **策略与代际边界**：`P6-15`/`P6-15b` 的两体制仍是 `share=1` vs `share<1` 单轴分裂且 `generationalMode='none'`，不外推至 `random-uniform-v1` 或 `generationalMode='replace'`；2026-11-18 后因策略回落实跑 `RandomPolicy` 的旧批次（changes/0106）不作 `mock-weighted-v1` 证据。
- 阶段 R3（`P6-11` 30 对与 `P6-14` 60/60 live）确认了微观 LLM 规范提示（`survival_hint` vs `neutral`）对制度开放度 $O$、网络隔离度 $S$ 与流动率 $M_{\text{up}}$ 的宏观因果效应（`passesCausalClaim: true`），但该结论依赖于特定提示词规范与单一模型 `jev-1.13-free`，不外推至任意提示或未测模型。
- 浏览器工作台、上传器和 Worker 都是工程工具，不产生科学证据。

## 2. 确定性边界

- 权威 hash 只承诺在**同一 `runtimeVersion`** 内一致（ADR 0001）。
- 初始人口抽样使用 `Math.exp/log/cos`；Node 与 workerd 实测可出现 1 ulp 差异
  （changes/0073）。尚未实现 fdlibm 级确定性数学层。
- 跨运行时上传的 run 标记 `runtimeAuthority=non-authoritative`，服务器不复算
  `initialPopulationHash`；正式对照必须按 `runtimeVersion` 分组。
- Safari/Firefox 未列入权威运行时；导出时应视为非权威结果。

## 3. Worker / 数据服务

- **preview 与 production 基础链路已部署冒烟，P7 仍未完成**：
  preview（`https://stratify.logicc.top`，`95a4fb2f`）已完成公网冒烟、匿名上传、D1 备份恢复、回滚与小额 `/api/jev` live 代理验证（changes/0086/0087/0094）；production 的 D1 `stratify-prod` 与 R2 `stratify-artifacts-prod` 已创建并应用 0001–0003，版本 `4b79128b` 部署在 `https://stratify-prod.logicc.top`，完成基础冒烟、D1 导出隔离恢复与回滚演练（changes/0097）。两环境的 Cron 保留任务因 Workers Free 5 槽上限未注册（`crons: []`）；production 尚未配置 `RUNNER_TOKEN`、未演练 R2 孤儿清理、未跑独立回放验证与真实 Jev live 代理冒烟。
- 保留策略与维护任务已实现（browser 7d / runner 90d、静默超时标记 `abandoned_timeout`、R2→D1 级联删除、超宽限期 R2 孤儿对象枚举清理；changes/0076/0085），但**线上 Cron 定时触发与云端自动删除演练尚未开启**。
- `artifactManifestHash` 已由服务器从 D1 清单复算（changes/0077）；Worker `complete` 阶段不解压 R2 大块复算 `expectedDueDecisions`，由**独立验证器**（`src/runner/verifier.ts` / `pnpm verify:run`，changes/0084/0087）下载解压并逐 tick 确定性回放后将 `verificationStatus` 从 `uploaded` 更新为 `verified` 或 `rejected`（回写服务端状态需配置 `RUNNER_TOKEN`）。`verificationStatus=uploaded` 仍只代表上传技术完整，正式实验只接受 `verified`。
- `diagnosticsHash` 与 `verification_report_hash` 已持久化并在详情校验，作为诊断摘要（未注册独立核心回放 domain 前不参与核心状态哈希）。
- 同源 `/api/jev` 代理已通过 `https://stratify.logicc.top/api/jev` → `https://jev.logicc.top/v1/systemone` 的真实小额 live 冒烟（5/5 决策成功、0 回退、远端 D1 审计零明文密钥；changes/0087），但受限于单次串行 HTTP 延迟与上游配额，大规模正式实验仍应使用 VPS 批跑器而非浏览器页面。
- Worker 已加全局小时保险丝（`jev:global`，默认 1000）与按 IP 限流，但没有跨用户
  配额/计费；浏览器超建议规模（40 人 / 730 tick / 间隔 30）只要求显式勾选确认，
  不是硬拒绝。
- 未实现跨进程上传队列或配额计费；限流是固定窗口表，不提供全局保险丝。

## 4. 前端

- P3-07 已接入 10 项 jsdom DOM E2E（`pnpm test:e2e`）与 **Playwright 真实浏览器自动化 E2E**（`pnpm test:e2e:browser`，覆盖桌面端完整运行、快照跳转、IndexedDB v3 同标签页刷新恢复、交互沙盒剧场出牌与微扰分叉、360px 窄屏与 Firefox 非权威运行时提示；changes/0084）；WebKit/Safari 与真实跨设备真机兼容性矩阵尚未纳入自动流水线。
- IndexedDB 采用 v3 分块原子保存，支持同标签页刷新自动恢复；关闭标签页后不向云端续传，服务器 run 依赖静默超时。
- `jev_live` 可用但 Key 只在内存；导入/回放只对保存了 `selectedAction` 的决策有效，
  回放不再调用模型。
- 单次对比只给描述性差异，不提供显著性结论。

## 5. 上传与批跑

- 上传创建 run 的网络超时标记 `create_ambiguous`，需人工核对服务器列表；不会自动
  重试以避免复制实验。
- 批跑 `full` 导出已采用逐 tick 流式分块落盘（`createStreamingBundleWriter`），且 `--resume --upload-bundles` 支持缺失 bundle 自动确定性补导出（changes/0085）。流式 `full` 导出现可与 run 内 `--checkpoint-ticks` 同用：续跑时按 `full-export.json` 与磁盘分块续写，保留断点前的 decisions/events/snapshots（changes/0096）；内存模式 `captureArtifacts` 仍不接受 checkpoint。
- `metrics-only` 不可回放；只有 `full` 才具备 decisions/events/snapshot 全量 artifact。
- 上传 ledger 含 writeToken，调用方必须保证文件权限（Node 宿主默认 0600）。

## 6. 发布与运维

- 云端隔离 D1 新建库导入尚未执行；已完成含真实业务行的远端 `stratify-preview` D1 导出、本地 `rehearseD1Restore` 隔离 SQLite 外键回放演练、Preview `wrangler rollback` 回滚/前滚演练与 `pnpm audit --prod` 依赖审计（changes/0085/0086/0087）。
- 生产环境（`stratify-prod.logicc.top`）已完成初始化部署、基础冒烟、D1 导出恢复与回滚演练（changes/0097），但 Cron 保留、`RUNNER_TOKEN`、R2 孤儿清理、生产独立回放验证、真实 Jev live 冒烟与发布后监控看板尚未完成，不得声称已正式发布或 P7 完成。
