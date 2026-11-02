# 09 部署与运维手册

## 1. 环境划分

至少两套隔离资源：

| 环境 | 用途 | 数据与密钥 |
|---|---|---|
| local | 单元、workerd、前端开发 | 本地 D1/R2，不使用生产密钥 |
| preview | PR/发布前集成、真实小额冒烟 | 独立 D1/R2、独立 Runner token、低预算 Jev |
| production | 正式网站和实验归档 | 独立 D1/R2、生产 Runner token、严格配额 |

禁止 preview 与 production 共用数据库、bucket、writeToken 或 Runner token。所有命名、ID 和域名放 wrangler 环境配置，不写死源码。

## 2. 首次准备

### 2.1 通用

- Node.js >=22.18、pnpm、Wrangler、Git；Cloudflare 账号有 Workers/D1/R2 权限。
- VPS 建议 Linux、非 root 运行用户、可靠磁盘、NTP 同步、SSH 密钥登录。
- 官方限制发布前复核：Workers <https://developers.cloudflare.com/workers/platform/limits/>，D1 <https://developers.cloudflare.com/d1/platform/limits/>。

### 2.2 Cloudflare 资源

以下为施工命令模板，资源名可按环境替换：

```bash
pnpm install --frozen-lockfile
pnpm build
wrangler d1 create stratify-preview
wrangler r2 bucket create stratify-artifacts-preview
wrangler d1 create stratify-prod
wrangler r2 bucket create stratify-artifacts-prod
```

把返回的 database_id 写入对应 `wrangler.jsonc` 环境；配置 Static Assets、D1/R2 binding、兼容性日期。普通变量：

```text
JEV_ALLOWED_MODELS=jev-1.13.0
MAX_JEV_BODY_BYTES=262144
MAX_ARTIFACT_BYTES=8388608
BROWSER_RUN_RETENTION_DAYS=7
RUNNER_RUN_RETENTION_DAYS=90
RUNNER_TOKEN=仅通过 wrangler secret 配置
```

MVP 不配置公共 TYPESAFE_API_KEY；访客使用自己的 X-Api-Key。密钥通过 `wrangler secret put RUNNER_TOKEN` 的交互安全流程设置，不写入文件/命令历史。

## 3. 数据库与 R2 初始化

```bash
wrangler d1 migrations apply stratify-preview --remote
wrangler d1 migrations apply stratify-prod --remote
```

生产 apply 前必须先备份、核对迁移列表和 SQL；已应用迁移永不修改。R2 配置生命周期/保留策略要与 D1 `artifacts/runs` 一致，避免只删一边。清理任务先在 preview 对小数据演练。

部署脚本至少提供：

```bash
pnpm deploy:preview
pnpm deploy:prod
pnpm smoke:preview
pnpm smoke:prod
pnpm backup:d1
pnpm verify:backup
```

脚本未实现前不得声称这些命令可用；P4/P7 负责补齐。

## 4. 标准发布流程

1. 确认目标 commit、CI 全绿、 changelog/规则和 API 兼容说明。
2. 检查当前生产健康、错误率、存储余量；不在事故中发布。
3. 导出 D1 并记录 R2 manifest 总数/大小；验证备份文件非空且可读取。
4. preview 应用同迁移、部署同构建，执行 API、浏览器和低预算 Jev 冒烟。
5. 生产先应用向后兼容迁移，再 `wrangler deploy`；数据库迁移不能依赖新代码尚未支持。
6. 检查 `/api/health`、静态页、创建/写入/完成一个受控 run、artifact 上传/下载、NDJSON 导出。
7. 观察 Worker 错误/CPU、D1 写入、R2 增长、429/5xx、Jev 回退和成本。
8. 记录版本、时间、操作者、备份位置和验证结果。

数据库 rollback 不使用破坏性回退；需要时写前向修复迁移。应用代码可用 `wrangler rollback` 回上一正常部署，但必须确认旧代码兼容当前 schema。

## 5. 回滚触发与步骤

触发：核心结算错误、认证绕过、数据重复/丢失、错误率显著升高、预算保护失效、迁移导致读写不兼容。

1. 暂停 Runner 新批次和匿名写入口；保留证据，不继续污染数据。
2. 回滚 Worker 到上一兼容版本；必要时打开维护/只读开关。
3. 已错误写入的数据不直接删除，标记 quarantine，按 runId/hash 评估修复。
4. 用前向迁移修复 schema；从备份恢复只在隔离环境验证后进行。
5. 完成 preview/生产冒烟，逐步恢复写入和 Runner。
6. 记录影响 run、时间范围、根因、补救和预防措施。

## 6. VPS Runner 标准部署

MVP 选择 **systemd**，不维护一套漂移的 Docker 配置。建议路径：

```text
/opt/stratify/current          只读发布代码
/etc/stratify/runner.env       权限600，仅RUNNER_TOKEN/API URL/预算等
/var/lib/stratify/checkpoints  权威本地检查点
/var/lib/stratify/manifests    批次与上传确认
/var/lib/stratify/exports      待上传/诊断数据
```

