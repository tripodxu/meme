import type { RunConfig } from '../config/types.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import type { AgentId, Seed } from '../control/ids.js';
import { compareAgentId, type FlowWindowEntry } from '../model/society.js';
import type { SimState } from '../model/state.js';
import { createDraw } from '../rng/rng.js';
import { RNG_EVENT_TAGS } from '../rng/tags.js';
import { EventSequence, type TickEvent } from '../events.js';
import type { ExecutionRecord } from '../../decision/types.js';
import { parseActionKey } from '../legal-actions.js';
import { attemptRewire } from '../network/rewire.js';
import { computeTickStats, type TickStats } from '../macros/tick-metrics.js';
import { maybeUpdateOpenness, updateClassEnvironment } from '../feedback/slow-variables.js';
import {
  computeAscendCost,
  computeAscendCushion,
  computeDescendCost,
  sampleDisplacementTarget,
} from '../legal-actions.js';
import {
  computeNeedClass,
  computeNeedOwn,
  computeOpportunityFromMedians,
  effortFunction,
  lifeLoss,
  logPower,
  median,
  resolveCompetition,
} from './settlement.js';

/** 本 tick 的单个体决策；重放只使用 `selectedAction`（04 §9.2）。 */
export interface StepDecision {
  readonly selectedAction: string;
  /** 决策层回退标记；用于 stats 的 fallbackRate（07 §5），cancelled 不计入分母的口径由调用方保证。 */
  readonly isFallback?: boolean;
}

export type StepDecisions = ReadonlyMap<AgentId, StepDecision>;

export interface StepContext {
  /** 事件与执行记录的 runId；由运行端注入，核心不做任何校验。 */
  readonly runId: string;
}

export type EndReason = 'scheduled' | 'extinct';

export interface StepResult {
  /** 完成该 tick 后的权威状态；输入 state 不被修改（02 §4）。 */
  readonly state: SimState;
  readonly events: readonly TickEvent[];
  readonly executions: readonly ExecutionRecord[];
  readonly stats: TickStats;
  /** 本 tick 结算后全死亡时给出结束原因（早于最后计划 tick 为 extinct）。 */
  readonly endReason: EndReason | null;
}

interface WorkingAgent {
  readonly id: AgentId;
  alive: boolean;
  classIndex: number;
  maxClassIndex: number;
  value: number;
  readonly ge: number;
  readonly hard: number;
  readonly initialLife: number;
  remainingLife: number;
  classAge: number;
  baselineSum: number;
  belowNeedStreak: number;
  lastAscentTick: number | null;
  lastDescentTick: number | null;
  ties: AgentId[];
  deathTick: number | null;
  deathReason: 'age' | null;
}

interface TickAccumulator {
  competitionLoss: number;
  competitionGain: number;
}

/**
 * 单 tick 唯一结算管线（03 §6）：
 * A 期初快照与决策（合法行动枚举/序列化由调用方完成）→ B 主动行动 →
 * C 日常积累与需求 → D 被动跌落 → E 寿命与死亡 → F 网络重构 →
 * G 宏观指标 → H 慢变量更新。
 * 输入 state 不被修改；同 tick 不得用新 E/O 回头重算。
 */
