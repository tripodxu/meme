import type { RunConfig } from '../core/config/types.js';
import { asAgentId } from '../core/control/ids.js';
import type { TickEvent } from '../core/events.js';
import {
  computeNeedClass,
  computeNeedOwn,
  computeOpportunity,
  effortFunction,
  median,
  resolveCompetition,
} from '../core/engine/settlement.js';
import {
  cachedClassShareSnapshot,
  computeAscendBarrier,
  computeAscendCost,
  computeAscendCrossBase,
  computeAscendCushion,
  computeDescendCost,
} from '../core/legal-actions.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { agentIndexFromId, type AgentState } from '../core/model/agent.js';
import type { SimState } from '../core/model/state.js';
import type { DecisionRecord, ExecutionRecord } from '../decision/types.js';
import type { ControllerSnapshot } from './types.js';

export interface Kpi {
  readonly id: string;
  readonly label: string;
  readonly symbol: string;
  readonly value: string;
  readonly unit: string;
  readonly definition: string;
  readonly tone?: 'default' | 'warn' | 'ok' | 'muted';
}

export interface AgentRow {
  readonly id: string;
  readonly classIndex: number;
  readonly alive: boolean;
  readonly value: number;
  readonly need: number | null;
  readonly needRatio: number | null;
  readonly remainingLife: number;
  readonly classAge: number;
  readonly ties: number;
  readonly riskTolerance: number;
  readonly crossClassOpenness: number;
  readonly belowNeedStreak: number;
}

export interface AgentDetail extends AgentRow {
  readonly maxClassIndex: number;
  readonly returnDistance: number;
  readonly ge: number;
  readonly hard: number;
  readonly effortValue: number;
  readonly initialLife: number;
  readonly derivedAgeYears: number;
  readonly baselineSum: number;
  readonly ascendCost: number | null;
  readonly descendCost: number | null;
  readonly lastAscentTick: number | null;
  readonly lastDescentTick: number | null;
  readonly deathTick: number | null;
  readonly neighborIds: readonly string[];
  readonly neighbors: readonly {
    readonly id: string;
    readonly classIndex: number;
    readonly value: number;
    readonly alive: boolean;
  }[];
  readonly neighborMedianValue: number;
}

export interface DecisionView {
  readonly tick: number;
  readonly selectedAction: string;
  readonly requestedAction: string | null;
  readonly policyVersion: string;
  readonly promptVersion: string | null;
  readonly promptStyle: string | null;
  readonly source: string;
  readonly legalActions: readonly string[];
  readonly probabilities: readonly { action: string; value: number }[];
  readonly fallbackReason: string | null;
  readonly latencyMs: number;
  readonly stateHash: string;
  readonly actionSetHash: string;
  /** 已递归脱敏的原始响应预览（绝不含任何密钥字段，06 §6）。 */
  readonly sanitizedRawResponse: unknown | null;
}

export interface WealthLedgerRow {
  readonly tick: number;
  readonly seq: number;
  readonly cause: string;
  readonly before: number;
  readonly delta: number;
  readonly after: number;
  readonly referenceId: string | null;
}

export type WindowKey = 'all' | 'burnin' | 'w1' | 'w2' | 'w3';

export interface WindowSpec {
  readonly id: WindowKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly startTick: number;
  readonly endTick: number | null;
}

export const OVERVIEW_WINDOWS: readonly WindowSpec[] = Object.freeze([
  { id: 'all', label: '全周期窗口 (0..T)', shortLabel: '全周期', startTick: 0, endTick: null },
  {
    id: 'burnin',
    label: '预热期 (Tick 0..364)',
    shortLabel: 'Burn-in',
    startTick: 0,
    endTick: 364,
  },
  {
    id: 'w1',
    label: '评估窗 w1 (Tick 365..1094)',
    shortLabel: 'w1',
    startTick: 365,
    endTick: 1094,
  },
  {
    id: 'w2',
    label: '评估窗 w2 (Tick 1095..1824)',
    shortLabel: 'w2',
    startTick: 1095,
    endTick: 1824,
  },
  {
    id: 'w3',
    label: '评估窗 w3 (Tick 2555..3284)',
    shortLabel: 'w3',
    startTick: 2555,
    endTick: 3284,
  },
]);

