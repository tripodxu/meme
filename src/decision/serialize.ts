import type { RunConfig } from '../core/config/types.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { AgentId } from '../core/control/ids.js';
import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import { hashValue } from '../core/hash/hash.js';
import type { TickEvent } from '../core/events.js';
import type { SimState } from '../core/model/state.js';
import type { LegalActionSet } from '../core/legal-actions.js';
import {
  classShareSnapshot,
  computeAscendCost,
  computeDescendCost,
} from '../core/legal-actions.js';
import { computeNeedClass, computeNeedOwn } from '../core/engine/settlement.js';
import { POLICY_VERSION_MOCK } from './mock.js';

/**
 * P2-02：决策 state 序列化（04 §3）。
 *
 * - 紧凑英文 JSON；字段集合固定，键构造顺序固定（prompt 稳定性）；
 * - `stateHash` 按 02 §8 对同一对象做 JCS 排序后计算（与构造顺序分离）；
 * - 字段增删或含义变化必须升级 `promptVersion`；
 * - `needRatio` 唯一定义 `need===0 ? null : Value/need`；
 * - `costs.ascend/descend` 为实际应付净额，不可用层为 null 且该行动不进入 legalActions。
 */

// prompt-v3：修正 classPopulationShares 语义（决策时点存活份额，而非初始份额）。
export const PROMPT_VERSION = 'prompt-v3';

/** 04 §3.2 固定构造顺序的决策 state。 */
export interface DecisionState {
  readonly schema: 'stratify-decision-v1';
  readonly tick: number;
  readonly decisionIntervalDays: number;
  readonly self: {
    readonly id: string;
    readonly classIndex: number;
    readonly highestClassEver: number;
    readonly value: number;
    readonly talent: number;
    readonly effort: number;
    readonly remainingLifeDays: number;
    readonly daysInClass: number;
    readonly needRatio: number | null;
    readonly belowNeedDays: number;
    readonly neighborCount: number;
  };
  readonly society: {
    readonly openness: number;
    readonly gini: number;
    readonly classPopulationShares: number[];
  };
  readonly costs: {
    readonly ascend: number | null;
    readonly descend: number | null;
  };
  readonly targets: readonly {
    readonly id: string;
    readonly classIndex: number;
    readonly value: number;
    readonly isNeighbor: boolean;
  }[];
  readonly recentEvents: readonly {
    readonly tick: number;
    readonly type: string;
    readonly actorId: string;
    readonly targetId: string | null;
    readonly deltaValue: number | null;
    readonly fromClass: number | null;
    readonly toClass: number | null;
  }[];
}

/** `stateHash`（02 §8）：对 04 §3.2 的完整 state 对象做 JCS 哈希。 */
export function computeDecisionStateHash(state: DecisionState): string {
  return hashValue(HASH_DOMAINS.decisionState, state);
}

/** 最近事件压缩为 04 §3.2 的固定字段（最多 5 条，按 (tick,seq)）。 */
export function compressRecentEvents(
  events: readonly TickEvent[],
  count = 5,
): DecisionState['recentEvents'] {
  const relevant = events
    .filter(
      (event): event is TickEvent & { agentId?: string; tick: number; type: string } =>
        event.type === 'wealth_changed' ||
        event.type === 'class_ascended' ||
        event.type === 'class_descended' ||
        event.type === 'competition_resolved',
    )
    .sort((a, b) => a.tick - b.tick || a.seq - b.seq)
    .slice(-count);
  return relevant.map((event) => {
    switch (event.type) {
      case 'wealth_changed':
        return {
          tick: event.tick,
          type: event.type,
          actorId: event.agentId,
          targetId: event.referenceId,
          deltaValue: event.delta,
          fromClass: null,
          toClass: null,
        };
      case 'class_ascended':
      case 'class_descended':
        return {
          tick: event.tick,
          type: event.type,
          actorId: event.agentId,
          targetId: null,
          deltaValue: event.type === 'class_descended' && event.cost !== null ? -event.cost : null,
          fromClass: event.from,
          toClass: event.to,
        };
      case 'competition_resolved':
        return {
          tick: event.tick,
          type: event.type,
          actorId: event.initiatorId,
          targetId: event.targetId,
          deltaValue: event.gain - event.loss,
          fromClass: null,
          toClass: null,
        };
      default:
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `不可压缩的事件类型: ${event.type}`);
    }
  });
}

/**
 * 构建到期个体的完整决策 state（04 §3.2）。
 * 字段构造顺序固定；数值均附单位语义（比率 [0,1]、寿命与 classAge 用 days）。
 */
