import { defineConfig } from 'vitest/config';

/**
 * 运行层（`src/runner`）覆盖率门禁（08 §3）。
 *
 * 为什么单独一条：`src/runner` 承载证据链（窗口统计、标签、预注册、聚类、
 * 均值场），但长期不在覆盖率门禁内——预注册哈希漏 6 个字段、
 * 全灭日污染窗口均值这类缺陷都没被任何测试拦住（changes/0006、0007）。
 *
 * 为什么不并入 `vitest.config.ts` 的 core 门禁：两者绝对值差很多，
 * 合并成一条全局阈值会稀释 core 的强度（core branches 95.08%，runner 79.91%）。
 *
 * `branches` 取当前实测地板并作为**棘轮**：只允许上调，不得下调。
 * 目标与 core 对齐到 95，缺口是"防御性 throw 分支 + 未覆盖的 I/O 失败路径"。
 *
 * `testTimeout` 放宽到 30s：本次运行只为**测量覆盖率**，不是语义门禁。
 * `test/property/invariants.property.test.ts` 的重型性质用例（15×2 次 3650 tick
 * 仿真）在插桩后卡在默认 5s 边缘，CI 上会偶发超时；语义门禁仍是 `pnpm test`，
 * 它保留默认超时，不放宽。
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/property/**/*.test.ts', 'test/golden/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/runner/**/*.ts'],
      thresholds: {
        statements: 95,
        branches: 78,
      },
    },
  },
});
