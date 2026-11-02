# test/e2e

端到端测试目录，使用 `vitest.e2e.config.ts`。当前为空，`passWithNoTests` 保证骨架阶段可运行。

## 约定

- 覆盖浏览器端创建运行、取消、回放与错误恢复的关键路径。
- 主分支与发布前必须运行；PR 阶段可按需运行。
- 使用固定 seed 与 mock 决策保证可重复；不得依赖 wall clock。