export function buildDecisionState(
  state: SimState,
  agentId: AgentId,
  legal: LegalActionSet,
  recentEvents: readonly TickEvent[],
): DecisionState {
  const config = state.config;
  const agent = state.society.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined || !agent.alive) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `决策个体不存在或已死亡: ${agentId}`);
  }
  // 需求参照系分派（rules-v6）：与引擎同口径；'own' 与 v5 逐位一致。
  let need: number;
  if (config.need.referenceMode === 'class') {
    const refC = state.society.refIncome[agent.classIndex];
    if (refC === undefined) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        `refIncome 缺少阶级 ${agent.classIndex}`,
      );
    }
    need = computeNeedClass(config, refC, agent.classIndex);
  } else {
    need = computeNeedOwn(config, agent.classAge, agent.baselineSum, agent.classIndex);
  }
  const needRatio = need === 0 ? null : agent.value / need;
  if (needRatio !== null && !Number.isFinite(needRatio)) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `needRatio 非有限: ${String(needRatio)}`,
    );
  }
  const ascendCost =
    legal.ascendCost ??
    computeAscendCost(
      config,
      agent,
      state.society.eByClass,
      state.society.openness,
      state.society.refIncome,
    );
  const descendCost =
    legal.descendCost ?? computeDescendCost(config, agent, state.society.eByClass);
  const neighborSet = new Set<string>(agent.ties);
  const aliveById = new Map(state.society.agents.map((candidate) => [candidate.id, candidate]));
  const targets = legal.targets.map((target) => {
    const targetAgent = aliveById.get(target);
    if (targetAgent === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `目标不存在: ${target}`);
    }
    return {
      id: target,
      classIndex: targetAgent.classIndex,
      value: targetAgent.value,
      isNeighbor: neighborSet.has(target),
    };
  });
  const decisionState: DecisionState = {
    schema: DECISION_SCHEMA_VERSION,
    tick: state.society.tick,
    decisionIntervalDays: config.decision.interval,
    self: {
      id: agent.id,
      classIndex: agent.classIndex,
      highestClassEver: agent.maxClassIndex,
      value: agent.value,
      talent: agent.ge,
      effort: agent.hard,
      remainingLifeDays: agent.remainingLife,
      daysInClass: agent.classAge,
      needRatio,
      belowNeedDays: agent.belowNeedStreak,
      neighborCount: agent.ties.length,
    },
    society: {
      openness: state.society.openness,
      gini: state.society.gini,
      // 04 §3.2 的 classPopulationShares 是决策时点存活人口的 P[c]，不是初始份额。
      classPopulationShares: classShareSnapshot(state.society.agents, config.population.classCount),
    },
    costs: {
      ascend: ascendCost,
      descend: descendCost,
    },
    targets,
    recentEvents: compressRecentEvents(recentEvents),
  };
  return decisionState;
}

/**
 * 04 §3.3 的 action criteria 描述（由当前 config 生成，不写死）。
 * 事实句由 `baseTransferEfficiency×directionMultiplier` 决定：等于 1 时守恒，<1 时损耗。
 */
export function buildActionCriteria(
  config: RunConfig,
  state: DecisionState,
): Record<string, string> {
  const criteria: Record<string, string> = {
    accumulate: 'Take no active class or competition action; receive normal daily accumulation.',
  };
  if (state.costs.ascend !== null) {
    criteria['ascend'] =
      `Pay ${state.costs.ascend} value to move one class upward if still affordable.`;
  }
  if (state.costs.descend !== null) {
    criteria['descend'] =
      `Pay ${state.costs.descend} value to move one class downward and reset class tenure.`;
  }
  const maxMultiplier = Math.max(
    1,
    config.competition.highToLowWinMultiplier,
    config.competition.lowToHighWinMultiplier,
  );
  const destroys = config.competition.baseTransferEfficiency * maxMultiplier < 1;
  for (const target of state.targets) {
    criteria[`compete:${target.id}`] =
      `Compete with agent ${target.id} in class ${target.classIndex} with current value ${target.value}; the engine determines the result and wealth ${destroys ? 'loss' : 'is conserved'}.`;
  }
  return criteria;
}

/** 04 §3.3 的 instructions（promptStyle 为实验处理变量，进入 promptVersion 语义）。 */
export function buildInstructions(
  config: RunConfig,
  promptStyle: 'neutral' | 'survival_hint',
): string {
  const maxMultiplier = Math.max(
    1,
    config.competition.highToLowWinMultiplier,
    config.competition.lowToHighWinMultiplier,
  );
  const destroys = config.competition.baseTransferEfficiency * maxMultiplier < 1;
  const facts = destroys
    ? 'competition moves value between agents and may destroy part of the transferred value; the engine determines the result.'
    : 'competition moves value between agents with total wealth conserved; the engine determines the result.';
  const base = `Choose exactly one action for this agent for the next decision cycle. Use only the supplied state; do not calculate outcomes. Facts: ${facts}`;
  if (promptStyle === 'neutral') {
    return base + '.';
  }
  return (
    base +
    ' Prefer actions that support long-term survival and sustainable mobility for this agent.'
  );
}

/** mock 策略的 policyVersion 常量转出口（04 §2.1：policyVersion 纳入 run identity）。 */
export { POLICY_VERSION_MOCK };
