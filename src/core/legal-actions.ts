import type { RunConfig } from './config/types.js';
import { errorCodes, StratifyError } from './control/errors.js';
import type { AgentId } from './control/ids.js';
import { HASH_DOMAINS } from './hash/domains.js';
import { hashValue } from './hash/hash.js';
import type { AgentState } from './model/agent.js';
import type { SimState } from './model/state.js';
import { createDraw } from './rng/rng.js';
import { RNG_EVENT_TAGS } from './rng/tags.js';
import { uniformIndex } from './rng/sampling.js';

/** 行动类型固定顺序（03 §5）：同时决定请求顺序、actionSetHash、mock 抽样与 topK 并列。 */
export const ACTION_TYPE_ORDER = ['accumulate', 'ascend', 'descend', 'compete'] as const;
export type ActionType = (typeof ACTION_TYPE_ORDER)[number];

/** 合法行动键：`accumulate | ascend | descend | compete:<agentId>`。 */
export type ActionKey = string;

/** 单个到期个体的合法行动集合与净额费用（04 §3.2：costs 为实际应付净额）。 */
export interface LegalActionSet {
  /** 按 `accumulate<ascend<descend<compete`、同类内 agentId 升序排列。 */
  readonly actions: readonly ActionKey[];
  /** 上升净额；仅最高层结构不可用时为 null（费用不足只影响合法性，不影响净额）。 */
  readonly ascendCost: number | null;
  /** 主动降阶净额；仅最低层结构不可用时为 null。 */
  readonly descendCost: number | null;
  /** compete 目标（生成顺序），与 actions 中的 compete 键一一对应。 */
  readonly targets: readonly AgentId[];
}

/** 上升费用（03 §6 阶段 B）：`crossBase×(1-discount)×openMultiplier`，均为正。 */
export function computeAscendCost(
  config: RunConfig,
  agent: Pick<AgentState, 'classIndex' | 'maxClassIndex'>,
  eByClass: readonly number[],
  openness: number,
): number | null {
  const nextClass = agent.classIndex + 1;
  if (nextClass >= config.population.classCount) {
    return null;
  }
  const d = agent.maxClassIndex - agent.classIndex;
  // d=1/2/>=3 分别读取 returnDiscount[0]/[1]/[2]；配置校验保证长度为 3。
  const discount =
    d === 0
      ? 0
      : d === 1
        ? (config.ascent.returnDiscount[0] ?? 0)
        : d === 2
          ? (config.ascent.returnDiscount[1] ?? 0)
          : (config.ascent.returnDiscount[2] ?? 0);
  // crossDays 长度为 C-1，classIndex<C-1 时必有值；E 由状态保证长度 C。
  const crossBase =
    (config.ascent.crossDays[agent.classIndex] ?? 0) *
    config.opportunity.dailyBase *
    (eByClass[nextClass] ?? 0);
  const openMultiplier = clamp(
    Math.exp(config.openness.ascentCostWeight * (0.5 - openness)),
    config.openness.multiplierMin,
    config.openness.multiplierMax,
  );
  return crossBase * (1 - discount) * openMultiplier;
}

/** 主动降阶费用：`descendDays×B×E[t,current]`；最低层不合法。 */
export function computeDescendCost(
  config: RunConfig,
  agent: Pick<AgentState, 'classIndex'>,
  eByClass: readonly number[],
): number | null {
  if (agent.classIndex === 0) {
    return null;
  }
  return config.descent.days * config.opportunity.dailyBase * (eByClass[agent.classIndex] ?? 0);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 阶段 A 的合法行动枚举（03 §5）。
 *
 * 竞争目标：槽位 k 先消费来源地址（`2k`，按 `localTargetProbability` 选邻居/全局），
 * 再消费目标地址（`2k+1`）从该来源的剩余合法目标中均匀抽样；来源为空则用目标地址
 * 在另一来源抽样；选满 `candidateCount` 个或全局无剩余目标即停止，不为空槽继续消费。
 * 去重即无放回，不做重复拒绝抽样。
 */
export function enumerateLegalActions(state: SimState, agentId: AgentId): LegalActionSet {
  const config = state.config;
  const agent = state.society.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined || !agent.alive) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `到期个体不存在或已死亡: ${agentId}`);
  }
  const eByClass = state.society.eByClass;
  const ascendCost = computeAscendCost(config, agent, eByClass, state.society.openness);
  const descendCost = computeDescendCost(config, agent, eByClass);
  const canAscend = ascendCost !== null && agent.value >= ascendCost;
  const canDescend = descendCost !== null && agent.value >= descendCost;

  const targets = sampleCompetitionTargets(state, agent);
  const actions: string[] = ['accumulate'];
  if (canAscend) {
    actions.push('ascend');
  }
  if (canDescend) {
    actions.push('descend');
  }
  for (const target of targets) {
    actions.push(`compete:${target}`);
  }
  return {
    actions,
    ascendCost,
    descendCost,
    targets,
  };
}

function sampleCompetitionTargets(state: SimState, agent: AgentState): AgentId[] {
  const config = state.config;
  const candidateCount = config.competition.candidateCount;
  if (candidateCount === 0) {
    return [];
  }
  const alive = state.society.agents.filter((candidate) => candidate.alive);
  const neighborSet = new Set<string>(agent.ties);
  const selected: AgentId[] = [];
  const selectedSet = new Set<string>();
  const draw = createDraw(state.seed, state.society.tick, agent.id);
  const isLegalTarget = (candidate: AgentState): boolean =>
    candidate.alive && candidate.id !== agent.id && !selectedSet.has(candidate.id);

  for (let slot = 0; slot < candidateCount; slot += 1) {
    const globalRemaining = alive.filter((candidate) => isLegalTarget(candidate));
    if (globalRemaining.length === 0) {
      break;
    }
    const sourceDraw = draw(RNG_EVENT_TAGS.competitionCandidate, 2 * slot);
    const preferLocal = sourceDraw < config.competition.localTargetProbability;
    const neighborPool = preferLocal
      ? globalRemaining.filter((candidate) => neighborSet.has(candidate.id))
      : globalRemaining;
    const pool = neighborPool.length > 0 ? neighborPool : globalRemaining;
    const targetDraw = draw(RNG_EVENT_TAGS.competitionCandidate, 2 * slot + 1);
    const index = uniformIndex(targetDraw, pool.length);
    // uniformIndex 保证 index ∈ [0, pool.length)，pool.length>0 已在上方确认。
    const chosen = pool[index] as AgentState;
    selected.push(chosen.id);
    selectedSet.add(chosen.id);
  }
  // 目标键按 agentId 升序排列（03 §5：同类内按 UTF-8 字节序）。
  return [...selected].sort();
}

/** `actionSetHash`（02 §8）：覆盖按请求顺序排列的 legalActions 字符串数组。 */
export function computeActionSetHash(actions: readonly string[]): string {
  return hashValue(HASH_DOMAINS.actionSet, [...actions]);
}

/** 竞争行动键 → 目标 id；只接受 `compete:<agentId>` 精确形态（04 §4）。 */
export function parseActionKey(key: ActionKey): { type: ActionType; target: AgentId | null } {
  if (key === 'accumulate' || key === 'ascend' || key === 'descend') {
    return { type: key, target: null };
  }
  if (key.startsWith('compete:')) {
    const target = key.slice('compete:'.length) as AgentId;
    if (target.length === 0 || key !== `compete:${target}`) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `非法竞争行动键: ${key}`);
    }
    return { type: 'compete', target };
  }
  throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `未知行动键: ${key}`);
}
