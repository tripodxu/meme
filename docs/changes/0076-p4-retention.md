# 0076 P4-06 保留策略与维护任务

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：docs/09 §7、docs/11、changes/0071/0073
- 性质：工程交付；不改规则、参数、schema 或实验结论
- 影响范围：`src/worker/maintenance.ts`、`src/worker/index.ts`、`wrangler.jsonc`、测试与文档

## 1. 交付

- `src/worker/maintenance.ts`：
  - `retentionCutoffs(env, now)`：browser 默认 7 天、runner 默认 90 天，
    可被 `BROWSER_RUN_RETENTION_DAYS` / `RUNNER_RUN_RETENTION_DAYS` 覆盖；
    非法值回退默认值。
  - `runMaintenance(env, now)`：按 source 与 `created_at` 分批（每源最多 1000）
    删除过期 run；先逐块删除 R2 artifact，再删除 D1 run（tick/agent/artifact
    由外键级联）。R2 删除失败时保留 D1 行，下一轮重试，避免清单与对象脱节。
  - 清理两天前的 `rate_limits` 固定窗口行。
- Worker 导出对象改为 `{ fetch, scheduled }`：Cron 触发时 `waitUntil(runMaintenance)`；
  仍导出命名 `app` 供测试直接 `app.request`。
- `wrangler.jsonc` 增加 `triggers.crons = ["17 3 * * *"]` 与三套环境的保留天数变量。

## 2. 验证

- `test/unit/worker/maintenance.test.ts` 2 项：
  1. 过期 browser/runner run（含 artifact）被删除，新 run 保留；R2 对象从 3 降到 1；
     D1 tick/agent/artifact 行级联清空；旧 `rate_limits` 行删除、新窗口保留。
  2. `retentionCutoffs` 默认值、环境覆盖与非法值回退。
- 全套 typecheck/lint/test/docs/secrets 门禁通过（见 rev 50）。

## 3. 未完成 / 边界

- 未实现 R2 **孤儿对象**枚举清理（D1 已无对应行、但对象仍存在的块）；当前只删除
  有 D1 清单的 artifact。需要 R2 list + 对账任务。
- 未在 preview/production 触发 Cron 或执行真实删除演练；不得声称线上保留策略已生效。
- 删除是物理删除，不可恢复；生产启用前必须完成备份与恢复演练（09 §7）。
- 不改 `rulesVersion`、`schemaVersion`、`promptVersion`；不构成校准或结构证据。