步骤：

```bash
node --version
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

- 创建专用系统用户，目录最小权限；不以 root 跑 runner。
- unit 使用 `EnvironmentFile=/etc/stratify/runner.env`，`WorkingDirectory=/opt/stratify/current`，`Restart=on-failure` 并限制重启频率。
- ExecStart 指向构建后的固定批次 CLI 和 manifest；没有 manifest 不自动启动真实 Jev。
- 每批 manifest 独立，服务重启读取检查点；不要把长命令只放 shell 历史。
- journald 配置大小/保留，磁盘到阈值时停止新批次；NTP 正常，避免时间戳和超时异常。

环境至少：

```text
STRATIFY_API_BASE=https://<production-domain>
RUNNER_TOKEN=<secret>
RUNNER_DATA_DIR=/var/lib/stratify
MAX_CALLS=<batch limit>
MAX_INPUT_TOKENS=<batch limit>
MAX_RUN_MINUTES=<batch limit>
MAX_COST_USD=<batch limit, if supported>
JEV_CONCURRENCY=4
```

真实 Key 若由 VPS 直连 TypeSafe，使用单独 env 权限 600，不写 manifest/日志。若经 Worker，则按代理协议使用用户 Key；两种路径在同一正式对照实验中不可混用而不记录。

## 7. Runner 启动、恢复与完成

启动前：检查 commit/config hash、manifest、磁盘、预算、上游小额探针、API auth 和剩余配额。

运行中：记录 runId/cell/seed/tick、调用/token、回退、延迟、上传确认和 checkpoint hash。不得把完整 state/raw body 打 journal。

恢复：

1. 进程异常或 kill 后，忽略未完成的临时文件。
2. 校验最近 checkpoint hash/schema/config；不兼容则停止，不猜测。
3. 重建共享预算和限流状态，历史 usage 从 manifest 恢复。
4. 对超时未确认的上传用原主键/hash 幂等重试。
5. 从下一未结算 tick 继续；最终 hash 与无中断对照一致。

完成：停止新调用，等待在途 settled，上传最终 agent/artifact，核对计数和 manifest，complete 后才写本地 completed。complete 超时可重试查询，不创建新 run。

## 8. 备份与恢复演练

### 8.1 备份内容

- 每日 D1 导出（包含 migrations 状态）、Worker/wrangler 非敏感配置、当前代码 commit。
- R2 不清空复制；每日核对 artifact manifest、对象数/大小/hash，重要正式批次另复制到独立备份位置。
- VPS manifest、检查点和上传确认按实验保留；环境秘密不进普通备份，使用专门秘密管理。

### 8.2 校验与恢复

- 每次备份检查文件非空、hash、可解压/SQL 可读；每周至少一次抽样恢复到隔离 D1/R2 或本地验证环境。
- 恢复演练核对 run/tick/agent/artifact 数、complete manifest 和随机 run 的导出可读。
- 不直接覆盖生产做“演练”；生产真实恢复需事故负责人批准和现有数据快照。
- 备份保留周期、加密和异地位置由运维记录，测试 `pnpm verify:backup` 必须真正检查可读性而非只检查文件存在。

## 9. 监控与告警

| 指标 | 需要告警的异常 |
|---|---|
| Worker | 5xx/CPU/内存、请求体超限、异常流量 |
| D1/R2 | 写失败、存储增长、孤儿 artifact、备份失败 |
| Jev | 401/429/5xx、延迟、回退率、token/成本突增 |
| Runner | 反复重启、checkpoint 停滞、上传落后、预算接近上限 |
| 实验质量 | NaN/invariant failure、缺失 tick、异常全死亡、版本混杂 |

告警含 runId/requestId/版本，不含 Key/writeToken/raw state。具体阈值经基线压测冻结；回退率>20% 和核心不变量失败可直接暂停正式实验。

## 10. 故障 Runbook

**Jev 大面积失败**：停止新 live 批次→保留 mock 核心服务→检查状态码/Retry-After/模型版本→禁止无限重试→恢复后小额冒烟→失败批次标记无效或单独重跑。

**成本/调用异常**：打开 Runner 停止和 Worker 全局保险丝→撤销/轮换相关 Runner token→核对 usage 与日志→保留未完成 run→确认预算修复后恢复。

**D1/R2 写入失败**：Runner 在本地安全暂停→使用幂等重试，不新建 run→检查存储/权限→恢复后重传并核对 manifest→孤儿块由维护任务处理。

**核心不变量失败**：立即终止受影响 run→保存诊断快照/配置/seed→quarantine 结果→添加最小回归→修复需新引擎版本，不覆盖旧结论。

**VPS 进程被 kill**：按第 7 节恢复；若 checkpoint 损坏回上一完整点，记录重跑区间，验证最终 hash。

**密钥泄漏**：立即撤销/轮换→检查调用和成本→清理公开 artifact/日志中的秘密（保留必要审计）→评估影响并补充扫描测试。
