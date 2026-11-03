import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 模块边界守卫。
 *
 * `src/experimental/` 存放「已写但未获准启用」的实现（见该目录 README）。
 * 隔离只有在其不可被生产路径导入时才成立；一旦生产目录出现指向 experimental
 * 的导入，说明能力被悄悄启用，必须改回生产目录并走版本轴与闸门。
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRODUCTION_DIRS = ['src/core', 'src/runner', 'src/decision', 'scripts'];

function collectSourceFiles(relativeDir: string): string[] {
  const absolute = join(ROOT, relativeDir);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(ts|mts|mjs|js)$/.test(entry)) {
        files.push(path);
      }
    }
  };
  walk(absolute);
  return files;
}

describe('模块边界（src/experimental 隔离）', () => {
  it('生产目录不得导入 src/experimental', () => {
    const offenders: string[] = [];
    for (const dir of PRODUCTION_DIRS) {
      for (const file of collectSourceFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*experimental\//.test(source)) {
          offenders.push(file.slice(ROOT.length));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/core 不得运行时导入 runner / decision / experimental（核心纯度）', () => {
    // `import type` 在 verbatimModuleSyntax 下完全擦除，不构成运行时耦合；
    // 当前唯一例外是 `engine.ts` 对 `ExecutionRecord` 的 type-only 依赖。
    // 运行时导入则会让核心层依赖外层模块，必须禁止。
    const importRe =
      /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]*(?:runner|decision|experimental)\/[^'"]*)['"]/g;
    const offenders: string[] = [];
    for (const file of collectSourceFiles('src/core')) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importRe)) {
        if (match[1] !== undefined) {
          continue;
        }
        offenders.push(`${file.slice(ROOT.length)}: ${match[3]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