export interface WindowAggregate {
  readonly spec: WindowSpec;
  readonly sampleCount: number;
  readonly startObserved: number | null;
  readonly endObserved: number | null;
  readonly meanGini: number | null;
  readonly meanTop10: number | null;
  readonly meanMUp: number | null;
  readonly meanMDown: number | null;
  readonly meanSegregation: number | null;
  readonly meanOpenness: number | null;
  readonly meanCrossEdgeShare: number | null;
  readonly meanClassShares: readonly number[];
  readonly totalDeaths: number;
  readonly rows: readonly TickStats[];
}

export function formatNumber(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 10_000 || magnitude < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(digits);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatTick(tick: number, totalTicks: number): string {
  return `Tick ${tick.toLocaleString()} / ${totalTicks.toLocaleString()}`;
}

/** 检测当前浏览器是否为受支持的 V8 运行时（06 §3.2 & §11.11）。 */
export function detectRuntimeAuthority(): {
  readonly authoritative: boolean;
  readonly label: string;
  readonly detail: string;
} {
  if (typeof navigator === 'undefined') {
    return {
      authoritative: true,
      label: 'V8 Runtime',
      detail: 'Node / Headless V8 运行环境',
    };
  }
  const ua = navigator.userAgent ?? '';
  const isFirefox = /Firefox\//i.test(ua);
  const isSafariOnly = /Safari\//i.test(ua) && !/Chrome\/|Chromium\/|Edg\//i.test(ua);
  if (isFirefox || isSafariOnly) {
    return {
      authoritative: false,
      label: 'nonAuthoritativeRuntime',
      detail:
        '检测到非 V8 浏览器引擎（Safari/Firefox）：可正常交互运行，但浮点 Math.exp/log 可能存在 1 ulp 差异，哈希与回放不承诺与 Chromium/Node 权威值逐位相同。',
    };
  }
  return {
    authoritative: true,
    label: 'Chromium V8',
    detail: '当前为 V8 兼容浏览器引擎；在同一 runtimeVersion 内承诺状态哈希一致。',
  };
}

export function summarizeWindowStats(
  stats: readonly TickStats[],
  windowId: WindowKey,
  classCount = 5,
): WindowAggregate {
  const spec =
    OVERVIEW_WINDOWS.find((item) => item.id === windowId) ?? (OVERVIEW_WINDOWS[0] as WindowSpec);
  const rows =
    spec.id === 'all'
      ? stats
      : stats.filter(
          (row) =>
            row.tick >= spec.startTick && (spec.endTick === null || row.tick <= spec.endTick),
        );
  if (rows.length === 0) {
    return {
      spec,
      sampleCount: 0,
      startObserved: null,
      endObserved: null,
      meanGini: null,
      meanTop10: null,
      meanMUp: null,
      meanMDown: null,
      meanSegregation: null,
      meanOpenness: null,
      meanCrossEdgeShare: null,
      meanClassShares: new Array<number>(classCount).fill(0),
      totalDeaths: 0,
      rows: [],
    };
  }
  let sumG = 0;
  let sumTop10 = 0;
  let sumMUp = 0;
  let sumMDown = 0;
  let sumS = 0;
  let sumO = 0;
  let sumCross = 0;
  let totalDeaths = 0;
  let aliveTicks = 0;
  const sumShares = new Array<number>(classCount).fill(0);

  for (const row of rows) {
    totalDeaths += row.deathCount;
    if (row.aliveCount <= 0) continue;
    aliveTicks += 1;
    sumG += row.gini;
    sumTop10 += row.topWealthShare;
    sumMUp += row.mUp;
    sumMDown += row.mDown;
    sumS += row.segregation;
    sumO += row.openness;
    sumCross += row.crossClassEdgeShare;
    for (let c = 0; c < classCount; c += 1) {
      sumShares[c] = (sumShares[c] ?? 0) + (row.classCounts[c] ?? 0) / row.aliveCount;
    }
  }

  const denom = aliveTicks > 0 ? aliveTicks : 1;
  return {
    spec,
    sampleCount: rows.length,
    startObserved: rows[0]?.tick ?? null,
    endObserved: rows[rows.length - 1]?.tick ?? null,
    meanGini: aliveTicks > 0 ? sumG / denom : null,
    meanTop10: aliveTicks > 0 ? sumTop10 / denom : null,
    meanMUp: aliveTicks > 0 ? sumMUp / denom : null,
    meanMDown: aliveTicks > 0 ? sumMDown / denom : null,
    meanSegregation: aliveTicks > 0 ? sumS / denom : null,
    meanOpenness: aliveTicks > 0 ? sumO / denom : null,
    meanCrossEdgeShare: aliveTicks > 0 ? sumCross / denom : null,
    meanClassShares: sumShares.map((s) => (aliveTicks > 0 ? s / denom : 0)),
    totalDeaths,
    rows,
  };
}

export function buildKpis(snapshot: ControllerSnapshot): Kpi[] {
  const s = snapshot.latestStats;
  const cumulativeDeaths =
    typeof snapshot.cumulativeDeaths === 'number'
      ? snapshot.cumulativeDeaths
      : snapshot.stats.reduce((sum, row) => sum + row.deathCount, 0);
  return [
    {
      id: 'alive',
      label: '存活人口',
      symbol: 'N',
      value: String(snapshot.aliveCount),
      unit: '人',
      definition: '当前 tick 结算后的存活个体数。',
    },
    {
      id: 'gini',
      label: '财富基尼',
      symbol: 'G',
      value: formatNumber(s?.gini),
      unit: '[0,1]',
      definition: '当前 tick 存活个体的财富基尼系数。',
    },
    {
      id: 'mup',
      label: '上升参与率',
      symbol: 'Mup',
      value: formatNumber(s?.mUp),
      unit: '窗口参与率',
      definition: `最近 ${snapshot.config?.metrics.mobilityWindowDays ?? '—'} 日发生上升行动的存活个体比例，不是年化事件率。`,
    },
    {
      id: 'mdown',
      label: '下降参与率',
      symbol: 'Mdown',
      value: formatNumber(s?.mDown),
      unit: '窗口参与率',
      definition: `最近 ${snapshot.config?.metrics.mobilityWindowDays ?? '—'} 日发生下降行动的存活个体比例。`,
    },
    {
      id: 'segregation',
      label: '调整后网络隔离',
      symbol: 'S',
      value: formatNumber(s?.segregation),
      unit: '[-1,1]',
      definition:
        '同层边占比相对随机基线的调整值；无连边时显示 edgeCount=0，不把空网络解释为完全隔离。',
    },
    {
      id: 'openness',
      label: '开放度',
      symbol: 'O',
      value: formatNumber(s?.openness),
      unit: '[0,1]',
      definition: `慢变量，时间常数 ${snapshot.config?.openness.timeConstantDays ?? '—'} 日；当前 tick ${snapshot.config ? snapshot.tick : '—'}。`,
    },
    {
      id: 'top10',
      label: '前 10% 财富占比',
      symbol: 'Top10',
      value: formatPercent(s?.topWealthShare),
      unit: '占存活总财富',
      definition: '按 ceil(10%×N) 个最高 Value 个体计算；总财富为 0 时显示 0。',
    },
    {
      id: 'deaths',
      label: '累计死亡',
      symbol: 'D',
      value: String(cumulativeDeaths),
      unit: '人',
      definition: '本次 run 内死亡结算的累计人数；与存活数分开显示，避免把死亡误读为流动。',
    },
  ];
}

function toAgentRow(config: RunConfig, state: SimState, agent: AgentState): AgentRow {
  const need = needOf(config, state, agent);
  return {
    id: agent.id,
    classIndex: agent.classIndex,
    alive: agent.alive,
    value: agent.value,
    need,
    needRatio: need === null || need === 0 ? null : agent.value / need,
    remainingLife: agent.remainingLife,
    classAge: agent.classAge,
    ties: agent.ties.length,
    riskTolerance: agent.riskTolerance,
    crossClassOpenness: agent.crossClassOpenness,
    belowNeedStreak: agent.belowNeedStreak,
  };
}

export function agentRows(state: SimState | null): AgentRow[] {
  if (state === null) return [];
  const config = state.config;
  return state.society.agents.map((agent) => toAgentRow(config, state, agent));
}

/** O(1) 定位个体并生成深度检查档案（不再重复遍历全员计算 need）。 */
export function agentDetail(state: SimState | null, agentId: string): AgentDetail | null {
  if (state === null) return null;
  let agent: AgentState | undefined;
  try {
    const idx = agentIndexFromId(asAgentId(agentId));
    const candidate = state.society.agents[idx];
    agent = candidate !== undefined && candidate.id === agentId ? candidate : undefined;
  } catch {
    agent = state.society.agents.find((candidate) => candidate.id === agentId);
  }
  if (agent === undefined) return null;
  const config = state.config;
  const row = toAgentRow(config, state, agent);
  const neighbors: {
    id: string;
    classIndex: number;
    value: number;
    alive: boolean;
  }[] = [];
  const aliveNeighborValues: number[] = [];
  for (const neighborId of agent.ties) {
    let nAgent: AgentState | undefined;
    try {
      const nIdx = agentIndexFromId(neighborId);
      nAgent = state.society.agents[nIdx];
    } catch {
      nAgent = state.society.agents.find((c) => c.id === neighborId);
    }
    if (nAgent !== undefined) {
      neighbors.push({
        id: nAgent.id,
        classIndex: nAgent.classIndex,
        value: nAgent.value,
        alive: nAgent.alive,
      });
      if (nAgent.alive) aliveNeighborValues.push(nAgent.value);
    }
  }
  let effortVal = 1;
  try {
    effortVal = effortFunction(config.effort.shape, agent.hard);
  } catch {
    effortVal = 1;
  }
  let ascendCost: number | null = null;
  let descendCost: number | null = null;
  try {
    ascendCost = computeAscendCost(
      config,
      agent,
      state.society.eByClass,
      state.society.openness,
      state.society.refIncome,
      cachedClassShareSnapshot(state.society.agents, config.population.classCount),
    );
    descendCost = computeDescendCost(config, agent, state.society.eByClass);
  } catch {
    ascendCost = null;
    descendCost = null;
  }

  return {
    ...row,
    maxClassIndex: agent.maxClassIndex,
    returnDistance: Math.max(0, agent.maxClassIndex - agent.classIndex),
    ge: agent.ge,
    hard: agent.hard,
    effortValue: effortVal,
    initialLife: agent.initialLife,
    derivedAgeYears: Math.max(0, (agent.initialLife - agent.remainingLife) / 365),
    baselineSum: agent.baselineSum,
    ascendCost,
    descendCost,
    lastAscentTick: agent.lastAscentTick,
    lastDescentTick: agent.lastDescentTick,
    deathTick: agent.deathTick,
    neighborIds: [...agent.ties],
    neighbors,
    neighborMedianValue: aliveNeighborValues.length > 0 ? median(aliveNeighborValues) : 0,
  };
}

export function needOf(config: RunConfig, state: SimState, agent: AgentState): number | null {
  try {
    if (config.need.referenceMode === 'class') {
      const ref = state.society.refIncome[agent.classIndex];
      return ref === undefined ? null : computeNeedClass(config, ref, agent.classIndex);
    }
    return computeNeedOwn(config, agent.classAge, agent.baselineSum, agent.classIndex);
  } catch {
    return null;
  }
}

export function decisionsForAgent(
  snapshot: ControllerSnapshot,
  agentId: string,
  limit = 12,
): DecisionView[] {
  const rows: DecisionView[] = [];
  for (let index = snapshot.decisions.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const record = snapshot.decisions[index];
    if (record === undefined || record.agentId !== agentId) continue;
    rows.push(toDecisionView(record));
  }
  return rows;
}

export function latestDecision(snapshot: ControllerSnapshot, agentId: string): DecisionView | null {
  for (let index = snapshot.decisions.length - 1; index >= 0; index -= 1) {
    const record = snapshot.decisions[index];
    if (record !== undefined && record.agentId === agentId) return toDecisionView(record);
  }
  return null;
}

function toDecisionView(record: DecisionRecord): DecisionView {
  const probabilities =
    record.probabilities === null
      ? []
      : Object.entries(record.probabilities)
          .map(([action, value]) => ({ action, value }))
          .sort((a, b) => b.value - a.value);
  return {
    tick: record.tick,
    selectedAction: record.selectedAction,
    requestedAction: record.requestedAction,
    policyVersion: record.policyVersion,
    promptVersion: record.promptVersion,
    promptStyle: record.promptStyle,
    source: record.source,
    legalActions: record.legalActions,
    probabilities,
    fallbackReason: record.fallbackReason,
    latencyMs: record.latencyMs,
    stateHash: record.stateHash,
    actionSetHash: record.actionSetHash,
    sanitizedRawResponse: sanitizeSecrets(record.rawResponse),
  };
}

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|secret|authorization|password|credential)/i;

