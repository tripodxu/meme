# 0077 complete 清单复算与 diagnosticsHash 持久化

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：docs/05 §3/§4.6、changes/0071
- 性质：契约收紧；不改规则、参数或实验结论
- 影响范围：`src/worker`、`migrations/0003_diagnostics_hash.sql`、`src/runner/uploader.ts`、测试

## 1. 交付

- `POST /api/runs/:id/complete` 现在由服务器从 D1 `artifacts` 复算
  `artifactManifestHash`：清单项为 `{key:"<kind>/<chunkId>", sha256:compressed,
bytes}`，按 key 字节序排序后做 SHA-256；与提交值不一致返回 409。
  - 只证明调用方看到的块集合与 D1 清单一致，**不证明**内容已解压/回放验证。
  - 上传器同步把 `localeCompare` 改为确定的字节序比较，避免运行时 locale 差异。
- `migrations/0003_diagnostics_hash.sql`：新增 `runs.diagnostics_hash`。
  `cancel/fail` 接受 `diagnosticsHash`（`sha256:hex` 或 null）并持久化；
  `GET /api/runs/:id` 返回该字段。它只是诊断元数据，不参与回放或内容认证。

## 2. 验证

- `test/unit/worker/api.test.ts`：
  - complete 时伪造 `artifactManifestHash` 返回 409；
  - cancel 非法 `diagnosticsHash` 返回 422，合法值持久化并在详情回显。
- 上传器测试与批跑导出测试继续通过（manifest 复算口径一致）。

## 3. 未完成 / 边界

- `expectedDueDecisions` 仍未由服务器复算（需要 decisions artifact 或全分辨率
  决策计数；Worker 不解压大对象）。
- 未在 preview/production 执行；不改 `rulesVersion`/`schemaVersion`/`promptVersion`，
  不构成校准或结构证据。