export function step(state: SimState, decisions: StepDecisions, context: StepContext): StepResult {
  const config = state.config;
  const tick = state.society.tick;
  const classCount = config.population.classCount;
  if (tick >= config.schedule.totalTicks) {
    throw new StratifyError(
      errorCodes.INVARIANT_VIOLATED,
      `tick ${tick} 已超出计划 (${config.schedule.totalTicks})`,
    );
  }
  if (state.society.agents.every((agent) => !agent.alive)) {
    // 全死亡是终态（03 §1）：extinct/scheduled 完成后继续 step 必须报明确终态错误。
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'run 已因全死亡结束，不能再 step');
  }
  const events = new EventSequence(context.runId, tick);
  const executions: ExecutionRecord[] = [];
  const accumulator: TickAccumulator = { competitionLoss: 0, competitionGain: 0 };

  // 工作副本：agent 数组按 id 升序（不变量），结算期间就地修改，阶段末装回新状态。
  const agents: WorkingAgent[] = state.society.agents.map((agent) => ({
    ...agent,
    ties: [...agent.ties],
  }));

  const isDecisionTick = tick % config.decision.interval === 0;
  const eByClass = state.society.eByClass;
  const opennessStart = state.society.openness;
  // 需求参照系（rules-v6）：本 tick 的 need/ascendCost 一律使用上期 refIncome
  //（先算后用，避免同期值引入 agent 顺序依赖）；'own' 模式不读取该数组。
  const referenceMode = config.need.referenceMode;
  const refIncomeStart = state.society.refIncome;
  // 本 tick 的存活查找表（O(1) 邻居/目标定位，O(N²) 防护）。
  const agentMap = new Map<string, WorkingAgent>(agents.map((agent) => [agent.id, agent]));

  // ---- 阶段 B：主动行动 ----
  const activeChanged = new Set<string>();
  const targetedAgents = new Set<string>();
  const flowCounts: number[][] = Array.from({ length: classCount }, () =>
    new Array<number>(classCount).fill(0),
  );

  if (isDecisionTick) {
    for (const agent of actionOrder(state.seed, tick, agents)) {
      const decision = decisions.get(agent.id);
      if (decision === undefined) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `到期个体缺少决策: tick=${tick} agent=${agent.id}`,
        );
      }
      executeAction({
        state,
        runId: context.runId,
        config,
        tick,
        agent,
        agents,
        agentMap,
        decision,
        eByClass,
        openness: opennessStart,
        events,
        executions,
        activeChanged,
        targetedAgents,
        flowCounts,
        accumulator,
      });
    }
  }

  // ---- 阶段 C：日常积累与需求（基于阶段期初快照统一计算 Opportunity）----
  const aliveAfterB = agents.filter((agent) => agent.alive);
  const stageCStartValues = new Map<string, number>();
  for (const agent of aliveAfterB) {
    stageCStartValues.set(agent.id, agent.value);
  }
  // 全体中位数每 tick 只计算一次（O(N²) 防护）。
  const allAliveValuesC = aliveAfterB.map((agent) => stageCStartValues.get(agent.id) as number);
  const medianAllC = aliveAfterB.length === 0 ? 0 : median(allAliveValuesC);
  const needs = new Map<string, number>();
  // rules-v6：各阶级当期 gain 求和/计数，阶段 C 结束后更新 refIncome（EMA）。
  const gainSumByClass = new Array<number>(classCount).fill(0);
  const gainCountByClass = new Array<number>(classCount).fill(0);
  const sortedAlive = [...aliveAfterB].sort((a, b) => compareAgentId(a.id, b.id));
  for (const agent of sortedAlive) {
    const neighborValues: number[] = [];
    for (const neighborId of agent.ties) {
      const neighbor = agentMap.get(neighborId);
      const value = stageCStartValues.get(neighborId);
      if (neighbor !== undefined && neighbor.alive && value !== undefined) {
        neighborValues.push(value);
      }
    }
    const medianNeighborC = neighborValues.length === 0 ? 0 : median(neighborValues);
    const opportunity = computeOpportunityFromMedians(
      config,
      neighborValues.length,
      medianNeighborC,
      medianAllC,
    );
    const env = eByClass[agent.classIndex];
    if (env === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `E 缺少阶级 ${agent.classIndex}`);
    }
    const gain =
      config.opportunity.dailyBase *
      env *
      agent.ge *
      effortFunction(config.effort.shape, agent.hard) *
      opportunity;
    const before = agent.value;
    agent.value = before + gain;
    events.emit({
      type: 'wealth_changed',
      agentId: agent.id,
      before,
      delta: gain,
      after: agent.value,
      cause: 'accumulate',
      referenceId: null,
    });
    agent.baselineSum += config.opportunity.dailyBase * env;
    agent.classAge += 1;
    // 需求参照系分派：'class' 用上期 refIncome 计价（持有标尺=阶级标准）；
    // 'own' 与 v5 逐位一致（G-D 硬门禁，不读 refIncome）。
    if (referenceMode === 'class') {
      const refC = refIncomeStart[agent.classIndex];
      if (refC === undefined) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `refIncome 缺少阶级 ${agent.classIndex}`,
        );
      }
      needs.set(agent.id, computeNeedClass(config, refC, agent.classIndex));
    } else {
      needs.set(
        agent.id,
        computeNeedOwn(config, agent.classAge, agent.baselineSum, agent.classIndex),
      );
    }
    // gain 归属发生时的阶级（阶段 B 升阶者按新阶级计入）。
    gainSumByClass[agent.classIndex] = (gainSumByClass[agent.classIndex] ?? 0) + gain;
    gainCountByClass[agent.classIndex] = (gainCountByClass[agent.classIndex] ?? 0) + 1;
  }

  // ---- 阶段 C'：需求参照系更新（rules-v6；阶段 C 全部 gain 算完之后，为下一 tick 服务）----
  // 空阶级保持上期值；EMA：refIncome(t+1) = (1-α)·refIncome(t) + α·refGain(t)。
  // 'own' 模式不更新也不读取（保持初始值，G-D 逐位一致）。
  let nextRefIncome = refIncomeStart;
  if (referenceMode === 'class') {
    const alpha = config.need.referenceSmoothing;
    nextRefIncome = refIncomeStart.map((previous, c) => {
      const count = gainCountByClass[c] ?? 0;
      if (count === 0) {
        return previous;
      }
      const refGain = (gainSumByClass[c] ?? 0) / count;
      return (1 - alpha) * previous + alpha * refGain;
    });
    for (const value of nextRefIncome) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `refIncome 更新后非法: ${String(value)}`,
        );
      }
    }
  }

  // ---- 阶段 D：被动跌落（仅未成功主动变动阶级者）----
  // 判定计时（rules-v6）：'class' 模式下 classAge ≤ graceDays 的个体不累加
  // belowNeedStreak（宽限期只控判定计时，不影响 need 数值）；
  // 'own' 模式按 0 处理——不读 graceDays、不走宽限分支，与 v5 逐位一致（G-D）。
  for (const agent of sortedAlive) {
    if (!agent.alive || activeChanged.has(agent.id)) {
      continue;
    }
    const need = needs.get(agent.id) ?? 0;
    const below = agent.value < config.need.threshold * need;
    if (referenceMode === 'class' && agent.classAge <= config.need.graceDays) {
      agent.belowNeedStreak = 0;
    } else if (below) {
      agent.belowNeedStreak += 1;
    } else {
      agent.belowNeedStreak = 0;
    }
    if (agent.belowNeedStreak >= config.need.belowNeedLimit) {
      if (agent.classIndex > 0) {
        const from = agent.classIndex;
        flowCounts[from]![from - 1] = (flowCounts[from]![from - 1] as number) + 1;
        agent.classIndex = from - 1;
        agent.classAge = 0;
        agent.baselineSum = 0;
        agent.belowNeedStreak = 0;
        agent.lastDescentTick = tick;
        events.emit({
          type: 'class_descended',
          agentId: agent.id,
          from,
          to: agent.classIndex,
          cost: null,
          reason: 'passive',
        });
      } else {
        // 最低层不跌落；streak 达到上限后钳制（03 §6 阶段 D）。
        agent.belowNeedStreak = config.need.belowNeedLimit;
      }
    }
  }

  // ---- 阶段 E：寿命与死亡 ----
  let deathCount = 0;
  for (const agent of agents) {
    if (!agent.alive) {
      continue;
    }
    const loss = lifeLoss(config, agent);
    agent.remainingLife = Math.max(0, agent.remainingLife - loss);
    if (agent.remainingLife === 0) {
      agent.alive = false;
      agent.deathTick = tick;
      agent.deathReason = 'age';
      deathCount += 1;
      for (const neighborId of agent.ties) {
        const neighbor = agentMap.get(neighborId);
        if (neighbor === undefined) {
          throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `邻居缺失: ${neighborId}`);
        }
        const tieIndex = neighbor.ties.indexOf(agent.id);
        if (tieIndex >= 0) {
          neighbor.ties.splice(tieIndex, 1);
        }
      }
      agent.ties = [];
      events.emit({ type: 'agent_died', agentId: agent.id, cause: 'age' });
    }
  }

  const aliveCount = agents.reduce((count, agent) => count + (agent.alive ? 1 : 0), 0);

  // ---- 阶段 F：网络重构（仅决策周期且仍有存活者）----
  if (isDecisionTick && aliveCount > 0) {
    const ordered = agents
      .filter((agent) => agent.alive)
      .sort((a, b) => compareAgentId(a.id, b.id));
    for (const agent of ordered) {
      attemptRewire(config, state.seed, tick, agent, agentMap, opennessStart, events);
    }
  }

  // ---- 阶段 G：宏观指标 ----
  const flowWindow = advanceFlowWindow(state.society.flowWindow, tick, flowCounts, config);
  const stats = computeTickStats({
    config,
    tick,
    agents,
    openness: opennessStart,
    eByClass,
    flowWindow,
    deathCount,
    competitionLoss: accumulator.competitionLoss,
    competitionGain: accumulator.competitionGain,
    fallbackRate: fallbackRate(decisions, isDecisionTick),
  });

  // ---- 阶段 H：慢变量更新（全死亡时不再执行，run 即将结束）----
  let nextE = eByClass;
  let nextOpenness = opennessStart;
  let lastOpennessUpdateTick = state.society.lastOpennessUpdateTick;
  if (aliveCount > 0) {
    const classShares = stats.classCounts.map((count) => count / aliveCount);
    nextE = updateClassEnvironment(
      config,
      eByClass,
      state.society.initialClassShares,
      classShares,
      stats.gini,
    );
    if (isDecisionTick) {
      // 仅决策周期更新 O（03 §6 阶段 H）；Δt=tick-lastOpennessUpdateTick。
      const opennessUpdate = maybeUpdateOpenness(config, {
        tick,
        openness: opennessStart,
        lastOpennessUpdateTick: state.society.lastOpennessUpdateTick,
        mUp: stats.mUp,
        gini: stats.gini,
        segregation: stats.segregation,
      });
      nextOpenness = opennessUpdate.openness;
      lastOpennessUpdateTick = opennessUpdate.lastOpennessUpdateTick;
    }
  }

  const endReason: EndReason | null =
    aliveCount === 0 ? (tick < config.schedule.totalTicks - 1 ? 'extinct' : 'scheduled') : null;

  const nextState: SimState = {
    schemaVersion: state.schemaVersion,
    config: state.config,
    configHash: state.configHash,
    paramsHash: state.paramsHash,
    seed: state.seed,
    society: {
      tick: tick + 1,
      agents: agents.map((agent) => ({ ...agent, ties: [...agent.ties] })),
      eByClass: nextE,
      refIncome: nextRefIncome,
      openness: nextOpenness,
      initialClassShares: state.society.initialClassShares,
      gini: stats.gini,
      segregation: stats.segregation,
      mUp: stats.mUp,
      mDown: stats.mDown,
      edgeCount: stats.edgeCount,
      flowWindow,
      lastOpennessUpdateTick,
    },
  };
  return { state: nextState, events: events.all(), executions, stats, endReason };
}