/** 递归剔除任何潜在敏感键，确保检查器折叠 JSON 绝不显示密钥（06 §6）。 */
export function sanitizeSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeSecrets(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitizeSecrets(child, depth + 1);
    }
  }
  return out;
}

export function latestExecution(
  snapshot: ControllerSnapshot,
  agentId: string,
): ExecutionRecord | null {
  for (let index = snapshot.executions.length - 1; index >= 0; index -= 1) {
    const record = snapshot.executions[index];
    if (record !== undefined && record.agentId === agentId) return record;
  }
  return null;
}

export interface EventView {
  readonly tick: number;
  readonly seq: number;
  readonly type: string;
  readonly summary: string;
}

export function eventViews(events: readonly TickEvent[], limit = 100): EventView[] {
  const out: EventView[] = [];
  const start = Math.max(0, events.length - limit);
  for (let i = events.length - 1; i >= start; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    out.push({
      tick: event.tick,
      seq: event.seq,
      type: event.type,
      summary: summarizeEvent(event),
    });
  }
  return out;
}

function summarizeEvent(event: TickEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    'agentId',
    'initiatorId',
    'targetId',
    'from',
    'to',
    'delta',
    'cause',
    'reason',
    'winner',
  ]) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      const formatted = typeof value === 'number' ? formatNumber(value, 2) : String(value);
      parts.push(`${key}=${formatted}`);
    }
  }
  return parts.length === 0 ? '—' : parts.join(' · ');
}

