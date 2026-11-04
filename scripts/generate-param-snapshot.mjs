#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paramsUrl = new URL('../dist/core/params.js', import.meta.url);
const { PARAM_DEFINITIONS } = await import(paramsUrl.href);

const definitions = PARAM_DEFINITIONS.map(
  ({ name, unit, formulaRef, domain, guardOnly, affectsBehavior }) => ({
    name,
    unit,
    formulaRef,
    domain,
    guardOnly,
    affectsBehavior,
  }),
);

const snapshot = {
  schemaVersion: 'stratify-params-v1',
  description: '参数注册表契约快照；任何变更必须人工审查并同步 03 与 golden 测试。',
  source: 'scripts/generate-param-snapshot.mjs（读取 src/core/params.ts 的构建产物）',
  definitions,
};

const target = resolve(ROOT, 'test/fixtures/config/param-definitions.json');
// 经 Prettier 输出（沿用 .prettierrc），使 `pnpm params:snapshot` 在无注册表变更时
// 产生空 diff——否则 `pnpm format` 会立刻把生成物改回，形成无意义噪声。
const formatted = await prettier.format(`${JSON.stringify(snapshot, null, 2)}\n`, {
  filepath: target,
});

writeFileSync(target, formatted, 'utf8');

console.log(`已写入 ${definitions.length} 个参数定义。`);
