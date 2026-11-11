# 本地 run 上传（P5b）

本指南覆盖 `run-upload-bundle-file-v1` 与上传 CLI。上传器只负责把**已经算完**的
本地 run 交给 P4 Worker；上传失败不会重跑实验，也不会新建 run。

## 1. 目录格式

```text
my-run/
  bundle.json
  metrics.ndjson          # metrics-v1，全分辨率 tick
  final-state.ndjson      # final-state-v1
  decisions.ndjson        # artifactProfile=full 时必需
  events.ndjson           # artifactProfile=full 时必需
  snapshot.ndjson         # artifactProfile=full 时必需
  agents.json             # UploadAgent[] 或 { "agents": [...] }
```

`bundle.json`：

```json
{
  "schemaVersion": "run-upload-bundle-file-v1",
  "config": { "...": "RunConfig" },
  "identity": {
    "rulesVersion": "rules-v15",
    "engineVersion": "engine-v0.12.0",
    "decisionSchemaVersion": "stratify-decision-v1",
    "policyVersion": "mock-weighted-v2",
    "promptVersion": null,
    "requestedModel": null,
    "seed": "seed-0001",
    "runtimeVersion": "node-v22.21.0",
    "configHash": "sha256:...",
    "paramsHash": "sha256:...",
    "initialPopulationHash": "sha256:...",
    "codeSha": "..."
  },
  "experiment": null,
  "artifactProfile": "metrics-only",
  "finalTick": 119,
  "endReason": "scheduled",
  "finalAliveCount": 40,
  "expectedDueDecisions": 0,
  "finalStateHash": "sha256:...",
  "summaryHash": "sha256:...",
  "agents": { "path": "agents.json" },
  "artifacts": [
    {
      "kind": "metrics",
      "chunkId": "metrics-0",
      "path": "metrics.ndjson",
      "startTick": 0,
      "endTick": 119
    },
    { "kind": "final_state", "chunkId": "final-0", "path": "final-state.ndjson" }
  ]
}
```

- `identity` 的哈希由服务器按 config/seed 重算校验；自报 roster 会被拒绝。
- `agents` 可内联数组，也可用 `{path}`；路径必须位于 `bundle.json` 所在目录内。
- `metrics.ndjson` 每行必须有整数 `tick`，且覆盖计划 stats 序列
  （`t=0, stride, …, totalTicks-1`；extinct 时截到 `finalTick`）。
- `artifactProfile=full` 时 `decisions/events/snapshot` 必需；`metrics-only`
  不得声明可回放。
- `finalAliveCount` 必须等于 `agents` 中 `alive=true` 的数量。

## 2. 上传

批跑可自动导出 bundle：

```bash
pnpm build
node bin/stratify-batch.mjs manifest.json --out out/my-batch \
  --upload-bundles out/my-batch/upload-bundles
```

每个成功 run 输出 `out/my-batch/upload-bundles/<cellKey>-<seed>/`。默认导出
`metrics-only`（metrics + final_state + agents）；需要可回放时加
`--artifact-profile full`（会额外收集 events/decisions/snapshot，内存更高，
且不能与 `--checkpoint-ticks` 同用）：

```bash
node bin/stratify-batch.mjs manifest.json --out out/my-batch \
  --upload-bundles out/my-batch/upload-bundles \
  --artifact-profile full --snapshot-stride 365
```

手工上传：

```bash
pnpm build
node scripts/upload-run.mjs my-run/bundle.json \
  --base-url http://127.0.0.1:8787 \
  --ledger my-run/upload-ledger.json
```

- 正式 runner 通过环境变量提供 `RUNNER_TOKEN`（默认读取同名变量；可用
  `--runner-token-env NAME` 换名）。匿名浏览器上传不传 token。
- 默认 ledger 为 `<bundle.json>.upload-ledger.json`；ledger 含 `writeToken`，
  本地文件权限应为 0600。
- 上传顺序：创建 run → 分块 PUT artifact → 写 tick/agent 批次 → complete。
- 每确认一个块就原子更新 ledger；网络恢复后重跑同命令只补传未确认块。
- 创建 run 的网络失败标记为 `create_ambiguous`，**不会自动重试**；先核对服务器
  run 列表，避免复制实验。
- 服务器 409（同键不同 hash、状态冲突）是终止错误，不重试。

## 3. 当前边界

- 批跑已可自动导出 metrics-only 或 full bundle（changes/0075/0080）；full 捕获
  events/executions/周期快照会显著增加内存，且不能与 `--checkpoint-ticks` 同用。
- `--resume` 复用的已完成 run 不会重新触发 bundle 导出；需要换输出目录或上游单独导出。
- 未执行真实 Cloudflare preview 部署；本地上传与 workerd 冒烟已通过（P4-07 远程部分未做）。
- 上传成功只代表技术完整（`verificationStatus=uploaded`），不代表内容已验证，
  也不构成校准或结构证据。