export function agentEvents(
  events: readonly TickEvent[],
  agentId: string,
  limit = 40,
): EventView[] {
  const out: EventView[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    const record = event as unknown as Record<string, unknown>;
    if (
      record['agentId'] === agentId ||
      record['targetId'] === agentId ||
      record['initiatorId'] === agentId
    ) {
      out.push({
        tick: event.tick,
        seq: event.seq,
        type: event.type,
        summary: summarizeEvent(event),
      });
    }
  }
  return out;
}

/** 提取特定个体的近期财富复式变动账本（06 §6）。 */
export function agentWealthLedger(
  events: readonly TickEvent[],
  agentId: string,
  limit = 30,
): WealthLedgerRow[] {
  const rows: WealthLedgerRow[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== 'wealth_changed') continue;
    if (event.agentId !== agentId) continue;
    rows.push({
      tick: event.tick,
      seq: event.seq,
      cause: event.cause,
      before: event.before,
      delta: event.delta,
      after: event.after,
      referenceId: event.referenceId,
    });
  }
  return rows;
}

export interface DirectionCompetitionRow {
  readonly direction: 'same_class' | 'high_to_low' | 'low_to_high';
  readonly label: string;
  readonly count: number;
  readonly initiatorWins: number;
  readonly winRate: number | null;
  readonly totalLoss: number;
  readonly totalGain: number;
  readonly netFriction: number;
}

