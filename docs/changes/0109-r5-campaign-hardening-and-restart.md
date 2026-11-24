# 0109 R5 大规模实验战役脚本硬化、停旧归档与 `r5-prereg-v2` 重启

- 日期：2026-11-24
- 关联：[0105](0105-r5-campaign-start.md)、[0106](0106-runsingle-policy-fallthrough-audit.md)、[0108](0108-p6-15b-g6-d1-closure.md)、[R5 计划](../plans/r5-campaign.md)
- 代码提交：`00b99b3`（`runSingle` fail-closed 与脚本策略修复）、`8e2d7d7`（[scripts/r5-campaign.mjs](../../scripts/r5-campaign.mjs) 硬化）
- 影响：仅影响批量探索脚本与上海 VPS（`lhsh:~/stratify-r5`）运行状态；**不改变 `rulesVersion`（`rules-v19`）、`schemaVersion`、`promptVersion`、产品前端/Worker 或核心 golden 哈希**
- 兼容性与实验可比性：2026-11-22 启动的旧 `RandomPolicy` 批次产物不得与本次新分片混用，已整体移出并归档；预注册 schema 升级为 `r5-prereg-v2`，显式将 `defaultPolicy` 与逐 cell `policy` 纳入 `designHash`，自动拒绝加载旧版 `r5-prereg-v1` 清单。

## 1. 脚本硬化内容（`8e2d7d7`）

在 `00b99b3` 补齐 `policy` 参数并修复 `task.kind === 'pert'` 分发后，对 `scripts/r5-campaign.mjs` 进行重启前全量审计并落地五项硬化：

1. **清理 `configHash` 污染**：移除 `buildConfig` 中无效的 `overrides.decision.policy` 字段（`RunConfig.decision` 无 `policy` 字段，但 `mergeConfig` 会保留并污染 `r5-robust-policy` 的 `configHash`）。
2. **运行期逐决策策略校验**：将 `runSingleTask` 中的 `NOOP_ARTIFACT_SINK` 替换为 `createPolicyVerifyingSink(policy)`，对每条 `DecisionRecord` 断言 `d.policyVersion === policy`（失配或零决策立即抛错），并把 `observedPolicy` 持久化至每个分片 JSON。
3. **补齐特征与窗口完整性守卫**：修复 `windowFeatures` 原本恒为 `0` 的 `vec[6]`（`topWealthShare`）与 `vec[8]`（`mDown`），并新增 `missingTicks > 0` 守卫以防静默接受缺窗数据。
4. **微扰配对与 worker 健壮性**：`runPairTask` 显式持久化 `policy` 字段；`runTasks` 监听 worker `exit` 事件，非零退出即 `reject`，防止异常静默挂起。
5. **预注册绑定策略（`r5-prereg-v2`）**：`designFor` / `freezeExperiment` 将 `defaultPolicy` 与逐 cell `policy` 纳入预注册设计与哈希，确保策略不可被未备案替换。

## 2. 旧进程清理与审计归档（`lhsh:~/stratify-r5`）

- 停止 2026-11-22 启动、受 `0106` 策略回落影响的旧进程 `PID 3183653`（当时运行至 `r5-gen-n1000`）及其两枚旧轮询 shell watcher（`PID 3186657` / `PID 3186943`）。
- 将旧 `out/r5`（约 `15 MB`）与旧日志（`r5-campaign.log`、`r5-progress.log`、`r5-watchdog.log`）完整迁移归档至 VPS `~/stratify-r5/archive-random-bug-2026-11-24/` 留存审计，未删除且未触碰 `~/stratify-g6`。
- 同步 `8e2d7d7` 编译产物（`dist/`、`package.json`、`scripts/r5-campaign.mjs`）至 `~/stratify-r5`，规则基线为当前默认 `rules-v19`（`lineageDiscount=0` 时与 `rules-v18` 逐位等价）。

## 3. 全新预注册（`r5-prereg-v2`，共 10 项实验 / 3,660 任务）

在上海 VPS 执行 `node scripts/r5-campaign.mjs --validate` 与 `--freeze` 冻结全部 10 项实验清单（位于 `~/stratify-r5/out/r5/<exp>/prereg.json`）：

