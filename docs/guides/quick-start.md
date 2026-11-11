# 快速开始

本指南只覆盖**本地工程运行**；任何结果都不构成校准或结构证据（G6 未通过）。

## 1. 环境

- Node.js >= 22.18、pnpm 11。
- Windows/macOS/Linux 均可；`node:sqlite` 目前是实验特性，测试输出会有
  `ExperimentalWarning`，不影响结果。
- 不需要 Jev Key 即可运行 mock/random 与全部本地测试。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

## 2. 浏览器工作台（P3）

```bash
pnpm dev:web
```

打开 <http://localhost:5180>。默认预设 40 人 / 120 tick：

- `1–5` 切换工作区，`Space` 暂停/继续，`N` 单步，`E` 导出。
- 总览、个体检查器、回放、实验管理与设置均可离线使用；IndexedDB 自动保存。
- 导入只接受 `stratify-web-run-v1`；损坏/未知版本不会覆盖当前实验。
- `jev_live` 仍禁用；需要 P4 代理与显式配置后才能启用。

生产静态构建：

```bash
pnpm build:web
```

输出 `dist-web/`，由 `wrangler.jsonc` 的 Static Assets 托管。

## 3. 本地批跑（P5a）

```bash
pnpm build
pnpm batch path/to/manifest.json --out out/my-batch --resume --checkpoint-ticks 500
```

stdout 输出 `batch-summary-v1` JSON；进度走 stderr。`--resume` 从 ledger 恢复，
不重跑已完成任务。

## 4. Worker 本地（P4）

```bash
pnpm build
pnpm build:web
pnpm db:migrate:local
pnpm dev:worker
```

默认 `http://127.0.0.1:8787`。本地 D1/R2 由 Wrangler 创建，`RUNNER_TOKEN` 可放在
`.dev.vars`（已 gitignore）：

```text
RUNNER_TOKEN=local-dev-only
```

冒烟：

```bash
node scripts/smoke-remote.mjs --base-url http://127.0.0.1:8787 --runtime-version workerd-local
```

`--runtime-version` 必须与目标环境 `RUNTIME_VERSION` 一致；不同运行时的
`initialPopulationHash` 只标记 `non-authoritative`，不在服务器复算（ADR 0001）。

## 5. 上传本地 run（P5b）

```bash
pnpm build
pnpm upload path/to/bundle.json --base-url http://127.0.0.1:8787 \
  --ledger path/to/upload-ledger.json
```

bundle 格式与断点续传说明见 [上传指南](upload.md)。正式 runner 的
`RUNNER_TOKEN` 只从环境变量读取，不写入命令或日志。

## 6. 常用门禁

```bash
pnpm typecheck && pnpm typecheck:core
pnpm lint && pnpm format
pnpm test
pnpm test:e2e
pnpm check:docs && pnpm check:secrets
pnpm exec wrangler deploy --dry-run --outdir .wrangler-dry --env=""
```

发布、备份和回滚仍按 [09 发布与运维](../09-deployment-operations.md) 执行；
preview/production 尚未完成真实部署冒烟。
