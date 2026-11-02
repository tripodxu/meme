import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/property/**/*.test.ts', 'test/golden/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      thresholds: {
        statements: 95,
        branches: 95,
      },
    },
  },
});
