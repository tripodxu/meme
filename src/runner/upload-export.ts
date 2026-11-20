import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { RunConfig } from '../core/config/types.js';
import { computeConfigHash } from '../core/config/hash.js';
import type { SimState } from '../core/model/state.js';
import type { Seed } from '../core/control/ids.js';
import { StratifyError, errorCodes } from '../core/control/errors.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../core/control/versions.js';
import { deriveInitialPopulation } from '../core/init/population.js';
import { computeInitialPopulationHash } from '../core/hash/state-hash.js';
import type { ArtifactStreamSink, RunOutcome } from './run-cell.js';

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

export function resolveUploadBundleDir(outDir: string, cellKey: string, seed: Seed): string {
  return join(outDir, `${safeSegment(cellKey)}-${safeSegment(String(seed))}`);
}

export function uploadBundleExists(outDir: string, cellKey: string, seed: Seed): boolean {
  return existsSync(join(resolveUploadBundleDir(outDir, cellKey, seed), 'bundle.json'));
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
    expectedDueDecisions: outcome.dueDecisionCount ?? outcome.decisions.length,
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

export interface StreamingBundleWriter {
  readonly sink: ArtifactStreamSink;
  finalize(outcome: RunOutcome): WrittenUploadBundle;
  abort(): void;
}

const STREAM_CHUNK_PATTERN = /^(decisions|events|snapshot)-(\d+)\.ndjson(\.stream\.tmp)?$/;

function tickOfLine(line: string): number | null {
  try {
    const value = JSON.parse(line) as { tick?: unknown };
    return typeof value.tick === 'number' ? value.tick : null;
  } catch {
    return null;
  }
}

function stateHashOfLine(line: string): string | null {
  try {
    const value = JSON.parse(line) as { stateHash?: unknown };
    return typeof value.stateHash === 'string' ? value.stateHash : null;
  } catch {
    return null;
  }
}

/**
 * 重启后检查既有分块：kill 可能截断最后一行，按最后一个换行修复；
 * 首尾 tick 从内容解析，避免额外维护分块清单。
 */
function inspectChunk(filePath: string): {
  bytes: number;
  startTick: number | null;
  endTick: number | null;
  lastStateHash: string | null;
} {
  let buffer = readFileSync(filePath);
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    buffer = buffer.subarray(0, lastNewline + 1);
    writeFileSync(filePath, buffer);
  }
  const lines = buffer
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const first = lines[0] === undefined ? null : tickOfLine(lines[0]);
  const lastLine = lines[lines.length - 1];
  const last = lastLine === undefined ? null : tickOfLine(lastLine);
  const lastStateHash = lastLine === undefined ? null : stateHashOfLine(lastLine);
  return { bytes: buffer.length, startTick: first, endTick: last, lastStateHash };
}

class RollingNdjsonStream {
  private index = 0;
  private currentBytes = 0;
  private startTick: number | null = null;
  private endTick: number | null = null;
  private currentTmpPath: string | null = null;
  readonly completedChunks: {
    readonly kind: string;
    readonly chunkId: string;
    readonly path: string;
    readonly tmpPath: string;
    readonly startTick: number | null;
    readonly endTick: number | null;
  }[] = [];
  readonly lastStateHash: string | null;

  constructor(
    private readonly dir: string,
    private readonly kind: 'decisions' | 'events' | 'snapshot',
    private readonly chunkBytes: number,
    resume: boolean,
  ) {
    this.lastStateHash = this.initialize(resume);
  }

