import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../src/core/config/defaults.js';
import { ENGINE_VERSION, RULES_VERSION } from '../../src/core/control/versions.js';

/**
 * P5-01 集成测试：真实 spawn `bin/stratify-batch.mjs`。
 * 覆盖：stdout 纯 JSON 与报告分离、报告/审计/ledger 三文件落盘、
 * 无 --resume 拒绝覆盖既有 ledger、--resume 全量跳过、退出码语义。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = join(repoRoot, 'bin', 'stratify-batch.mjs');
const distReady =
  existsSync(join(repoRoot, 'dist', 'runner', 'batch-cli.js')) &&
  existsSync(join(repoRoot, 'dist', 'runner', 'batch.js')) &&
  existsSync(join(repoRoot, 'dist', 'runner', 'checkpoint-fs.js'));

const workRoot = mkdtempSync(join(tmpdir(), 'stratify-batch-cli-'));
const manifestPath = join(workRoot, 'manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify({
    schemaVersion: 'batch-v1',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    populationSize: DEFAULT_RUN_CONFIG.population.initialPopulation,
    totalTicks: 12,
    policy: 'mock-weighted-v1',
    seeds: ['s1', 's2'],
    cells: [
      { cellKey: 'baseline', overrides: {} },
      { cellKey: 'threshold=0.9', overrides: { need: { threshold: 0.9 } } },
    ],
  }),
  'utf8',
);

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

interface SummaryShape {
  readonly schemaVersion: string;
  readonly manifestHash: string;
  readonly runs: readonly unknown[];
  readonly failures: readonly unknown[];
  readonly totals: {
    readonly due: number;
    readonly ok: number;
    readonly failed: number;
    readonly resumed: number;
  };
}

describe('batch CLI 端到端（P5-01）', () => {
  it.runIf(distReady)('首轮：stdout 纯 JSON 摘要，报告/审计/ledger 落盘，退出码 0', () => {
    const outDir = join(workRoot, 'out1');
    const result = spawnSync(process.execPath, [bin, manifestPath, '--out', outDir], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status).toBe(0);

    // stdout 与报告分离：stdout 必须是可解析的纯 JSON（无进度文本混入）。
    const summary = JSON.parse(result.stdout) as SummaryShape;
    expect(summary.schemaVersion).toBe('batch-summary-v1');
    expect(summary.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(summary.totals).toMatchObject({ due: 4, ok: 4, failed: 0, resumed: 0 });

    // 报告文件与 stdout 一致；审计 manifest 与 ledger 落盘。
    const reportText = readFileSync(join(outDir, 'batch-summary.json'), 'utf8');
    expect(JSON.parse(reportText)).toEqual(summary);
    expect(JSON.parse(readFileSync(join(outDir, 'batch-manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: 'batch-v1',
    });
    expect(existsSync(join(outDir, 'batch-ledger.json'))).toBe(true);

    // 进度只走 stderr。
    expect(result.stderr).toContain('[batch] 4/4 ok threshold=0.9 s2');
  });

  it.runIf(distReady)('无 --resume 且 ledger 已存在：拒绝启动防覆盖，退出码 2', () => {
    const result = spawnSync(
      process.execPath,
      [bin, manifestPath, '--out', join(workRoot, 'out1')],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ledger 已存在');
    expect(result.stdout).toBe('');
  });

  it.runIf(distReady)('--resume：全量复用 ledger，resumed=4，退出码 0', () => {
    const result = spawnSync(
      process.execPath,
      [bin, manifestPath, '--out', join(workRoot, 'out1'), '--resume'],
      { encoding: 'utf8', timeout: 120_000 },
    );
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as SummaryShape;
    expect(summary.totals).toMatchObject({ due: 4, ok: 4, failed: 0, resumed: 4 });
    expect(result.stderr).toContain('resumed baseline s1');
  });

  it.runIf(distReady)('缺少参数与未知参数：退出码 2 且 --help 可用', () => {
    const noArgs = spawnSync(process.execPath, [bin], { encoding: 'utf8', timeout: 60_000 });
    expect(noArgs.status).toBe(2);
    const unknown = spawnSync(
      process.execPath,
      [bin, manifestPath, '--out', join(workRoot, 'x'), '--wat'],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(unknown.status).toBe(2);
    const help = spawnSync(process.execPath, [bin, '--help'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--resume');
  });
});