/** 按原发起方向分组统计近期竞争博弈（06 §5）。 */
export function competitionByDirection(events: readonly TickEvent[]): DirectionCompetitionRow[] {
  const buckets: Record<
    'same_class' | 'high_to_low' | 'low_to_high',
    { label: string; count: number; wins: number; loss: number; gain: number }
  > = {
    same_class: { label: '同层博弈 (same)', count: 0, wins: 0, loss: 0, gain: 0 },
    low_to_high: { label: '低打高 (low→high)', count: 0, wins: 0, loss: 0, gain: 0 },
    high_to_low: { label: '高打低 (high→low)', count: 0, wins: 0, loss: 0, gain: 0 },
  };
  for (const ev of events) {
    if (ev.type !== 'competition_resolved') continue;
    const b = buckets[ev.direction];
    b.count += 1;
    if (ev.winner === 'initiator') b.wins += 1;
    b.loss += ev.loss;
    b.gain += ev.gain;
  }
  return (['same_class', 'low_to_high', 'high_to_low'] as const).map((dir) => {
    const b = buckets[dir];
    return {
      direction: dir,
      label: b.label,
      count: b.count,
      initiatorWins: b.wins,
      winRate: b.count === 0 ? null : b.wins / b.count,
      totalLoss: b.loss,
      totalGain: b.gain,
      netFriction: b.loss - b.gain,
    };
  });
}