  /** 返回最后一个 snapshot 的 stateHash（非 snapshot 流恒为 null）。 */
  private initialize(resume: boolean): string | null {
    if (!resume) {
      for (const entry of readdirSync(this.dir)) {
        const match = STREAM_CHUNK_PATTERN.exec(entry);
        if (match !== null && match[1] === this.kind) {
          rmSync(join(this.dir, entry), { force: true });
        }
      }
      return null;
    }
    const entries: { index: number; tmp: boolean; name: string }[] = [];
    for (const entry of readdirSync(this.dir)) {
      const match = STREAM_CHUNK_PATTERN.exec(entry);
      if (match === null || match[1] !== this.kind) continue;
      entries.push({ index: Number(match[2]), tmp: match[3] !== undefined, name: entry });
    }
    if (entries.length === 0) {
      // 初始 snapshot 在 tick 循环之前写出；缺失意味着无法重建可回放起点。
      if (this.kind === 'snapshot') {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          '无法恢复 full artifact：缺少初始 snapshot 分块',
        );
      }
      return null;
    }
    entries.sort((a, b) => a.index - b.index);
    for (const [position, entry] of entries.entries()) {
      if (entry.index !== position) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `${this.kind} 分块序号不连续：期望 ${position}，收到 ${entry.index}`,
        );
      }
    }
    let lastStateHash: string | null = null;
    const last = entries[entries.length - 1];
    for (const entry of entries) {
      const filePath = join(this.dir, entry.name);
      const inspected = inspectChunk(filePath);
      if (this.kind === 'snapshot' && inspected.lastStateHash !== null) {
        lastStateHash = inspected.lastStateHash;
      }
      const finalPath = join(this.dir, `${this.kind}-${entry.index}.ndjson`);
      const isLast = entry === last;
      if (isLast && entry.tmp && inspected.bytes < this.chunkBytes) {
        // 续写被 kill 时尚未封口的当前分块。
        this.currentTmpPath = filePath;
        this.currentBytes = inspected.bytes;
        this.startTick = inspected.startTick;
        this.endTick = inspected.endTick;
      } else {
        if (entry.tmp) renameSync(filePath, finalPath);
        this.completedChunks.push({
          kind: this.kind,
          chunkId: `${this.kind}-${entry.index}`,
          path: `${this.kind}-${entry.index}.ndjson`,
          tmpPath: finalPath,
          startTick: inspected.startTick,
          endTick: inspected.endTick,
        });
      }
      this.index = entry.index + 1;
    }
    return lastStateHash;
  }

  appendLine(line: string, tick: number | null): void {
    const lineWithNl = `${line}\n`;
    const byteLen = Buffer.byteLength(lineWithNl, 'utf8');
    if (this.currentTmpPath !== null && this.currentBytes + byteLen > this.chunkBytes) {
      this.sealCurrentChunk();
    }
    if (this.currentTmpPath === null) {
      const chunkId = `${this.kind}-${this.index}`;
      this.currentTmpPath = join(this.dir, `${chunkId}.ndjson.stream.tmp`);
      writeFileSync(this.currentTmpPath, '', 'utf8');
      this.currentBytes = 0;
      this.startTick = null;
      this.endTick = null;
    }
    appendFileSync(this.currentTmpPath, lineWithNl, 'utf8');
    this.currentBytes += byteLen;
    if (tick !== null) {
      if (this.startTick === null) this.startTick = tick;
      this.endTick = tick;
    }
  }

  private sealCurrentChunk(): void {
    if (this.currentTmpPath === null) return;
    const chunkId = `${this.kind}-${this.index}`;
    this.completedChunks.push({
      kind: this.kind,
      chunkId,
      path: `${chunkId}.ndjson`,
      tmpPath: this.currentTmpPath,
      startTick: this.startTick,
      endTick: this.endTick,
    });
    this.index += 1;
    this.currentTmpPath = null;
    this.currentBytes = 0;
    this.startTick = null;
    this.endTick = null;
  }

  promoteAll(): {
    kind: string;
    chunkId: string;
    path: string;
    startTick: number | null;
    endTick: number | null;
  }[] {
    this.sealCurrentChunk();
    return this.completedChunks.map((c) => {
      const finalPath = join(this.dir, c.path);
      if (c.tmpPath !== finalPath) {
        renameSync(c.tmpPath, finalPath);
      }
      return {
        kind: c.kind,
        chunkId: c.chunkId,
        path: c.path,
        startTick: c.startTick,
        endTick: c.endTick,
      };
    });
  }

  cleanupTmp(): void {
    // 保留已写分块以便断点续跑；只清掉空的当前临时文件。
    if (this.currentTmpPath !== null && statSync(this.currentTmpPath).size === 0) {
      rmSync(this.currentTmpPath, { force: true });
      this.currentTmpPath = null;
    }
  }
}

/**
 * P5b 流式 full bundle 写出器：
 * 逐 tick 将 decisions/events/snapshots 直接刷入磁盘 4 MiB 分块临时文件，
 * 不在 V8 堆内存中累积全程大数组，收尾时原子 rename 生成 `run-upload-bundle-file-v1`。
 */
export interface StreamingBundleWriterOptions extends Omit<
  WriteUploadBundleOptions,
  'outcome' | 'artifactProfile'
> {
  /** 为 true 时续写已有分块（run 内 checkpoint 恢复）；为 false 时清理旧分块重写。 */
  readonly resume?: boolean;
  /** 分块大小上限（测试可调小）；缺省 4 MiB。 */
  readonly chunkBytes?: number;
}

