import type { RunConfig } from './config/types.js';
import { errorCodes, StratifyError } from './control/errors.js';
import { AGENT_ID_PATTERN, type AgentId } from './control/ids.js';
import { HASH_DOMAINS } from './hash/domains.js';
import { hashValue } from './hash/hash.js';
import { agentIndexFromId, type AgentState } from './model/agent.js';
import type { SimState } from './model/state.js';
import { clamp } from './engine/arith.js';
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

/**
 * 上升费用（03 §6 阶段 B）：`crossBase×(1-discount)×openMultiplier`，均为正。
 * 需求参照系（rules-v6）：`class` 模式 `crossBase = crossDays[c]×refIncome[c+1]`
 *（目的地阶级参照收入）；`own` 模式保持 v5 旧式 `crossDays[c]×B×E[c+1]` 逐位一致（G-D）。
 */
export function computeAscendCost(
  config: RunConfig,
  agent: Pick<AgentState, 'classIndex' | 'maxClassIndex'>,
  eByClass: readonly number[],
  openness: number,
  refIncome: readonly number[],
): number | null {
  const nextClass = agent.classIndex + 1;
  if (nextClass >= config.population.classCount) {
    return null;
  }
  const d = agent.maxClassIndex - agent.classIndex;
  // d=1/2/>=3 分别读取 returnDiscount[0]/[1]/[2]；配置校验保证长度为 3。
  // returnDiscount 长度恒为 3（配置校验）；d=1/2/>=3 分别读取 [0]/[1]/[2]。
  const discounts = config.ascent.returnDiscount as readonly number[];
  const discount =
    d === 0
      ? 0
      : d === 1
        ? (discounts[0] as number)
        : d === 2
          ? (discounts[1] as number)
          : (discounts[2] as number);
  // crossDays 长度为 C-1，classIndex<C-1 时必有值；E/refIncome 由状态保证长度 C。
  let crossBase: number;
  if (config.need.referenceMode === 'class') {
    const refNext = refIncome[nextClass];
    if (refNext === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `refIncome 缺少阶级 ${nextClass}`);
    }
    crossBase = (config.ascent.crossDays[agent.classIndex] as number) * refNext;
  } else {
    crossBase =
      (config.ascent.crossDays[agent.classIndex] as number) *
      config.opportunity.dailyBase *
      (eByClass[nextClass] as number);
  }
  const openMultiplier = clamp(
    Math.exp(config.openness.ascentCostWeight * (0.5 - openness)),
    config.openness.multiplierMin,
    config.openness.multiplierMax,
  );
  return crossBase * (1 - discount) * openMultiplier;
}

/**
 * 持有裕度门槛（rule.md 9 / changes/0005、0009）：上升要求支付 cross 后仍保有
 * `ρ × 参照量[target] × ψ_eff[target]` 的余额；裕度不支付、只作余额门槛。
 * 参照量随 `need.referenceMode` 分派（rules-v7 完成需求参照系统一计价）：
 * - `'class'`：`ρ×refIncome[target]×ψ_eff[target]`——裕度与持有标尺同参照系，
 *   新升阶者支付后余额恰为 `ρ/bufferDays × need`（ρ=bufferDays=30 时 = need），
 *   不再天然高于需求线，跌落通道恢复（changes/0008 §6 尺度错位修断）；
 * - `'own'`：`ρ×B×E[t,target]×ψ_eff[target]`，与 v5 逐位一致（G-D 硬门禁）。
 * `ρ=0` 时裕度为 0，与 v4 逐位一致。
 */
export function computeAscendCushion(
  config: RunConfig,
  targetClassIndex: number,
  eByClass: readonly number[],
  refIncome: readonly number[],
): number {
  const rho = config.ascent.holdingCushionDays;
  if (rho === 0) {
    return 0;
  }
  const psi = config.need.needMultiplier[targetClassIndex];
  if (psi === undefined) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `needMultiplier 缺少阶级 ${targetClassIndex}`,
    );
  }
  const phi = config.need.envExponent;
  let envMultiplier = 1;
  if (phi !== 0) {
    const own = config.opportunity.env0[targetClassIndex];
    const bottom = config.opportunity.env0[0];
    if (own === undefined || bottom === undefined || !(bottom > 0)) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'env0 非法');
    }
    envMultiplier = Math.pow(own / bottom, phi);
  }
  let cushion: number;
  if (config.need.referenceMode === 'class') {
    const ref = refIncome[targetClassIndex];
    if (ref === undefined) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        `refIncome 缺少阶级 ${targetClassIndex}`,
      );
    }
    cushion = rho * ref * psi * envMultiplier;
  } else {
    const env = eByClass[targetClassIndex];
    if (env === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `E 缺少阶级 ${targetClassIndex}`);
    }
    cushion = rho * config.opportunity.dailyBase * env * psi * envMultiplier;
  }
  if (!Number.isFinite(cushion)) {
    // 裕度参与 `value >= cost + cushion` 判定；NaN 会让枚举与复核两侧
    // 对「是否可上升」给出相反答案，必须立即停止而不是静默放行。
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `持有裕度非有限: ${String(cushion)}`);
  }
  return cushion;
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
  return (
    config.descent.days * config.opportunity.dailyBase * (eByClass[agent.classIndex] as number)
  );
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
  // agents 恒按 id 升序且 id 为顺序分配，用序号 O(1) 定位（O(N²) 防护）。
  const index = agentIndexFromId(agentId);
  const agent = state.society.agents[index];
  if (agent === undefined || agent.id !== agentId || !agent.alive) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `到期个体不存在或已死亡: ${agentId}`);
  }
  const eByClass = state.society.eByClass;
  const ascendCost = computeAscendCost(
    config,
    agent,
    eByClass,
    state.society.openness,
    state.society.refIncome,
  );
  const descendCost = computeDescendCost(config, agent, eByClass);
  const canAscend =
    ascendCost !== null &&
    agent.value >=
      ascendCost +
        computeAscendCushion(config, agent.classIndex + 1, eByClass, state.society.refIncome);
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
    const target = key.slice('compete:'.length);
    // 必须校验目标 id 的真实格式：`target` 由 key 切片而来，
    // 旧写法 `key !== \`compete:${target}\`` 是恒真式，让 `compete: a-0001`
    //（前导空格）和 `compete:../x` 之类非法键直接进入执行端。
    if (!AGENT_ID_PATTERN.test(target)) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `非法竞争行动键: ${key}`);
    }
    return { type: 'compete', target: target as AgentId };
  }
  throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `未知行动键: ${key}`);
}
