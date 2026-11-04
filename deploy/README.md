# deploy：VPS Runner systemd 标准部署（P5-06）

> 唯一事实来源是 [docs/09 §6 VPS Runner 标准部署](../docs/09-deployment-operations.md)；
> 本目录是该节的机器可读落地。**不维护第二套 Docker/supervisord 配置。**

| 文件                      | 安装目标                                         | 作用                                              |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `stratify-runner.service` | `/etc/systemd/system/stratify-runner.service`    | 批跑 unit：oneshot、--resume 续跑、重启限频、加固 |
| `check-disk-space.sh`     | 随仓库在 `/opt/stratify/current/deploy/`（只读） | ExecStartPre 磁盘守卫：可用空间不足拒绝启动新批次 |
| `journald-stratify.conf`  | `/etc/systemd/journald.conf.d/stratify.conf`     | journal 大小/保留上限（200M / 留 1G / 14 天）     |

## 安装（对应 docs/09 §6 步骤）

```bash
# 0) 代码与构建（/opt/stratify/current 只读发布）
corepack enable
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test

# 1) 专用系统用户与目录（最小权限，不以 root 跑 runner）
useradd --system --home /var/lib/stratify --shell /usr/sbin/nologin stratify-runner
mkdir -p /var/lib/stratify/{checkpoints,manifests,exports}
chown -R stratify-runner:stratify-runner /var/lib/stratify
chmod 750 /var/lib/stratify/{checkpoints,manifests,exports}

# 2) 环境文件（权限 600，仅 token/URL/预算；键名见 docs/09 §6 环境清单）
install -m 600 -o root -g stratify-runner /path/to/runner.env /etc/stratify/runner.env

# 3) unit 与 journald
install -m 644 deploy/stratify-runner.service /etc/systemd/system/stratify-runner.service
install -m 644 deploy/journald-stratify.conf /etc/systemd/journald.conf.d/stratify.conf
systemctl daemon-reload && systemctl restart systemd-journald

# 4) 放入本批 manifest 后启动（没有 manifest 不自动启动：ConditionPathExists）
cp <batch>.json /var/lib/stratify/manifests/current.json
systemctl start stratify-runner.service
journalctl -u stratify-runner.service -f
```

## 语义对照（unit ↔ docs/09）

- **每批 manifest 独立，服务重启读取检查点**：`ExecStart` 固定指向
  `bin/stratify-batch.mjs … current.json --out … --resume --checkpoint-ticks 500`；
  `--resume` 从 `batch-ledger-v1` ledger 与 `run-progress-v1` 检查点续跑（changes/0031/0032）。
- **没有 manifest 不自动启动**：`ConditionPathExists=/var/lib/stratify/manifests/current.json`。
- **重启限频**：`StartLimitIntervalSec=300` + `StartLimitBurst=5` + `Restart=on-failure`。
- **磁盘到阈值停止新批次**：`ExecStartPre=check-disk-space.sh /var/lib/stratify 2048`。
- **不以 root、最小权限**：专用用户 + `ProtectSystem=strict` + `ReadWritePaths=/var/lib/stratify`
  - `NoNewPrivileges` + `PrivateTmp` + `ProtectHome` + `UMask=0027`。
- **Runner token/密钥**：只经 `/etc/stratify/runner.env`（600）；不写 manifest/日志/URL。
- **共享预算/限流**：MVP 单机多进程记账（`/var/lib/stratify/budget.sqlite` WAL）属 P5-02；
  当前 unit 是单进程 oneshot 批跑。

## 验证

- `test/unit/deploy/systemd-unit.test.ts`：unit 必备键与 docs/09 契约静态断言
  （ConditionPathExists/EnvironmentFile/WorkingDirectory/Restart=on-failure/StartLimit/
  非 root User/ReadWritePaths/ExecStart 含 --resume 与 --checkpoint-ticks）。
- `check-disk-space.sh` 行为测试：阈值过高拒绝（exit 1）、充足通过（exit 0）、
  参数非法（exit 2）。