/** 行动顺序（03 §4.4）：`R(seed,tick,id,"action_order",0)` 按 (值,id) 升序。 */
function actionOrder(seed: Seed, tick: number, agents: readonly WorkingAgent[]): WorkingAgent[] {
  const due = agents.filter((agent) => agent.alive);
  const keyed = due.map((agent) => ({
    agent,
    order: createDraw(seed, tick, agent.id)(RNG_EVENT_TAGS.actionOrder, 0),
  }));
  keyed.sort((a, b) => a.order - b.order || compareAgentId(a.agent.id, b.agent.id));
  return keyed.map((entry) => entry.agent);
}

function fallbackRate(decisions: StepDecisions, isDecisionTick: boolean): number | null {
  if (!isDecisionTick || decisions.size === 0) {
    return null;
  }
  let fallbacks = 0;
  for (const decision of decisions.values()) {
    if (decision.isFallback === true) {
      fallbacks += 1;
    }
  }
  return fallbacks / decisions.size;
}

function advanceFlowWindow(
  current: readonly FlowWindowEntry[],
  tick: number,
  flowCounts: readonly (readonly number[])[],
  config: RunConfig,
): FlowWindowEntry[] {
  const hasTransfers = flowCounts.some((row) => row.some((cell) => cell > 0));
  const window: FlowWindowEntry[] = hasTransfers
    ? [...current, { tick, counts: flowCounts.map((row) => [...row]) }]
    : [...current];
  const lowerBound = tick - config.metrics.flowWindowDays + 1;
  return window.filter((entry) => entry.tick >= lowerBound);
}

