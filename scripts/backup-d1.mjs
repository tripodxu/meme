#!/usr/bin/env node
/**
 * D1 远程导出备份（09 §7）。需要已登录的 wrangler 与对应环境权限。
 *
 *   pnpm build
 *   node scripts/backup-d1.mjs --database stratify-preview --env preview \
 *     --output backups/2026-11-11-preview.sql
 *
 * 目标文件已存在时拒绝覆盖；导出后立即做静态校验，失败以非零退出。
 * 该脚本不执行恢复；恢复必须在隔离 D1 演练并记录（09 §7）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { verifyD1Export } from '../dist/ops/backup.js';

function parseArgs(argv) {
  const options = { database: null, env: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--database') options.database = argv[++index];
    else if (arg === '--env') options.env = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(
    'usage: backup-d1.mjs --database <name> --env preview|production --output <file.sql>\n',
  );
  process.exit(0);
}
if (options.database === null || options.output === null) {
  process.stderr.write('缺少 --database 或 --output\n');
  process.exit(2);
}
if (options.env !== null && options.env !== 'preview' && options.env !== 'production') {
  process.stderr.write('--env 只能是 preview 或 production\n');
  process.exit(2);
}
const output = resolve(options.output);
if (existsSync(output)) {
  process.stderr.write(`目标已存在，拒绝覆盖: ${output}\n`);
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
const args = ['d1', 'export', options.database, '--remote', '--output', output];
if (options.env !== null) args.push('--env', options.env);
const run = spawnSync('wrangler', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (run.status !== 0) {
  process.stderr.write(`wrangler d1 export 失败（exit ${String(run.status)}）\n`);
  process.exit(1);
}
const result = verifyD1Export(readFileSync(output, 'utf8'));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) {
  process.stderr.write('备份静态校验失败，不得视为可用备份\n');
  process.exitCode = 1;
}
