import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import { createSimulation } from '../core/init/simulation.js';
import type { RunConfig } from '../core/config/types.js';
import type { SimState } from '../core/model/state.js';
import { asSeed, type AgentId, type Seed } from '../core/control/ids.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { step } from '../core/engine/engine.js';
import { computeActionSetHash, enumerateLegalActions } from '../core/legal-actions.js';
import type { TickEvent } from '../core/events.js';
import { POLICY_VERSION_MOCK } from '../decision/mock.js';
import { POLICY_VERSION_RANDOM } from '../decision/random.js';
import { MockPolicy, RandomPolicy } from '../decision/policies.js';
import type { DecisionInput, DecisionPolicy } from '../decision/policy.js';
import {
  buildDecisionState,
  computeDecisionStateHash,
  PROMPT_VERSION,
} from '../decision/serialize.js';
import type { DecisionRecord } from '../decision/types.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { computeAuthoritativeStateHash } from '../core/hash/state-hash.js';
import { ANALYSIS_WINDOWS, summarizeWindow, type WindowSummary } from './window-stats.js';
import { evaluateLabels } from './labels.js';

/** 单 run 的窗口聚合结果（P1.5-01 报告契约的一部分）。 */
export interface RunWindowReport {
  readonly windows: readonly WindowSummary[];
  readonly labelsByWindow: Readonly<Record<string, readonly string[]>>;
  readonly labelsEvidenceByWindow: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly extinct: boolean;
  readonly endTick: number;
  readonly endReason: string | null;
  /** P2：调用方取消（AbortSignal）时为 true；未结算的 tick 不计入 stats/decisions。 */
  readonly cancelled: boolean;
  readonly finalStateHash: string;
  readonly aliveAtEnd: number;
}

export interface RunOptions {
  /** 决策策略；P1.5 只用 mock/random；live/replay 通过 `policyImpl` 注入。 */
  readonly policy: 'mock-weighted-v1' | 'random-uniform-v1';
  /** 预算护栏：单 run 最大 tick 数（超过视为异常终止）。 */
  readonly maxTicks?: number;
  /**
   * P2-01：可注入的策略实现。缺省时由 `policy` 选择内置 mock/random；
   * 同步路径拒绝返回 Promise 的策略（live 必须走 `runSingleWithPolicy`）。
   */
  readonly policyImpl?: DecisionPolicy;
  /**
   * P5/分叉实验：从给定状态继续（例如检查点恢复或多阶段参数路径）。
   * 其 `configHash` 与 `seed` 必须与本次 run 一致；状态自身不得被外部修改。
   */
  readonly initialState?: SimState;
}

export interface RunOutcome {
  readonly configHash: string;
  readonly paramsHash: string;
  readonly stats: readonly TickStats[];
  readonly flowsByTick: ReadonlyMap<number, readonly (readonly number[])[]>;
  readonly decisionsByTick: ReadonlyMap<
    number,
    { readonly due: number; readonly fallbacks: number }
  >;
  /** P2-06：逐决策记录（run 级日志；mock/random 的 requestedAction 为 null）。 */
  readonly decisions: readonly DecisionRecord[];
  readonly report: RunWindowReport;
  /** run 结束时的权威状态（G-D own 逐位对照、微扰克隆等用途）。 */
  readonly finalState: SimState;
}

function flowsFromEvents(
  events: readonly { type: string; from?: number; to?: number }[],
  classCount: number,
): number[][] {
  const matrix = Array.from({ length: classCount }, () => new Array<number>(classCount).fill(0));
  for (const event of events) {
    if (event.type === 'class_ascended' || event.type === 'class_descended') {
      const from = event.from;
      const to = event.to;
      if (from !== undefined && to !== undefined) {
        const row = matrix[from] as number[];
        row[to] = (row[to] as number) + 1;
      }
    }
  }
  return matrix;
}

/**
 * 灭绝判定（07 §5）：引擎在最后一 tick 才全死亡时返回 `scheduled` 而非 `extinct`，
 * 但 `finalAliveCount=0`；二者都必须标 extinct，否则该 run 会以「存活」身份
 * 进入聚类与结构判异。
 */
export function deriveExtinct(endReason: string | null, aliveAtEnd: number): boolean {
  return endReason === 'extinct' || aliveAtEnd === 0;
}

/**
 * 运行单个 (config, seed) 到结束（scheduled/extinct 或 maxTicks 护栏），
 * 收集全分辨率 stats、每 tick 转移矩阵与决策计数，并产出窗口聚合与标签。
 */
