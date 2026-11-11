# migrations

D1 追加式迁移目录。`0001_init.sql` 建立 run 元数据、采样 tick、最终个体、实验、
artifact 清单与固定窗口限流表。

## 约定

- 已发布的迁移只追加，不修改、不删除、不重命名；修正通过新的迁移文件完成。
- 编号四位递增（`0001_...`、`0002_...`），描述使用小写蛇形命名。
- 每个迁移在同一个 PR 内更新对应的 TypeScript 类型、fixture 与集成测试。
- `rulesVersion`、`promptVersion`、`schemaVersion` 是三个独立版本号，迁移编号不代表规则版本。
- 上线前按 [09 发布与运维](../docs/09-deployment-operations.md) 记录备份位置与恢复验证结果。

## 本地

```bash
pnpm db:migrate:local
```

测试使用本机 `node:sqlite` 执行同一份 SQL（`test/helpers/worker-env.ts`），
不维护第二套 schema。`preview`/`production` 的远程 ID 写在 `wrangler.jsonc` 对应环境，
部署前替换占位符；`RUNNER_TOKEN` 只通过 `wrangler secret put` 配置。
