#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  description: '参数注册表契约快照；任何变更必须人工审查并同步 03 与 golden 测试。',
  definitions,
};

writeFileSync(
  resolve(ROOT, 'test/fixtures/config/param-definitions.json'),
  `${JSON.stringify(snapshot, null, 2)}\n`,
  'utf8',
);

console.log(`已写入 ${definitions.length} 个参数定义。`);
