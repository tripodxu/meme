# test/integration

集成测试目录，使用 `vitest.integration.config.ts`。当前为空，`passWithNoTests` 保证骨架阶段可运行。

## 约定

- 覆盖 Worker 路由、D1 查询与 R2 manifest 交互；必要时在本地 workerd 运行，不访问真实网络。
- 与契约相关的 PR 必须运行 `pnpm test:integration`。
- 不得调用真实 Jev；需要模型行为时使用 `src/decision` 的 mock。
