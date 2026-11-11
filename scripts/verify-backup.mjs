#!/usr/bin/env node
/**
 * 校验 D1 导出备份（09 §7）。只做静态检查，真实恢复必须在隔离 D1 演练。
 *
 *   pnpm build
 *   node scripts/verify-backup.mjs <backup.sql>
 */
import { readFileSync } from 'node:fs';

import { verifyD1Export } from '../dist/ops/backup.js';

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write('usage: verify-backup.mjs <backup.sql>\n');
  process.exit(2);
}
let text;
try {
  text = readFileSync(path, 'utf8');
} catch (error) {
  process.stderr.write(`无法读取备份: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const result = verifyD1Export(text);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
