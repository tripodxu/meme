#!/usr/bin/env node
/**
 * 部署冒烟（P7）：health → 静态首页 → 创建/读取/取消一个 20 tick run。
 *
 *   pnpm build
 *   node scripts/smoke-remote.mjs --base-url https://... --runtime-version node-v22.21.0
 *
 * `--runtime-version` 必须填写**目标环境实际运行时**；不同运行时的
 * initialPopulationHash 不会被 workerd 复算（ADR 0001），run 会标记
 * non-authoritative。冒烟不会上传 artifact、不调用 Jev、不写 Key。
 */
import { runRemoteSmoke } from '../dist/ops/smoke.js';

function parseArgs(argv) {
  const options = { baseUrl: null, runtimeVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') options.baseUrl = argv[++index];
    else if (arg === '--runtime-version') options.runtimeVersion = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write('usage: smoke-remote.mjs --base-url <url> --runtime-version <runtime>\n');
  process.exit(0);
}
if (options.baseUrl === null || options.runtimeVersion === null) {
  process.stderr.write('缺少 --base-url 或 --runtime-version\n');
  process.exit(2);
}
const result = await runRemoteSmoke({
  baseUrl: options.baseUrl,
  runtimeVersion: options.runtimeVersion,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
