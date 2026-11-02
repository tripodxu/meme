import type { RunConfig } from '../config/types.js';
import { agentIdFromIndex, type AgentState } from '../model/agent.js';
import { compareAgentId, type Edge } from '../model/society.js';
import { allocateClassCounts } from './allocate.js';
import {
  fisherYatesShuffle,
  sampleTruncatedLognormal,
  sampleTruncatedNormal,
} from '../rng/sampling.js';
import { createDraw } from '../rng/rng.js';
import { RNG_EVENT_TAGS, RNG_INIT_TICK, RNG_POPULATION_ACTOR } from '../rng/tags.js';
import type { Seed } from '../control/ids.js';

/** 由 `(config, seed)` 派生的初始世界（03 §4.3）：按 id 升序的个体与无向边。 */
export interface InitialPopulation {
  readonly agents: AgentState[];
  /** 无向边，规范化 `a<b` 后按字典序升序。 */
  readonly ties: readonly Edge[];
  /** 同阶级初始边数（初始 S 的输入）。 */
  readonly sameClassEdgeCount: number;
}

/**
 * 初始人口、属性与年龄派生（03 §4.3 步骤 1–5、7）。
 *
 * 纯函数：相同 `(config, seed)` 在任何运行端得到相同结果；
 * 不接受外部 roster。网络初始化含在本函数内，使 `initialPopulationHash`
 * 能覆盖初始 ties。
 */
export function deriveInitialPopulation(config: RunConfig, seed: Seed): InitialPopulation {
  const classCount = config.population.classCount;
  const counts = allocateClassCounts(
    config.population.classShares,
    config.population.initialPopulation,
  );

  // 步骤 1：按 classIndex 排序的多重集合，再洗牌（步骤 2）。
  const classMultiset: number[] = [];
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    const count = counts[classIndex] ?? 0;
    for (let i = 0; i < count; i += 1) {
      classMultiset.push(classIndex);
    }
  }
  const shuffleDraw = createDraw(seed, RNG_INIT_TICK, RNG_POPULATION_ACTOR);
  const shuffled = fisherYatesShuffle(classMultiset, (counter) =>
    shuffleDraw(RNG_EVENT_TAGS.initClassShuffle, counter),
  );

  const agents: AgentState[] = shuffled.map((classIndex, index) => {
    const id = agentIdFromIndex(index);
    const attributeDraw = createDraw(seed, RNG_INIT_TICK, id);
    // 步骤 3：ge/hard/initialLife 使用独立 tag，属性之间不共享 counter。
    const ge = sampleTruncatedLognormal(config.attributes.ge, (counter) =>
      attributeDraw(RNG_EVENT_TAGS.initGe, counter),
    );
    const hard = sampleTruncatedLognormal(config.attributes.hard, (counter) =>
      attributeDraw(RNG_EVENT_TAGS.initHard, counter),
    );
    const initialLife = sampleTruncatedNormal(config.lifespan.initialLife, (counter) =>
      attributeDraw(RNG_EVENT_TAGS.initLife, counter),
    );
    // 步骤 4：两种 initialAgeMode 都消费 init_age（03 §4.2）。
    const uAge = attributeDraw(RNG_EVENT_TAGS.initAge, 0);
    const remainingLife =
      config.population.initialAgeMode === 'uniform' ? initialLife * (1 - uAge) : initialLife;
    // 步骤 5：Value=initialValue；classAge/baselineSum/belowNeedStreak=0。
    return {
      id,
      alive: true,
      classIndex,
      maxClassIndex: classIndex,
      value: config.population.initialValue,
      ge,
      hard,
      initialLife,
      remainingLife,
      classAge: 0,
      baselineSum: 0,
      belowNeedStreak: 0,
      lastAscentTick: null,
      lastDescentTick: null,
      ties: [],
      deathTick: null,
      deathReason: null,
    };
  });
  agents.sort((a, b) => compareAgentId(a.id, b.id));

  const network = buildInitialNetwork(config, seed, agents);
  return { agents, ties: network.edges, sameClassEdgeCount: network.sameClassEdgeCount };
}

