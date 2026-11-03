import type { RunConfig } from '../core/config/types.js';
import { DEFAULT_RUN_CONFIG } from '../core/config/defaults.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { asSeed, type Seed } from '../core/control/ids.js';
import { ENGINE_VERSION, RULES_VERSION } from '../core/control/versions.js';
import { computeConfigHash } from '../core/config/hash.js';
import { buildCellConfig, PREREG_SEEDS } from './preregistration.js';

/**
 * P5a-01/P5a-04：批量 manifest 与配对任务生成（01 §8.1）。
 *
 * - 单实验/矩阵/消融可启动：cells × seeds 全笛卡尔（每 cell 覆盖一个声明变量）；
 * - stdout 与报告分离由 CLI 层负责；本模块产出机器可读任务列表与摘要；
 * - 配对种子：同一 seed 下 cells 的 (config, seed) 纯函数派生可比初始人口；
 * - manifest 声明的 rules/engine 版本必须与当前构建一致，cellKey 唯一，
 *   人口规模必须与 base config 一致（07 §3）。
 */

export interface BatchCell {
  readonly cellKey: string;
  readonly overrides: Record<string, unknown>;
}

export interface BatchManifest {
  readonly schemaVersion: 'batch-v1';
  readonly rulesVersion: string;
  readonly engineVersion: string;
  readonly populationSize: number;
  readonly totalTicks: number;
  readonly policy: 'mock-weighted-v1' | 'random-uniform-v1';
  readonly seeds: readonly string[];
  readonly cells: readonly BatchCell[];
}

export interface BatchTask {
  readonly cellKey: string;
  readonly seed: Seed;
  readonly config: RunConfig;
  readonly configHash: string;
}

const RUN_CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_RUN_CONFIG));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertManifestVersions(rulesVersion: unknown, engineVersion: unknown): void {
  if (typeof rulesVersion !== 'string' || rulesVersion.trim().length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.rulesVersion 必须为非空字符串');
  }
  if (rulesVersion !== RULES_VERSION) {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知 manifest.rulesVersion: ${rulesVersion}（当前构建 ${RULES_VERSION}）`,
    );
  }
  if (typeof engineVersion !== 'string' || engineVersion.trim().length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.engineVersion 必须为非空字符串');
  }
  if (engineVersion !== ENGINE_VERSION) {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知 manifest.engineVersion: ${engineVersion}（当前构建 ${ENGINE_VERSION}）`,
    );
  }
}

/** `populationSize` 必须等于 base config 的人口；cell 不得用同一字段冒充不同人口（07 §3）。 */
function assertPopulationSize(populationSize: number): void {
  const basePopulation = DEFAULT_RUN_CONFIG.population.initialPopulation;
  if (populationSize !== basePopulation) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `manifest.populationSize 必须等于 base config 的 population.initialPopulation（${basePopulation}），实际为 ${populationSize}`,
    );
  }
}

/**
 * 校验单个 cell：cellKey 非空且唯一、overrides 为纯对象、只含 RunConfig 顶层键、
 * 不覆盖 `population.initialPopulation`（人口变化必须作为独立 cell 记录）。
 */
function parseCell(value: unknown, index: number, seen: Set<string>): BatchCell {
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `cells[${index}] 必须是对象`);
  }
  const cellKey = value['cellKey'];
  if (typeof cellKey !== 'string' || cellKey.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `cells[${index}].cellKey 必须为非空字符串`);
  }
  if (seen.has(cellKey)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `cellKey 重复: ${cellKey}`);
  }
  seen.add(cellKey);

  const rawOverrides = value['overrides'];
  const overrides = rawOverrides === undefined ? {} : rawOverrides;
  if (!isPlainObject(overrides)) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `cells[${index}].overrides 必须为纯对象（不得为 null/数组）`,
    );
  }
  for (const key of Object.keys(overrides)) {
    if (!RUN_CONFIG_TOP_LEVEL_KEYS.has(key)) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `cells[${index}].overrides 含未登记的 RunConfig 顶层键: ${key}`,
      );
    }
  }
  const populationOverride = overrides['population'];
  if (isPlainObject(populationOverride) && 'initialPopulation' in populationOverride) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `cell ${cellKey} 不得覆盖 population.initialPopulation；人口规模变化必须作为独立 cell 记录`,
    );
  }
  return { cellKey, overrides };
}

