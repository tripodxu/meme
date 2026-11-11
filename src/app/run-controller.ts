import { validateRunConfig } from '../core/config/validate.js';
import type { RunConfig } from '../core/config/types.js';
import { StratifyError, errorCodes } from '../core/control/errors.js';
import { asSeed, type AgentId, type Seed } from '../core/control/ids.js';
import { step, type StepDecisions } from '../core/engine/engine.js';
import type { TickEvent } from '../core/events.js';
import { computeActionSetHash, enumerateLegalActions } from '../core/legal-actions.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { deriveInitialPopulation } from '../core/init/population.js';
import { createSimulation } from '../core/init/simulation.js';
import type { SimState } from '../core/model/state.js';
import type { Snapshot } from '../core/replay/snapshot.js';
import { captureSnapshot, restoreSnapshot } from '../core/replay/snapshot.js';
import { computeInitialPopulationHash } from '../core/hash/state-hash.js';
import { MockPolicy, MockPolicyV2, RandomPolicy } from '../decision/policies.js';
import type { DecisionPolicy } from '../decision/policy.js';
import { buildDecisionState, computeDecisionStateHash } from '../decision/serialize.js';
import type { DecisionRecord, ExecutionRecord } from '../decision/types.js';
import { createBrowserLivePolicy, type BrowserLiveOptions } from './live-policy.js';
import type {
  ControllerSnapshot,
  OfflinePolicyId,
  ReplayInfo,
  RunFailure,
  RunIssue,
  RunStatus,
  WebRunBundle,
} from './types.js';

const MAX_STATS = 50_000;
const MAX_EVENTS = 500;
const MAX_DECISIONS = 50_000;

export interface RunControllerOptions {
  readonly policy?: OfflinePolicyId;
  readonly live?: BrowserLiveOptions;
  readonly runId?: string;
  readonly config?: RunConfig;
  readonly seed?: string;
  /** 每帧/每片的计算预算；默认 10ms（02 §5）。 */
  readonly sliceBudgetMs?: number;
  readonly onUpdate?: (snapshot: ControllerSnapshot) => void;
}

export interface PrepareResult {
  readonly ok: boolean;
  readonly issues: readonly RunIssue[];
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function yieldToMain(): Promise<void> {
  // 后台标签页会暂停 requestAnimationFrame；用定时器保证推进循环不被宿主节流卡死，
  // 浏览器仍会在每片之间获得绘制机会（02 §5）。
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createPolicy(policy: OfflinePolicyId, live?: BrowserLiveOptions): DecisionPolicy {
  if (policy === 'mock-weighted-v1') return new MockPolicy();
  if (policy === 'mock-weighted-v2') return new MockPolicyV2();
  if (policy === 'random-uniform-v1') return new RandomPolicy();
  if (live === undefined) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'jev_live 需要内存中的 API Key、模型与预算配置',
    );
  }
  return createBrowserLivePolicy(live).policy;
}

function localRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `local-${crypto.randomUUID()}`;
  }
  return `local-${Date.now().toString(36)}-${Math.floor(now()).toString(36)}`;
}

function replayMode(policy: OfflinePolicyId): ReplayInfo['mode'] {
  if (policy === 'jev_live') return 'jev_replay';
  return policy === 'random-uniform-v1' ? 'random_replay' : 'mock_replay';
}

/**
 * 浏览器端 12 态 RunController（02 §5）：
 * - 单推进循环 + generation；pause/reset 使旧异步响应失效；
 * - 时间片调度，每片让出主线程，UI 不被长循环锁死；
 * - 只调用 core/decision，不复制任何结算公式；
 * - 完整日志与最近事件分界：统计数据有界、决策日志有界并可导出。
 */
