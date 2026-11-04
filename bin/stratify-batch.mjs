#!/usr/bin/env node
/**
 * P5-01：批量批跑 CLI（01 §8.1）。
 *
 * 用法：
 *   node bin/stratify-batch.mjs <manifest.json> --out <dir> [--resume] [--help]
 *
 * 契约（01 §8.1 P5-01）：
 * - 单实验/矩阵/消融共用同一 batch manifest 语义（cells × seeds 笛卡尔）；
 * - stdout 与报告分离：stdout 只输出 batch-summary-v1 纯 JSON（可管道），
 *   进度日志走 stderr；报告文件落 `<out>/batch-summary.json`，
 *   审计用已校验 manifest 落 `<out>/batch-manifest.json`；
 * - mock/random 批跑不依赖 P2：不读密钥、不发网络请求；
 * - 断点续跑（G5a）：ledger 固定写 `<out>/batch-ledger.json`，逐 run 原子落盘；
 *   `--resume` 从 ledger 跳过已完成 run；不带 `--resume` 且 ledger 已存在时拒绝启动，
 *   防止静默覆盖既有证据。
 *
 * 退出码：0 全部成功；1 批跑完成但有失败（failures 非空）；2 用法/配置错误。
 *
 * 依赖 `dist/`（先 `pnpm build`）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distBatchCli = join(here, '..', 'dist', 'runner', 'batch-cli.js');
const distBatch = join(here, '..', 'dist', 'runner', 'batch.js');

if (!existsSync(distBatchCli) || !existsSync(distBatch)) {
  process.stderr.write('[batch] 缺少 dist/ 产物；先运行 `pnpm build`。\n');
  process.exit(2);
}

const { runBatch } = await import(`file://${distBatchCli.replace(/\\/g, '/')}`);
const { validateBatchManifest } = await import(`file://${distBatch.replace(/\\/g, '/')}`);
const { nodeCheckpointHost } = await import(
  `file://${join(here, '..', 'dist', 'runner', 'checkpoint-fs.js').replace(/\\/g, '/')}`
);

function printHelp() {
  process.stdout.write(
    [
      '用法：node bin/stratify-batch.mjs <manifest.json> --out <dir> [--resume]',
      '',
      '参数：',
      '  <manifest.json>  batch manifest（schemaVersion=batch-v1；cells×seeds 笛卡尔）',
      '  --out <dir>      输出目录（batch-summary.json / batch-manifest.json / batch-ledger.json）',
      '  --resume         从 ledger 恢复，跳过已完成 run（kill 后续跑）',
      '  --help           显示本帮助',
      '',
      'stdout：batch-summary-v1 纯 JSON；进度走 stderr。',
      '退出码：0 全部成功；1 有失败（failures 非空）；2 用法/配置错误。',
      '',
      'manifest 示例：',
      '  {',
      '    "schemaVersion": "batch-v1",',
      '    "rulesVersion": "rules-v11",',
      '    "engineVersion": "engine-v0.9.0",',
      '    "populationSize": 40,',
      '    "totalTicks": 3650,',
      '    "policy": "mock-weighted-v1",',
      '    "seeds": ["p15r3-seed-001", "p15r3-seed-002"],',
      '    "cells": [',
      '      { "cellKey": "baseline", "overrides": {} },',
      '      { "cellKey": "thr0.9", "overrides": { "need": { "threshold": 0.9 } } }',
      '    ]',
      '  }',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { manifest: null, out: null, resume: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      args.help = true;
    } else if (arg === '--resume') {
      args.resume = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write('[batch] --out 需要一个目录参数。\n');
        process.exit(2);
      }
      args.out = value;
      i += 1;
    } else if (args.manifest === null && !arg.startsWith('--')) {
      args.manifest = arg;
    } else {
      process.stderr.write(`[batch] 未知参数：${arg}（--help 查看用法）。\n`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.manifest === null || args.out === null) {
  process.stderr.write('[batch] 缺少 <manifest.json> 或 --out <dir>（--help 查看用法）。\n');
  process.exit(2);
}

function log(message) {
  process.stderr.write(`[batch] ${message}\n`);
}

try {
  const manifestPath = isAbsolute(args.manifest) ? args.manifest : resolve(args.manifest);
  const outDir = isAbsolute(args.out) ? args.out : resolve(args.out);
  if (!existsSync(manifestPath)) {
    log(`manifest 不存在：${manifestPath}`);
    process.exit(2);
  }

  let manifestRecord;
  try {
    manifestRecord = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    log(`manifest JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  // 校验在 src/runner/batch.ts（版本/人口/cell 唯一性等），非法即 2 退出。
  const manifest = validateBatchManifest(manifestRecord);
  mkdirSync(outDir, { recursive: true });

  const ledgerPath = join(outDir, 'batch-ledger.json');
  if (!args.resume && existsSync(ledgerPath)) {
    log(`ledger 已存在：${ledgerPath}；续跑请加 --resume，重跑请换输出目录。`);
    process.exit(2);
  }

  // 审计：记录本次实际消费的（已校验）manifest，可复算 manifestHash。
  writeFileSync(
    join(outDir, 'batch-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const summary = await runBatch(manifest, {
    ledger: { host: nodeCheckpointHost(), path: ledgerPath },
    onProgress: (progress) => {
      const status = progress.resumed ? 'resumed' : progress.ok ? 'ok' : 'FAILED';
      log(
        `${progress.index + 1}/${progress.total} ${status} ${progress.cellKey} ${progress.seed}` +
          (progress.ok && !progress.resumed ? ` ${Math.round(progress.elapsedMs)}ms` : ''),
      );
    },
  });

  const summaryPath = join(outDir, 'batch-summary.json');
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(summaryPath, summaryText, 'utf8');

  // stdout 只输出摘要 JSON（报告分离：报告文件已落盘）。
  process.stdout.write(summaryText);

  log(
    `完成 ${summary.totals.ok}/${summary.totals.due}（resumed ${summary.totals.resumed}，failed ${summary.totals.failed}）；报告 ${summaryPath}`,
  );
  process.exit(summary.totals.failed > 0 ? 1 : 0);
} catch (error) {
  log(`批跑中止：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
