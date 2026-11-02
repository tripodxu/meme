import { computeConfigHash, computeParamsHash } from '../config/hash.js';
import type { RunConfig } from '../config/types.js';
import { validateRunConfig } from '../config/validate.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import { asSeed, type Seed } from '../control/ids.js';
import { STATE_SCHEMA_VERSION } from '../control/versions.js';
import { computeGini, computeSegregation } from '../macros/metrics.js';
import type { SocietyState } from '../model/society.js';
import type { SimState } from '../model/state.js';
import { deriveInitialPopulation } from './population.js';

/**
 * 创建权威初始状态（02 §4）。
 *
 * 初始人口、初始网络与初始年龄全部由 `(config, seed)` 纯函数派生；
 * `seed` 不进入 `configHash/paramsHash`。初始宏观值在网络完成后计算，
 * 保证 `S/edgeCount` 与初始网络一致（03 §4.3 步骤 6–7 的实现澄清）。
 */
export function createSimulation(config: RunConfig, seed: Seed): SimState {
  const result = validateRunConfig(config);
  if (!result.ok) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, '配置未通过校验', result.issues);
  }
  const validConfig = result.config;
  const validSeed = asSeed(seed);
  const population = deriveInitialPopulation(validConfig, validSeed);

  const classCount = validConfig.population.classCount;
  const aliveClassCounts = new Array<number>(classCount).fill(0);
  for (const agent of population.agents) {
    aliveClassCounts[agent.classIndex] = (aliveClassCounts[agent.classIndex] ?? 0) + 1;
  }
  // 配置校验保证 initialPopulation>=2，total 恒 >0。
  const total = population.agents.length;
  const initialClassShares = aliveClassCounts.map((count) => count / total);

  const sameClassEdges = population.sameClassEdgeCount;
  const society: SocietyState = {
    tick: 0,
    agents: population.agents,
    eByClass: [...validConfig.opportunity.env0],
    openness: validConfig.openness.initial,
    initialClassShares,
    gini: computeGini(population.agents.map((agent) => agent.value)),
    segregation: computeSegregation(sameClassEdges, population.ties.length, aliveClassCounts),
    mUp: 0,
    mDown: 0,
    edgeCount: population.ties.length,
    flowWindow: [],
    lastOpennessUpdateTick: 0,
  };
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    config: validConfig,
    configHash: computeConfigHash(validConfig),
    paramsHash: computeParamsHash(validConfig),
    seed: validSeed,
    society,
  };
}