/** 存活个体剩余寿命（折算年）5 档分布直方图（06 §5）。 */
export function remainingLifeBins(
  state: SimState | null,
): readonly { readonly label: string; readonly value: number; readonly color: string }[] {
  const counts = [0, 0, 0, 0, 0];
  if (state !== null) {
    for (const agent of state.society.agents) {
      if (!agent.alive) continue;
      const years = agent.remainingLife / 365;
      const idx = years < 10 ? 0 : years < 25 ? 1 : years < 45 ? 2 : years < 65 ? 3 : 4;
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }
  const labels = ['0–10y', '10–25y', '25–45y', '45–65y', '65y+'] as const;
  const colors = [
    'var(--status-danger)',
    'var(--action-descend)',
    'var(--class-2-color)',
    'var(--accent)',
    'var(--violet)',
  ] as const;
  return labels.map((label, i) => ({
    label,
    value: counts[i] ?? 0,
    color: colors[i] ?? 'var(--accent)',
  }));
}

/** 计算当前存活人口财富的洛伦兹曲线坐标点（06 §5）。 */
export function lorenzCurvePoints(state: SimState | null): readonly { x: number; y: number }[] {
  if (state === null) return [];
  const vals = state.society.agents.filter((a) => a.alive).map((a) => Math.max(0, a.value));
  if (vals.length === 0) return [];
  vals.sort((a, b) => a - b);
  const total = vals.reduce((s, v) => s + v, 0);
  if (total <= 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }
  const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  let runSum = 0;
  for (let i = 0; i < vals.length; i += 1) {
    runSum += vals[i] ?? 0;
    pts.push({ x: (i + 1) / vals.length, y: runSum / total });
  }
  return pts;
}

/** 导出原始统计序列为标准 CSV 文本（06 §5）。 */
export function statsToCsv(rows: readonly TickStats[]): string {
  const headers = [
    'tick',
    'aliveCount',
    'gini',
    'medianValue',
    'topWealthShare',
    'mUp',
    'mDown',
    'segregation',
    'edgeCount',
    'openness',
    'deathCount',
    'competitionLoss',
    'competitionGain',
    'crossClassEdgeShare',
    'classCounts',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.tick,
        r.aliveCount,
        r.gini,
        r.medianValue,
        r.topWealthShare,
        r.mUp,
        r.mDown,
        r.segregation,
        r.edgeCount,
        r.openness,
        r.deathCount,
        r.competitionLoss,
        r.competitionGain,
        r.crossClassEdgeShare,
        `"${r.classCounts.join(';')}"`,
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface ForestMetricInterval {
  readonly metric: string;
  readonly estimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly sameSignFraction?: number;
}

export interface PairedBatchForestSummary {
  readonly title: string;
  readonly pairedSeeds: number;
  readonly eligibleForInference: boolean;
  readonly metrics: readonly ForestMetricInterval[];
}

/**
 * 解析导入的多配对种子批次摘要以渲染置信区间森林图（06 §7）：
 * 仅当 `pairedSeeds >= 30` 时标记 `eligibleForInference=true`。
 */
export function parsePairedBatchForest(raw: unknown): PairedBatchForestSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const pairedSeeds =
    typeof obj['pairedSeeds'] === 'number'
      ? obj['pairedSeeds']
      : Array.isArray(obj['seeds'])
        ? obj['seeds'].length
        : 0;
  const rawMetrics = obj['metrics'];
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) return null;
  const metrics: ForestMetricInterval[] = [];
  for (const item of rawMetrics) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const metric = typeof rec['metric'] === 'string' ? rec['metric'] : null;
    const estimate = typeof rec['estimate'] === 'number' ? rec['estimate'] : null;
    const ciLow = typeof rec['ciLow'] === 'number' ? rec['ciLow'] : null;
    const ciHigh = typeof rec['ciHigh'] === 'number' ? rec['ciHigh'] : null;
    if (
      metric !== null &&
      estimate !== null &&
      ciLow !== null &&
      ciHigh !== null &&
      Number.isFinite(estimate) &&
      Number.isFinite(ciLow) &&
      Number.isFinite(ciHigh)
    ) {
      const sameSign = rec['sameSignFraction'];
      metrics.push(
        typeof sameSign === 'number' && Number.isFinite(sameSign)
          ? { metric, estimate, ciLow, ciHigh, sameSignFraction: sameSign }
          : { metric, estimate, ciLow, ciHigh },
      );
    }
  }
  if (metrics.length === 0) return null;
  return {
    title: typeof obj['title'] === 'string' ? obj['title'] : '配对批次对比摘要',
    pairedSeeds,
    eligibleForInference: pairedSeeds >= 30,
    metrics,
  };
}