| 实验               | 任务数 | `schemaVersion` | `designHash`                                                              |
| :----------------- | -----: | :-------------- | :------------------------------------------------------------------------ |
| `r5-phase-n200`    |    900 | `r5-prereg-v2`  | `sha256:98ed6a9a30a4d2b03cc94536660dd3af5ef1a42faf3a4122412645c33e26cbd8` |
| `r5-robust-c`      |    540 | `r5-prereg-v2`  | `sha256:84292d7d732efeb6bd83f528d46cb87bcaf7443f4d21a2e5476f93944e54089d` |
| `r5-robust-policy` |    540 | `r5-prereg-v2`  | `sha256:e2765901828c9641312be7174bc80374da675bb2b5350e18cede513b58f0ea36` |
| `r5-horizon`       |    360 | `r5-prereg-v2`  | `sha256:c87b3c7fca45b9cada92f38b80f17f8e09172c0c25d508cba074ecffd5fe66a6` |
| `r5-scale-n200`    |    180 | `r5-prereg-v2`  | `sha256:e3fa6cc1e08b075acb20eaeb6a08448b0038bb1fbfdd55322c1207a75a2fa649` |
| `r5-scale-n1000`   |    180 | `r5-prereg-v2`  | `sha256:1badf0a457b4d666e471cd347ceca9a8630f2820a070131b7067c04d260480a3` |
| `r5-scale-n3000`   |    180 | `r5-prereg-v2`  | `sha256:b7b3e373dcd147374637dece26b1b72921dc5143250c35d3184b4284af0f231b` |
| `r5-gen-n1000`     |    320 | `r5-prereg-v2`  | `sha256:183776d749f28ff2ab01a8b0287f1347c4ca550348724984aa3befa27df23067` |
| `r5-pert-n200`     |    300 | `r5-prereg-v2`  | `sha256:6d65f7f4d811b0dd1e6e7efab6f7a036e360d5db948c20ec45bf2253c9f37480` |
| `r5-pert-n1000`    |    180 | `r5-prereg-v2`  | `sha256:30876566b59b21c67edd3773910ac69e6217e7e8dac6be15bd9387995c6c38a5` |

## 4. 重启执行与首批分片真策略验真

- **启动方式**：通过既有 15 分钟 cron 看门狗 `~/stratify-r5/r5-watchdog.sh`（每小时 `:07 / :22 / :37 / :52` 巡检）启动，于 `2026-11-24T15:27:03+08:00` 拉起 `PID 1379069`（`node scripts/r5-campaign.mjs --run`，4 workers）。
- **资源与进度**：
  - 启动 1 分 30 秒时：`CPU = 346%`、`RSS = 474 MB`（`6.0%` 内存，可用内存充足），`r5-phase-n200` 完成 `8/900` 分片，日志无报错；
  - 启动约 9 分钟时（`15:36`）：`r5-phase-n200` 稳步推进至 `71/900` 分片。
- **首批分片抽检（`S0.30-W0`，`N=200`，`3650` tick）**：
  - `r5-phase-s001`：`policy = "mock-weighted-v1"`、`observedPolicy = "mock-weighted-v1"`，`P = [0, 0, 0, 0.1217, 0.8783]`，`G = 0.4034`，`topWealthShare = 0.3130`，`mUp = 0.5394`，`mDown = 0.0697`，`S = 0.1253`，`O = 0.7585`；
  - `r5-phase-s002`：`policy = "mock-weighted-v1"`、`observedPolicy = "mock-weighted-v1"`，`P = [0, 0, 0.0014, 0.8054, 0.1932]`，`G = 0.4769`，`topWealthShare = 0.3770`，`mUp = 0.0844`，`mDown = 0.0140`，`S = 0.4737`，`O = 0.1163`。
  - 证实与旧版实跑 `RandomPolicy`（`P0 ≈ 0.64` 且 `topWealthShare = mDown = 0`）彻底区分，11 维特征与逐决策策略断言均正常工作。

## 5. 验证证据与适用边界

- **本地验证**：`node --check scripts/r5-campaign.mjs`、`node scripts/r5-campaign.mjs --validate`、`pnpm lint`（0 warning）、`pnpm build`、`pnpm check:docs` 与 `pnpm check:secrets` 均通过（遵循 AGENTS 约束 11，本地不执行仿真）。
- **科学边界**：R5 全部 10 项实验均为 exploratory/characterization，旨在检验传统 `k≥3`、尺度/时程收敛、代际通道与微扰放大边界；**不影响已收口的 G6 D1 校准口径（[0108](0108-p6-15b-g6-d1-closure.md)），也不构成 `k≥3` 确认**；若后续发现候选第三簇，必须另立 ADR、全新预注册与全新种子。
