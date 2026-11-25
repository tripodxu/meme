# 0110 轨道 A 线上部署刷新（含新冻结两体制预设）与 R5 Wave A 中期分析

- 日期：2026-11-25
- 关联：[0094](0094-preview-deploy-smoke-2026-11-20.md)、[0097](0097-production-deploy-backup-rollback.md)、[0108](0108-p6-15b-g6-d1-closure.md)、[0109](0109-r5-campaign-hardening-and-restart.md)、[R5 Wave A 中期报告](../research/2026-11-25-r5-wave-a-interim-analysis.md)
- 影响：分支推送与 CI 核验、Cloudflare Preview / Production 前端与 Worker 刷新部署、R5 Wave A 探索分析归档；**无核心规则、`schemaVersion`、数据库迁移或 golden 哈希变更**

## 1. 轨道 A：远端同步、CI 全绿与双环境刷新部署

1. **分支同步与 CI 核验**：将 `zcodes11.4` 领先的 10 个本地提交（`9045b86..80fe77e`，含 `changes/0106–0109` 与 `5123454` 冻结两体制预设）推送至 `origin/zcodes11.4`；PR #2 触发的 GitHub Actions CI（Run `45581200882`）**21 项质量门禁全部通过**（耗时 `4m4s`，含文档链接、密钥扫描、格式/Lint/类型/纯度检查、依赖审计、核心覆盖率 ≥95%、运行层覆盖率、集成、jsdom E2E、Playwright Chromium 浏览器 E2E、前后端构建与 Worker dry-run）。
2. **Cloudflare Preview 刷新（`https://stratify.logicc.top`）**：
   - 执行 `pnpm build && pnpm build:web && pnpm deploy:preview`；
   - 部署版本：**`774c12e9-79fd-4cb4-b3c7-a10ff5cf721c`**（Worker 启动 `1 ms`，静态资源 `/assets/index-kHxbrbA_.js` 已更新）；
   - 公网冒烟 `pnpm smoke:worker --base-url https://stratify.logicc.top --runtime-version node-22.21.0`：`ok: true`（`run_92dae69f9a4ba092d8c98909`，`health / static-index / create-run / read-run / cancel-run` 全通过）。
3. **Cloudflare Production 刷新（`https://stratify-prod.logicc.top`）**：
   - 在 CI `45581200882` 全绿后执行 `pnpm deploy:prod`；
   - 部署版本：**`d7ccfae6-d618-453b-89ba-dcb2b4cfc8df`**（Worker 启动 `3 ms`，静态资源 `/assets/index-kHxbrbA_.js` 已更新）；
   - 公网冒烟 `pnpm smoke:worker --base-url https://stratify-prod.logicc.top --runtime-version node-22.21.0`：`ok: true`（`run_0a9c492442cbe44671affa88`，5 项检查全通过）。
4. **线上前端预设核验**：拉取 Preview 与 Production 线上首页引用的 `/assets/index-kHxbrbA_.js`，两端均已包含新冻结的两体制代表预设（`regime1_pyramid`、`regime2_continuum`）与 `P6-15` 校准证据引用。
5. **工程边界不变**：本次仅为常规刷新部署与冒烟，**不构成 P7 正式发布完成**（生产 Cron 保留、`RUNNER_TOKEN`、R2 孤儿清理、生产真实 Jev live 代理冒烟与独立回放验证器 `verified` 仍未执行）。

## 2. 轨道 B：R5 Wave A（6 项 `N=200` 实验，2,820/2,820）中期收口

详细数值与图表见 [2026-11-25 R5 Wave A 中期分析报告](../research/2026-11-25-r5-wave-a-interim-analysis.md)，核心结论摘要如下（全部为 exploratory）：

- **完整性**：6 项 Wave A 实验合计 `2,820/2,820` 分片全完成、`0` 例策略失配（`r5-horizon` `T=21900` 有 1 例高龄灭绝，其余 `0` 灭绝）；
- **`r5-phase-n200`**：在 `w ≥ 15` 内部无第三盆地（相邻 `TV(P)` 平滑衰减）；但 `(share ≤ 0.85, w = 0)` 形成纯度 `117/120` 的高位塌缩/倒金字塔簇（与 `w=15` 跃变 `TV(P)=0.646–0.736`，`k=3 ARI=0.894, sil=0.357`），后续需先用细粒度 `w ∈ {0,1,2,5,10,15}` 探针判别其是边界不连续还是陡峭过渡，再决定是否立项 E7；
- **`r5-robust-c` & `r5-robust-policy`**：`C=4/6/8` 下两体制 `k=2` 全部 `ARI=1.000`（`sil 0.678–0.747`）；`random-v1` 与 `mock-v1/v2` 特征方向明确分化；
- **`r5-horizon`**：`k=2` 持续至 `T=21900`（`ARI=1.000`），`T=10950` 的 `k=3` 在 `T=21900` 消失（`ARI=0.365`），同时披露无代际模式下的高龄差分死亡尾效应；
- **`r5-pert-n200`**：300/300 真微扰配对在 `M=1e-6..1e-1` 两体制 `100%` 吸收，`M=1` 仍保持 `100% / 96.7%` 吸收；
- **Wave B/C 在途**：`r5-gen-n1000` 已推进至 `167/320`（52.2%，预计剩 ~`15.6 h`），后续继续自动消费 `r5-scale-n1000` / `r5-pert-n1000` / `r5-scale-n3000`。
