#!/usr/bin/env node
/**
 * 由当前构建的 DEFAULT_RUN_CONFIG 生成 config golden fixture（累加式，artifacts §5）：
 * `test/fixtures/config/default-<rulesVersion>.json` + `.hashes.json`。
 * 用法：pnpm build && node scripts/generate-default-config-fixture.mjs [rulesVersion]
 * rulesVersion 缺省取当前构建的 RULES_VERSION；旧版本 fixture 不被本脚本改写。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rulesVersion =
  process.argv[2] ??
  (await import(new URL('../dist/core/control/versions.js', import.meta.url).href)).RULES_VERSION;
const { DEFAULT_RUN_CONFIG } = await import(
  new URL('../dist/core/config/defaults.js', import.meta.url).href
);
const { computeConfigHash, computeParamsHash } = await import(
  new URL('../dist/core/config/hash.js', import.meta.url).href
);

if (DEFAULT_RUN_CONFIG.rulesVersion !== rulesVersion) {
  throw new Error(
    `DEFAULT_RUN_CONFIG.rulesVersion=${DEFAULT_RUN_CONFIG.rulesVersion} 与目标 ${rulesVersion} 不一致`,
  );
}
const fixturePath = `test/fixtures/config/default-${rulesVersion}.json`;
const hashesPath = `test/fixtures/config/default-${rulesVersion}.hashes.json`;
if (existsSync(resolve(ROOT, fixturePath))) {
  throw new Error(`${fixturePath} 已存在；config fixture 为累加式，不得就地改写（artifacts §5）`);
}
const configJson = JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG));
writeFileSync(resolve(ROOT, fixturePath), `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');
writeFileSync(
  resolve(ROOT, hashesPath),
  `${JSON.stringify(
    {
      rulesVersion,
      fixture: fixturePath,
      configHash: computeConfigHash(DEFAULT_RUN_CONFIG),
      paramsHash: computeParamsHash(DEFAULT_RUN_CONFIG),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`已写入 ${fixturePath} 与 ${hashesPath}`);
