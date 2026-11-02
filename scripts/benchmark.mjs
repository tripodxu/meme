#!/usr/bin/env node
/**
 * P1-09 核心基准：40/200/1000 人 mock 运行（01 §4 P1-09）。
 *
 * 输出 ticks/s、峰值内存与事件规模，机器可读（stdout 纯 JSON）。
 * 结果记录在 docs/benchmarks/，不预设未实测性能承诺。
 */
import { performance } from 'node:perf_hooks';

import { createDemoConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { createSimulation } from '../dist/core/init/simulation.js';
import { enumerateLegalActions } from '../dist/core/legal-actions.js';
import { step } from '../dist/core/engine/engine.js';
import { decideMockWeighted } from '../dist/decision/mock.js';

function runBenchmark(population, totalTicks, seed) {
  const config = createDemoConfig({
    population: { initialPopulation: population },
    schedule: { totalTicks, statsStride: 10, snapshotStride: 1000 },
  });
  let state = createSimulation(config, asSeed(seed));
  const started = performance.now();
  let ticks = 0;
  let events = 0;
  let endReason = null;
  while (state.society.tick < totalTicks) {
    const decisions = new Map();
    if (state.society.tick % config.decision.interval === 0) {
      for (const agent of state.society.agents) {
        if (!agent.alive) continue;
        const legal = enumerateLegalActions(state, agent.id);
        const decision = decideMockWeighted({
          runId: 'local-benchmark',
          seed: state.seed,
          state,
          agentId: agent.id,
          stateHash: 'sha256:bench',
          actionSetHash: 'sha256:bench',
          legal,
        });
        decisions.set(agent.id, { selectedAction: decision.selectedAction });
      }
    }
    const result = step(state, decisions, { runId: 'local-benchmark' });
    state = result.state;
    events += result.events.length;
    ticks += 1;
    endReason = result.endReason;
    if (endReason !== null) break;
  }
  const elapsedMs = performance.now() - started;
  const memory = process.memoryUsage();
  return {
    population,
    plannedTicks: totalTicks,
    executedTicks: ticks,
    endReason,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    ticksPerSecond: Math.round((ticks / elapsedMs) * 1000),
    events,
    peakHeapMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
  };
}

const scenarios = [
  { population: 40, totalTicks: 3650, seed: 'bench-40' },
  { population: 200, totalTicks: 3650, seed: 'bench-200' },
  { population: 1000, totalTicks: 3650, seed: 'bench-1000' },
];

const results = scenarios.map((scenario) =>
  runBenchmark(scenario.population, scenario.totalTicks, scenario.seed),
);
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 'benchmark-v1', node: process.version, results }, null, 2)}\n`,
);