interface ExecuteActionInput {
  readonly state: SimState;
  readonly runId: string;
  readonly config: RunConfig;
  readonly tick: number;
  readonly agent: WorkingAgent;
  /** 结算工作副本（位移准入抽样与降级作用于此，非快照）。 */
  readonly agents: readonly WorkingAgent[];
  readonly agentMap: ReadonlyMap<string, WorkingAgent>;
  readonly decision: StepDecision;
  readonly eByClass: readonly number[];
  readonly openness: number;
  readonly events: EventSequence;
  readonly executions: ExecutionRecord[];
  readonly activeChanged: Set<string>;
  readonly targetedAgents: Set<string>;
  readonly flowCounts: number[][];
  readonly accumulator: TickAccumulator;
}

/**
 * 阶段 B 单个主动行动（03 §5/§6）：执行前复核费用与目标状态；
 * 失效行动记 `stale_invalid`，不执行主动行动，仍进入日常积累。
 */
function executeAction(input: ExecuteActionInput): void {
  const {
    state,
    config,
    tick,
    agent,
    agents,
    agentMap,
    decision,
    eByClass,
    openness,
    events,
    executions,
    activeChanged,
    targetedAgents,
    flowCounts,
    accumulator,
    runId,
  } = input;
  const record = (
    executedAction: string | null,
    status: ExecutionRecord['status'],
    reason: string | null,
  ): void => {
    executions.push({
      schemaVersion: 'execution-v1',
      runId,
      tick,
      agentId: agent.id,
      selectedAction: decision.selectedAction,
      executedAction,
      status,
      reason,
      eventSeq: null,
    });
  };
  const parsed = parseActionKey(decision.selectedAction);
  if (parsed.type === 'accumulate') {
    record('accumulate', 'executed', null);
    return;
  }
  if (parsed.type === 'ascend') {
    // 执行前复核：费用 + 持有裕度与当前 Value（前序竞争可能已消耗）。
    const cost = computeAscendCost(config, agent, eByClass, openness, state.society.refIncome);
    const cushion =
      cost === null
        ? 0
        : computeAscendCushion(config, agent.classIndex + 1, eByClass, state.society.refIncome);
    // 反向比较写 `!(value >= cost + cushion)`：NaN（如 E 缺失）时枚举侧拒绝、
    // 复核侧也必须拒绝，不能因 `NaN < x` 为 false 而放行。
    if (cost === null || !(agent.value >= cost + cushion)) {
      events.emit({
        type: 'action_invalid',
        agentId: agent.id,
        action: decision.selectedAction,
        reason: 'insufficient_cushion',
      });
      record(null, 'stale_invalid', 'insufficient_cushion');
      return;
    }
    // rules-v8 位移准入（D-09，diagnosis §8）：仅 'class' 参照系——上升需击败目标阶级
    // 在位者（按 displacementTarget 地址均匀抽样；目标阶级为空则直接准入），
    // 被击败者降级到攻击方原阶级；对决复用 rule.md 12–19 竞争结算（含财富转移）。
    // 'own' 模式不进入该分支、不消费 displacement/competitionResolve 地址，
    // RNG 流与 v5 逐位一致（G-D 硬门禁）。
    if (config.need.referenceMode === 'class') {
      const incumbent = sampleDisplacementTarget(
        state.seed,
        tick,
        agent.id,
        agents,
        agent.classIndex + 1,
      );
      if (incumbent !== null) {
        const duelDraw = createDraw(state.seed, tick, agent.id);
        const outcome = resolveCompetition(
          config,
          agent,
          incumbent,
          duelDraw(RNG_EVENT_TAGS.competitionResolve, 0),
        );
        const duelLoser = outcome.winner === 'initiator' ? incumbent : agent;
        const duelWinner = outcome.winner === 'initiator' ? agent : incumbent;
        const duelLoserBefore = duelLoser.value;
        duelLoser.value = duelLoserBefore - outcome.loss;
        events.emit({
          type: 'wealth_changed',
          agentId: duelLoser.id,
          before: duelLoserBefore,
          delta: -outcome.loss,
          after: duelLoser.value,
          cause: 'competition_loss',
          referenceId: duelWinner.id,
        });
        const duelWinnerBefore = duelWinner.value;
        duelWinner.value = duelWinnerBefore + outcome.gain;
        events.emit({
          type: 'wealth_changed',
          agentId: duelWinner.id,
          before: duelWinnerBefore,
          delta: outcome.gain,
          after: duelWinner.value,
          cause: 'competition_gain',
          referenceId: duelLoser.id,
        });
        accumulator.competitionLoss += outcome.loss;
        accumulator.competitionGain += outcome.gain;
        targetedAgents.add(incumbent.id);
        events.emit({
          type: 'competition_resolved',
          initiatorId: agent.id,
          targetId: incumbent.id,
          logPowerInitiator: logPower(config, agent),
          logPowerTarget: logPower(config, incumbent),
          pInitiator: outcome.pInitiator,
          winner: outcome.winner,
          direction: outcome.direction,
          directionMultiplier: outcome.directionMultiplier,
          loss: outcome.loss,
          gain: outcome.gain,
        });
        if (outcome.winner !== 'initiator') {
          // 准入失败：在位者守擂成功；攻击方不支付、不升阶（对决财富转移已结算）。
          events.emit({
            type: 'action_invalid',
            agentId: agent.id,
            action: decision.selectedAction,
            reason: 'displacement_lost',
          });
          record(null, 'stale_invalid', 'displacement_lost');
          return;
        }
        // 攻击方获胜：在位者被击败降级（maxClass 不变；lastDescentTick 计入 Mdown）。
        const displacedFrom = incumbent.classIndex;
        flowCounts[displacedFrom]![displacedFrom - 1] =
          (flowCounts[displacedFrom]![displacedFrom - 1] as number) + 1;
        incumbent.classIndex = displacedFrom - 1;
        incumbent.classAge = 0;
        incumbent.baselineSum = 0;
        incumbent.belowNeedStreak = 0;
        incumbent.lastDescentTick = tick;
        events.emit({
          type: 'class_descended',
          agentId: incumbent.id,
          from: displacedFrom,
          to: incumbent.classIndex,
          cost: null,
          reason: 'passive',
        });
      }
    }
    const before = agent.value;
    agent.value = before - cost;
    events.emit({
      type: 'wealth_changed',
      agentId: agent.id,
      before,
      delta: -cost,
      after: agent.value,
      cause: 'ascend_cost',
      referenceId: null,
    });
    const from = agent.classIndex;
    flowCounts[from]![from + 1] = (flowCounts[from]![from + 1] as number) + 1;
    agent.classIndex = from + 1;
    agent.maxClassIndex = Math.max(agent.maxClassIndex, agent.classIndex);
    agent.classAge = 0;
    agent.baselineSum = 0;
    agent.belowNeedStreak = 0;
    agent.lastAscentTick = tick;
    activeChanged.add(agent.id);
    events.emit({
      type: 'class_ascended',
      agentId: agent.id,
      from,
      to: agent.classIndex,
      cost,
      reason: 'active',
    });
    record('ascend', 'executed', null);
    return;
  }
  if (parsed.type === 'descend') {
    const cost = computeDescendCost(config, agent, eByClass);
    if (cost === null || !(agent.value >= cost)) {
      events.emit({
        type: 'action_invalid',
        agentId: agent.id,
        action: decision.selectedAction,
        reason: 'insufficient_value',
      });
      record(null, 'stale_invalid', 'insufficient_value');
      return;
    }
    const before = agent.value;
    agent.value = before - cost;
    events.emit({
      type: 'wealth_changed',
      agentId: agent.id,
      before,
      delta: -cost,
      after: agent.value,
      cause: 'descend_cost',
      referenceId: null,
    });
    const from = agent.classIndex;
    flowCounts[from]![from - 1] = (flowCounts[from]![from - 1] as number) + 1;
    agent.classIndex = from - 1;
    agent.classAge = 0;
    agent.baselineSum = 0;
    agent.belowNeedStreak = 0;
    agent.lastDescentTick = tick;
    activeChanged.add(agent.id);
    events.emit({
      type: 'class_descended',
      agentId: agent.id,
      from,
      to: agent.classIndex,
      cost,
      reason: 'active',
    });
    record('descend', 'executed', null);
    return;
  }
  // compete:<targetId>
  const targetId = parsed.target;
  if (targetId === null) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '竞争行动缺少目标');
  }
  // 自竞争守卫：合法行动集永不包含自身，决策层（含外部 live 策略）传入
  // `compete:<self>` 时按失效处理，不得先扣后加造成净损失。
  if (targetId === agent.id) {
    events.emit({
      type: 'action_invalid',
      agentId: agent.id,
      action: decision.selectedAction,
      reason: 'self_target',
    });
    record(null, 'stale_invalid', 'self_target');
    return;
  }
  const target = agentMap.get(targetId);
  if (target === undefined) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `竞争目标缺失: ${targetId}`);
  }
  const staleReason = !target.alive
    ? 'target_dead'
    : targetedAgents.has(target.id)
      ? 'target_taken'
      : null;
  if (staleReason !== null) {
    events.emit({
      type: 'action_invalid',
      agentId: agent.id,
      action: decision.selectedAction,
      reason: staleReason,
    });
    record(null, 'stale_invalid', staleReason);
    return;
  }
  // 竞争结算：只消费原发起方地址（03 §4.4）。
  const r = createDraw(state.seed, tick, agent.id)(RNG_EVENT_TAGS.competitionResolve, 0);
  const outcome = resolveCompetition(config, agent, target, r);
  const loser = outcome.winner === 'initiator' ? target : agent;
  const winner = outcome.winner === 'initiator' ? agent : target;
  const loserBefore = loser.value;
  loser.value = loserBefore - outcome.loss;
  events.emit({
    type: 'wealth_changed',
    agentId: loser.id,
    before: loserBefore,
    delta: -outcome.loss,
    after: loser.value,
    cause: 'competition_loss',
    referenceId: winner.id,
  });
  const winnerBefore = winner.value;
  winner.value = winnerBefore + outcome.gain;
  events.emit({
    type: 'wealth_changed',
    agentId: winner.id,
    before: winnerBefore,
    delta: outcome.gain,
    after: winner.value,
    cause: 'competition_gain',
    referenceId: loser.id,
  });
  accumulator.competitionLoss += outcome.loss;
  accumulator.competitionGain += outcome.gain;
  targetedAgents.add(target.id);
  events.emit({
    type: 'competition_resolved',
    initiatorId: agent.id,
    targetId: target.id,
    logPowerInitiator: logPower(config, agent),
    logPowerTarget: logPower(config, target),
    pInitiator: outcome.pInitiator,
    winner: outcome.winner,
    direction: outcome.direction,
    directionMultiplier: outcome.directionMultiplier,
    loss: outcome.loss,
    gain: outcome.gain,
  });
  record(decision.selectedAction, 'executed', null);
}
