# 0073 运行时权威边界与 workerd 上传冒烟

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0001（runtime authority）、docs/02 §8、docs/05 §2、changes/0071/0072
- 性质：工程修正；不改规则、参数或实验结论
- 影响范围：`src/worker`、`migrations/0002_runtime_authority.sql`、`wrangler.jsonc`、测试与文档

## 1. 发现

用 Node 生成 `run-upload-bundle-v1` 上传到本地 workerd 时，服务器复算
`initialPopulationHash` 报不一致。定位到 `ge` 等抽样值在 Node 与 workerd 相差
1 ulp（如 `0.4182433983855968` vs `...69`），根因是初始人口抽样使用
`Math.exp/log/cos`，不同 V8 构建的最后一位可能不同——这与 ADR 0001 已声明的
“hash 只在同一 `runtimeVersion` 内承诺一致”一致，是**服务器校验口径错误**，
不是上传器算错。

## 2. 修正

- `wrangler.jsonc` 新增 `RUNTIME_VERSION` 变量（local/preview/production 分别配置）；
  部署时必须改为该环境实际运行时标识。
- 创建 run 时：
  - `identity.runtimeVersion === RUNTIME_VERSION` → 服务器复算
    `initialPopulationHash` 并要求相等（`runtime_authority=authoritative`）；
  - 不同运行时 → 仍派生人口以验证 config/seed，但不复算比对，记录
    `runtime_authority=non-authoritative`，禁止把该 run 混入同运行时正式对照。
- D1 追加 `migrations/0002_runtime_authority.sql`：
  `runs.runtime_authority TEXT NOT NULL DEFAULT 'non-authoritative'`；
  `GET /api/runs/:id` 与列表返回 `runtimeAuthority`。
- 浏览器/Node runner 的 hash 仍按 ADR 0001 分组；正式对照必须同
  `runtimeVersion`，或等待 fdlibm 级确定性数学层。

## 3. 验证

- `test/unit/worker/api.test.ts` 15 项：原同运行时哈希拒绝仍生效；新增跨运行时
  用错误 hash 可创建，但 `runtimeAuthority=non-authoritative`。
- `test/unit/runner/uploader.test.ts` 7 项在 `RUNTIME_VERSION=test-runtime` 下全通过。
- **P4-07 本地 workerd + D1 + R2 集成冒烟通过**（`wrangler dev --local`，
  `migrations` 已应用）：`/api/health` 200；Node 上传器创建 run（非权威）→
  上传 metrics/final_state → 写 3 条 tick 与 1 条 agent → complete；run 详情
  `status=completed`、`progress={tickRows:3,agentRows:1}`；artifact GET 200、
  `If-None-Match` 返回 304；stats 返回 3 条。**preview 远程部署冒烟仍未执行**。

## 4. 边界

- 未实现确定性数学层；Node/workerd/Chromium 跨版本仍可能有 1 ulp 差异。
- 非权威 run 创建时无法防自报 roster；独立验证器必须在同 `runtimeVersion`
  下复算，正式实验只接受 verified。
- 未改 `rulesVersion`、`schemaVersion`、`promptVersion`；不构成校准或结构证据。
