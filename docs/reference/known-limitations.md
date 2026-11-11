# 已知限制

本页列出当前版本**明确未完成或未验证**的事项。不要把工程完成度当成科学验收：
`rules-v15` 仍未通过 [07](../07-experiment-calibration.md) 的统计验收，G6 未通过，
P6 已按 ADR 0008 停止。

## 1. 科学结论

- 不声称参数已校准、结构已涌现、双稳态或三簇成立；P6-05/P6-06/P6-07 均未通过。
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

- **preview/production 尚未真实部署或冒烟**；只有 `wrangler deploy --dry-run`
  与本地 `wrangler dev --local` 的 workerd+D1+R2 全链路（changes/0073）。
- 保留策略与维护任务（过期 run、孤儿 artifact、`rate_limits` 清理）未实现。
- `expectedDueDecisions`、`artifactManifestHash` 只做格式校验，未做服务端复算。
- `diagnosticsHash` 未持久化；cancel/fail 只记录 reason 与 finalTick。
- 独立验证器、压缩/未压缩内容复核与回放验证未接入；`verificationStatus=uploaded`
  不代表内容已验证。
- 同源 `/api/jev` 代理没有真实 live 冒烟；浏览器 `jev_live` 仍禁用。
- 未实现跨进程上传队列或配额计费；限流是固定窗口表，不提供全局保险丝。

## 4. 前端

- P3-07 只有 5 项 jsdom DOM E2E 与手动 Chromium 验证；**真实浏览器自动化 E2E
  未接入**（仓库无 Playwright/Puppeteer）。
- IndexedDB 自动保存每 2 秒至多一次；关闭标签页后不续传，服务器 run 依赖静默超时。
- `jev_live` 禁用；导入/回放只对保存了 `selectedAction` 的决策有效。
- 单次对比只给描述性差异，不提供显著性结论。

## 5. 上传与批跑

- `pnpm batch` 尚未自动产出 `run-upload-bundle-file-v1`；当前需上游导出器或手工
  准备 artifact 目录（指南 `docs/guides/upload.md`）。
- 上传创建 run 的网络超时标记 `create_ambiguous`，需人工核对服务器列表；不会自动
  重试以避免复制实验。
- `metrics-only` 不可回放；`full` 需要 decisions/events/snapshot 全量 artifact。
- 上传 ledger 含 writeToken，调用方必须保证文件权限（Node 宿主默认 0600）。

## 6. 发布与运维

- 备份/恢复、回滚、依赖审计和限流演练尚未在真实 preview 环境执行。
- `scripts/backup-d1.mjs` 只做导出与静态校验，不执行恢复；恢复必须在隔离 D1
  演练并记录（09 §7）。
- 部署后错误率、Jev 回退率、D1/R2 增长、Runner 失败率和成本监控尚未接入。
- 本文档与命令在本地通过；不代表 Cloudflare 账号、配额或网络环境已验证。