export function runSingle(config: RunConfig, seed: Seed, options: RunOptions): RunOutcome {
  const validatedSeed = asSeed(seed);
  let state: SimState;
  if (options.initialState !== undefined) {
    if (computeConfigHash(options.initialState.config) !== computeConfigHash(config)) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        'initialState.config 与本次 run 的 config 不一致',
      );
    }
    if (options.initialState.seed !== validatedSeed) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        'initialState.seed 与本次 run 的 seed 不一致',
      );
    }
    state = options.initialState;
  } else {
    state = createSimulation(config, validatedSeed);
  }
  const classCount = config.population.classCount;
  const stats: TickStats[] = [];
  const flowsByTick = new Map<number, readonly (readonly number[])[]>();
  const decisionsByTick = new Map<number, { due: number; fallbacks: number }>();
  const maxTicks = options.maxTicks ?? config.schedule.totalTicks;
  // P2-01：同步路径只接受同步策略；缺省按 policy 字符串选择内置实现。
  const policy =
    options.policyImpl ??
    (options.policy === 'mock-weighted-v1' ? new MockPolicy() : new RandomPolicy());
  const decisionRecords: DecisionRecord[] = [];
  let endReason: string | null = null;
  let endTick = 0;
  while (state.society.tick < Math.min(config.schedule.totalTicks, maxTicks)) {
    const tick = state.society.tick;
    const isDecisionTick = tick % config.decision.interval === 0;
    const decisions = new Map<AgentId, { selectedAction: string; isFallback?: boolean }>();
    let due = 0;
    let fallbacks = 0;
    if (isDecisionTick) {
      for (const agent of state.society.agents) {
        if (!agent.alive) {
          continue;
        }
        due += 1;
        const legal = enumerateLegalActions(state, agent.id);
        const input: DecisionInput = {
          runId: 'local-batch',
          seed: validatedSeed,
          config,
          tick,
          agentId: agent.id,
          stateHash: 'sha256:batch',
          actionSetHash: 'sha256:batch',
          legal,
          state: null,
          simState: state,
          topK: 1,
          requestedModel: 'mock',
          promptVersion: null,
          promptStyle: 'neutral',
          recentEvents: [],
        };
        const decision = policy.decide(input, new AbortController().signal);
        if (decision instanceof Promise) {
          throw new StratifyError(
            errorCodes.INVARIANT_VIOLATED,
            '同步 run 不支持异步策略；live/replay 请使用 runSingleWithPolicy',
          );
        }
        decisionRecords.push(decision);
        const isFallback = decision.source === 'fallback';
        if (isFallback) {
          fallbacks += 1;
        }
        decisions.set(agent.id, { selectedAction: decision.selectedAction, isFallback });
      }
    }
    decisionsByTick.set(tick, { due, fallbacks });
    const result = step(state, decisions, { runId: 'local-batch' });
    state = result.state;
    stats.push(result.stats as TickStats);
    flowsByTick.set(tick, flowsFromEvents(result.events, classCount));
    endTick = tick;
    endReason = result.endReason;
    if (endReason !== null) {
      break;
    }
  }
  return finalizeRun({
    config,
    stats,
    flowsByTick,
    decisionsByTick,
    decisions: decisionRecords,
    state,
    endReason,
    endTick,
  });
}

interface FinalizeInput {
  readonly config: RunConfig;
  readonly stats: readonly TickStats[];
  readonly flowsByTick: ReadonlyMap<number, readonly (readonly number[])[]>;
  readonly decisionsByTick: ReadonlyMap<
    number,
    { readonly due: number; readonly fallbacks: number }
  >;
  readonly decisions: readonly DecisionRecord[];
  readonly state: SimState;
  readonly endReason: string | null;
  readonly endTick: number;
  readonly cancelled?: boolean;
}

/** 共享收尾：窗口聚合、标签、extinct 与权威状态哈希（同步/异步路径同一口径）。 */
function finalizeRun(input: FinalizeInput): RunOutcome {
  const { config, stats, flowsByTick, decisionsByTick, decisions, state, endReason, endTick } =
    input;
  const aliveAtEnd = state.society.agents.reduce(
    (count, agent) => count + (agent.alive ? 1 : 0),
    0,
  );
  // 07 §5：最后一 tick 才全死亡时引擎返回 scheduled 但 finalAliveCount=0，
  // 必须同样标 extinct，否则该 run 会以「存活」身份进入聚类与结构判异。
  const extinct = deriveExtinct(endReason, aliveAtEnd);
  const windows = ANALYSIS_WINDOWS.map((window) =>
    summarizeWindow(
      { config, stats, flowsByTick, decisionsByTick },
      window.label,
      window.start,
      window.end,
    ),
  );
  const labelsByWindow: Record<string, string[]> = {};
  const labelsEvidenceByWindow: Record<string, Record<string, string>> = {};
  for (const window of windows) {
    const evaluation = evaluateLabels(window);
    labelsByWindow[window.label] = [...evaluation.labels];
    labelsEvidenceByWindow[window.label] = evaluation.evidence;
  }
  return {
    configHash: computeConfigHash(config),
    paramsHash: computeParamsHash(config),
    stats,
    flowsByTick,
    decisionsByTick,
    decisions,
    report: {
      windows,
      labelsByWindow,
      labelsEvidenceByWindow,
      extinct,
      endTick,
      endReason,
      cancelled: input.cancelled ?? false,
      finalStateHash: computeAuthoritativeStateHash(state),
      aliveAtEnd,
    },
    finalState: state,
  };
}

