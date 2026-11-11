import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunConfig } from '../core/config/types.js';
import type { SimState } from '../core/model/state.js';
import type { Seed } from '../core/control/ids.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../core/control/versions.js';
import { deriveInitialPopulation } from '../core/init/population.js';
import { computeInitialPopulationHash } from '../core/hash/state-hash.js';
import type { RunOutcome } from './run-cell.js';

/**
 * P5b：把批跑完成的 run 导出为 `run-upload-bundle-file-v1`。
 *
 * 只导出 `metrics-only`：全分辨率 metrics + final_state + agents。decisions/events/
 * snapshot 需要批跑保留全量事件与快照，当前 `runSingle` 不持有这些数据；因此
 * `full` profile 仍需上游单独导出，不能在这里假装可回放。
 *
 * 输出目录：`<outDir>/<safeCell>-<safeSeed>/`，含 bundle.json、metrics.ndjson、
 * final-state.ndjson、agents.json。所有文件先写 `.tmp` 再 rename。
 */

export interface WriteUploadBundleOptions {
  readonly outDir: string;
  readonly cellKey: string;
  readonly seed: Seed;
  readonly config: RunConfig;
  readonly outcome: RunOutcome;
  readonly runtimeVersion: string;
  readonly codeSha?: string;
  readonly runId?: string;
}

export interface WrittenUploadBundle {
  readonly dir: string;
  readonly bundlePath: string;
  readonly metricsRows: number;
  readonly agents: number;
  readonly finalTick: number;
  readonly endReason: 'scheduled' | 'extinct';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, path);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'run';
}

function metricsLine(runId: string, stats: RunOutcome['stats'][number]): string {
  const row = {
    schemaVersion: 'metrics-v1',
    runId,
    tick: stats.tick,
    aliveCount: stats.aliveCount,
    classCounts: stats.classCounts,
    gini: stats.gini,
    medianValue: stats.medianValue,
    top10Share: stats.topWealthShare,
    mUp: stats.mUp,
    mDown: stats.mDown,
    segregation: stats.segregation,
    edgeCount: stats.edgeCount,
    openness: stats.openness,
    deathCount: stats.deathCount,
    competitionLoss: stats.competitionLoss,
    competitionGain: stats.competitionGain,
    fallbackRate: stats.fallbackRate,
    eByClass: stats.eByClass,
    crossClassEdgeShare: stats.crossClassEdgeShare,
    avgDegree: stats.avgDegree,
    connectedComponents: stats.connectedComponents,
    flowMatrix: stats.flowMatrix,
  };
  return JSON.stringify({ ...row, payloadHash: `sha256:${sha256(JSON.stringify(row))}` });
}

function agentRow(agent: SimState['society']['agents'][number]): Record<string, unknown> {
  const row = {
    agentId: agent.id,
    alive: agent.alive,
    classIndex: agent.classIndex,
    maxClassIndex: agent.maxClassIndex,
    value: agent.value,
    ge: agent.ge,
    hard: agent.hard,
    initialLife: agent.initialLife,
    remainingLife: agent.remainingLife,
    deathTick: agent.deathTick,
    deathReason: agent.deathReason ?? null,
  };
  return { ...row, payloadHash: `sha256:${sha256(JSON.stringify(row))}` };
}

export function writeUploadBundle(options: WriteUploadBundleOptions): WrittenUploadBundle {
  const { outcome, config, seed } = options;
  const runId = options.runId ?? 'local-batch';
  const dir = join(options.outDir, `${safeSegment(options.cellKey)}-${safeSegment(String(seed))}`);
  mkdirSync(dir, { recursive: true });

  const metricsRows = outcome.stats.map((stats) => metricsLine(runId, stats));
  const finalTick = outcome.report.endTick;
  const extinct = outcome.report.extinct && finalTick < config.schedule.totalTicks - 1;
  const endReason: 'scheduled' | 'extinct' = extinct ? 'extinct' : 'scheduled';
  const finalStateText = JSON.stringify({
    schemaVersion: 'final-state-v1',
    runId,
    finalStateHash: outcome.report.finalStateHash,
    finalState: outcome.finalState,
  });
  const agents = outcome.finalState.society.agents.map(agentRow);
  const summaryHash = `sha256:${sha256(
    JSON.stringify({
      report: outcome.report,
      finalStateHash: outcome.report.finalStateHash,
      finalTick,
      endReason,
      aliveAtEnd: outcome.report.aliveAtEnd,
    }),
  )}`;
  const population = deriveInitialPopulation(config, seed);
  const bundle = {
    schemaVersion: 'run-upload-bundle-file-v1',
    config,
    identity: {
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      policyVersion: config.decision.policy,
      promptVersion: null,
      requestedModel: null,
      seed: String(seed),
      runtimeVersion: options.runtimeVersion,
      configHash: outcome.configHash,
      paramsHash: outcome.paramsHash,
      initialPopulationHash: computeInitialPopulationHash(seed, population),
      codeSha: options.codeSha ?? 'local-batch',
    },
    experiment: null,
    artifactProfile: 'metrics-only',
    finalTick,
    endReason,
    finalAliveCount: outcome.report.aliveAtEnd,
    expectedDueDecisions: outcome.decisions.length,
    finalStateHash: outcome.report.finalStateHash,
    summaryHash,
    agents: { path: 'agents.json' },
    artifacts: [
      {
        kind: 'metrics',
        chunkId: 'metrics-0',
        path: 'metrics.ndjson',
        startTick: 0,
        endTick: finalTick,
      },
      { kind: 'final_state', chunkId: 'final-state-0', path: 'final-state.ndjson' },
    ],
  };

  writeAtomic(join(dir, 'metrics.ndjson'), `${metricsRows.join('\n')}\n`);
  writeAtomic(join(dir, 'final-state.ndjson'), `${finalStateText}\n`);
  writeAtomic(join(dir, 'agents.json'), `${JSON.stringify(agents)}\n`);
  const bundlePath = join(dir, 'bundle.json');
  writeAtomic(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    dir,
    bundlePath,
    metricsRows: metricsRows.length,
    agents: agents.length,
    finalTick,
    endReason,
  };
}