export class RunController {
  private readonly listeners = new Set<(snapshot: ControllerSnapshot) => void>();
  private sliceBudgetMs: number;
  private speedDelayMs = 0;
  private abortController = new AbortController();
  private generation = 0;
  private loopActive = false;
  private idleWaiters: Array<() => void> = [];
  private status: RunStatus = 'idle';
  private policyId: OfflinePolicyId;
  private policy: DecisionPolicy;
  /** 仅内存；不进入 snapshot/导出/IndexedDB。 */
  private liveOptions: BrowserLiveOptions | undefined;
  private config: RunConfig | null = null;
  private seed: Seed | null = null;
  private runId: string | null = null;
  private state: SimState | null = null;
  private stats: TickStats[] = [];
  private events: TickEvent[] = [];
  private decisions: DecisionRecord[] = [];
  private executions: ExecutionRecord[] = [];
  private decisionsTruncated = false;
  private initialSnapshot: Snapshot | null = null;
  private latestSnapshot: Snapshot | null = null;
  private initialPopulationHash: string | null = null;
  private endReason: 'scheduled' | 'extinct' | null = null;
  private failure: RunFailure | null = null;
  private issues: RunIssue[] = [];
  private replay: ReplayInfo | null = null;
  private replayDecisions: Map<number, Map<AgentId, string>> | null = null;

  /** 速度只改变片间让出节奏，不改变结算语义或 tick 顺序。 */
  setSpeed(multiplier: number): void {
    this.speedDelayMs = multiplier <= 1 ? 60 : multiplier <= 5 ? 12 : 0;
    this.sliceBudgetMs = multiplier >= 20 ? 14 : 10;
  }

  constructor(options: RunControllerOptions = {}) {
    this.policyId = options.policy ?? 'mock-weighted-v1';
    this.liveOptions = options.live;
    this.policy = createPolicy(this.policyId, this.liveOptions);
    this.sliceBudgetMs = options.sliceBudgetMs ?? 10;
    if (options.runId !== undefined) this.runId = options.runId;
    if (options.config !== undefined) {
      this.prepare(options.config, options.seed ?? 'web-seed-001', options.policy, options.live);
    }
    if (options.onUpdate !== undefined) this.subscribe(options.onUpdate);
  }

