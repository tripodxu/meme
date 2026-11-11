import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import { createSimulation } from '../core/init/simulation.js';
import type { RunConfig } from '../core/config/types.js';
import type { SimState } from '../core/model/state.js';
import { captureSnapshot, type Snapshot } from '../core/replay/snapshot.js';
import { asSeed, type AgentId, type Seed } from '../core/control/ids.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { step } from '../core/engine/engine.js';
import { computeActionSetHash, enumerateLegalActions } from '../core/legal-actions.js';
import type { TickEvent } from '../core/events.js';
import { POLICY_VERSION_MOCK } from '../decision/mock.js';
import { POLICY_VERSION_RANDOM } from '../decision/random.js';
import { MockPolicy, MockPolicyV2, RandomPolicy } from '../decision/policies.js';
import type { DecisionInput, DecisionPolicy } from '../decision/policy.js';
import {
  buildDecisionState,
  computeDecisionStateHash,
  PROMPT_VERSION,
} from '../decision/serialize.js';
import type { DecisionRecord, ExecutionRecord } from '../decision/types.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { computeAuthoritativeStateHash } from '../core/hash/state-hash.js';
import { ANALYSIS_WINDOWS, summarizeWindow, type WindowSummary } from './window-stats.js';
import { evaluateLabels } from './labels.js';
import type { CheckpointHost, SyncCheckpointHost } from './checkpoint.js';
import {
  buildRunProgressPayload,
  loadRunProgress,
  loadRunProgressAsync,
  removeRunProgress,
  removeRunProgressAsync,
  saveRunProgress,
  saveRunProgressAsync,
} from './run-progress.js';

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

/**
 * P5-03：run 内进度检查点选项（`run-progress-v1`，见 `run-progress.ts`）。
 * 提供时每 `everyTicks` 个已完成 tick 原子落盘一次（状态 + 窗口累计器）；
 * 启动时若存在 meta 匹配的检查点则自动恢复，恢复后的窗口聚合与不中断运行逐字一致；
 * run 正常结束（scheduled/extinct 或到达 totalTicks）后移除检查点文件。
 */
export interface RunCheckpointOptions {
  readonly host: SyncCheckpointHost;
  readonly path: string;
  /** 每 N 个已完成 tick 落一次检查点；>=1。注意单次写是 O(已完成 tick) 序列化。 */
  readonly everyTicks: number;
  /** 批量任务标识（进 meta，恢复时校验，防跨 run 污染）。 */
  readonly cellKey: string;
}