export interface AgentMechanismAnatomy {
  readonly agentId: string;
  readonly classIndex: number;
  readonly value: number;
  readonly eClass: number;
  readonly ge: number;
  readonly effortFactor: number;
  readonly opportunity: number;
  readonly expectedDailyGain: number;
  readonly canAscendFurther: boolean;
  readonly ascendCost: number;
  readonly ascendCushion: number;
  readonly ascendBarrier: number;
  readonly ascendTotalRequired: number;
  readonly ascendGap: number;
}

/**
 * 个体单日产出因子与升阶门槛瀑布拆解（纯只读，直接复用 core 纯函数）。
 */
export function agentMechanismAnatomy(
  state: SimState | null,
  agentId: string,
): AgentMechanismAnatomy | null {
  if (state === null) return null;
  let agent: AgentState | undefined;
  try {
    agent = state.society.agents[agentIndexFromId(asAgentId(agentId))];
  } catch {
    agent = state.society.agents.find((a) => a.id === agentId);
  }
  if (agent === undefined) return null;

  const eClass = state.society.eByClass[agent.classIndex] ?? 0;
  const effortFactor = effortFunction(state.config.effort.shape, agent.hard);
  const allAliveValues: number[] = [];
  for (const a of state.society.agents) {
    if (a.alive) allAliveValues.push(a.value);
  }
  const neighborValues: number[] = [];
  for (const nid of agent.ties) {
    const nb = state.society.agents[agentIndexFromId(nid)];
    if (nb !== undefined && nb.alive) neighborValues.push(nb.value);
  }
  const opportunity =
    allAliveValues.length === 0
      ? 1
      : computeOpportunity(state.config, neighborValues, allAliveValues);
  const expectedDailyGain = eClass * agent.ge * effortFactor * opportunity;

  const canAscendFurther = agent.classIndex < state.config.population.classCount - 1;
  let ascendCost = 0;
  let ascendCushion = 0;
  let ascendBarrier = 0;
  if (canAscendFurther) {
    ascendCost =
      computeAscendCost(
        state.config,
        agent,
        state.society.eByClass,
        state.society.openness,
        state.society.refIncome,
        cachedClassShareSnapshot(state.society.agents, state.config.population.classCount),
      ) ?? 0;
    ascendCushion = computeAscendCushion(
      state.config,
      agent.classIndex + 1,
      state.society.eByClass,
      state.society.refIncome,
    );
    const crossBase = computeAscendCrossBase(
      state.config,
      agent,
      state.society.eByClass,
      state.society.refIncome,
    );
    ascendBarrier =
      crossBase === null
        ? 0
        : computeAscendBarrier(
            state.config,
            agent.classIndex,
            crossBase.crossBase,
            state.society.occupancyPressure,
          );
  }
  const ascendTotalRequired = ascendCost + ascendCushion + ascendBarrier;
  return {
    agentId: agent.id,
    classIndex: agent.classIndex,
    value: agent.value,
    eClass,
    ge: agent.ge,
    effortFactor,
    opportunity,
    expectedDailyGain,
    canAscendFurther,
    ascendCost,
    ascendCushion,
    ascendBarrier,
    ascendTotalRequired,
    ascendGap: Math.max(0, ascendTotalRequired - agent.value),
  };
}

export interface CompetitionPreview {
  readonly initiatorId: string;
  readonly targetId: string;
  readonly direction: 'same_class' | 'high_to_low' | 'low_to_high';
  readonly pWin: number;
  readonly winGain: number;
  readonly winNetLoss: number;
  readonly loseLoss: number;
  readonly loseOpponentGain: number;
}

/**
 * 竞争发起前真实期望胜率与双方损益预演（直接调用 core `resolveCompetition`，零公式复制）。
 */
export function previewCompetition(
  state: SimState | null,
  initiatorId: string,
  targetId: string,
): CompetitionPreview | null {
  if (state === null) return null;
  const initiator = state.society.agents.find((a) => a.id === initiatorId);
  const target = state.society.agents.find((a) => a.id === targetId);
  if (initiator === undefined || target === undefined || !initiator.alive || !target.alive) {
    return null;
  }
  const winOutcome = resolveCompetition(state.config, initiator, target, 0);
  const loseOutcome = resolveCompetition(state.config, initiator, target, 0.999999999999);
  return {
    initiatorId: initiator.id,
    targetId: target.id,
    direction: winOutcome.direction,
    pWin: winOutcome.pInitiator,
    winGain: winOutcome.gain,
    winNetLoss: Math.max(0, winOutcome.loss - winOutcome.gain),
    loseLoss: loseOutcome.loss,
    loseOpponentGain: loseOutcome.gain,
  };
}

