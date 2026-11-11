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
 * - `metrics-only`：全分辨率 metrics + final_state + agents；
 * - `full`：额外导出 decisions/events/snapshot，要求 run 以 `captureArtifacts`
 *   执行（否则本地直接拒绝，不伪造可回放）。
 *
 * 输出目录：`<outDir>/<safeCell>-<safeSeed>/`，含 bundle.json 与各 NDJSON。
 * 所有文件先写 `.tmp` 再 rename。
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
  /** 缺省 metrics-only。 */
  readonly artifactProfile?: 'full' | 'metrics-only';
}

export interface WrittenUploadBundle {
  readonly dir: string;
  readonly bundlePath: string;
  readonly artifactProfile: 'full' | 'metrics-only';
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

/** P5b：单块未压缩上限 4 MiB，留足 gzip/请求头余量（服务端限制 8 MiB）。 */
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

function lineTick(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const tick = (parsed as Record<string, unknown>)['tick'];
      if (typeof tick === 'number' && Number.isInteger(tick)) return tick;
    }
  } catch {
    // 行由本模块生成，解析失败不应阻止按字节分块；tick 范围保持 null。
  }
  return null;
}

function chunkLines(lines: readonly string[]): {
  index: number;
  lines: readonly string[];
  startTick: number | null;
  endTick: number | null;
}[] {
  const chunks: {
    index: number;
    lines: readonly string[];
    startTick: number | null;
    endTick: number | null;
  }[] = [];
  let current: string[] = [];
  let bytes = 0;
  let startTick: number | null = null;
  let endTick: number | null = null;
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, lines: current, startTick, endTick });
    current = [];
    bytes = 0;
    startTick = null;
    endTick = null;
  };
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (current.length > 0 && bytes + size > UPLOAD_CHUNK_BYTES) flush();
    current.push(line);
    bytes += size;
    const tick = lineTick(line);
    if (tick !== null) {
      if (startTick === null) startTick = tick;
      endTick = tick;
    }
  }
  flush();
  return chunks;
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
  const artifactProfile = options.artifactProfile ?? 'metrics-only';
  const artifacts: {
    kind: string;
    chunkId: string;
    path: string;
    startTick: number | null;
    endTick: number | null;
  }[] = [
    {
      kind: 'metrics',
      chunkId: 'metrics-0',
      path: 'metrics.ndjson',
      startTick: 0,
      endTick: finalTick,
    },
    {
      kind: 'final_state',
      chunkId: 'final-state-0',
      path: 'final-state.ndjson',
      startTick: null,
      endTick: null,
    },
  ];
  const files: { name: string; text: string }[] = [
    { name: 'metrics.ndjson', text: `${metricsRows.join('\n')}\n` },
    { name: 'final-state.ndjson', text: `${finalStateText}\n` },
  ];
  if (artifactProfile === 'full') {
    if (
      outcome.events === undefined ||
      outcome.snapshots === undefined ||
      outcome.executionsByTick === undefined
    ) {
      throw new Error(
        'full artifact 需要 runSingle({captureArtifacts:true}) 的 events/snapshots/executions',
      );
    }
    const executions = new Map<string, { tick: number; agentId: string }>();
    for (const [tick, records] of outcome.executionsByTick) {
      for (const record of records) {
        executions.set(`${tick}:${record.agentId}`, record);
      }
    }
    const decisionLines = outcome.decisions.map((decision) => {
      const execution = executions.get(`${decision.tick}:${decision.agentId}`) ?? null;
      return JSON.stringify({
        schemaVersion: 'decision-v1',
        runId,
        tick: decision.tick,
        agentId: decision.agentId,
        decision,
        execution,
        tickSettled: execution !== null,
      });
    });
    const eventLines = outcome.events.map((event) =>
      JSON.stringify({ ...event, schemaVersion: 'event-v1', runId }),
    );
    const snapshotLines = outcome.snapshots.map((snapshot) =>
      JSON.stringify({
        schemaVersion: 'snapshot-v1',
        runId,
        stateHash: snapshot.stateHash,
        snapshot: snapshot.state,
      }),
    );
    for (const [kind, lines] of [
      ['decisions', decisionLines],
      ['events', eventLines],
      ['snapshot', snapshotLines],
    ] as const) {
      for (const chunk of chunkLines(lines)) {
        const chunkId = `${kind}-${chunk.index}`;
        const name = `${chunkId}.ndjson`;
        artifacts.push({
          kind,
          chunkId,
          path: name,
          startTick: chunk.startTick,
          endTick: chunk.endTick,
        });
        files.push({ name, text: `${chunk.lines.join('\n')}\n` });
      }
    }
  }
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
    artifactProfile,
    finalTick,
    endReason,
    finalAliveCount: outcome.report.aliveAtEnd,
    expectedDueDecisions: outcome.decisions.length,
    finalStateHash: outcome.report.finalStateHash,
    summaryHash,
    agents: { path: 'agents.json' },
    artifacts,
  };

  for (const file of files) {
    writeAtomic(join(dir, file.name), file.text);
  }
  writeAtomic(join(dir, 'agents.json'), `${JSON.stringify(agents)}\n`);
  const bundlePath = join(dir, 'bundle.json');
  writeAtomic(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    dir,
    bundlePath,
    artifactProfile,
    metricsRows: metricsRows.length,
    agents: agents.length,
    finalTick,
    endReason,
  };
}