  /** 校验并冻结配置；成功进入 ready，失败进入 invalid，不创建任何状态。 */
  prepare(
    config: RunConfig,
    seed: string,
    policy: OfflinePolicyId = this.policyId,
    live: BrowserLiveOptions | undefined = this.liveOptions,
  ): PrepareResult {
    this.generation += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.status = 'validating';
    this.issues = [];
    this.failure = null;
    this.emit();

    const result = validateRunConfig(config);
    if (!result.ok) {
      this.status = 'invalid';
      this.issues = result.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      }));
      this.config = null;
      this.state = null;
      this.emit();
      return { ok: false, issues: this.issues };
    }
    try {
      const validSeed = asSeed(seed);
      const state = createSimulation(result.config, validSeed);
      this.config = result.config;
      this.seed = validSeed;
      this.policyId = policy;
      this.liveOptions = live;
      this.policy = createPolicy(policy, live);
      this.state = state;
      this.runId = this.runId ?? localRunId();
      this.stats = [];
      this.events = [];
      this.decisions = [];
      this.decisionsTruncated = false;
      this.endReason = null;
      this.replay = null;
      this.replayDecisions = null;
      this.initialSnapshot = captureSnapshot(state);
      this.latestSnapshot = this.initialSnapshot;
      const population = deriveInitialPopulation(result.config, validSeed);
      this.initialPopulationHash = computeInitialPopulationHash(validSeed, population);
      this.status = 'ready';
      this.emit();
      return { ok: true, issues: [] };
    } catch (error) {
      this.status = 'failed';
      this.failure = this.makeFailure(error, 'validating');
      this.emit();
      return {
        ok: false,
        issues: [{ path: '$', message: this.failure.message, code: this.failure.code }],
      };
    }
  }

  subscribe(listener: (snapshot: ControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ControllerSnapshot {
    const tick = this.state?.society.tick ?? 0;
    const aliveCount = this.state?.society.agents.filter((agent) => agent.alive).length ?? 0;
    return {
      status: this.status,
      generation: this.generation,
      runId: this.runId,
      seed: this.seed,
      policy: this.policyId,
      config: this.config,
      tick,
      totalTicks: this.config?.schedule.totalTicks ?? 0,
      aliveCount,
      configHash: this.state?.configHash ?? null,
      paramsHash: this.state?.paramsHash ?? null,
      initialPopulationHash: this.initialPopulationHash,
      latestStats: this.stats[this.stats.length - 1] ?? null,
      stats: this.stats,
      events: this.events,
      decisions: this.decisions,
      executions: this.executions,
      endReason: this.endReason,
      failure: this.failure,
      issues: this.issues,
      snapshotTick: this.latestSnapshot?.state.society.tick ?? null,
      replay: this.replay,
      decisionsTruncated: this.decisionsTruncated,
    };
  }

  getState(): SimState | null {
    return this.state;
  }

  getReplayBundle(): WebRunBundle | null {
    return this.exportBundle(false);
  }

  start(): void {
    if (this.status !== 'ready' && this.status !== 'paused') return;
    if (this.loopActive) return;
    const gen = ++this.generation;
    this.abortController = new AbortController();
    this.status = 'running';
    this.emit();
    void this.runLoop(gen);
  }

  pause(): void {
    if (this.status !== 'running' && this.status !== 'awaiting_decision') return;
    this.generation += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.status = 'paused';
    this.emit();
  }

  async stepOnce(): Promise<void> {
    if (this.status !== 'ready' && this.status !== 'paused') return;
    const gen = ++this.generation;
    this.abortController = new AbortController();
    this.status = 'settling_tick';
    this.emit();
    try {
      const finished = await this.advanceOne(gen, false);
      if (!finished && !this.isTerminal()) {
        this.status = 'paused';
      }
      this.emit();
    } catch (error) {
      this.fail(error, 'settling_tick');
    }
  }

  stop(): void {
    if (
      this.status !== 'running' &&
      this.status !== 'paused' &&
      this.status !== 'awaiting_decision' &&
      this.status !== 'settling_tick'
    ) {
      return;
    }
    this.generation += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.status = 'cancelled';
    this.emit();
  }

  reset(): void {
    this.generation += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.status = 'idle';
    this.config = null;
    this.seed = null;
    this.runId = null;
    this.state = null;
    this.stats = [];
    this.events = [];
    this.decisions = [];
    this.executions = [];
    this.decisionsTruncated = false;
    this.initialSnapshot = null;
    this.latestSnapshot = null;
    this.initialPopulationHash = null;
    this.endReason = null;
    this.failure = null;
    this.issues = [];
    this.replay = null;
    this.replayDecisions = null;
    this.emit();
  }

  /** 导出完整离线 run；`finalOnly=false` 时保留初始快照以支持从头回放。 */
  exportBundle(includeHistory = true): WebRunBundle | null {
    if (this.config === null || this.seed === null || this.runId === null || this.state === null) {
      return null;
    }
    const latest = this.latestSnapshot ?? captureSnapshot(this.state);
    return {
      schemaVersion: 'stratify-web-run-v1',
      exportedAt: new Date().toISOString(),
      runId: this.runId,
      seed: this.seed,
      policy: this.policyId,
      status: this.status,
      endReason: this.endReason,
      config: this.config,
      configHash: this.state.configHash,
      paramsHash: this.state.paramsHash,
      initialPopulationHash: this.initialPopulationHash ?? '',
      initialSnapshot: includeHistory ? this.initialSnapshot : null,
      latestSnapshot: latest,
      stats: includeHistory ? [...this.stats] : this.stats.slice(-1),
      events: includeHistory ? [...this.events] : this.events.slice(-20),
      decisions: includeHistory ? [...this.decisions] : [],
      decisionsTruncated: this.decisionsTruncated,
    };
  }

  /** 导入 bundle：先校验 schema/config/state hash，失败不覆盖当前实验。 */
  importBundle(value: unknown): PrepareResult {
    const parsed = parseBundle(value);
    if (!parsed.ok) {
      return { ok: false, issues: parsed.issues };
    }
    const bundle = parsed.bundle;
    try {
      const configResult = validateRunConfig(bundle.config);
      if (!configResult.ok) {
        return {
          ok: false,
          issues: configResult.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
            code: issue.code,
          })),
        };
      }
      const validSeed = asSeed(bundle.seed);
      const initialSnapshotValue = bundle.initialSnapshot;
      const latestSnapshotValue = bundle.latestSnapshot;
      const state = restoreSnapshot(initialSnapshotValue ?? latestSnapshotValue);
      const population = deriveInitialPopulation(configResult.config, validSeed);
      this.generation += 1;
      this.abortController.abort();
      this.abortController = new AbortController();
      this.status = 'paused';
      this.config = configResult.config;
      this.seed = validSeed;
      this.runId = bundle.runId;
      this.policyId = bundle.policy;
      // 导入 live bundle 时只回放已保存的 selectedAction；策略不会被调用，
      // 用一个无副作用的确定性实现占位，避免要求用户重新提供 Key。
      this.policy = bundle.policy === 'jev_live' ? new MockPolicyV2() : createPolicy(bundle.policy);
      this.state = state;
      this.stats = [...bundle.stats];
      this.events = [...bundle.events];
      this.decisions = [...bundle.decisions];
      this.decisionsTruncated = bundle.decisionsTruncated;
      this.initialSnapshot = initialSnapshotValue;
      this.latestSnapshot = latestSnapshotValue;
      this.initialPopulationHash = computeInitialPopulationHash(validSeed, population);
      this.endReason = bundle.endReason;
      this.failure = null;
      this.issues = [];
      this.replay = {
        source: 'bundle',
        policyVersion: bundle.policy,
        fromTick: state.society.tick,
        mode: replayMode(bundle.policy),
        replayInvalid: 0,
      };
      this.replayDecisions = groupDecisions(bundle.decisions);
      this.emit();
      return { ok: true, issues: [] };
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            path: '$',
            message: error instanceof Error ? error.message : String(error),
            code: 'import_invalid',
          },
        ],
      };
    }
  }

  /** 从导入的初始快照按决策日志回放；不调用策略、不发 live 请求。 */
  startReplay(): void {
    if (this.replay === null || this.replayDecisions === null) return;
    if (this.status !== 'paused' && this.status !== 'ready') return;
    if (this.loopActive) return;
    const gen = ++this.generation;
    this.status = 'replaying';
    this.emit();
    void this.replayLoop(gen);
  }

  private async runLoop(gen: number): Promise<void> {
    this.loopActive = true;
    try {
      while (this.status === 'running' && this.generation === gen && this.state !== null) {
        const started = now();
        while (
          this.status === 'running' &&
          this.generation === gen &&
          now() - started < this.sliceBudgetMs
        ) {
          const finished = await this.advanceOne(gen, true);
          if (finished) break;
        }
        this.emit();
        if (this.status === 'running') await this.pauseBetweenSlices();
      }
    } finally {
      this.loopActive = false;
      this.resolveIdle();
    }
  }

  private async replayLoop(gen: number): Promise<void> {
    this.loopActive = true;
    try {
      while (this.status === 'replaying' && this.generation === gen && this.state !== null) {
        const started = now();
        while (
          this.status === 'replaying' &&
          this.generation === gen &&
          now() - started < this.sliceBudgetMs
        ) {
          const finished = await this.advanceReplay(gen);
          if (finished) break;
        }
        this.emit();
        if (this.status === 'replaying') await this.pauseBetweenSlices();
      }
    } finally {
      this.loopActive = false;
      this.resolveIdle();
    }
  }

  private isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'failed';
  }

  private async pauseBetweenSlices(): Promise<void> {
    if (this.speedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.speedDelayMs));
    }
    await yieldToMain();
  }

  private async advanceOne(gen: number, fromLoop: boolean): Promise<boolean> {
    if (this.state === null || this.config === null || this.runId === null) return true;
    if (this.state.society.tick >= this.config.schedule.totalTicks) {
      this.finish('scheduled');
      return true;
    }
    const due =
      this.state.society.tick % this.config.decision.interval === 0
        ? this.state.society.agents.filter((agent) => agent.alive)
        : [];
    let decisions: StepDecisions = new Map();
    if (due.length > 0) {
      if (fromLoop) {
        this.status = 'awaiting_decision';
        this.emit();
      }
      const collected = await this.collectDecisions(due, gen);
      if (collected === null) return true;
      decisions = collected;
      if (this.generation !== gen) return true;
      if (fromLoop) {
        this.status = 'settling_tick';
        this.emit();
      }
    }
    const result = step(this.state, decisions, { runId: this.runId });
    this.state = result.state;
    this.pushStats(result.stats);
    this.pushEvents(result.events);
    this.pushExecutions(result.executions);
    if (
      this.latestSnapshot === null ||
      this.state.society.tick % this.config.schedule.snapshotStride === 0
    ) {
      this.latestSnapshot = captureSnapshot(this.state);
    }
    if (result.endReason !== null) {
      this.finish(result.endReason);
      return true;
    }
    if (this.state.society.tick >= this.config.schedule.totalTicks) {
      this.finish('scheduled');
      return true;
    }
    if (fromLoop && !this.isTerminal()) this.status = 'running';
    return false;
  }

  private async collectDecisions(
    due: readonly SimState['society']['agents'][number][],
    gen: number,
  ): Promise<StepDecisions | null> {
    if (this.state === null || this.seed === null || this.runId === null) return null;
    const decisions = new Map<AgentId, { selectedAction: string; isFallback?: boolean }>();
    const recent = this.events.slice(-5);
    for (const agent of due) {
      if (this.generation !== gen || this.status === 'cancelled') return null;
      const legal = enumerateLegalActions(this.state, agent.id);
      const decisionState = buildDecisionState(this.state, agent.id, legal, recent);
      const stateHash = computeDecisionStateHash(decisionState);
      const actionSetHash = computeActionSetHash(legal.actions);
      const record = await this.policy.decide(
        {
          runId: this.runId,
          seed: this.seed,
          config: this.state.config,
          tick: this.state.society.tick,
          agentId: agent.id,
          stateHash,
          actionSetHash,
          legal,
          state: decisionState,
          simState: this.state,
          topK: this.state.config.decision.topK,
          requestedModel: 'mock',
          promptVersion: null,
          promptStyle: 'neutral',
          recentEvents: recent,
        },
        this.abortController.signal,
      );
      if (this.generation !== gen) return null;
      this.pushDecision(record);
      decisions.set(agent.id, {
        selectedAction: record.selectedAction,
        isFallback: record.source === 'fallback',
      });
    }
    return decisions;
  }

  private async advanceReplay(gen: number): Promise<boolean> {
    if (this.state === null || this.config === null || this.runId === null) return true;
    if (this.state.society.tick >= this.config.schedule.totalTicks) {
      this.finish('scheduled');
      return true;
    }
    const tick = this.state.society.tick;
    const due =
      tick % this.config.decision.interval === 0
        ? this.state.society.agents.filter((agent) => agent.alive)
        : [];
    const decisions = new Map<AgentId, { selectedAction: string; isFallback?: boolean }>();
    const saved = this.replayDecisions?.get(tick);
    for (const agent of due) {
      const selected = saved?.get(agent.id);
      if (selected === undefined) {
        decisions.set(agent.id, { selectedAction: 'accumulate', isFallback: true });
        if (this.replay !== null) {
          this.replay = { ...this.replay, replayInvalid: this.replay.replayInvalid + 1 };
        }
      } else {
        decisions.set(agent.id, { selectedAction: selected });
      }
    }
    if (this.generation !== gen) return true;
    const result = step(this.state, decisions, { runId: this.runId });
    this.state = result.state;
    this.pushStats(result.stats);
    this.pushEvents(result.events);
    this.pushExecutions(result.executions);
    if (
      this.latestSnapshot === null ||
      this.state.society.tick % this.config.schedule.snapshotStride === 0
    ) {
      this.latestSnapshot = captureSnapshot(this.state);
    }
    if (result.endReason !== null) {
      this.finish(result.endReason);
      return true;
    }
    if (this.state.society.tick >= this.config.schedule.totalTicks) {
      this.finish('scheduled');
      return true;
    }
    return false;
  }

  private pushStats(stats: TickStats): void {
    this.stats.push(stats);
    if (this.stats.length > MAX_STATS) this.stats.splice(0, this.stats.length - MAX_STATS);
  }

  private pushEvents(events: readonly TickEvent[]): void {
    for (const event of events) {
      this.events.push(event);
    }
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  private pushExecutions(records: readonly ExecutionRecord[]): void {
    for (const record of records) this.executions.push(record);
    if (this.executions.length > MAX_DECISIONS) {
      this.executions.splice(0, this.executions.length - MAX_DECISIONS);
    }
  }

  private pushDecision(record: DecisionRecord): void {
    this.decisions.push(record);
    if (this.decisions.length > MAX_DECISIONS) {
      this.decisions.shift();
      this.decisionsTruncated = true;
    }
  }

  private finish(reason: 'scheduled' | 'extinct'): void {
    this.endReason = reason;
    this.status = 'completed';
    if (this.state !== null) this.latestSnapshot = captureSnapshot(this.state);
    this.emit();
  }

  private fail(error: unknown, phase: RunStatus): void {
    this.failure = this.makeFailure(error, phase);
    this.status = 'failed';
    this.emit();
  }

  private makeFailure(error: unknown, phase: RunStatus): RunFailure {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 'run_failed',
      message,
      phase,
      diagnostics: {
        runId: this.runId,
        tick: this.state?.society.tick ?? null,
        configHash: this.state?.configHash ?? null,
        policy: this.policyId,
      },
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    if (
      !this.loopActive &&
      this.status !== 'running' &&
      this.status !== 'awaiting_decision' &&
      this.status !== 'replaying'
    ) {
      this.resolveIdle();
    }
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 测试/脚本用：等待当前推进循环结束。 */
  whenIdle(): Promise<void> {
    if (
      this.status !== 'running' &&
      this.status !== 'awaiting_decision' &&
      this.status !== 'replaying' &&
      !this.loopActive
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

function groupDecisions(decisions: readonly DecisionRecord[]): Map<number, Map<AgentId, string>> {
  const grouped = new Map<number, Map<AgentId, string>>();
  for (const record of decisions) {
    const tick = grouped.get(record.tick) ?? new Map<AgentId, string>();
    tick.set(record.agentId as AgentId, record.selectedAction);
    grouped.set(record.tick, tick);
  }
  return grouped;
}

/** 导入信任边界：先看 schema，再交给 restoreSnapshot/validateRunConfig 校验内容。 */
function parseBundle(
  value: unknown,
): { ok: true; bundle: WebRunBundle } | { ok: false; issues: readonly RunIssue[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '$', message: '导入文件必须是 JSON 对象' }] };
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== 'stratify-web-run-v1') {
    return {
      ok: false,
      issues: [
        {
          path: '$.schemaVersion',
          message: `未知导入 schemaVersion: ${String(record['schemaVersion'])}`,
          code: 'unknown_version',
        },
      ],
    };
  }
  const policy = record['policy'];
  if (
    policy !== 'mock-weighted-v1' &&
    policy !== 'mock-weighted-v2' &&
    policy !== 'random-uniform-v1' &&
    policy !== 'jev_live'
  ) {
    return {
      ok: false,
      issues: [{ path: '$.policy', message: '仅支持已登记策略', code: 'unsupported_policy' }],
    };
  }
  const latestSnapshot = record['latestSnapshot'];
  if (typeof latestSnapshot !== 'object' || latestSnapshot === null) {
    return {
      ok: false,
      issues: [{ path: '$.latestSnapshot', message: '缺少最终快照', code: 'missing_snapshot' }],
    };
  }
  const initialSnapshot = record['initialSnapshot'];
  return {
    ok: true,
    bundle: {
      schemaVersion: 'stratify-web-run-v1',
      exportedAt: typeof record['exportedAt'] === 'string' ? record['exportedAt'] : '',
      runId: typeof record['runId'] === 'string' ? record['runId'] : 'local-import',
      seed: typeof record['seed'] === 'string' ? record['seed'] : '',
      policy,
      status: 'paused',
      endReason:
        record['endReason'] === 'scheduled' || record['endReason'] === 'extinct'
          ? record['endReason']
          : null,
      config: record['config'] as WebRunBundle['config'],
      configHash: typeof record['configHash'] === 'string' ? record['configHash'] : '',
      paramsHash: typeof record['paramsHash'] === 'string' ? record['paramsHash'] : '',
      initialPopulationHash:
        typeof record['initialPopulationHash'] === 'string' ? record['initialPopulationHash'] : '',
      initialSnapshot:
        typeof initialSnapshot === 'object' && initialSnapshot !== null
          ? (initialSnapshot as Snapshot)
          : null,
      latestSnapshot: latestSnapshot as Snapshot,
      stats: Array.isArray(record['stats']) ? (record['stats'] as TickStats[]) : [],
      events: Array.isArray(record['events']) ? (record['events'] as TickEvent[]) : [],
      decisions: Array.isArray(record['decisions'])
        ? (record['decisions'] as DecisionRecord[])
        : [],
      decisionsTruncated: record['decisionsTruncated'] === true,
    },
  };
}