/** 校验 manifest 结构；cells 覆盖必须可构造为合法 RunConfig。 */
export function validateBatchManifest(value: unknown): BatchManifest {
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'batch manifest 必须是对象');
  }
  const record = value;
  if (record['schemaVersion'] !== 'batch-v1') {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知 manifest 版本: ${String(record['schemaVersion'])}`,
    );
  }
  assertManifestVersions(record['rulesVersion'], record['engineVersion']);

  const seeds = record['seeds'];
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.seeds 必须为非空数组');
  }
  const normalizedSeeds = seeds.map((seed) => {
    if (typeof seed !== 'string') {
      throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.seeds 必须为字符串数组');
    }
    return seed;
  });

  const cells = record['cells'];
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.cells 必须为非空数组');
  }
  const seenCellKeys = new Set<string>();
  const normalizedCells = cells.map((cell, index) => parseCell(cell, index, seenCellKeys));

  const populationSize = record['populationSize'];
  const totalTicks = record['totalTicks'];
  if (
    typeof populationSize !== 'number' ||
    !Number.isInteger(populationSize) ||
    populationSize < 2
  ) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.populationSize 非法');
  }
  assertPopulationSize(populationSize);
  if (typeof totalTicks !== 'number' || !Number.isInteger(totalTicks) || totalTicks < 1) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.totalTicks 非法');
  }
  const policy = record['policy'];
  if (policy !== 'mock-weighted-v1' && policy !== 'random-uniform-v1') {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'manifest.policy 必须为 mock/random（live 走 P2 管线）',
    );
  }
  return {
    schemaVersion: 'batch-v1',
    rulesVersion: record['rulesVersion'] as string,
    engineVersion: record['engineVersion'] as string,
    populationSize,
    totalTicks,
    policy,
    seeds: normalizedSeeds,
    cells: normalizedCells,
  };
}

/** manifest → 任务列表（cells × seeds；配置深合并 + 校验，失败拒绝该任务）。 */
export function buildBatchTasks(manifest: BatchManifest): BatchTask[] {
  assertManifestVersions(manifest.rulesVersion, manifest.engineVersion);
  assertPopulationSize(manifest.populationSize);
  const tasks: BatchTask[] = [];
  const seenCellKeys = new Set<string>();
  manifest.cells.forEach((rawCell, index) => {
    const cell = parseCell(rawCell, index, seenCellKeys);
    const config = buildCellConfig(
      { cellKey: cell.cellKey, hypothesis: '', overrides: cell.overrides as never },
      manifest.populationSize,
      manifest.totalTicks,
    );
    for (const seed of manifest.seeds) {
      tasks.push({
        cellKey: cell.cellKey,
        seed: asSeed(seed),
        config,
        configHash: computeConfigHash(config),
      });
    }
  });
  return tasks;
}

/** 默认配对种子列表（与 P1.5 相同的冻结列表）。 */
export function defaultPairedSeeds(count = 30): readonly string[] {
  if (count > PREREG_SEEDS.length) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `配对种子数超过冻结列表上限 ${PREREG_SEEDS.length}`,
    );
  }
  return PREREG_SEEDS.slice(0, count);
}

/** 微扰任务生成（07 §7：从同一检查点克隆，仅改声明字段）。 */
export interface PerturbationTask {
  readonly baselineCellKey: string;
  readonly seed: Seed;
  readonly field: string;
  readonly delta: number;
}

export function buildPerturbationTasks(
  cellKey: string,
  seeds: readonly string[],
  field: string,
  deltas: readonly number[],
): PerturbationTask[] {
  return seeds.flatMap((seed) =>
    deltas.map((delta) => ({ baselineCellKey: cellKey, seed: seed as Seed, field, delta })),
  );
}
