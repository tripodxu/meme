#!/usr/bin/env node
/**
 * P5b / P4-05 独立验证器 CLI：
 * 1) 验证本地导出包：
 *      node scripts/verify-run.mjs <bundle.json>
 * 2) 下载并验证远端 Worker run（可选提交 verified/rejected 状态）：
 *      node scripts/verify-run.mjs --run-id <runId> --base-url https://... [--submit] [--runner-token-env RUNNER_TOKEN]
 *
 * 只从环境变量读取 RUNNER_TOKEN，绝不输出或写入报告。
 */
import { existsSync } from 'node:fs';

import { loadUploadBundle } from '../dist/runner/upload-bundle.js';
import { verifyRemoteRun, verifyUploadBundle } from '../dist/runner/verifier.js';

function parseArgs(argv) {
  const positional = [];
  const options = {
    baseUrl: process.env.STRATIFY_BASE_URL ?? 'http://127.0.0.1:8787',
    runId: null,
    submit: false,
    runnerTokenEnv: 'RUNNER_TOKEN',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') {
      options.baseUrl = argv[++i];
    } else if (arg === '--run-id') {
      options.runId = argv[++i];
    } else if (arg === '--submit') {
      options.submit = true;
    } else if (arg === '--runner-token-env') {
      options.runnerTokenEnv = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { bundlePath: positional[0] ?? null, options };
}

async function main() {
  const { bundlePath, options } = parseArgs(process.argv.slice(2));
  if (options.help || (bundlePath === null && options.runId === null)) {
    process.stdout.write(
      'usage:\n' +
        '  verify-run.mjs <bundle.json>\n' +
        '  verify-run.mjs --run-id <runId> [--base-url <url>] [--submit] [--runner-token-env NAME]\n',
    );
    if (!options.help) process.exitCode = 2;
    return;
  }

  if (options.runId !== null) {
    const runnerToken = process.env[options.runnerTokenEnv];
    const outcome = await verifyRemoteRun({
      baseUrl: options.baseUrl,
      runId: options.runId,
      submit: options.submit,
      ...(runnerToken === undefined ? {} : { runnerToken }),
    });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    if (outcome.status !== 'verified') process.exitCode = 1;
    return;
  }

  if (!existsSync(bundlePath)) {
    throw new Error(`bundle 文件不存在: ${bundlePath}`);
  }
  const bundle = loadUploadBundle(bundlePath);
  const outcome = verifyUploadBundle(bundle);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (outcome.status !== 'verified') process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`verify failed: ${message}\n`);
  process.exitCode = 1;
});
