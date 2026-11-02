# migrations

D1 追加式迁移目录。当前尚未创建迁移；首次出现持久化表时新增 `NNNN_description.sql`。

## 约定

- 已发布的迁移只追加，不修改、不删除、不重命名；修正通过新的迁移文件完成。
- 编号四位递增（`0001_...`、`0002_...`），描述使用小写蛇形命名。
- 每个迁移在同一个 PR 内更新对应的 TypeScript 类型、fixture 与集成测试。
- `rulesVersion`、`promptVersion`、`schemaVersion` 是三个独立版本号，迁移编号不代表规则版本。
- 上线前按 [09 发布与运维](../docs/09-deployment-operations.md) 记录备份位置与恢复验证结果。