export function createStreamingBundleWriter(
  options: StreamingBundleWriterOptions,
): StreamingBundleWriter {
  const { config, seed } = options;
  const runId = options.runId ?? 'local-batch';
  const dir = resolveUploadBundleDir(options.outDir, options.cellKey, seed);
  mkdirSync(dir, { recursive: true });
  const chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const resume = options.resume === true;
  const identityPath = join(dir, 'full-export.json');
  const identity = {
    schemaVersion: 'upload-full-export-v1' as const,
    runId,
    cellKey: options.cellKey,
    seed: String(seed),
    configHash: computeConfigHash(config),
    chunkBytes,
  };
  if (resume) {
    if (!existsSync(identityPath)) {
      throw new StratifyError(
        errorCodes.INVARIANT_VIOLATED,
        'resume full 导出缺少 full-export.json，无法确认分块归属',
      );
    }
    const previous = JSON.parse(readFileSync(identityPath, 'utf8')) as Partial<typeof identity>;
    if (
      previous.schemaVersion !== identity.schemaVersion ||
      previous.cellKey !== identity.cellKey ||
      previous.seed !== identity.seed ||
      previous.configHash !== identity.configHash
    ) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        'full-export.json 与当前任务不一致，拒绝续写',
      );
    }
  } else {
    rmSync(identityPath, { force: true });
    writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, 'utf8');
  }

  const decStream = new RollingNdjsonStream(dir, 'decisions', chunkBytes, resume);
  const evStream = new RollingNdjsonStream(dir, 'events', chunkBytes, resume);
  const snapStream = new RollingNdjsonStream(dir, 'snapshot', chunkBytes, resume);
  let lastSnapshotHash: string | null = snapStream.lastStateHash;

  const writeSnapshot = (snapshot: { stateHash: string; state: unknown }): void => {
    if (lastSnapshotHash === snapshot.stateHash) return;
    lastSnapshotHash = snapshot.stateHash;
    snapStream.appendLine(
      JSON.stringify({
        schemaVersion: 'snapshot-v1',
        runId,
        stateHash: snapshot.stateHash,
        snapshot: snapshot.state,
      }),
      null,
    );
  };

  const sink: ArtifactStreamSink = {
    onInitialSnapshot(snapshot) {
      writeSnapshot(snapshot);
    },
    onTickSettled({ decisions, executions, events, periodicSnapshot }) {
      if (decisions.length > 0) {
        const execByAgent = new Map<string, unknown>();
        for (const ex of executions) {
          execByAgent.set(ex.agentId, ex);
        }
        for (const dec of decisions) {
          const execution = execByAgent.get(dec.agentId) ?? null;
          decStream.appendLine(
            JSON.stringify({
              schemaVersion: 'decision-v1',
              runId,
              tick: dec.tick,
              agentId: dec.agentId,
              decision: dec,
              execution,
              tickSettled: execution !== null,
            }),
            dec.tick,
          );
        }
      }
      for (const ev of events) {
        evStream.appendLine(JSON.stringify({ ...ev, schemaVersion: 'event-v1', runId }), ev.tick);
      }
      if (periodicSnapshot !== null) {
        writeSnapshot(periodicSnapshot);
      }
    },
    onFinalState(finalSnapshot) {
      writeSnapshot(finalSnapshot);
    },
  };

  return {
    sink,
    finalize(outcome: RunOutcome): WrittenUploadBundle {
      const streamedArtifacts = [
        ...decStream.promoteAll(),
        ...evStream.promoteAll(),
        ...snapStream.promoteAll(),
      ];
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
      const artifacts = [
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
        ...streamedArtifacts,
      ];
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
        artifactProfile: 'full' as const,
        finalTick,
        endReason,
        finalAliveCount: outcome.report.aliveAtEnd,
        expectedDueDecisions: outcome.dueDecisionCount ?? outcome.decisions.length,
        finalStateHash: outcome.report.finalStateHash,
        summaryHash,
        agents: { path: 'agents.json' },
        artifacts,
      };
      writeAtomic(join(dir, 'metrics.ndjson'), `${metricsRows.join('\n')}\n`);
      writeAtomic(join(dir, 'final-state.ndjson'), `${finalStateText}\n`);
      writeAtomic(join(dir, 'agents.json'), `${JSON.stringify(agents)}\n`);
      const bundlePath = join(dir, 'bundle.json');
      writeAtomic(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
      return {
        dir,
        bundlePath,
        artifactProfile: 'full',
        metricsRows: metricsRows.length,
        agents: agents.length,
        finalTick,
        endReason,
      };
    },
    abort(): void {
      // 保留已写分块与 full-export.json，供 checkpoint 续跑继续追加；
      // 只清理本次会话未写内容的空临时文件与可能残留的 bundle.json。
      decStream.cleanupTmp();
      evStream.cleanupTmp();
      snapStream.cleanupTmp();
      rmSync(join(dir, 'bundle.json'), { force: true });
    },
  };
}
