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
 *   审计用已校验 manifest 落 `<out>/batch-manifest.json`（均原子写，kill 不留半截 JSON）；
 * - mock/random 批跑不依赖 P2：不读密钥、不发网络请求；
 * - 断点续跑（G5a）：ledger 固定写 `<out>/batch-ledger.json`，逐任务原子落盘；
 *   `--resume` 从 ledger 跳过已完成 run；不带 `--resume` 且 ledger 已存在时拒绝启动，
 *   防止静默覆盖既有证据；技术失败跨 resume 保留（07 §3）。
 * - run 内检查点（P5-03）：`--checkpoint-ticks N` 每 N tick 原子落盘
 *   `<out>/run-checkpoints/run-<i>.progress.json`（状态+窗口累计器），
 *   kill 后从 tick 级完整点恢复，恢复 run 的窗口聚合与不中断运行逐字一致。
 * - 单写者：同一输出目录不得并发运行两个批跑进程（并发/共享预算属 P5-02）。
 *
 * 退出码：0 全部任务完成（历史失败可保留在 failures）；1 仍有任务未完成；2 用法/配置错误。
 *
 * 依赖 `dist/`（先 `pnpm build`）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
const { DEFAULT_RUN_CONFIG, mergeConfig } = await import(
  `file://${join(here, '..', 'dist', 'core', 'config', 'defaults.js').replace(/\\/g, '/')}`
);
const { nodeCheckpointHost, nodeCheckpointHostSync } = await import(
  `file://${join(here, '..', 'dist', 'runner', 'checkpoint-fs.js').replace(/\\/g, '/')}`
);
const { createStreamingBundleWriter, uploadBundleExists, writeUploadBundle } = await import(
  `file://${join(here, '..', 'dist', 'runner', 'upload-export.js').replace(/\\/g, '/')}`
);

