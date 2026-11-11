import type { RunConfig } from '../core/config/types.js';
import type { TickEvent } from '../core/events.js';
import { computeNeedClass, computeNeedOwn } from '../core/engine/settlement.js';
import type { AgentState } from '../core/model/agent.js';
import type { SimState } from '../core/model/state.js';
import type { DecisionRecord } from '../decision/types.js';
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
}

export interface AgentDetail extends AgentRow {
  readonly maxClassIndex: number;
  readonly ge: number;
  readonly hard: number;
  readonly initialLife: number;
  readonly baselineSum: number;
  readonly belowNeedStreak: number;
  readonly lastAscentTick: number | null;
  readonly lastDescentTick: number | null;
  readonly deathTick: number | null;
  readonly neighborIds: readonly string[];
}

export interface DecisionView {
  readonly tick: number;
  readonly selectedAction: string;
  readonly policyVersion: string;
  readonly source: string;
  readonly probabilities: readonly { action: string; value: number }[];
  readonly fallbackReason: string | null;
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

export function buildKpis(snapshot: ControllerSnapshot): Kpi[] {
  const s = snapshot.latestStats;
  const cumulativeDeaths = snapshot.stats.reduce((sum, row) => sum + row.deathCount, 0);
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
      definition: `慢变量，时间常数 ${snapshot.config?.openness.timeConstantDays ?? '—'} 日；上次更新 tick ${snapshot.config ? snapshot.tick : '—'}。`,
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

export function agentRows(state: SimState | null): AgentRow[] {
  if (state === null) return [];
  const config = state.config;
  return state.society.agents.map((agent) => {
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
    };
  });
}

export function agentDetail(state: SimState | null, agentId: string): AgentDetail | null {
  if (state === null) return null;
  const agent = state.society.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) return null;
  const row = agentRows(state).find((candidate) => candidate.id === agentId);
  if (row === undefined) return null;
  return {
    ...row,
    maxClassIndex: agent.maxClassIndex,
    ge: agent.ge,
    hard: agent.hard,
    initialLife: agent.initialLife,
    baselineSum: agent.baselineSum,
    belowNeedStreak: agent.belowNeedStreak,
    lastAscentTick: agent.lastAscentTick,
    lastDescentTick: agent.lastDescentTick,
    deathTick: agent.deathTick,
    neighborIds: [...agent.ties],
  };
}

function needOf(config: RunConfig, state: SimState, agent: AgentState): number | null {
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
    policyVersion: record.policyVersion,
    source: record.source,
    probabilities,
    fallbackReason: record.fallbackReason,
  };
}

export interface EventView {
  readonly tick: number;
  readonly seq: number;
  readonly type: string;
  readonly summary: string;
}

export function eventViews(events: readonly TickEvent[], limit = 100): EventView[] {
  return events
    .slice(-limit)
    .reverse()
    .map((event) => ({
      tick: event.tick,
      seq: event.seq,
      type: event.type,
      summary: summarizeEvent(event),
    }));
}

function summarizeEvent(event: TickEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['agentId', 'targetId', 'fromClass', 'toClass', 'deltaValue', 'reason']) {
    const value = record[key];
    if (value !== undefined && value !== null) parts.push(`${key}=${String(value)}`);
  }
  return parts.length === 0 ? '—' : parts.join(' · ');
}

export function agentEvents(
  events: readonly TickEvent[],
  agentId: string,
  limit = 40,
): EventView[] {
  return events
    .filter((event) => {
      const record = event as unknown as Record<string, unknown>;
      return record['agentId'] === agentId || record['targetId'] === agentId;
    })
    .slice(-limit)
    .reverse()
    .map((event) => ({
      tick: event.tick,
      seq: event.seq,
      type: event.type,
      summary: summarizeEvent(event),
    }));
}
