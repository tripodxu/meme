import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { diffConfigPaths } from '../../../src/core/config/diff.js';
import type { RunConfig } from '../../../src/core/config/types.js';
import { HASH_DOMAINS } from '../../../src/core/hash/domains.js';
import { hashValue } from '../../../src/core/hash/hash.js';
import {
  buildBaseConfig,
  buildCellConfig,
  buildPreregCells,
  buildPreregHashInput,
  buildPreregManifest,
  computePreregistrationHash,
} from '../../../src/runner/preregistration.js';

const POPULATION = 40;
const TICKS = 3650;

describe('diffConfigPaths', () => {
  it('相同配置返回空', () => {
    const base = buildBaseConfig(POPULATION, TICKS);
    expect(diffConfigPaths(base, base)).toEqual([]);
  });

  it('数组视为单个叶子，不按下标展开', () => {
    const base = buildBaseConfig(POPULATION, TICKS);
    const variant = {
      ...base,
      need: { ...base.need, needMultiplier: [1, 1.5, 1.5, 1.5, 1.5] },
    } as RunConfig;
    expect(diffConfigPaths(base, variant)).toEqual(['need.needMultiplier']);
  });

  it('嵌套差异定位到最末级叶子并按字典序返回', () => {
    const base = buildBaseConfig(POPULATION, TICKS);
    const variant = {
      ...base,
      ascent: { ...base.ascent, holdingCushionDays: 90 },
      attributes: { ...base.attributes, ge: { ...base.attributes.ge, median: 0.7 } },
    } as RunConfig;
    expect(diffConfigPaths(base, variant)).toEqual([
      'ascent.holdingCushionDays',
      'attributes.ge.median',
    ]);
  });
});

