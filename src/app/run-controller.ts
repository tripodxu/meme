import { validateRunConfig } from '../core/config/validate.js';
import type { RunConfig } from '../core/config/types.js';
import { StratifyError, errorCodes } from '../core/control/errors.js';
import { asSeed, type AgentId, type Seed } from '../core/control/ids.js';
import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';
import { step, type StepDecisions } from '../core/engine/engine.js';
import type { TickEvent } from '../core/events.js';
import { computeActionSetHash, enumerateLegalActions } from '../core/legal-actions.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { deriveInitialPopulation } from '../core/init/population.js';
import { createSimulation } from '../core/init/simulation.js';
import { agentIndexFromId } from '../core/model/agent.js';
import { decodeSimState, encodeSimState } from '../core/model/serialize.js';
import type { SimState } from '../core/model/state.js';
import type { Snapshot } from '../core/replay/snapshot.js';
import { captureSnapshot, restoreSnapshot } from '../core/replay/snapshot.js';
import { computeInitialPopulationHash } from '../core/hash/state-hash.js';
import { decideMockWeightedV2 } from '../decision/mock.js';
import { MockPolicy, MockPolicyV2, RandomPolicy } from '../decision/policies.js';
import type { DecisionPolicy } from '../decision/policy.js';
import {
  buildDecisionState,
  computeDecisionStateHash,
  PROMPT_VERSION,
} from '../decision/serialize.js';
import type { DecisionRecord, ExecutionRecord, PromptStyle } from '../decision/types.js';
import { createBrowserLivePolicy, type BrowserLiveOptions } from './live-policy.js';
import { needOf } from './view-model.js';
import type {
  AvatarDecisionPrompt,
  ControllerSnapshot,
  ForkProvenance,
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
/** 摊还裁剪批次：超出上限 2,048 条时一次性切片，彻底避免每次 push 调用 shift() 的 O(M) 平移。 */
const COMPACT_SLACK = 2_048;
const OFFLINE_PLACEHOLDER_HASH =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

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

export interface ForkPerturbationResult {
  readonly ok: boolean;
  readonly message: string;
  readonly baselineBundle: WebRunBundle | null;
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

function countAlive(state: SimState | null): number {
  if (state === null) return 0;
  let count = 0;
  for (const agent of state.society.agents) {
    if (agent.alive) count += 1;
  }
  return count;
}

/**
 * 浏览器端高性能 12 态 RunController（02 §5）：
 * - 单推进循环 + generation；pause/reset 使旧异步响应失效；
 * - 离线策略走同步零哈希快路径（避免 O(N²) 决策状态构造与 JCS SHA-256）；
 * - O(1) 摊还缓冲裁剪与增量计数器；
 * - 支持沙盒化身手动抉择（只从核心合法行动集中做 Choice）与受控微扰分叉。
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
  private aliveCount = 0;
  private cumulativeDeaths = 0;
  private stats: TickStats[] = [];
  private events: TickEvent[] = [];
  private decisions: DecisionRecord[] = [];
  private executions: ExecutionRecord[] = [];
  private decisionsTruncated = false;
  private initialSnapshot: Snapshot | null = null;
  private latestSnapshot: Snapshot | null = null;
  private periodicSnapshots: Snapshot[] = [];
  private promptStyle: PromptStyle = 'neutral';
  private initialPopulationHash: string | null = null;
  private endReason: 'scheduled' | 'extinct' | null = null;
  private failure: RunFailure | null = null;
  private issues: RunIssue[] = [];
  private replay: ReplayInfo | null = null;
  private replayDecisions: Map<number, Map<AgentId, string>> | null = null;
  private decisionProgress: ControllerSnapshot['decisionProgress'] = null;

  /** 沙盒玩家化身控制（不改变任何核心结算公式）。 */
  private avatarId: AgentId | null = null;
  private avatarInteractive = false;
  private pendingAvatarPrompt: AvatarDecisionPrompt | null = null;
  private avatarResolver: ((action: string | null) => void) | null = null;
  private forkProvenance: ForkProvenance | null = null;

  /** 速度只改变片间让出节奏，不改变结算语义或 tick 顺序。 */
  setSpeed(multiplier: number): void {
    this.speedDelayMs = multiplier === 0 ? 0 : multiplier >= 20 ? 0 : multiplier >= 5 ? 12 : 60;
    this.sliceBudgetMs = multiplier === 0 ? 16 : multiplier >= 20 ? 12 : 10;
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

  /** 设置或切换玩家化身及是否开启手动抉择挂起。 */
  setAvatar(agentId: AgentId | null, interactive = this.avatarInteractive): void {
    this.avatarId = agentId;
    this.avatarInteractive = interactive;
    // 若关闭手动抉择时正处于等待玩家出牌状态，自动交由当前离线先验选牌继续推进
    if (!interactive && this.pendingAvatarPrompt !== null && this.avatarResolver !== null) {
      const prompt = this.pendingAvatarPrompt;
      const best =
        Object.entries(prompt.advisorProbabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ??
        prompt.legal.actions[0] ??
        'accumulate';
      this.submitAvatarAction(best);
      return;
    }
    this.emit();
  }

  /** 玩家在沙盒界面提交本轮合法行动抉择。 */
  submitAvatarAction(actionKey: string): boolean {
    if (this.pendingAvatarPrompt === null || this.avatarResolver === null) return false;
    if (!this.pendingAvatarPrompt.legal.actions.includes(actionKey)) return false;
    const resolve = this.avatarResolver;
    this.avatarResolver = null;
    this.pendingAvatarPrompt = null;
    resolve(actionKey);
    return true;
  }

  private cancelAvatarPrompt(): void {
    if (this.avatarResolver !== null) {
      const resolve = this.avatarResolver;
      this.avatarResolver = null;
      this.pendingAvatarPrompt = null;
      resolve(null);
    } else {
      this.pendingAvatarPrompt = null;
    }
  }

  /** 校验并冻结配置；成功进入 ready，失败进入 invalid，不创建任何状态。 */
  prepare(
    config: RunConfig,
    seed: string,
    policy: OfflinePolicyId = this.policyId,
    live: BrowserLiveOptions | undefined = this.liveOptions,
  ): PrepareResult {
    this.generation += 1;
    this.cancelAvatarPrompt();
    this.abortController.abort();
    this.abortController = new AbortController();
    this.status = 'validating';
    this.issues = [];
    this.failure = null;
    this.decisionProgress = null;
    this.forkProvenance = null;
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
      this.aliveCount = 0;
      this.cumulativeDeaths = 0;
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
      this.promptStyle = live?.promptStyle ?? 'neutral';
      this.policy = createPolicy(policy, live);
      this.state = state;
      this.aliveCount = countAlive(state);
      this.cumulativeDeaths = 0;
      this.runId = localRunId();
      this.stats = [];
      this.events = [];
      this.decisions = [];
      this.executions = [];
      this.decisionsTruncated = false;
      this.endReason = null;
      this.replay = null;
      this.replayDecisions = null;
      this.initialSnapshot = captureSnapshot(state);
      this.latestSnapshot = this.initialSnapshot;
      this.periodicSnapshots = [this.initialSnapshot];
      const population = deriveInitialPopulation(result.config, validSeed);
      this.initialPopulationHash = computeInitialPopulationHash(validSeed, population);
      // 若此前选中的化身不在新人口中，清空或重绑定
      if (
        this.avatarId !== null &&
        !state.society.agents.some((agent) => agent.id === this.avatarId)
      ) {
        this.avatarId = null;
      }
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

  /**
   * 受控平行宇宙分叉（06 §6 & §7）：
   * 保留当前权威快照作为 Baseline bundle 返回，克隆当前世界并仅对指定存活个体施加合法 ΔValue 微扰。
   */
  forkAgentValuePerturbation(agentId: AgentId, deltaValue: number): ForkPerturbationResult {
    if (this.state === null || this.config === null || this.seed === null || this.runId === null) {
      return { ok: false, message: '尚未初始化世界，无法分叉。', baselineBundle: null };
    }
    if (!Number.isFinite(deltaValue) || deltaValue === 0) {
      return { ok: false, message: '微扰增量必须为非零有限数。', baselineBundle: null };
    }
    if (this.status === 'running' || this.status === 'replaying') {
      this.pause();
    }
    const checkpoint = captureSnapshot(this.state);
    const baselineBundle = this.exportBundle(true);
    try {
      const encoded = encodeSimState(this.state);
      const target = encoded.society.agents.find((candidate) => candidate.id === agentId);
      if (target === undefined || !target.alive) {
        return { ok: false, message: `目标个体 ${agentId} 不存在或已故。`, baselineBundle: null };
      }
      const nextValue = Math.max(0, target.value + deltaValue);
      if (nextValue === target.value) {
        return {
          ok: false,
          message: '微扰被精度或非负边界吸收（Value 未发生变化）。',
          baselineBundle: null,
        };
      }
      target.value = nextValue;
      const nextState = decodeSimState(encoded);
      const parentRunId = this.runId;
      this.generation += 1;
      this.cancelAvatarPrompt();
      this.abortController.abort();
      this.abortController = new AbortController();
      this.state = nextState;
      this.runId = localRunId();
      this.latestSnapshot = captureSnapshot(nextState);
      this.replay = null;
      this.replayDecisions = null;
      this.status = 'paused';
      const sign = deltaValue >= 0 ? '+' : '';
      this.forkProvenance = {
        parentRunId,
        forkTick: nextState.society.tick,
        checkpointStateHash: checkpoint.stateHash,
        changedField: `society.agents[${agentId}].value`,
        description: `在 Tick ${nextState.society.tick} 对 ${agentId} 施加单字段微扰 ΔValue=${sign}${deltaValue}`,
      };
      this.emit();
      return {
        ok: true,
        message: `已从 Tick ${nextState.society.tick} 分叉平行宇宙（${agentId} Value ${sign}${deltaValue}）。原世界已存入对比基准。`,
        baselineBundle,
      };
    } catch (error) {
      return {
        ok: false,
        message: `分叉校验未通过：${error instanceof Error ? error.message : String(error)}`,
        baselineBundle: null,
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
    return {
      status: this.status,
      generation: this.generation,
      runId: this.runId,
      seed: this.seed,
      policy: this.policyId,
      promptStyle: this.promptStyle,
      config: this.config,
      tick,
      totalTicks: this.config?.schedule.totalTicks ?? 0,
      aliveCount: this.aliveCount,
      cumulativeDeaths: this.cumulativeDeaths,
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
      availableSnapshotTicks: this.periodicSnapshots.map((snap) => snap.state.society.tick),
      replay: this.replay,
      decisionsTruncated: this.decisionsTruncated,
      decisionProgress: this.decisionProgress,
      avatarId: this.avatarId,
      avatarInteractive: this.avatarInteractive,
      pendingAvatarPrompt: this.pendingAvatarPrompt,
      forkProvenance: this.forkProvenance,
    };
  }

  /** 跳转到已记录的历史周期快照点，裁剪后续日志并停在 paused 态（06 §4）。 */
  jumpToSnapshot(targetTick: number): boolean {
    const snap = this.periodicSnapshots.find((item) => item.state.society.tick === targetTick);
    if (snap === undefined || this.config === null) return false;
    try {
      const restored = restoreSnapshot(snap);
      this.generation += 1;
      this.cancelAvatarPrompt();
      this.abortController.abort();
      this.abortController = new AbortController();
      this.decisionProgress = null;
      this.state = restored;
      this.latestSnapshot = snap;
      this.aliveCount = countAlive(restored);
      this.stats = this.stats.filter((row) => row.tick < targetTick);
      this.cumulativeDeaths = this.stats.reduce((sum, row) => sum + row.deathCount, 0);
      this.events = this.events.filter((ev) => ev.tick < targetTick);
      this.decisions = this.decisions.filter((dec) => dec.tick < targetTick);
      this.executions = this.executions.filter((ex) => ex.tick < targetTick);
      this.periodicSnapshots = this.periodicSnapshots.filter(
        (item) => item.state.society.tick <= targetTick,
      );
      this.endReason = null;
      this.status = 'paused';
      this.emit();
      return true;
    } catch {
      return false;
    }
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
    if (
      this.status !== 'running' &&
      this.status !== 'awaiting_decision' &&
      this.status !== 'replaying'
    ) {
      return;
    }
    this.generation += 1;
    this.cancelAvatarPrompt();
    this.abortController.abort();
    this.abortController = new AbortController();
    this.decisionProgress = null;
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
      if (!finished && !this.isTerminal() && this.generation === gen) {
        this.status = 'paused';
      }
      this.emit();
    } catch (error) {
      this.fail(error, 'settling_tick');
    }
  }

  /** 快进至下一个决策周期（方便玩家化身或试验台按决策步观察）。 */
  async stepDecisionCycle(): Promise<void> {
    if (this.status !== 'ready' && this.status !== 'paused') return;
    if (this.config === null || this.state === null) return;
    const interval = Math.max(1, this.config.decision.interval);
    const current = this.state.society.tick;
    const targetTick = Math.min(
      this.config.schedule.totalTicks,
      (Math.floor(current / interval) + 1) * interval,
    );
    const gen = ++this.generation;
    this.abortController = new AbortController();
    this.status = 'settling_tick';
    this.emit();
    try {
      while (
        this.state !== null &&
        this.state.society.tick < targetTick &&
        this.generation === gen &&
        !this.isTerminal()
      ) {
        const finished = await this.advanceOne(gen, false);
        if (finished) break;
      }
      if (!this.isTerminal() && this.generation === gen) {
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
      this.status !== 'settling_tick' &&
      this.status !== 'replaying'
    ) {
      return;
    }
    this.generation += 1;
    this.cancelAvatarPrompt();
    this.abortController.abort();
    this.abortController = new AbortController();
    this.decisionProgress = null;
    this.status = 'cancelled';
    this.emit();
  }

  reset(): void {
    this.generation += 1;
    this.cancelAvatarPrompt();
    this.abortController.abort();
    this.abortController = new AbortController();
    this.status = 'idle';
    this.config = null;
    this.seed = null;
    this.runId = null;
    this.state = null;
    this.aliveCount = 0;
    this.cumulativeDeaths = 0;
    this.stats = [];
    this.events = [];
    this.decisions = [];
    this.executions = [];
    this.decisionsTruncated = false;
    this.initialSnapshot = null;
    this.latestSnapshot = null;
    this.periodicSnapshots = [];
    this.initialPopulationHash = null;
    this.endReason = null;
    this.failure = null;
    this.issues = [];
    this.replay = null;
    this.replayDecisions = null;
    this.decisionProgress = null;
    this.forkProvenance = null;
    this.emit();
  }

  /** 导出完整离线 run；`includeHistory=true` 时保留初始快照以支持从头回放。 */
  exportBundle(includeHistory = true): WebRunBundle | null {
    if (this.config === null || this.seed === null || this.runId === null || this.state === null) {
      return null;
    }
    const latest =
      this.latestSnapshot !== null &&
      this.latestSnapshot.state.society.tick === this.state.society.tick
        ? this.latestSnapshot
        : captureSnapshot(this.state);
    this.latestSnapshot = latest;
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
      ...(includeHistory ? { periodicSnapshots: [...this.periodicSnapshots] } : {}),
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
      this.cancelAvatarPrompt();
      this.abortController.abort();
      this.abortController = new AbortController();
      this.status = 'paused';
      this.config = configResult.config;
      this.seed = validSeed;
      this.runId = bundle.runId;
      this.policyId = bundle.policy;
      // 导入 live bundle 时只回放已保存的 selectedAction；策略不会被调用
      this.policy = bundle.policy === 'jev_live' ? new MockPolicyV2() : createPolicy(bundle.policy);
      this.state = state;
      this.aliveCount = countAlive(state);
      this.stats = [...bundle.stats];
      this.cumulativeDeaths = this.stats.reduce((sum, row) => sum + row.deathCount, 0);
      this.events = [...bundle.events];
      this.decisions = [...bundle.decisions];
      this.executions = [];
      this.decisionsTruncated = bundle.decisionsTruncated;
      this.initialSnapshot = initialSnapshotValue;
      this.latestSnapshot = latestSnapshotValue;
      this.periodicSnapshots =
        bundle.periodicSnapshots !== undefined && bundle.periodicSnapshots.length > 0
          ? [...bundle.periodicSnapshots]
          : [initialSnapshotValue, latestSnapshotValue].filter(
              (item): item is Snapshot => item !== null,
            );
      this.initialPopulationHash = computeInitialPopulationHash(validSeed, population);
      this.endReason = bundle.endReason;
      this.failure = null;
      this.issues = [];
      this.decisionProgress = null;
      this.forkProvenance = null;
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
    if (this.initialSnapshot !== null) {
      const resetState = restoreSnapshot(this.initialSnapshot);
      this.state = resetState;
      this.aliveCount = countAlive(resetState);
      this.cumulativeDeaths = 0;
      this.stats = [];
      this.events = [];
      this.executions = [];
      this.endReason = null;
      this.replay = { ...this.replay, fromTick: resetState.society.tick, replayInvalid: 0 };
    }
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
    } catch (error) {
      if (this.generation === gen) {
        this.fail(error, 'running');
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
    } catch (error) {
      if (this.generation === gen) {
        this.fail(error, 'replaying');
      }
    } finally {
      this.loopActive = false;
      this.resolveIdle();
    }
  }

  private isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled';
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
    const isDecisionTick = this.state.society.tick % this.config.decision.interval === 0;
    let decisions: StepDecisions = new Map();
    if (isDecisionTick) {
      const due = this.state.society.agents.filter((agent) => agent.alive);
      if (due.length > 0) {
        const needsAsyncUi =
          this.policyId === 'jev_live' ||
          (this.avatarInteractive &&
            this.avatarId !== null &&
            due.some((agent) => agent.id === this.avatarId));
        if (needsAsyncUi) {
          this.status = 'awaiting_decision';
          this.decisionProgress = { total: due.length, completed: 0, fallbacks: 0 };
          this.emit();
        }
        const collected = await this.collectDecisions(due, gen, needsAsyncUi);
        this.decisionProgress = null;
        if (collected === null) return true;
        decisions = collected;
        if (this.generation !== gen) return true;
        if (needsAsyncUi && fromLoop) {
          this.status = 'settling_tick';
        }
      }
    }
    const result = step(this.state, decisions, { runId: this.runId });
    this.state = result.state;
    this.aliveCount = result.stats.aliveCount;
    this.cumulativeDeaths += result.stats.deathCount;
    this.pushStats(result.stats);
    this.pushEvents(result.events);
    this.pushExecutions(result.executions);
    if (
      this.latestSnapshot === null ||
      this.state.society.tick % this.config.schedule.snapshotStride === 0
    ) {
      this.latestSnapshot = captureSnapshot(this.state);
      this.recordPeriodicSnapshot(this.latestSnapshot);
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
    needsAsyncUi: boolean,
  ): Promise<StepDecisions | null> {
    if (this.state === null || this.seed === null || this.runId === null) return null;
    const decisions = new Map<AgentId, { selectedAction: string; isFallback?: boolean }>();
    const isLive = this.policyId === 'jev_live';
    const recent = isLive ? this.events.slice(-5) : [];
    let completed = 0;
    let fallbacks = 0;

    for (const agent of due) {
      if (this.generation !== gen || this.status === 'cancelled') return null;
      const legal = enumerateLegalActions(this.state, agent.id);

      // 玩家化身手动抉择分支：挂起等待 UI 合法选牌
      if (this.avatarInteractive && this.avatarId === agent.id) {
        const advisor = decideMockWeightedV2({
          runId: this.runId,
          seed: this.seed,
          state: this.state,
          agentId: agent.id,
          stateHash: OFFLINE_PLACEHOLDER_HASH,
          actionSetHash: OFFLINE_PLACEHOLDER_HASH,
          legal,
        });
        const need = needOf(this.state.config, this.state, agent);
        const neighborSet = new Set<string>(agent.ties);
        const targets = legal.targets.map((targetId) => {
          const targetAgent = this.state?.society.agents[agentIndexFromId(targetId)];
          return {
            id: targetId,
            classIndex: targetAgent?.classIndex ?? 0,
            value: targetAgent?.value ?? 0,
            isNeighbor: neighborSet.has(targetId),
          };
        });
        this.pendingAvatarPrompt = {
          tick: this.state.society.tick,
          agentId: agent.id,
          classIndex: agent.classIndex,
          value: agent.value,
          need,
          needRatio: need === null || need === 0 ? null : agent.value / need,
          belowNeedStreak: agent.belowNeedStreak,
          remainingLife: agent.remainingLife,
          initialLife: agent.initialLife,
          legal,
          advisorProbabilities: advisor.probabilities ?? {},
          targets,
        };
        this.emit();
        const chosen = await new Promise<string | null>((resolve) => {
          this.avatarResolver = resolve;
        });
        if (chosen === null || this.generation !== gen || this.isTerminal()) {
          return null;
        }
        const record: DecisionRecord = {
          schemaVersion: DECISION_SCHEMA_VERSION,
          runId: this.runId,
          tick: this.state.society.tick,
          agentId: agent.id,
          stateHash: OFFLINE_PLACEHOLDER_HASH,
          actionSetHash: OFFLINE_PLACEHOLDER_HASH,
          legalActions: [...legal.actions],
          policyVersion: this.policy.policyVersion,
          promptVersion: null,
          promptStyle: null,
          requestedAction: chosen,
          selectedAction: chosen,
          source: 'mock',
          probabilitySource: 'derived',
          requestedModel: null,
          responseModel: null,
          probabilities: advisor.probabilities,
          confidence: 1,
          topK: 1,
          usage: {},
          latencyMs: 0,
          attempts: 1,
          fallbackReason: null,
          rawResponse: null,
        };
        this.pushDecision(record);
        decisions.set(agent.id, { selectedAction: chosen, isFallback: false });
        completed += 1;
        if (needsAsyncUi) {
          this.decisionProgress = { total: due.length, completed, fallbacks };
        }
        continue;
      }

      // 离线策略同步零哈希快路径（消除 O(N²) 构造与 JCS SHA-256 瓶颈）
      if (!isLive) {
        const syncOrPromise = this.policy.decide(
          {
            runId: this.runId,
            seed: this.seed,
            config: this.state.config,
            tick: this.state.society.tick,
            agentId: agent.id,
            stateHash: OFFLINE_PLACEHOLDER_HASH,
            actionSetHash: OFFLINE_PLACEHOLDER_HASH,
            legal,
            state: null,
            simState: this.state,
            topK: this.state.config.decision.topK,
            requestedModel: 'mock',
            promptVersion: null,
            promptStyle: 'neutral',
            recentEvents: recent,
          },
          this.abortController.signal,
        );
        const record = syncOrPromise instanceof Promise ? await syncOrPromise : syncOrPromise;
        if (this.generation !== gen) return null;
        this.pushDecision(record);
        const isFallback = record.source === 'fallback';
        if (isFallback) fallbacks += 1;
        completed += 1;
        decisions.set(agent.id, { selectedAction: record.selectedAction, isFallback });
        continue;
      }

      // jev_live 权威序列化与真实哈希路径
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
          requestedModel: this.liveOptions?.model ?? 'jev-1.13.0',
          promptVersion: PROMPT_VERSION,
          promptStyle: this.promptStyle,
          recentEvents: recent,
        },
        this.abortController.signal,
      );
      if (this.generation !== gen) return null;
      this.pushDecision(record);
      const isFallback = record.source === 'fallback';
      if (isFallback) fallbacks += 1;
      completed += 1;
      this.decisionProgress = { total: due.length, completed, fallbacks };
      this.emit();
      decisions.set(agent.id, { selectedAction: record.selectedAction, isFallback });
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
    this.aliveCount = result.stats.aliveCount;
    this.cumulativeDeaths += result.stats.deathCount;
    this.pushStats(result.stats);
    this.pushEvents(result.events);
    this.pushExecutions(result.executions);
    if (
      this.latestSnapshot === null ||
      this.state.society.tick % this.config.schedule.snapshotStride === 0
    ) {
      this.latestSnapshot = captureSnapshot(this.state);
      this.recordPeriodicSnapshot(this.latestSnapshot);
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
    if (this.stats.length > MAX_STATS + COMPACT_SLACK) {
      this.stats = this.stats.slice(-MAX_STATS);
    }
  }

  private pushEvents(events: readonly TickEvent[]): void {
    for (const event of events) {
      this.events.push(event);
    }
    if (this.events.length > MAX_EVENTS + 128) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  private pushExecutions(records: readonly ExecutionRecord[]): void {
    for (const record of records) this.executions.push(record);
    if (this.executions.length > MAX_DECISIONS + COMPACT_SLACK) {
      this.executions = this.executions.slice(-MAX_DECISIONS);
    }
  }

  private pushDecision(record: DecisionRecord): void {
    this.decisions.push(record);
    if (this.decisions.length > MAX_DECISIONS) {
      this.decisionsTruncated = true;
      if (this.decisions.length > MAX_DECISIONS + COMPACT_SLACK) {
        this.decisions = this.decisions.slice(-MAX_DECISIONS);
      }
    }
  }

  /** 同标签页刷新恢复（06 §8 & §11.9）：从最近完整块 `latestSnapshot` 恢复停在 paused/completed。 */
  restoreSessionBundle(value: unknown): PrepareResult {
    const parsed = parseBundle(value);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
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
      const latestSnap = bundle.latestSnapshot;
      if (latestSnap === null) {
        return {
          ok: false,
          issues: [
            { path: '$.latestSnapshot', message: '缺少最近完整快照', code: 'missing_snapshot' },
          ],
        };
      }
      const state = restoreSnapshot(latestSnap);
      const population = deriveInitialPopulation(configResult.config, validSeed);
      this.generation += 1;
      this.cancelAvatarPrompt();
      this.abortController.abort();
      this.abortController = new AbortController();
      this.config = configResult.config;
      this.seed = validSeed;
      this.runId = bundle.runId;
      this.policyId = bundle.policy;
      this.policy = bundle.policy === 'jev_live' ? new MockPolicyV2() : createPolicy(bundle.policy);
      this.state = state;
      this.aliveCount = countAlive(state);
      this.stats = [...bundle.stats];
      this.cumulativeDeaths = this.stats.reduce((sum, row) => sum + row.deathCount, 0);
      this.events = [...bundle.events];
      this.decisions = [...bundle.decisions];
      this.executions = [];
      this.decisionsTruncated = bundle.decisionsTruncated;
      this.initialSnapshot = bundle.initialSnapshot;
      this.latestSnapshot = latestSnap;
      this.periodicSnapshots =
        bundle.periodicSnapshots !== undefined && bundle.periodicSnapshots.length > 0
          ? [...bundle.periodicSnapshots]
          : bundle.initialSnapshot !== null
            ? [bundle.initialSnapshot, latestSnap]
            : [latestSnap];
      this.initialPopulationHash = computeInitialPopulationHash(validSeed, population);
      this.endReason = bundle.endReason;
      this.failure = null;
      this.issues = [];
      this.decisionProgress = null;
      this.forkProvenance = null;
      this.replay = null;
      this.replayDecisions = null;
      this.status = bundle.endReason !== null ? 'completed' : 'paused';
      this.emit();
      return { ok: true, issues: [] };
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            path: '$',
            message: error instanceof Error ? error.message : String(error),
            code: 'restore_invalid',
          },
        ],
      };
    }
  }

  private recordPeriodicSnapshot(snap: Snapshot): void {
    const tick = snap.state.society.tick;
    if (this.periodicSnapshots.some((existing) => existing.state.society.tick === tick)) {
      return;
    }
    this.periodicSnapshots.push(snap);
    // 始终保留 tick 0 初始快照在 [0]，其余保留最近 63 个周期快照
    if (this.periodicSnapshots.length > 64) {
      this.periodicSnapshots.splice(1, this.periodicSnapshots.length - 64);
    }
  }

  private finish(reason: 'scheduled' | 'extinct'): void {
    this.endReason = reason;
    this.status = 'completed';
    this.decisionProgress = null;
    if (this.state !== null) {
      this.latestSnapshot = captureSnapshot(this.state);
      this.recordPeriodicSnapshot(this.latestSnapshot);
    }
    this.emit();
  }

  private fail(error: unknown, phase: RunStatus): void {
    this.cancelAvatarPrompt();
    this.decisionProgress = null;
    this.failure = this.makeFailure(error, phase);
    this.status = 'failed';
    this.emit();
  }

  private makeFailure(error: unknown, phase: RunStatus): RunFailure {
    const code = error instanceof StratifyError ? error.code : 'run_failed';
    const message = error instanceof Error ? error.message : String(error);
    return {
      code,
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
      ...(Array.isArray(record['periodicSnapshots'])
        ? { periodicSnapshots: record['periodicSnapshots'] as Snapshot[] }
        : {}),
      stats: Array.isArray(record['stats']) ? (record['stats'] as TickStats[]) : [],
      events: Array.isArray(record['events']) ? (record['events'] as TickEvent[]) : [],
      decisions: Array.isArray(record['decisions'])
        ? (record['decisions'] as DecisionRecord[])
        : [],
      decisionsTruncated: record['decisionsTruncated'] === true,
    },
  };
}