function printHelp() {
  process.stdout.write(
    [
      '用法：node bin/stratify-batch.mjs <manifest.json> --out <dir> [--resume] [--checkpoint-ticks N]',
      '',
      '参数：',
      '  <manifest.json>     batch manifest（schemaVersion=batch-v1；cells×seeds 笛卡尔）',
      '  --out <dir>         输出目录（batch-summary.json / batch-manifest.json / batch-ledger.json）',
      '  --resume            从 ledger 恢复，跳过已完成 run（kill 后续跑）',
      '  --checkpoint-ticks N  每 N 个 tick 落 run 内进度检查点（<out>/run-checkpoints/；',
      '                        kill 后从 tick 级完整点恢复，长 run 建议开启，如 500）',
      '  --upload-bundles <dir>  为每个成功 run 导出 run-upload-bundle-file-v1 到 <dir>',
      '                        （metrics-only；可用 pnpm upload 上传，见 docs/guides/upload.md）',
      '  --artifact-profile <p>  上传 bundle 的 profile：metrics-only（缺省）或 full；',
      '                        full 需同时收集 events/decisions/snapshot（内存更高）',
      '  --snapshot-stride N     full profile 的周期快照间隔（缺省 config.schedule.snapshotStride）',
      '  --population N     实验级人口规模（P6-01 Stage A 200 / Stage B 1000；',
      '                     manifest.populationSize 必须与之一致），缺省 40',
      '  --help              显示本帮助',
      '',
      'stdout：batch-summary-v1 纯 JSON；进度走 stderr。',
      '退出码：0 全部任务完成；1 仍有任务未完成；2 用法/配置错误。',
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
  const args = {
    manifest: null,
    out: null,
    resume: false,
    help: false,
    checkpointTicks: null,
    population: null,
    uploadBundles: null,
    artifactProfile: 'metrics-only',
    snapshotStride: null,
  };
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
    } else if (arg === '--population') {
      const value = argv[i + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 2) {
        process.stderr.write('[batch] --population 需要 >=2 的整数。\n');
        process.exit(2);
      }
      args.population = parsed;
      i += 1;
    } else if (arg === '--checkpoint-ticks') {
      const value = argv[i + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        process.stderr.write('[batch] --checkpoint-ticks 需要 >=1 的整数。\n');
        process.exit(2);
      }
      args.checkpointTicks = parsed;
      i += 1;
    } else if (arg === '--upload-bundles') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write('[batch] --upload-bundles 需要一个目录参数。\n');
        process.exit(2);
      }
      args.uploadBundles = value;
      i += 1;
    } else if (arg === '--artifact-profile') {
      const value = argv[i + 1];
      if (value !== 'metrics-only' && value !== 'full') {
        process.stderr.write('[batch] --artifact-profile 只能是 metrics-only 或 full。\n');
        process.exit(2);
      }
      args.artifactProfile = value;
      i += 1;
    } else if (arg === '--snapshot-stride') {
      const value = argv[i + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        process.stderr.write('[batch] --snapshot-stride 需要 >=1 的整数。\n');
        process.exit(2);
      }
      args.snapshotStride = parsed;
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
  // 人口是实验级声明：--population 改变校验基准（P6-01 Stage A 200 / Stage B 1000）。
  const baseConfig =
    args.population !== null
      ? mergeConfig(DEFAULT_RUN_CONFIG, { population: { initialPopulation: args.population } })
      : undefined;
  const manifest = validateBatchManifest(manifestRecord, baseConfig);
  mkdirSync(outDir, { recursive: true });
  const uploadBundlesDir = args.uploadBundles === null ? null : resolve(args.uploadBundles);
  if (args.artifactProfile === 'full' && uploadBundlesDir === null) {
    log('--artifact-profile full 必须同时提供 --upload-bundles。');
    process.exit(2);
  }
  if (args.artifactProfile === 'full' && args.checkpointTicks !== null) {
    log('full artifact 捕获与 --checkpoint-ticks 不能同时启用（恢复段缺少 events/snapshots）。');
    process.exit(2);
  }
  if (uploadBundlesDir !== null) {
    mkdirSync(uploadBundlesDir, { recursive: true });
    log(
      `上传 bundle 输出：${uploadBundlesDir}（${args.artifactProfile}；runtimeVersion=${process.version}）`,
    );
  }

  const ledgerPath = join(outDir, 'batch-ledger.json');
  if (!args.resume && existsSync(ledgerPath)) {
    log(`ledger 已存在：${ledgerPath}；续跑请加 --resume，重跑请换输出目录。`);
    process.exit(2);
  }

  // 审计：记录本次实际消费的（已校验）manifest，可复算 manifestHash。
  // 报告/审计文件与 ledger 一样走临时文件+rename 原子替换，kill 不留半截 JSON。
  const host = nodeCheckpointHost();
  const manifestOutPath = join(outDir, 'batch-manifest.json');
  await host.writeTemp(`${manifestOutPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  await host.promote(`${manifestOutPath}.tmp`, manifestOutPath);

  const codeSha = process.env.STRATIFY_CODE_SHA ?? 'local-batch';
  const summary = await runBatch(manifest, {
    ...(baseConfig !== undefined ? { baseConfig } : {}),
    ...(args.snapshotStride !== null ? { snapshotStride: args.snapshotStride } : {}),
    ledger: { host, path: ledgerPath },
    ...(uploadBundlesDir !== null
      ? {
          shouldBackfillResumedTask: (task) =>
            !uploadBundleExists(uploadBundlesDir, task.cellKey, task.seed),
          ...(args.artifactProfile === 'full'
            ? {
                createArtifactSink: (task) =>
                  createStreamingBundleWriter({
                    outDir: uploadBundlesDir,
                    cellKey: task.cellKey,
                    seed: task.seed,
                    config: task.config,
                    runtimeVersion: process.version,
                    codeSha,
                  }),
              }
            : {
                onRunComplete: ({ task, outcome }) => {
                  writeUploadBundle({
                    outDir: uploadBundlesDir,
                    cellKey: task.cellKey,
                    seed: task.seed,
                    config: task.config,
                    outcome,
                    runtimeVersion: process.version,
                    codeSha,
                    artifactProfile: 'metrics-only',
                  });
                },
              }),
        }
      : {}),
    ...(args.checkpointTicks !== null
      ? (() => {
          const checkpointDir = join(outDir, 'run-checkpoints');
          mkdirSync(checkpointDir, { recursive: true });
          return {
            runCheckpoints: {
              host: nodeCheckpointHostSync(),
              dir: checkpointDir,
              everyTicks: args.checkpointTicks,
            },
          };
        })()
      : {}),
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
  await host.writeTemp(`${summaryPath}.tmp`, summaryText);
  await host.promote(`${summaryPath}.tmp`, summaryPath);

  // stdout 只输出摘要 JSON（报告分离：报告文件已落盘）。
  process.stdout.write(summaryText);

  log(
    `完成 ${summary.totals.ok}/${summary.totals.due}（resumed ${summary.totals.resumed}，failed ${summary.totals.failed}）；报告 ${summaryPath}`,
  );
  // 退出码按「本次调用后仍未完成的任务数」：历史失败已被重试成功时不阻断（07 §3 保留记录）。
  // 用 exitCode 而非 process.exit：stdout 在管道/重定向下是异步写，立即退出可能截断 JSON。
  process.exitCode = summary.totals.due - summary.totals.ok > 0 ? 1 : 0;
} catch (error) {
  log(`批跑中止：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