/**
 * 步骤 7：初始网络（03 §4.3）。
 *
 * 按 agentId 顺序为未达目标初始度者加边，直到 `min(initialDegree, maxDegree)`
 * 或无合法候选；候选双方存活、非自身、未连边且度合法，按初始权重
 * `w=exp(-H×|classDiff|-hV×|logValueDiff|)` 抽样。初始化时所有 Value 相等，
 * `logValueDiff=0`，权重可按 |classDiff| 查表（与公式逐位一致）。
 * 每成功加一条边消费一个 `network_init` counter；候选为空则停止且不消费。
 */
interface InitialNetwork {
  readonly edges: Edge[];
  /** 同阶级边数，供初始隔离度 S 直接使用。 */
  readonly sameClassEdgeCount: number;
}

function buildInitialNetwork(config: RunConfig, seed: Seed, agents: AgentState[]): InitialNetwork {
  const maxDegree = config.network.maxDegree;
  const degreeTarget = Math.min(config.network.initialDegree, maxDegree);
  if (degreeTarget === 0 || agents.length < 2) {
    return { edges: [], sameClassEdgeCount: 0 };
  }
  const classCount = config.population.classCount;
  const weightByClassDiff = new Map<number, number>();
  for (let diff = 0; diff < classCount; diff += 1) {
    const logValueDiff = Math.abs(
      Math.log(1 + config.population.initialValue) - Math.log(1 + config.population.initialValue),
    );
    weightByClassDiff.set(
      diff,
      Math.exp(-config.network.classWeight * diff - config.network.valueWeight * logValueDiff),
    );
  }
  const neighborSets = new Map<string, Set<string>>();
  const degrees = new Map<string, number>();
  for (const agent of agents) {
    neighborSets.set(agent.id, new Set<string>());
    degrees.set(agent.id, 0);
  }
  const edges: Edge[] = [];
  let sameClassEdgeCount = 0;

  for (const agent of agents) {
    const draw = createDraw(seed, RNG_INIT_TICK, agent.id);
    let counter = 0;
    while ((degrees.get(agent.id) ?? 0) < degreeTarget) {
      // 两遍流式加权抽样：先求和，再按累计权重选择（候选按 agentId 升序）。
      let totalWeight = 0;
      for (const candidate of agents) {
        if (!isCandidate(agent, candidate, neighborSets, degrees, maxDegree)) {
          continue;
        }
        const diff = Math.abs(agent.classIndex - candidate.classIndex);
        totalWeight += weightByClassDiff.get(diff) ?? 0;
      }
      if (totalWeight <= 0) {
        break;
      }
      const r = draw(RNG_EVENT_TAGS.networkInit, counter);
      const target = r * totalWeight;
      let cumulative = 0;
      let chosen: AgentState | undefined;
      for (const candidate of agents) {
        if (!isCandidate(agent, candidate, neighborSets, degrees, maxDegree)) {
          continue;
        }
        const diff = Math.abs(agent.classIndex - candidate.classIndex);
        cumulative += weightByClassDiff.get(diff) ?? 0;
        if (target < cumulative) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === undefined) {
        break;
      }
      neighborSets.get(agent.id)?.add(chosen.id);
      neighborSets.get(chosen.id)?.add(agent.id);
      degrees.set(agent.id, (degrees.get(agent.id) ?? 0) + 1);
      degrees.set(chosen.id, (degrees.get(chosen.id) ?? 0) + 1);
      edges.push(
        agent.id < chosen.id ? { a: agent.id, b: chosen.id } : { a: chosen.id, b: agent.id },
      );
      if (agent.classIndex === chosen.classIndex) {
        sameClassEdgeCount += 1;
      }
      agent.ties.push(chosen.id);
      chosen.ties.push(agent.id);
      counter += 1;
    }
  }

  for (const agent of agents) {
    agent.ties.sort(compareAgentId);
  }
  edges.sort((x, y) => (x.a === y.a ? compareAgentId(x.b, y.b) : compareAgentId(x.a, y.a)));
  return { edges, sameClassEdgeCount };
}

function isCandidate(
  self: AgentState,
  other: AgentState,
  neighborSets: Map<string, Set<string>>,
  degrees: Map<string, number>,
  maxDegree: number,
): boolean {
  if (other.id === self.id || !other.alive) {
    return false;
  }
  if (neighborSets.get(self.id)?.has(other.id)) {
    return false;
  }
  return (degrees.get(other.id) ?? 0) < maxDegree;
}
