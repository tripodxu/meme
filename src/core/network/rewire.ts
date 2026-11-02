import { errorCodes, StratifyError } from '../control/errors.js';
import type { AgentId } from '../control/ids.js';
import type { AgentState } from '../model/agent.js';
import { clamp } from '../engine/arith.js';
import { createDraw } from '../rng/rng.js';
import { weightedSampleIndex } from '../rng/sampling.js';
import { RNG_EVENT_TAGS } from '../rng/tags.js';
import type { Seed } from '../control/ids.js';
import type { EventSequence, TickEventPayload } from '../events.js';
import type { RunConfig } from '../config/types.js';

export interface RewireOutcome {
  readonly removedNeighbor: AgentId | null;
  readonly addedNeighbor: AgentId | null;
  readonly restored: boolean;
}

/**
 * 阶段 F 网络重构（03 §6）：仅决策周期执行。
 *
 * 按 agentId 顺序，每人消费 `network_rewire/0` 判定一次；`r<rewireProb` 且有旧边
 * 才继续消费 counter 1（均匀选旧边移除）与 counter 2（加权选新候选；
 * 无新候选恢复旧边但 counter 2 已消费）。无旧边时不消费 counter 1/2。
 * 新权重 `w=exp(-H×(1-O)×|classDiff|-hV×|logValueDiff|)`。
 */
export function attemptRewire(
  config: RunConfig,
  seed: Seed,
  tick: number,
  agent: AgentState,
  agentMap: ReadonlyMap<string, AgentState>,
  openness: number,
  events: EventSequence,
): RewireOutcome {
  const draw = createDraw(seed, tick, agent.id);
  const judge = draw(RNG_EVENT_TAGS.networkRewire, 0);
  if (judge >= config.network.rewireProb) {
    return { removedNeighbor: null, addedNeighbor: null, restored: false };
  }
  if (agent.ties.length === 0) {
    return { removedNeighbor: null, addedNeighbor: null, restored: false };
  }
  // counter 1：均匀选一条旧边并暂时移除（ties 恒按 id 升序）。
  const r1 = draw(RNG_EVENT_TAGS.networkRewire, 1);
  const oldIndex = Math.floor(r1 * agent.ties.length);
  // oldIndex ∈ [0, ties.length)（r1 ∈ [0,1) 且有旧边）。
  const oldNeighbor = agent.ties[oldIndex] as AgentId;
  removeTie(agent, oldNeighbor);
  const other = agentMap.get(oldNeighbor);
  if (other === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `旧边端点缺失: ${oldNeighbor}`);
  }
  removeTie(other, agent.id);

  // counter 2：无论是否有新候选都消费（03 §4.4）。
  const r2 = draw(RNG_EVENT_TAGS.networkRewire, 2);
  const candidates = [...agentMap.values()].filter(
    (candidate) =>
      candidate.alive &&
      candidate.id !== agent.id &&
      candidate.id !== oldNeighbor &&
      !candidate.ties.includes(agent.id) &&
      candidate.ties.length < config.network.maxDegree &&
      agent.ties.length < config.network.maxDegree,
  );
  if (candidates.length === 0) {
    // 无候选恢复旧边。
    agent.ties.push(oldNeighbor);
    other.ties.push(agent.id);
    sortTies(agent);
    sortTies(other);
    emitRewire(events, agent.id, oldNeighbor, null, true);
    return { removedNeighbor: oldNeighbor, addedNeighbor: null, restored: true };
  }
  const weights = candidates.map((candidate) => rewireWeight(config, agent, candidate, openness));
  const index = weightedSampleIndex(weights, r2);
  // 候选权重全部为正且候选非空，weightedSampleIndex 必然命中。
  const chosen = candidates[index] as AgentState;
  agent.ties.push(chosen.id);
  chosen.ties.push(agent.id);
  sortTies(agent);
  sortTies(chosen);
  emitRewire(events, agent.id, oldNeighbor, chosen.id, false);
  return { removedNeighbor: oldNeighbor, addedNeighbor: chosen.id, restored: false };
}

function emitRewire(
  events: EventSequence,
  agentId: AgentId,
  removedNeighbor: AgentId | null,
  addedNeighbor: AgentId | null,
  restored: boolean,
): void {
  const event: TickEventPayload = {
    type: 'network_rewired',
    agentId,
    removedNeighbor,
    addedNeighbor,
    restored,
  };
  events.emit(event);
}

/** 重构权重（03 §6 阶段 F）；与初始化不同处在于 `(1-O)` 因子与当前 Value。 */
export function rewireWeight(
  config: RunConfig,
  self: Pick<AgentState, 'classIndex' | 'value'>,
  other: Pick<AgentState, 'classIndex' | 'value'>,
  openness: number,
): number {
  const logValueDiff = Math.abs(Math.log1p(self.value) - Math.log1p(other.value));
  return Math.exp(
    -config.network.classWeight * (1 - openness) * Math.abs(self.classIndex - other.classIndex) -
      config.network.valueWeight * logValueDiff,
  );
}

function removeTie(agent: AgentState, neighbor: AgentId): void {
  const index = agent.ties.indexOf(neighbor);
  if (index < 0) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `关系缺失: ${agent.id}-${neighbor}`);
  }
  agent.ties.splice(index, 1);
}

function sortTies(agent: AgentState): void {
  agent.ties.sort();
  void clamp;
}
