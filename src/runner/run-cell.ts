import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import { createSimulation } from '../core/init/simulation.js';
import type { RunConfig } from '../core/config/types.js';
import { asSeed, type AgentId, type Seed } from '../core/control/ids.js';
import { step } from '../core/engine/engine.js';
import { enumerateLegalActions } from '../core/legal-actions.js';
import { decideMockWeighted, POLICY_VERSION_MOCK } from '../decision/mock.js';
import { decideRandomUniform, POLICY_VERSION_RANDOM } from '../decision/random.js';
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
  readonly finalStateHash: string;
  readonly aliveAtEnd: number;
}

export interface RunOptions {
  /** 决策策略；P1.5 只用 mock/random（live 属 P2/P6）。 */
  readonly policy: 'mock-weighted-v1' | 'random-uniform-v1';
  /** 预算护栏：单 run 最大 tick 数（超过视为异常终止）。 */
  readonly maxTicks?: number;
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
  readonly report: RunWindowReport;
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
 * 运行单个 (config, seed) 到结束（scheduled/extinct 或 maxTicks 护栏），
 * 收集全分辨率 stats、每 tick 转移矩阵与决策计数，并产出窗口聚合与标签。
 */
export function runSingle(config: RunConfig, seed: Seed, options: RunOptions): RunOutcome {
  const validatedSeed = asSeed(seed);
  let state = createSimulation(config, validatedSeed);
  const classCount = config.population.classCount;
  const stats: TickStats[] = [];
  const flowsByTick = new Map<number, readonly (readonly number[])[]>();
  const decisionsByTick = new Map<number, { due: number; fallbacks: number }>();
  const maxTicks = options.maxTicks ?? config.schedule.totalTicks;
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
        const decision =
          options.policy === 'mock-weighted-v1'
            ? decideMockWeighted({
                runId: 'local-batch',
                seed: validatedSeed,
                state,
                agentId: agent.id,
                stateHash: 'sha256:batch',
                actionSetHash: 'sha256:batch',
                legal,
              })
            : decideRandomUniform({
                runId: 'local-batch',
                seed: validatedSeed,
                state,
                agentId: agent.id,
                stateHash: 'sha256:batch',
                actionSetHash: 'sha256:batch',
                legal,
              });
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
  const extinct = endReason === 'extinct';
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
  const aliveAtEnd = state.society.agents.reduce(
    (count, agent) => count + (agent.alive ? 1 : 0),
    0,
  );
  return {
    configHash: computeConfigHash(config),
    paramsHash: computeParamsHash(config),
    stats,
    flowsByTick,
    decisionsByTick,
    report: {
      windows,
      labelsByWindow,
      labelsEvidenceByWindow,
      extinct,
      endTick,
      endReason,
      finalStateHash: computeAuthoritativeStateHash(state),
      aliveAtEnd,
    },
  };
}

export { POLICY_VERSION_MOCK, POLICY_VERSION_RANDOM };