/** P2-01：异步策略 run（live/replay）。与同步 `runSingle` 共用同一结算与收尾口径。 */
export interface PolicyRunOptions {
  readonly policy: DecisionPolicy;
  /** run 身份；离线 run 必须用 `local-<ulid>`，不得伪装 server run。 */
  readonly runId: string;
  readonly requestedModel: string;
  readonly promptStyle: 'neutral' | 'survival_hint';
  readonly topK?: number;
  readonly maxTicks?: number;
  /** 取消信号：策略应尽快返回 `cancelled` 回退（04 §6）。 */
  readonly signal?: AbortSignal;
}

export async function runSingleWithPolicy(
  config: RunConfig,
  seed: Seed,
  options: PolicyRunOptions,
): Promise<RunOutcome> {
  const validatedSeed = asSeed(seed);
  let state = createSimulation(config, validatedSeed);
  const classCount = config.population.classCount;
  const stats: TickStats[] = [];
  const flowsByTick = new Map<number, readonly (readonly number[])[]>();
  const decisionsByTick = new Map<number, { due: number; fallbacks: number }>();
  const decisionRecords: DecisionRecord[] = [];
  const maxTicks = options.maxTicks ?? config.schedule.totalTicks;
  const signal = options.signal ?? new AbortController().signal;
  let recentEvents: TickEvent[] = [];
  let endReason: string | null = null;
  let endTick = 0;
  let cancelled = false;
  while (state.society.tick < Math.min(config.schedule.totalTicks, maxTicks)) {
    // 04 §6：取消后不再发新请求，也不再结算新 tick。
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    const tick = state.society.tick;
    const isDecisionTick = tick % config.decision.interval === 0;
    const decisions = new Map<AgentId, { selectedAction: string; isFallback?: boolean }>();
    let due = 0;
    let fallbacks = 0;
    if (isDecisionTick) {
      const recordsAtTickStart = decisionRecords.length;
      for (const agent of state.society.agents) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        if (!agent.alive) {
          continue;
        }
        due += 1;
        const legal = enumerateLegalActions(state, agent.id);
        // P2-02：live 需要固定构造顺序的 state 与真实哈希；mock/random 忽略这两项。
        const decisionState = buildDecisionState(state, agent.id, legal, recentEvents);
        const input: DecisionInput = {
          runId: options.runId,
          seed: validatedSeed,
          config,
          tick,
          agentId: agent.id,
          stateHash: computeDecisionStateHash(decisionState),
          actionSetHash: computeActionSetHash(legal.actions),
          legal,
          state: decisionState,
          simState: state,
          // 04 §4.5：实验 topK 来自配置；`PolicyRunOptions.topK` 仅作显式覆盖。
          topK: options.topK ?? config.decision.topK,
          requestedModel: options.requestedModel,
          promptVersion: PROMPT_VERSION,
          promptStyle: options.promptStyle,
          recentEvents: [...recentEvents],
        };
        const decision = await options.policy.decide(input, signal);
        decisionRecords.push(decision);
        const isFallback = decision.source === 'fallback';
        if (isFallback) {
          fallbacks += 1;
        }
        decisions.set(agent.id, { selectedAction: decision.selectedAction, isFallback });
      }
      if (cancelled) {
        // 未结算 tick 的决策不进入产物，避免日志出现「已决策未执行」的悬空记录。
        decisionRecords.length = recordsAtTickStart;
        break;
      }
    }
    decisionsByTick.set(tick, { due, fallbacks });
    const result = step(state, decisions, { runId: options.runId });
    state = result.state;
    stats.push(result.stats as TickStats);
    flowsByTick.set(tick, flowsFromEvents(result.events, classCount));
    recentEvents = [...recentEvents, ...result.events].slice(-50);
    endTick = tick;
    endReason = result.endReason;
    if (endReason !== null) {
      break;
    }
  }
  return finalizeRun({
    config,
    stats,
    flowsByTick,
    decisionsByTick,
    decisions: decisionRecords,
    state,
    endReason,
    endTick,
    cancelled,
  });
}

export { POLICY_VERSION_MOCK, POLICY_VERSION_RANDOM };
