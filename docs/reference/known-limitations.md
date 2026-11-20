# 已知限制

本页列出当前版本**明确未完成或未验证**的事项。不要把工程完成度当成科学验收：
`rules-v18` 延续并保持 D1 目标“2 体制 + 连续统”的 G6 校准闭环（`P6-09` + 阶段 R4，changes/0089/0090），且阶段 R3 `P6-11`（changes/0093）已正式通过 30 种子真实 Jev 提示词规范诱导宏观相变因果实验确认；但**传统全特征 `k≥3` 离散结构（`P6-10` 与 R2-B 探索探针均未通过）仍未实现，不声称三类离散结构涌现**。

## 1. 科学结论

- 不声称“三类离散结构涌现”、全局多稳态或现实因果成立；P6-05/P6-06/P6-07/P6-08/P6-10 均未通过，已校准预设（`regime1_pyramid`/`regime2_continuum`）仅限 D1 两体制与 `mock-weighted-v1` / `N=200`。
- 阶段 R3（`P6-11`，30 对种子）确认了微观 LLM 规范提示（`survival_hint` vs `neutral`）对制度开放度 $O$ 和流动率 $M_{\text{up}}$ 具有统计显著的宏观相变因果效应（`passesCausalClaim: true`），但该结论依赖于特定提示词规范，不应过度外推至任意通用提示或未测 LLM 模型。
- D1 目标“2 体制 + 连续统”只是验收目标修订，不是已实现的结论。
- 浏览器工作台、上传器和 Worker 都是工程工具，不产生科学证据。

## 2. 确定性边界

- 权威 hash 只承诺在**同一 `runtimeVersion`** 内一致（ADR 0001）。
- 初始人口抽样使用 `Math.exp/log/cos`；Node 与 workerd 实测可出现 1 ulp 差异
  （changes/0073）。尚未实现 fdlibm 级确定性数学层。
- 跨运行时上传的 run 标记 `runtimeAuthority=non-authoritative`，服务器不复算
  `initialPopulationHash`；正式对照必须按 `runtimeVersion` 分组。
- Safari/Firefox 未列入权威运行时；导出时应视为非权威结果。

## 3. Worker / 数据服务

- **preview 公网全链路已验证，production 资源尚未创建**：
  preview D1/R2 已应用 0001–0003 并绑定自定义域名 `https://stratify.logicc.top`（版本 `bd6cadab`），已完成公网 HTTP `smoke:worker`、真实浏览器在线运行、R2 5 分块 `full` 流式上传与独立回放验证（`verified`）、同源 `/api/jev` 真实上游小额冒烟（5/5 成功、0 回退）、带数据远端 D1 导出隔离恢复演练与 `wrangler rollback` 演练（changes/0086/0087）。preview 的 Cron 保留任务因 Free 计划 5 槽上限未注册（显式 `crons: []`）；`stratify-prod` 生产资源尚未创建。
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
- 生产环境（`stratify-prod`）尚未创建与发布，部署后长期错误率、Jev 回退率、D1/R2 增长、Runner 失败率和成本监控看板尚未接入。
