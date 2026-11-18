#!/usr/bin/env node
/**
 * 校验并可选在本地隔离 SQLite 中演练恢复 D1 导出备份（09 §7）。
 *
 *   pnpm build
 *   node scripts/verify-backup.mjs <backup.sql> [--rehearse]
 */
import { readFileSync } from 'node:fs';

import { rehearseD1Restore, verifyD1Export } from '../dist/ops/backup.js';

const args = process.argv.slice(2);
const rehearse = args.includes('--rehearse');
const positional = args.filter((a) => !a.startsWith('-'));
const path = positional[0];

if (path === undefined) {
  process.stderr.write('usage: verify-backup.mjs <backup.sql> [--rehearse]\n');
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, 'utf8');
} catch (error) {
  process.stderr.write(`无法读取备份: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const result = rehearse ? rehearseD1Restore(text) : verifyD1Export(text);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
