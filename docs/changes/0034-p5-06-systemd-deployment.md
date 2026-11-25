# 0034：P5-06 systemd 标准部署（unit + journald + 磁盘守卫）

- 日期：2026-11-05
- 作者：Runner 负责人
- 关联：P5-06（01 §8.1）、docs/09 §6（VPS Runner 标准部署）、`changes/0031`–`0033`
- 性质：**部署工件新增**；不改变规则、参数、引擎与 runner 库行为；
  新增仓库目录 `deploy/`（docs/01 §2 目录树同步）

## 1. 结论先行

P5-06 的「一种标准部署」落地为 `deploy/` 三个工件，逐条映射 docs/09 §6，不引入
第二套 Docker/supervisord 配置：

| 工件                             | 作用                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/stratify-runner.service` | oneshot 批跑 unit：ConditionPathExists（无 manifest 不自动启动）、EnvironmentFile、专用用户、Restart=on-failure + StartLimit 300s/5 次、ProtectSystem=strict 加固 |
| `deploy/check-disk-space.sh`     | ExecStartPre 磁盘守卫：可用空间 < 2048 MB 拒绝启动新批次（§6「磁盘到阈值时停止新批次」）                                                                          |
| `deploy/journald-stratify.conf`  | journal 上限 200M / 留 1G / 14 天（§6「journald 配置大小/保留」）                                                                                                 |

## 2. 语义要点

- **每批 manifest 独立，服务重启读取检查点**：ExecStart 固定指向
  `bin/stratify-batch.mjs /var/lib/stratify/manifests/current.json --out
/var/lib/stratify/exports/current --resume --checkpoint-ticks 500`；
  重启续跑 = `batch-ledger-v1`（run 粒度，changes/0031）+ `run-progress-v1`
  （tick 粒度，changes/0032）。
- **没有 manifest 不自动启动真实 Jev**：`ConditionPathExists` 用 systemd 原生语义
  实现，而非脚本内判断。
- **不以 root、最小权限**：专用系统用户 `stratify-runner` + `ProtectSystem=strict` +
  `ReadWritePaths=/var/lib/stratify` + `NoNewPrivileges/PrivateTmp/ProtectHome` +
  `UMask=0027`。
- **oneshot 而非常驻**：每批 manifest 是有限批跑，结束即退出；常驻调度与多 worker
  共享预算/限流属 P5-02（§6 的 budget.sqlite WAL 记账）。
- **日志纪律**（§7）：journal 只含 runId/cell/seed/tick、调用/token、回退、延迟、
  上传确认与 checkpoint hash；完整 state/raw body 不进 journal——由 CLI 现有输出
  口径保证（stdout 纯 JSON 摘要、stderr 进度行）。

## 3. 验证与演练边界

- `test/unit/deploy/systemd-unit.test.ts` 11 项：unit 必备键与 docs/09 契约静态断言、
  守卫脚本行为（充足/拒绝/非法参数）。
- **尚未做**（诚实边界）：在 VPS `2zhou` 上的真实 `systemctl` 安装演练（useradd/
  install/daemon-reload/start）未执行——本机是 Windows，systemd 语义由静态测试覆盖；
  正式发布前须按 deploy/README.md 在 VPS 完成一次安装演练并记录（09 §8 演练通过后
  才可正式发布）。
- 告警阈值冻结（§9）与磁盘清理流程（§10）不在本变更范围。

## 4. 验证证据

- 全套门禁：typecheck/typecheck:core/lint/format/test（637，含新增 11 项）/build 全绿。
