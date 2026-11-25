#!/usr/bin/env node
/**
 * P5b 上传 CLI：把本地 `run-upload-bundle-file-v1` 上传到 P4 Worker。
 *
 * 用法：
 *   pnpm build
 *   node scripts/upload-run.mjs <bundle.json> --base-url https://... \
 *     [--ledger <path>] [--runner-token-env RUNNER_TOKEN]
 *
 * 只从环境变量读取 RUNNER_TOKEN，不打印、不写日志、不进 URL。
 * 上传失败不会重跑实验；同一 ledger 重跑只补传未确认块。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { nodeCheckpointHost } from '../dist/runner/checkpoint-fs.js';
import { loadUploadBundle } from '../dist/runner/upload-bundle.js';
import { uploadRun } from '../dist/runner/uploader.js';

function parseArgs(argv) {
  const positional = [];
  const options = {
    baseUrl: process.env.STRATIFY_BASE_URL ?? 'http://127.0.0.1:8787',
    ledger: null,
    runnerTokenEnv: 'RUNNER_TOKEN',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') {
      options.baseUrl = argv[++index];
    } else if (arg === '--ledger') {
      options.ledger = argv[++index];
    } else if (arg === '--runner-token-env') {
      options.runnerTokenEnv = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!options.help && positional.length !== 1) {
    throw new Error('需要且只接受一个 bundle.json');
  }
  return { bundlePath: positional[0], options };
}

async function main() {
  const { bundlePath, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'usage: upload-run.mjs <bundle.json> --base-url <url> [--ledger <path>] [--runner-token-env NAME]\n',
    );
    return;
  }
  if (!existsSync(bundlePath)) throw new Error(`bundle 不存在: ${bundlePath}`);
  const bundle = loadUploadBundle(bundlePath);
  const ledgerPath = resolve(options.ledger ?? `${bundlePath}.upload-ledger.json`);
  const runnerToken = process.env[options.runnerTokenEnv];
  const result = await uploadRun(bundle, {
    baseUrl: options.baseUrl,
    ledger: { host: nodeCheckpointHost(), path: ledgerPath },
    ...(runnerToken === undefined ? {} : { runnerToken }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'upload_failed';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`upload failed [${String(code)}]: ${message}\n`);
  process.exitCode = 1;
});
