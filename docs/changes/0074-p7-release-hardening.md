# 0074 P7 发布硬化（本地可验证部分）

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：docs/09、docs/11、docs/guides/quick-start.md、docs/reference/known-limitations.md
- 性质：工程与文档硬化；不改规则、参数、schema 或实验结论
- 影响范围：CI、`src/ops`、运维脚本、文档与门禁

## 1. 交付

### 冒烟

- `src/ops/smoke.ts` + `scripts/smoke-remote.mjs`（`pnpm smoke:worker`）：
  `/api/health` → 静态首页 → 创建 20 tick run → 读取 → 用 writeToken 取消。
  不调用 Jev、不上传 artifact、不写 Key；`--runtime-version` 必须显式提供，
  避免把执行脚本机器的版本冒充部署目标。
- `test/unit/ops/smoke.test.ts` 3 项：全链路取消、显式 runtime/seed、健康失败短路。

### 备份校验

- `src/ops/backup.ts`：检查 D1 导出非空（≥512 字节）、7 张关键表、至少一条
  INSERT、末尾 SQL 未截断（忽略尾部注释）。
- `scripts/verify-backup.mjs`（`pnpm verify:backup`）与
  `scripts/backup-d1.mjs`（`pnpm backup:d1`）：后者调用
  `wrangler d1 export --remote`，目标存在时拒绝覆盖，导出后立即静态校验。
- `test/unit/ops/backup.test.ts` 3 项：完整备份、缺表/空数据/过小、末尾截断。

### CI 与命令

- CI 增加 `pnpm build:web` 与 `wrangler deploy --dry-run --outdir .wrangler-dry --env=""`
  （只打包校验，不部署）。
- 新增 `deploy:preview` / `deploy:prod` / `smoke:worker` / `backup:d1` /
  `verify:backup` 脚本；文档同步但明确标注未在真实 preview/production 执行。

### 文档

- `docs/guides/quick-start.md`：环境、浏览器、批跑、Worker 本地、上传、门禁。
- `docs/reference/metrics-dictionary.md`：人口/财富/流动/网络/开放度/证据字段。
- `docs/reference/known-limitations.md`：科学结论、确定性、Worker、前端、上传、
  发布六类未完成事项。
- docs/README 文档地图与状态段更新。

## 2. 验证

- `pnpm typecheck`、`pnpm lint`、`pnpm format`、`pnpm check:docs`、
  `pnpm check:secrets` 通过。
- 新增 6 项 ops 测试；全套测试与覆盖率门禁通过（见交接 rev 48）。

## 3. 未完成 / 边界

- 未在真实 preview/production 执行 deploy、smoke、backup、restore 或 rollback；
  不得声称这些命令已在云端验证。
- 未执行依赖漏洞审计的云端/离线复跑；CI 保留 `pnpm audit --prod`。
- 未接入发布后监控（错误率、Jev 回退率、D1/R2 增长、Runner 失败率、成本）。
- 未实现保留策略/维护任务与独立验证器；真实 Jev live 冒烟仍缺 Key 配置。
- 不改 `rulesVersion`、`schemaVersion`、`promptVersion`；不构成校准或结构证据。