describe('预注册 cell 设计类型（07 §6.2 / §6.3）', () => {
  const cells = buildPreregCells(POPULATION, TICKS);

  it('baseline 零覆盖', () => {
    const baseline = cells.filter((cell) => cell.design === 'baseline');
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.changedPaths).toEqual([]);
  });

  it('single 设计恰好改变一个参数（可单轴归因）', () => {
    const singles = cells.filter((cell) => cell.design === 'single');
    expect(singles.length).toBeGreaterThan(0);
    for (const cell of singles) {
      expect(cell.changedPaths, cell.cellKey).toHaveLength(1);
    }
  });

  it('interaction 设计改变至少两个参数（不得单轴归因）', () => {
    const interactions = cells.filter((cell) => cell.design === 'interaction');
    expect(interactions.length).toBeGreaterThan(0);
    for (const cell of interactions) {
      expect(cell.changedPaths.length, cell.cellKey).toBeGreaterThanOrEqual(2);
    }
  });

  it('设计类型计数与网格规模一致（diagnosis §6 W2 网格）', () => {
    const counts = { baseline: 0, single: 0, interaction: 0 };
    for (const cell of cells) {
      counts[cell.design] += 1;
    }
    // 1 baseline + 17 single（envExp 7、α 2、ψ 2、bufferDays 2、limit 2、threshold 2）
    // + 8 interaction（α×ψ 4、bufferDays×limit 4）= 26
    expect(counts).toEqual({ baseline: 1, single: 17, interaction: 8 });
    expect(cells).toHaveLength(26);
  });

  it('W2 网格覆盖 diagnosis §6 的全部四个轴', () => {
    const keys = cells.map((cell) => cell.cellKey);
    for (const phi of ['0', '0.3', '0.5', '0.7', '1.2', '1.5', '2']) {
      expect(keys).toContain(`envExponent=${phi}`);
    }
    for (const alpha of ['0.05', '0.6']) expect(keys).toContain(`referenceSmoothing=${alpha}`);
    for (const scale of ['0.7', '1.4']) expect(keys).toContain(`needMultiplier×${scale}`);
    for (const days of ['10', '60']) expect(keys).toContain(`bufferDays=${days}`);
    for (const limit of ['7', '30']) expect(keys).toContain(`belowNeedLimit=${limit}`);
    for (const threshold of ['0.3', '0.8']) expect(keys).toContain(`needThreshold=${threshold}`);
    // 交互 cell 双轴组合齐全
    for (const alpha of ['0.05', '0.6']) {
      for (const scale of ['0.7', '1.4']) {
        expect(keys).toContain(`alpha=${alpha}+psi×${scale}`);
      }
    }
    for (const days of ['10', '60']) {
      for (const limit of ['7', '30']) {
        expect(keys).toContain(`bufferDays=${days}+limit=${limit}`);
      }
    }
  });

  it('不存在配置完全相同的重复格点', () => {
    const hashes = cells.map((cell) => cell.fullConfigHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('回归：交互 cell 与单轴 cell 的 changedPaths 自洽且不与默认值重合', () => {
    const keys = cells.map((cell) => cell.cellKey);
    // 交互 cell 必须恰好改两个参数（单轴 cell 已由设计类型校验覆盖）
    const interactions = cells.filter((cell) => cell.design === 'interaction');
    for (const cell of interactions) {
      expect(cell.changedPaths, cell.cellKey).toHaveLength(2);
    }
    // 单轴 cell 不得落在默认值上（否则是白耗种子的重复格点，构建期已拒绝，
    // 这里锁定基线默认值不入 cell 列表的回归线）
    expect(keys).not.toContain('envExponent=1');
    expect(keys).not.toContain('referenceSmoothing=0.2');
    expect(keys).not.toContain('bufferDays=30');
    expect(keys).not.toContain('belowNeedLimit=14');
    expect(keys).not.toContain('needThreshold=0.5');
    expect(keys).not.toContain('needMultiplier×1');
  });

  it('cell 不得借 overrides 改写预注册人口与调度', () => {
    const config = buildCellConfig(
      { cellKey: 'probe', overrides: { population: { initialPopulation: 9999 } } },
      POPULATION,
      TICKS,
    );
    expect(config.population.initialPopulation).toBe(POPULATION);
    expect(config.schedule.totalTicks).toBe(TICKS);
  });

  it('buildCellConfig 不污染共享的 DEFAULT_RUN_CONFIG', () => {
    const before = JSON.stringify(DEFAULT_RUN_CONFIG);
    buildCellConfig(
      { cellKey: 'probe', overrides: { need: { threshold: 0.9 } } },
      POPULATION,
      TICKS,
    );
    expect(JSON.stringify(DEFAULT_RUN_CONFIG)).toBe(before);
  });
});

describe('preregistrationHash 预像（07 §3）', () => {
  const manifest = buildPreregManifest();
  const input = buildPreregHashInput(manifest);
  const base = computePreregistrationHash(manifest);

  it('预像字段清单与 07 §3 权威口径完全一致', () => {
    expect(Object.keys(input).sort()).toEqual(
      [
        'artifactProfile',
        'baseConfigHash',
        'budgets',
        'cells',
        'clustering',
        'decisionSchemaVersion',
        'differenceThresholds',
        'engineVersion',
        'exclusionRules',
        'experimentType',
        'hypothesis',
        'labelThresholdVersion',
        'labelThresholdsHash',
        'pairing',
        'policyVersion',
        'populationSize',
        'primaryMetric',
        'promptStyle',
        'promptVersion',
        'rulesVersion',
        'schemaVersion',
        'seeds',
        'totalTicks',
        'warmupDiagnostic',
        'warmupTicks',
        'windows',
      ].sort(),
    );
  });

  it('cells 子对象字段清单固定', () => {
    expect(Object.keys(input.cells[0]!).sort()).toEqual([
      'cellKey',
      'changedPaths',
      'design',
      'fullConfigHash',
      'overrides',
    ]);
  });

  it('哈希就是域分隔 SHA-256 作用于预像', () => {
    expect(base).toBe(hashValue(HASH_DOMAINS.preregistration, input));
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('同一设计重复计算结果稳定（无隐藏状态）', () => {
    expect(computePreregistrationHash(buildPreregManifest())).toBe(base);
  });

  it('运行后才产生的字段不进入哈希', () => {
    const withRuntime = {
      ...manifest,
      experimentId: 'exp-should-not-hash',
      createdAt: '2026-11-03T00:00:00.000Z',
      observedResponseModels: ['never'],
    } as unknown as typeof manifest;
    expect(computePreregistrationHash(withRuntime)).toBe(base);
  });

  it('任一预注册字段变化都改变哈希', () => {
    const variants = [
      { ...input, hypothesis: `${input.hypothesis}（改）` },
      { ...input, primaryMetric: 'G' },
      { ...input, promptVersion: 'prompt-none-v2' },
      { ...input, promptStyle: 'verbose' },
      { ...input, baseConfigHash: 'sha256:deadbeef' },
      { ...input, artifactProfile: 'metrics-only' },
      { ...input, populationSize: 41 },
      { ...input, totalTicks: 3651 },
      { ...input, seeds: [...input.seeds].reverse() },
      { ...input, warmupTicks: 1826 },
      { ...input, windows: [...input.windows].reverse() },
      { ...input, labelThresholdsHash: 'sha256:deadbeef' },
      { ...input, clustering: { ...input.clustering, featureWindows: ['w3'] as const } },
      {
        ...input,
        clustering: { ...input.clustering, temporalConsistencyMinRate: 0.7 },
      },
      { ...input, differenceThresholds: { ...input.differenceThresholds, gini: 0.05 as const } },
      { ...input, budgets: { ...input.budgets, maxRuns: 999 } },
      {
        ...input,
        exclusionRules: { ...input.exclusionRules, excludeExtinctRuns: false },
      },
      { ...input, cells: input.cells.slice(0, -1) },
    ];
    for (const variant of variants) {
      expect(hashValue(HASH_DOMAINS.preregistration, variant)).not.toBe(base);
    }
  });

  it('cell 的 design 与 changedPaths 参与哈希', () => {
    const cell = input.cells[1]!;
    const relabeled = {
      ...input,
      cells: [{ ...cell, design: 'interaction' as const }, ...input.cells.slice(2)],
    };
    expect(hashValue(HASH_DOMAINS.preregistration, relabeled)).not.toBe(base);
    const rewired = {
      ...input,
      cells: [{ ...cell, changedPaths: ['need.threshold'] }, ...input.cells.slice(2)],
    };
    expect(hashValue(HASH_DOMAINS.preregistration, rewired)).not.toBe(base);
  });
});

describe('baseConfigHash（07 §3：默认值漂移必须可见）', () => {
  const manifest = buildPreregManifest();

  it('是合法哈希，且与 cell overrides 无关', () => {
    expect(manifest.baseConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      diffConfigPaths(
        buildBaseConfig(manifest.populationSize, manifest.totalTicks),
        buildBaseConfig(manifest.populationSize, manifest.totalTicks),
      ),
    ).toEqual([]);
  });

  it('默认配置漂移会改变 baseConfigHash（buildCellConfig 合并默认值的前置防线）', () => {
    const base = buildBaseConfig(manifest.populationSize, manifest.totalTicks);
    const drifted = { ...base, ascent: { ...base.ascent, holdingCushionDays: 45 } } as RunConfig;
    expect(diffConfigPaths(base, drifted)).toEqual(['ascent.holdingCushionDays']);
  });
});
