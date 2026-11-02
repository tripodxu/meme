import type { Seed } from '../control/ids.js';
import { HASH_DOMAINS } from './domains.js';
import { hashValue } from './hash.js';
import { encodeSimState } from '../model/serialize.js';
import type { SimState } from '../model/state.js';
import type { InitialPopulation } from '../init/population.js';

/**
 * `initialPopulationHash`（02 §8）：覆盖按 id 排序的初始 agents（网络字段为空，
 * 边统一进入 `ties`）、初始 ties 与 `seed`。
 */
export function computeInitialPopulationHash(seed: Seed, population: InitialPopulation): string {
  return hashValue(HASH_DOMAINS.initialPopulation, {
    seed,
    agents: population.agents.map((agent) => ({
      id: agent.id,
      alive: agent.alive,
      classIndex: agent.classIndex,
      maxClassIndex: agent.maxClassIndex,
      value: agent.value,
      ge: agent.ge,
      hard: agent.hard,
      initialLife: agent.initialLife,
      remainingLife: agent.remainingLife,
      classAge: agent.classAge,
      baselineSum: agent.baselineSum,
      belowNeedStreak: agent.belowNeedStreak,
      lastAscentTick: agent.lastAscentTick,
      lastDescentTick: agent.lastDescentTick,
      deathTick: agent.deathTick,
      deathReason: agent.deathReason,
    })),
    ties: population.ties.map((edge) => [edge.a, edge.b]),
  });
}

/**
 * `finalStateHash`（02 §8）：覆盖权威快照的完整 canonical 序列化，
 * 排除日志、缓存与 wall-clock（权威状态本身不含这些字段）。
 */
export function computeAuthoritativeStateHash(state: SimState): string {
  return hashValue(HASH_DOMAINS.authoritativeState, encodeSimState(state));
}
