import type { RunConfig } from '../config/types.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import type { AgentState } from '../model/agent.js';
import { computeGini, computeSegregation } from './metrics.js';
import { median } from '../engine/settlement.js';
import type { FlowWindowEntry } from '../model/society.js';

/**
 * 阶段 G 的完整 tick 指标行（05 §4.3 基础字段 + metrics-v1 扩展）。
 * `payloadHash` 由上报层（runner）计算，不在核心行内。
 */
export interface TickStats {
  readonly tick: number;
  readonly aliveCount: number;
  readonly classCounts: readonly number[];
  readonly gini: number;
  readonly medianValue: number;
  readonly topWealthShare: number;
  readonly mUp: number;
  readonly mDown: number;
  readonly segregation: number;
  readonly edgeCount: number;
  readonly openness: number;
  readonly deathCount: number;
  readonly competitionLoss: number;
  readonly competitionGain: number;
  /** 回退决策数/非 cancelled 到期决策数；无到期决策为 null（07 §5）。 */
  readonly fallbackRate: number | null;
  readonly eByClass: readonly number[];
  readonly crossClassEdgeShare: number;
  readonly avgDegree: number;
  readonly connectedComponents: number;
  /** `metrics.flowWindowDays` 窗口累计转移矩阵。 */
  readonly flowMatrix: readonly (readonly number[])[];
}

export interface StageGInput {
  readonly config: RunConfig;
  readonly tick: number;
  readonly agents: readonly AgentState[];
  readonly openness: number;
  readonly eByClass: readonly number[];
  readonly flowWindow: readonly FlowWindowEntry[];
  readonly deathCount: number;
  readonly competitionLoss: number;
  readonly competitionGain: number;
  readonly fallbackRate: number | null;
}

/** 存活者阶级计数。 */
export function aliveClassCounts(agents: readonly AgentState[], classCount: number): number[] {
  const counts = new Array<number>(classCount).fill(0);
  for (const agent of agents) {
    if (agent.alive) {
      const slot = agent.classIndex as number;
      counts[slot] = (counts[slot] as number) + 1;
    }
  }
  return counts;
}

/** 存活无向边数与同层/跨层边数；O(E)（避免 O(N²) 防护要求退化）。 */
export function edgeStatistics(agents: readonly AgentState[]): {
  edgeCount: number;
  sameClassEdges: number;
} {
  let edgeCount = 0;
  let sameClassEdges = 0;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const seen = new Set<string>();
  for (const agent of agents) {
    if (!agent.alive) {
      continue;
    }
    for (const neighbor of agent.ties) {
      const key = agent.id < neighbor ? `${agent.id}|${neighbor}` : `${neighbor}|${agent.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const other = byId.get(neighbor);
      if (other === undefined || !other.alive) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `边端点缺失或已死亡: ${agent.id}-${neighbor}`,
        );
      }
      edgeCount += 1;
      if (other.classIndex === agent.classIndex) {
        sameClassEdges += 1;
      }
    }
  }
  return { edgeCount, sameClassEdges };
}

/** `metrics.topWealthShareFraction` 财富占比（03 §6 阶段 G）。 */
export function topWealthShare(values: readonly number[], fraction: number): number {
  const n = values.length;
  if (n === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (sum === 0) {
    return 0;
  }
  const topCount = Math.ceil(fraction * n);
  const sorted = [...values].sort((a, b) => b - a);
  let topSum = 0;
  for (let index = 0; index < topCount; index += 1) {
    topSum += sorted[index] as number;
  }
  return topSum / sum;
}

/** 存活网络的连通分量数（无向）；O(N+E)。 */
export function connectedComponents(agents: readonly AgentState[]): number {
  const alive = agents.filter((agent) => agent.alive);
  const byId = new Map(alive.map((agent) => [agent.id, agent]));
  const visited = new Set<string>();
  let components = 0;
  for (const agent of alive) {
    if (visited.has(agent.id)) {
      continue;
    }
    components += 1;
    const stack = [agent.id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const node = byId.get(current);
      if (node === undefined) {
        continue;
      }
      for (const neighbor of node.ties) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
  }
  return components;
}

/** 滚动窗口转移矩阵求和。 */
export function sumFlowWindow(
  flowWindow: readonly FlowWindowEntry[],
  classCount: number,
): number[][] {
  const matrix = Array.from({ length: classCount }, () => new Array<number>(classCount).fill(0));
  for (const entry of flowWindow) {
    for (let from = 0; from < classCount; from += 1) {
      for (let to = 0; to < classCount; to += 1) {
        // 解码与生产路径都保证 C×C 矩阵形状。
        const cell = (entry.counts[from] as readonly number[])[to] as number;
        const row = matrix[from] as number[];
        row[to] = (row[to] as number) + cell;
      }
    }
  }
  return matrix;
}

/** 阶段 G：在行动、死亡和网络完成后计算（03 §6）。 */
export function computeTickStats(input: StageGInput): TickStats {
  const { config, tick, agents, openness, eByClass } = input;
  const classCount = config.population.classCount;
  const alive = agents.filter((agent) => agent.alive);
  const aliveCount = alive.length;
  const classCounts = aliveClassCounts(agents, classCount);
  const values = alive.map((agent) => agent.value);
  const gini = computeGini(values);
  const { edgeCount, sameClassEdges } = edgeStatistics(agents);
  const segregation = computeSegregation(sameClassEdges, edgeCount, classCounts);
  const mUp = mobilityRate(alive, 'lastAscentTick', tick, config.metrics.mobilityWindowDays);
  const mDown = mobilityRate(alive, 'lastDescentTick', tick, config.metrics.mobilityWindowDays);
  return {
    tick,
    aliveCount,
    classCounts,
    gini,
    medianValue: aliveCount === 0 ? 0 : median(values),
    topWealthShare: topWealthShare(values, config.metrics.topWealthShareFraction),
    mUp,
    mDown,
    segregation,
    edgeCount,
    openness,
    deathCount: input.deathCount,
    competitionLoss: input.competitionLoss,
    competitionGain: input.competitionGain,
    fallbackRate: input.fallbackRate,
    eByClass: [...eByClass],
    crossClassEdgeShare: edgeCount === 0 ? 0 : (edgeCount - sameClassEdges) / edgeCount,
    avgDegree: aliveCount === 0 ? 0 : (2 * edgeCount) / aliveCount,
    connectedComponents: connectedComponents(agents),
    flowMatrix: sumFlowWindow(input.flowWindow, classCount),
  };
}

/** 365 日（metrics.mobilityWindowDays）流动参与率；只统计存活者（03 §6 阶段 G）。 */
export function mobilityRate(
  alive: readonly AgentState[],
  field: 'lastAscentTick' | 'lastDescentTick',
  tick: number,
  windowDays: number,
): number {
  if (alive.length === 0) {
    return 0;
  }
  const lowerBound = tick - windowDays + 1;
  let count = 0;
  for (const agent of alive) {
    const lastTick = agent[field];
    if (lastTick !== null && lastTick >= lowerBound) {
      count += 1;
    }
  }
  return count / alive.length;
}