export interface RunOptions {
  /** 决策策略；P1.5 只用 mock/random；live/replay 通过 `policyImpl` 注入。 */
  readonly policy: 'mock-weighted-v1' | 'mock-weighted-v2' | 'random-uniform-v1';
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
  /** P5-03：run 内进度检查点；与 `initialState` 不得同时给出（起点歧义）。 */
  readonly runCheckpoint?: RunCheckpointOptions;
  /** P5b：收集 full profile 所需的 events/executions/periodic snapshots。 */
  readonly captureArtifacts?: boolean;
  /** 快照间隔；缺省 `config.schedule.snapshotStride`。 */
  readonly snapshotStride?: number;
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
  /** P5b：仅在 `captureArtifacts` 时收集；用于 full profile 上传。 */
  readonly events?: readonly TickEvent[];
  readonly executionsByTick?: ReadonlyMap<number, readonly ExecutionRecord[]>;
  readonly snapshots?: readonly Snapshot[];
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
 * 检查点快照的第二道校验：`loadRunProgress` 已校验 meta 三元组，
 * 但快照自身携带的 config/params/seed 也必须与本次 run 一致。
 * 否则损坏或伪造的检查点可以保留匹配的 meta、却以不同规则续跑。
 */
function assertCheckpointSnapshot(state: SimState, config: RunConfig, seed: Seed): void {
  if (computeConfigHash(state.config) !== computeConfigHash(config)) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      '检查点快照 config 与本次 config 不一致；不得续跑',
    );
  }
  if (computeParamsHash(state.config) !== computeParamsHash(config)) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      '检查点快照 paramsHash 与本次 config 不一致；不得续跑',
    );
  }
  if (state.seed !== seed) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点快照 seed 不匹配: ${state.seed} ≠ ${seed}`,
    );
  }
}

/**
 * 运行单个 (config, seed) 到结束（scheduled/extinct 或 maxTicks 护栏），
 * 收集全分辨率 stats、每 tick 转移矩阵与决策计数，并产出窗口聚合与标签。
 *
 * P5-03：提供 `runCheckpoint` 时，启动先尝试恢复 meta 匹配的进度检查点
 * （状态 + 窗口累计器；损坏按不存在处理，meta 不匹配抛错），每 `everyTicks`
 * 个已完成 tick 原子落盘一次，run 正常结束后移除检查点文件。恢复路径不重建
 * 前段 `decisions` 决策日志（批量摘要不消费它；live 决策日志经 P2 管线另行落盘）。
 */
export function runSingle(config: RunConfig, seed: Seed, options: RunOptions): RunOutcome {
  const validatedSeed = asSeed(seed);
  const runCheckpoint = options.runCheckpoint;
  if (options.initialState !== undefined && runCheckpoint !== undefined) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'initialState 与 runCheckpoint 不得同时给出（起点歧义）',
    );
  }
  if (options.captureArtifacts === true && runCheckpoint !== undefined) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'full artifact 捕获与 runCheckpoint 不能同时启用（恢复段缺少 events/snapshots）',
    );
  }
  let state: SimState;
  let savedAtSequence = 0;
  let resumedStats: readonly TickStats[] = [];
  let resumedFlows: readonly (readonly (readonly number[])[])[] = [];
  let resumedFlowTicks: readonly number[] = [];
  let resumedDecisions: readonly {
    readonly tick: number;
    readonly due: number;
    readonly fallbacks: number;
  }[] = [];
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
  } else if (runCheckpoint !== undefined) {
    const configHash = computeConfigHash(config);
    const loaded = loadRunProgress(runCheckpoint.host, runCheckpoint.path, {
      cellKey: runCheckpoint.cellKey,
      seed: validatedSeed,
      configHash,
    });
    if (loaded !== null) {
      state = loaded.state;
      assertCheckpointSnapshot(state, config, validatedSeed);
      savedAtSequence = loaded.meta.savedAtSequence;
      resumedStats = loaded.progress.stats;
      resumedFlowTicks = loaded.progress.flows.map((entry) => entry.tick);
      resumedFlows = loaded.progress.flows.map((entry) => entry.matrix);
      resumedDecisions = loaded.progress.decisions;
    } else {
      state = createSimulation(config, validatedSeed);
    }
  } else {
    state = createSimulation(config, validatedSeed);
  }
  const classCount = config.population.classCount;
  // P5-03：从进度检查点恢复时，累计器由检查点重建（窗口聚合依赖全程数据）。
  const stats: TickStats[] = [...resumedStats];
  const flowsByTick = new Map<number, readonly (readonly number[])[]>();
  resumedFlowTicks.forEach((tick, index) => {
    flowsByTick.set(tick, resumedFlows[index] as readonly (readonly number[])[]);
  });
  const decisionsByTick = new Map<number, { due: number; fallbacks: number }>();
  for (const entry of resumedDecisions) {
    decisionsByTick.set(entry.tick, { due: entry.due, fallbacks: entry.fallbacks });
  }
  const checkpointConfigHash = runCheckpoint !== undefined ? computeConfigHash(config) : null;
  const maxTicks = options.maxTicks ?? config.schedule.totalTicks;
  // P2-01：同步路径只接受同步策略；缺省按 policy 字符串选择内置实现。
  const policy: DecisionPolicy =
    options.policyImpl ??
    (options.policy === 'mock-weighted-v1'
      ? new MockPolicy()
      : options.policy === 'mock-weighted-v2'
        ? new MockPolicyV2()
        : new RandomPolicy());
  const decisionRecords: DecisionRecord[] = [];
  const capture = options.captureArtifacts === true;
  const snapshotStride = Math.max(1, options.snapshotStride ?? config.schedule.snapshotStride);
  const capturedEvents: TickEvent[] = [];
  const executionsByTick = new Map<number, readonly ExecutionRecord[]>();
  const snapshots: Snapshot[] = capture ? [captureSnapshot(state)] : [];
  let endReason: string | null = null;
  // 初值 = 已完成 tick（P5-03 恢复路径可能无需再跑任何 tick，endTick 仍是检查点位置）。
  let endTick = state.society.tick;
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
    if (capture) {
      capturedEvents.push(...result.events);
      executionsByTick.set(tick, result.executions);
      if ((tick + 1) % snapshotStride === 0) {
        snapshots.push(captureSnapshot(state));
      }
    }
    if (
      runCheckpoint !== undefined &&
      checkpointConfigHash !== null &&
      state.society.tick % runCheckpoint.everyTicks === 0
    ) {
      savedAtSequence += 1;
      saveRunProgress(
        runCheckpoint.host,
        runCheckpoint.path,
        buildRunProgressPayload(
          {
            cellKey: runCheckpoint.cellKey,
            seed: validatedSeed,
            configHash: checkpointConfigHash,
            tickCompleted: state.society.tick,
            savedAtSequence,
          },
          state,
          {
            stats,
            flows: [...flowsByTick].map(([flowTick, matrix]) => ({ tick: flowTick, matrix })),
            decisions: [...decisionsByTick].map(([decisionTick, value]) => ({
              tick: decisionTick,
              due: value.due,
              fallbacks: value.fallbacks,
            })),
          },
        ),
      );
    }
    if (endReason !== null) {
      break;
    }
  }
  // P5-03：run 真正结束（引擎 endReason 或到达 totalTicks）后移除进度检查点；
  // maxTicks 护栏触发的异常终止保留检查点供下次恢复。
  if (
    runCheckpoint !== undefined &&
    (endReason !== null || state.society.tick >= config.schedule.totalTicks)
  ) {
    removeRunProgress(runCheckpoint.host, runCheckpoint.path);
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
    ...(capture
      ? {
          capturedEvents,
          executionsByTick,
          snapshots: ensureFinalSnapshot(snapshots, state),
        }
      : {}),
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
  readonly capturedEvents?: readonly TickEvent[];
  readonly executionsByTick?: ReadonlyMap<number, readonly ExecutionRecord[]>;
  readonly snapshots?: readonly Snapshot[];
}

function ensureFinalSnapshot(snapshots: Snapshot[], state: SimState): Snapshot[] {
  const final = captureSnapshot(state);
  const last = snapshots[snapshots.length - 1];
  return last !== undefined && last.stateHash === final.stateHash
    ? snapshots
    : [...snapshots, final];
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
    ...(input.capturedEvents === undefined ? {} : { events: input.capturedEvents }),
    ...(input.executionsByTick === undefined ? {} : { executionsByTick: input.executionsByTick }),
    ...(input.snapshots === undefined ? {} : { snapshots: input.snapshots }),
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
  /**
   * P6-04 前置：live run 内进度检查点（异步宿主；语义与同步版一致，changes/0040）。
   * 提供时每 `everyTicks` 个已完成 tick 原子落盘（状态 + 窗口累计器 + 决策日志），
   * 启动时自动恢复 meta 匹配的检查点（含前段决策日志——live 审计链不中断），
   * run 正常结束后移除；取消/致命失败保留检查点供续跑。
   */
  readonly runCheckpoint?: {
    readonly host: CheckpointHost;
    readonly path: string;
    readonly everyTicks: number;
    readonly cellKey: string;
  };
  /** P5b：收集 full profile 所需的 events/executions/periodic snapshots。 */
  readonly captureArtifacts?: boolean;
  readonly snapshotStride?: number;
}

export async function runSingleWithPolicy(
  config: RunConfig,
  seed: Seed,
  options: PolicyRunOptions,
): Promise<RunOutcome> {
  const validatedSeed = asSeed(seed);
  const checkpoint = options.runCheckpoint;
  if (options.captureArtifacts === true && checkpoint !== undefined) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'full artifact 捕获与 runCheckpoint 不能同时启用（恢复段缺少 events/snapshots）',
    );
  }
  let state = createSimulation(config, validatedSeed);
  let savedAtSequence = 0;
  let recentEvents: TickEvent[] = [];
  const stats: TickStats[] = [];
  const flowsByTick = new Map<number, readonly (readonly number[])[]>();
  const decisionsByTick = new Map<number, { due: number; fallbacks: number }>();
  const decisionRecords: DecisionRecord[] = [];
  const capture = options.captureArtifacts === true;
  const snapshotStride = Math.max(1, options.snapshotStride ?? config.schedule.snapshotStride);
  const capturedEvents: TickEvent[] = [];
  const executionsByTick = new Map<number, readonly ExecutionRecord[]>();
  const snapshots: Snapshot[] = capture ? [captureSnapshot(state)] : [];
  if (checkpoint !== undefined) {
    // 恢复语义与同步版一致：meta 三元组（cellKey/seed/configHash）不匹配抛错；
    // 损坏按不存在处理（确定性重跑）；前段决策日志随检查点恢复（live 审计链不中断）。
    const loaded = await loadRunProgressAsync(checkpoint.host, checkpoint.path, {
      cellKey: checkpoint.cellKey,
      seed: validatedSeed,
      configHash: computeConfigHash(config),
    });
    if (loaded !== null) {
      state = loaded.state;
      assertCheckpointSnapshot(state, config, validatedSeed);
      savedAtSequence = loaded.meta.savedAtSequence;
      for (const row of loaded.progress.stats) {
        stats.push(row);
      }
      for (const entry of loaded.progress.flows) {
        flowsByTick.set(entry.tick, entry.matrix);
      }
      for (const entry of loaded.progress.decisions) {
        decisionsByTick.set(entry.tick, { due: entry.due, fallbacks: entry.fallbacks });
      }
      for (const record of loaded.decisionRecords) {
        decisionRecords.push(record);
      }
      recentEvents = [...(loaded.recentEvents ?? [])];
    }
  }
  const classCount = config.population.classCount;
  const maxTicks = options.maxTicks ?? config.schedule.totalTicks;
  const signal = options.signal ?? new AbortController().signal;
  let endReason: string | null = null;
  let endTick = state.society.tick;
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
    if (capture) {
      capturedEvents.push(...result.events);
      executionsByTick.set(tick, result.executions);
      if ((tick + 1) % snapshotStride === 0) {
        snapshots.push(captureSnapshot(state));
      }
    }
    if (checkpoint !== undefined && state.society.tick % checkpoint.everyTicks === 0) {
      savedAtSequence += 1;
      // 异步路径直接 await 宿主写；取消/致命失败不落盘本次进度（保留上一完整点）。
      await saveRunProgressAsync(checkpoint.host, checkpoint.path, {
        schemaVersion: 'run-progress-v1',
        meta: {
          cellKey: checkpoint.cellKey,
          seed: validatedSeed,
          configHash: computeConfigHash(config),
          tickCompleted: state.society.tick,
          savedAtSequence,
        },
        snapshot: captureSnapshot(state),
        progress: {
          stats,
          flows: [...flowsByTick].map(([flowTick, matrix]) => ({ tick: flowTick, matrix })),
          decisions: [...decisionsByTick].map(([decisionTick, value]) => ({
            tick: decisionTick,
            due: value.due,
            fallbacks: value.fallbacks,
          })),
        },
        decisionRecords,
        recentEvents,
      });
    }
    if (endReason !== null) {
      break;
    }
  }
  // run 正常结束（引擎 endReason 或到达 totalTicks）后移除进度检查点；
  // 取消（cancelled）与 maxTicks 护栏停止保留检查点供续跑。
  if (
    checkpoint !== undefined &&
    !cancelled &&
    (endReason !== null || state.society.tick >= config.schedule.totalTicks)
  ) {
    await removeRunProgressAsync(checkpoint.host, checkpoint.path);
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
    ...(capture
      ? {
          capturedEvents,
          executionsByTick,
          snapshots: ensureFinalSnapshot(snapshots, state),
        }
      : {}),
  });
}

export { POLICY_VERSION_MOCK, POLICY_VERSION_RANDOM };
