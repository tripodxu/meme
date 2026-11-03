import type { RunConfig } from '../core/config/types.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { Seed } from '../core/control/ids.js';
import { computeConfigHash } from '../core/config/hash.js';
import { buildCellConfig, PREREG_SEEDS } from './preregistration.js';

/**
 * P5a-01/P5a-04：批量 manifest 与配对任务生成（01 §8.1）。
 *
 * - 单实验/矩阵/消融可启动：cells × seeds 全笛卡尔（每 cell 覆盖一个声明变量）；
 * - stdout 与报告分离由 CLI 层负责；本模块产出机器可读任务列表与摘要；
 * - 配对种子：同一 seed 下 cells 的 (config, seed) 纯函数派生可比初始人口。
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

/** 校验 manifest 结构；cells 覆盖必须可构造为合法 RunConfig。 */
export function validateBatchManifest(value: unknown): BatchManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'batch manifest 必须是对象');
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== 'batch-v1') {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知 manifest 版本: ${String(record['schemaVersion'])}`,
    );
  }
  const seeds = record['seeds'];
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.seeds 必须为非空数组');
  }
  const cells = record['cells'];
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.cells 必须为非空数组');
  }
  const populationSize = record['populationSize'];
  const totalTicks = record['totalTicks'];
  if (
    typeof populationSize !== 'number' ||
    !Number.isInteger(populationSize) ||
    populationSize < 2
  ) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'manifest.populationSize 非法');
  }
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
    rulesVersion: String(record['rulesVersion'] ?? ''),
    engineVersion: String(record['engineVersion'] ?? ''),
    populationSize,
    totalTicks,
    policy,
    seeds: seeds.map((seed) => String(seed)),
    cells: cells.map((cell) => {
      if (typeof cell !== 'object' || cell === null) {
        throw new StratifyError(errorCodes.CONFIG_INVALID, 'cell 必须是对象');
      }
      const cellRecord = cell as Record<string, unknown>;
      return {
        cellKey: String(cellRecord['cellKey'] ?? ''),
        overrides: (cellRecord['overrides'] ?? {}) as Record<string, unknown>,
      };
    }),
  };
}

/** manifest → 任务列表（cells × seeds；配置深合并 + 校验，失败拒绝该任务）。 */
export function buildBatchTasks(manifest: BatchManifest): BatchTask[] {
  const tasks: BatchTask[] = [];
  for (const cell of manifest.cells) {
    if (cell.cellKey.length === 0) {
      throw new StratifyError(errorCodes.CONFIG_INVALID, 'cellKey 不得为空');
    }
    const config = buildCellConfig(
      { cellKey: cell.cellKey, hypothesis: '', overrides: cell.overrides as never },
      manifest.populationSize,
      manifest.totalTicks,
    );
    for (const seed of manifest.seeds) {
      tasks.push({
        cellKey: cell.cellKey,
        seed: seed as Seed,
        config,
        configHash: computeConfigHash(config),
      });
    }
  }
  return tasks;
}

/** 校验后的配置合并（暴露给 CLI 复用 buildCellConfig 的深合并+校验路径）。 */
export function mergeCellOverrides(base: RunConfig, overrides: Record<string, unknown>): RunConfig {
  const merged = buildCellConfig(
    { cellKey: 'merge', hypothesis: '', overrides: overrides as never },
    base.population.initialPopulation,
    base.schedule.totalTicks,
  );
  return merged;
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