export interface LifeTimelinePoint {
  readonly tick: number;
  readonly classIndex: number;
  readonly kind: 'ascend' | 'descend' | 'compete_win' | 'compete_loss' | 'born' | 'died';
  readonly label: string;
}

export function agentLifeTimeline(
  events: readonly TickEvent[],
  agentId: string,
  initialClassIndex = 0,
): readonly LifeTimelinePoint[] {
  const pts: LifeTimelinePoint[] = [
    { tick: 0, classIndex: initialClassIndex, kind: 'born', label: `初始 C${initialClassIndex}` },
  ];
  let currentClass = initialClassIndex;
  for (const ev of events) {
    if (ev.type === 'agent_born' && ev.agentId === agentId) {
      currentClass = ev.classIndex;
      pts.push({
        tick: ev.tick,
        classIndex: currentClass,
        kind: 'born',
        label: `新生继承 C${currentClass} (来自 ${ev.parentId})`,
      });
    } else if (ev.type === 'class_ascended' && ev.agentId === agentId) {
      currentClass = ev.to;
      pts.push({
        tick: ev.tick,
        classIndex: currentClass,
        kind: 'ascend',
        label: `跃升 C${ev.from}→C${ev.to}`,
      });
    } else if (ev.type === 'class_descended' && ev.agentId === agentId) {
      currentClass = ev.to;
      pts.push({
        tick: ev.tick,
        classIndex: currentClass,
        kind: 'descend',
        label: `${ev.reason === 'passive' ? '被动跌落' : '主动降阶'} C${ev.from}→C${ev.to}`,
      });
    } else if (
      ev.type === 'competition_resolved' &&
      (ev.initiatorId === agentId || ev.targetId === agentId)
    ) {
      const won =
        (ev.winner === 'initiator' && ev.initiatorId === agentId) ||
        (ev.winner === 'target' && ev.targetId === agentId);
      pts.push({
        tick: ev.tick,
        classIndex: currentClass,
        kind: won ? 'compete_win' : 'compete_loss',
        label: won
          ? `竞争胜 (+${formatNumber(ev.gain, 1)})`
          : `竞争负 (-${formatNumber(ev.loss, 1)})`,
      });
    } else if (ev.type === 'agent_died' && ev.agentId === agentId) {
      pts.push({ tick: ev.tick, classIndex: currentClass, kind: 'died', label: '寿元耗尽离世' });
    }
  }
  return pts;
}

export interface AgentLineage {
  readonly parent: { readonly id: string; readonly classIndex: number; readonly ge: number } | null;
  readonly children: readonly {
    readonly id: string;
    readonly tick: number;
    readonly classIndex: number;
    readonly value: number;
  }[];
}

export function agentLineage(
  events: readonly TickEvent[],
  state: SimState | null,
  agentId: string,
): AgentLineage {
  let parentId: string | null = null;
  const children: { id: string; tick: number; classIndex: number; value: number }[] = [];
  for (const ev of events) {
    if (ev.type !== 'agent_born') continue;
    if (ev.agentId === agentId) parentId = ev.parentId;
    if (ev.parentId === agentId) {
      children.push({
        id: ev.agentId,
        tick: ev.tick,
        classIndex: ev.classIndex,
        value: ev.value,
      });
    }
  }
  const parentAgent =
    parentId === null || state === null
      ? undefined
      : state.society.agents.find((a) => a.id === parentId);
  return {
    parent:
      parentAgent === undefined
        ? null
        : { id: parentAgent.id, classIndex: parentAgent.classIndex, ge: parentAgent.ge },
    children,
  };
}

/**
 * 定位两套时间序列（如微扰分叉 vs 原宇宙）首次出现宏观统计分叉的 tick。
 */
export function firstDivergenceTick(
  current: readonly TickStats[],
  baseline: readonly TickStats[],
): number | null {
  const len = Math.min(current.length, baseline.length);
  for (let i = 0; i < len; i += 1) {
    const a = current[i];
    const b = baseline[i];
    if (a === undefined || b === undefined) continue;
    if (
      Math.abs(a.gini - b.gini) > 1e-9 ||
      Math.abs(a.openness - b.openness) > 1e-9 ||
      Math.abs(a.segregation - b.segregation) > 1e-9 ||
      Math.abs(a.medianValue - b.medianValue) > 1e-9
    ) {
      return a.tick;
    }
  }
  return null;
}
