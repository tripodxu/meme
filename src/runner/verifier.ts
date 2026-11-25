import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import type { RunConfig } from '../core/config/types.js';
import { validateRunConfig } from '../core/config/validate.js';
import { asSeed, type AgentId } from '../core/control/ids.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../core/control/versions.js';
import { step, type StepDecision } from '../core/engine/engine.js';
import { canonicalize } from '../core/hash/jcs.js';
import {
  computeAuthoritativeStateHash,
  computeInitialPopulationHash,
} from '../core/hash/state-hash.js';
import { deriveInitialPopulation } from '../core/init/population.js';
import { decodeSimState } from '../core/model/serialize.js';
import { restoreSnapshot } from '../core/replay/snapshot.js';
import {
  plannedStatsTicks,
  UPLOAD_BUNDLE_SCHEMA,
  type RunUploadBundle,
  type UploadAgent,
  type UploadArtifact,
  type UploadArtifactKind,
} from './uploader.js';

/**
 * P5b / P4-05 独立验证器（05 §4.6）：
 * - 对本地 `RunUploadBundle` 或远端 Worker 已上传 run 做压缩/未压缩双 SHA-256、
 *   NDJSON schema、单调连续性与权威确定性回放验证；
 * - 产出 `verification-report-v1` 及诊断摘要 `reportHash`（未注册独立 core domain 前不参与核心回放）；
 * - 可选使用 `RUNNER_TOKEN` 调用 `POST /api/runs/:id/verification` 将 `uploaded` 更新为 `verified` 或 `rejected`。
 */

export const VERIFICATION_REPORT_SCHEMA = 'verification-report-v1' as const;

export interface CheckedCounts {
  readonly artifacts: number;
  readonly metricsRows: number;
  readonly agentRows: number;
  readonly decisionRows: number;
  readonly eventRows: number;
  readonly snapshotRows: number;
  readonly replayedTicks: number;
}

export interface VerificationReport {
  readonly schemaVersion: typeof VERIFICATION_REPORT_SCHEMA;
  readonly status: 'verified' | 'rejected';
  readonly artifactProfile: 'full' | 'metrics-only';
  readonly replayable: boolean;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly finalTick: number;
  readonly endReason: 'scheduled' | 'extinct';
  readonly claimedFinalStateHash: string;
  readonly replayFinalStateHash: string | null;
  readonly checkedCounts: CheckedCounts;
  readonly reasons: readonly string[];
}

export interface VerificationOutcome {
  readonly status: 'verified' | 'rejected';
  readonly report: VerificationReport;
  /** 诊断摘要 SHA-256（RFC 8785 canonical JSON），满足 Worker `sha256:[0-9a-f]{64}` 格式。 */
  readonly reportHash: string;
}

export interface VerifyBundleOptions {
  /** 跨运行时 non-authoritative 记录允许跳过 initialPopulationHash 本地重算（ADR 0001）。默认 true。 */
  readonly checkInitialPopulationHash?: boolean;
}

export interface VerifyRemoteOptions {
  readonly baseUrl: string;
  readonly runId: string;
  readonly runnerToken?: string;
  /** 是否在验证完成后向 `POST /api/runs/:id/verification` 提交结果（需要 runnerToken）。 */
  readonly submit?: boolean;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface RemoteVerificationOutcome extends VerificationOutcome {
  readonly runId: string;
  readonly submitted: boolean;
  readonly serverStatus: string | null;
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNdjsonLines(
  ndjson: string,
  label: string,
  reasons: string[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const rawLines = ndjson.split('\n');
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]?.trim() ?? '';
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        reasons.push(`${label} 第 ${i + 1} 行不是 JSON 对象`);
      } else {
        out.push(parsed);
      }
    } catch {
      reasons.push(`${label} 第 ${i + 1} 行 JSON 解析失败`);
    }
  }
  return out;
}

function verifyMetricPayloadHash(row: Record<string, unknown>): boolean {
  const claimed = row['payloadHash'];
  if (typeof claimed !== 'string') return false;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k !== 'payloadHash') copy[k] = v;
  }
  return claimed === `sha256:${sha256Hex(JSON.stringify(copy))}`;
}

function verifyAgentPayloadHash(agent: UploadAgent): boolean {
  const copy = {
    agentId: agent.agentId,
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
  return agent.payloadHash === `sha256:${sha256Hex(JSON.stringify(copy))}`;
}

export function computeVerificationReportHash(report: VerificationReport): string {
  return `sha256:${sha256Hex(canonicalize(report))}`;
}

/**
 * 独立验证本地或重组后的 `RunUploadBundle`。
 * 任何 schema、hash、连续性或确定性回放不一致均记入 `reasons` 并返回 `status: 'rejected'`（不抛未捕获异常掩盖拒因）。
 */
export function verifyUploadBundle(
  bundle: RunUploadBundle,
  options: VerifyBundleOptions = {},
): VerificationOutcome {
  const reasons: string[] = [];
  const checkPopHash = options.checkInitialPopulationHash ?? true;

  if (bundle.schemaVersion !== UPLOAD_BUNDLE_SCHEMA) {
    reasons.push(`未知 bundle schemaVersion: ${String(bundle.schemaVersion)}`);
  }

  // 1. 校验 RunConfig、seed 与配置哈希
  const cfgCheck = validateRunConfig(bundle.config);
  let validConfig: RunConfig | null = null;
  if (!cfgCheck.ok) {
    reasons.push(`RunConfig 校验失败: ${cfgCheck.issues[0]?.message ?? '非法配置'}`);
  } else {
    validConfig = cfgCheck.config;
    const expectedCfgHash = computeConfigHash(validConfig);
    const expectedParamsHash = computeParamsHash(validConfig);
    if (bundle.identity.configHash !== expectedCfgHash) {
      reasons.push(
        `configHash 不一致: 声明 ${bundle.identity.configHash} ≠ 复算 ${expectedCfgHash}`,
      );
    }
    if (bundle.identity.paramsHash !== expectedParamsHash) {
      reasons.push(
        `paramsHash 不一致: 声明 ${bundle.identity.paramsHash} ≠ 复算 ${expectedParamsHash}`,
      );
    }
    try {
      const seed = asSeed(bundle.identity.seed);
      if (checkPopHash) {
        const pop = deriveInitialPopulation(validConfig, seed);
        const expectedPopHash = computeInitialPopulationHash(seed, pop);
        if (bundle.identity.initialPopulationHash !== expectedPopHash) {
          reasons.push('initialPopulationHash 与 (config, seed) 纯函数派生结果不一致');
        }
      }
    } catch (err) {
      reasons.push(`seed 非法: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. 解析并校验 metrics-v1 连续性与计划覆盖
  const metricRows: Record<string, unknown>[] = [];
  for (const art of bundle.artifacts.filter((a) => a.kind === 'metrics')) {
    metricRows.push(...parseNdjsonLines(art.ndjson, `metrics/${art.chunkId}`, reasons));
  }
  const metricsByTick = new Map<number, Record<string, unknown>>();
  let prevMetricTick = -1;
  for (const row of metricRows) {
    if (row['schemaVersion'] !== 'metrics-v1') {
      reasons.push(`metrics 行未知 schemaVersion: ${String(row['schemaVersion'])}`);
      continue;
    }
    const tick = row['tick'];
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick <= prevMetricTick) {
      reasons.push(`metrics tick 非严格单调递增: ${String(tick)}`);
      continue;
    }
    prevMetricTick = tick;
    if (!verifyMetricPayloadHash(row)) {
      reasons.push(`metrics tick ${tick} 的 payloadHash 校验失败`);
    }
    metricsByTick.set(tick, row);
  }

  if (validConfig !== null) {
    const planned = plannedStatsTicks(
      validConfig,
      bundle.finalTick,
      bundle.endReason === 'extinct',
    );
    for (const pt of planned) {
      if (!metricsByTick.has(pt)) {
        reasons.push(`metrics 缺失计划统计 tick ${pt}`);
      }
    }
    if (
      bundle.endReason === 'extinct' &&
      (bundle.finalTick >= validConfig.schedule.totalTicks - 1 || bundle.finalAliveCount !== 0)
    ) {
      reasons.push('extinct 终止条件与 finalTick / finalAliveCount 冲突');
    }
  }

  // 4. 校验 final-state-v1 与 agents 列表一致性
  const finalStateLines: Record<string, unknown>[] = [];
  for (const art of bundle.artifacts.filter((a) => a.kind === 'final_state')) {
    finalStateLines.push(...parseNdjsonLines(art.ndjson, `final_state/${art.chunkId}`, reasons));
  }
  if (finalStateLines.length !== 1) {
    reasons.push(`final_state 必须恰好 1 行，实际 ${finalStateLines.length} 行`);
  } else {
    const fLine = finalStateLines[0] as Record<string, unknown>;
    if (fLine['schemaVersion'] !== 'final-state-v1') {
      reasons.push(`final_state schemaVersion 非法: ${String(fLine['schemaVersion'])}`);
    }
    try {
      const decodedFinal = decodeSimState(fLine['finalState']);
      const recomputedFinalHash = computeAuthoritativeStateHash(decodedFinal);
      if (
        recomputedFinalHash !== bundle.finalStateHash ||
        fLine['finalStateHash'] !== bundle.finalStateHash
      ) {
        reasons.push('finalStateHash 与解码后的终局权威状态不一致');
      }
      if (decodedFinal.society.tick !== bundle.finalTick + 1) {
        reasons.push(
          `终局状态 society.tick (${decodedFinal.society.tick}) 应等于 finalTick+1 (${bundle.finalTick + 1})`,
        );
      }
      const aliveCount = decodedFinal.society.agents.filter((a) => a.alive).length;
      if (aliveCount !== bundle.finalAliveCount) {
        reasons.push(`终局状态存活人数 (${aliveCount}) 与声明 (${bundle.finalAliveCount}) 不一致`);
      }
      if (bundle.agents.length !== decodedFinal.society.agents.length) {
        reasons.push('agents 行数与终局状态人口数不一致');
      }
    } catch (err) {
      reasons.push(`final_state 解码失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const agent of bundle.agents) {
    if (!verifyAgentPayloadHash(agent)) {
      reasons.push(`agent ${agent.agentId} payloadHash 校验失败`);
      break;
    }
  }

  let decisionRowCount = 0;
  let eventRowCount = 0;
  let snapshotRowCount = 0;
  let replayedTicks = 0;
  let replayFinalStateHash: string | null = null;
  const replayable = bundle.artifactProfile === 'full';

  // 5. full profile：校验 snapshots / events / decisions 连续性，并从初始快照完整确定性回放！
  if (replayable) {
    const snapLines: Record<string, unknown>[] = [];
    for (const art of bundle.artifacts.filter((a) => a.kind === 'snapshot')) {
      snapLines.push(...parseNdjsonLines(art.ndjson, `snapshot/${art.chunkId}`, reasons));
    }
    snapshotRowCount = snapLines.length;
    const snapshotsByTick = new Map<number, ReturnType<typeof restoreSnapshot>>();
    const snapshotHashesByTick = new Map<number, string>();
    for (const sLine of snapLines) {
      if (sLine['schemaVersion'] !== 'snapshot-v1') {
        reasons.push(`snapshot 行未知 schemaVersion: ${String(sLine['schemaVersion'])}`);
        continue;
      }
      try {
        const restored = restoreSnapshot({
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          stateHash: sLine['stateHash'],
          state: sLine['snapshot'],
        });
        snapshotsByTick.set(restored.society.tick, restored);
        snapshotHashesByTick.set(restored.society.tick, String(sLine['stateHash']));
      } catch (err) {
        reasons.push(`snapshot 恢复校验失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const eventLines: Record<string, unknown>[] = [];
    for (const art of bundle.artifacts.filter((a) => a.kind === 'events')) {
      eventLines.push(...parseNdjsonLines(art.ndjson, `events/${art.chunkId}`, reasons));
    }
    eventRowCount = eventLines.length;
    let prevEvTick = -1;
    let prevEvSeq = 0;
    for (const ev of eventLines) {
      if (ev['schemaVersion'] !== 'event-v1') {
        reasons.push(`event 行未知 schemaVersion: ${String(ev['schemaVersion'])}`);
        break;
      }
      const t = ev['tick'];
      const seq = ev['seq'];
      if (typeof t !== 'number' || typeof seq !== 'number') {
        reasons.push('event 缺少数值 tick/seq');
        break;
      }
      if (t < prevEvTick || (t === prevEvTick && seq <= prevEvSeq)) {
        reasons.push(`events 顺序非严格单调: tick=${t}, seq=${seq}`);
        break;
      }
      prevEvTick = t;
      prevEvSeq = seq;
    }

    const decisionLines: Record<string, unknown>[] = [];
    for (const art of bundle.artifacts.filter((a) => a.kind === 'decisions')) {
      decisionLines.push(...parseNdjsonLines(art.ndjson, `decisions/${art.chunkId}`, reasons));
    }
    decisionRowCount = decisionLines.length;
    const decisionsByTick = new Map<number, Map<AgentId, StepDecision>>();
    for (const dLine of decisionLines) {
      if (dLine['schemaVersion'] !== 'decision-v1') {
        reasons.push(`decision 行未知 schemaVersion: ${String(dLine['schemaVersion'])}`);
        break;
      }
      if (dLine['tickSettled'] !== true) {
        reasons.push('completed run 包含未结算决策行 (tickSettled !== true)');
        break;
      }
      const tick = dLine['tick'];
      const agentId = dLine['agentId'];
      const rec = dLine['decision'];
      if (
        typeof tick !== 'number' ||
        typeof agentId !== 'string' ||
        !isRecord(rec) ||
        typeof rec['selectedAction'] !== 'string'
      ) {
        reasons.push('decision-v1 缺少 tick / agentId / decision.selectedAction');
        break;
      }
      let bucket = decisionsByTick.get(tick);
      if (bucket === undefined) {
        bucket = new Map();
        decisionsByTick.set(tick, bucket);
      }
      if (bucket.has(agentId as AgentId)) {
        reasons.push(`decision-v1 重复主键 (${tick}, ${agentId})`);
        break;
      }
      bucket.set(agentId as AgentId, {
        selectedAction: rec['selectedAction'],
        isFallback: rec['source'] === 'fallback',
      });
    }

    if (decisionRowCount !== bundle.expectedDueDecisions) {
      reasons.push(
        `decision-v1 行数 (${decisionRowCount}) 与 expectedDueDecisions (${bundle.expectedDueDecisions}) 不一致`,
      );
    }

    const initialState = snapshotsByTick.get(0);
    if (initialState === undefined) {
      reasons.push('full profile 缺少 tick=0 的初始权威快照');
    } else if (reasons.length === 0 && validConfig !== null) {
      let current = initialState;
      let totalReplayedEvents = 0;
      for (let tick = 0; tick <= bundle.finalTick; tick += 1) {
        const isDecisionTick = tick % validConfig.decision.interval === 0;
        const tickMap = decisionsByTick.get(tick) ?? new Map<AgentId, StepDecision>();
        if (isDecisionTick) {
          const aliveIds = current.society.agents.filter((a) => a.alive).map((a) => a.id);
          if (tickMap.size !== aliveIds.length || aliveIds.some((aid) => !tickMap.has(aid))) {
            reasons.push(
              `tick ${tick} 到期存活个体集合 (${aliveIds.length}) 与决策记录 (${tickMap.size}) 不一致`,
            );
            break;
          }
        } else if (tickMap.size > 0) {
          reasons.push(`非决策周期 tick ${tick} 出现了多余决策记录`);
          break;
        }

        const stepped = step(current, tickMap, { runId: 'verifier' });
        current = stepped.state;
        replayedTicks += 1;
        totalReplayedEvents += stepped.events.length;

        const mRow = metricsByTick.get(tick);
        if (
          mRow !== undefined &&
          (mRow['aliveCount'] !== stepped.stats.aliveCount ||
            mRow['gini'] !== stepped.stats.gini ||
            mRow['openness'] !== stepped.stats.openness ||
            mRow['segregation'] !== stepped.stats.segregation)
        ) {
          reasons.push(`tick ${tick} 回放统计指标与 metrics-v1 记录不一致`);
          break;
        }

        const expectedPeriodicHash = snapshotHashesByTick.get(current.society.tick);
        if (
          expectedPeriodicHash !== undefined &&
          computeAuthoritativeStateHash(current) !== expectedPeriodicHash
        ) {
          reasons.push(`周期快照 tick=${current.society.tick} stateHash 与回放状态不一致`);
          break;
        }
      }

      if (reasons.length === 0) {
        if (totalReplayedEvents !== eventRowCount) {
          reasons.push(
            `回放产生事件总数 (${totalReplayedEvents}) ≠ event-v1 记录数 (${eventRowCount})`,
          );
        }
        replayFinalStateHash = computeAuthoritativeStateHash(current);
        if (replayFinalStateHash !== bundle.finalStateHash) {
          reasons.push(
            `回放终局哈希 (${replayFinalStateHash}) ≠ 声明 finalStateHash (${bundle.finalStateHash})`,
          );
        }
      }
    }
  }

  const status: 'verified' | 'rejected' = reasons.length === 0 ? 'verified' : 'rejected';
  const report: VerificationReport = {
    schemaVersion: VERIFICATION_REPORT_SCHEMA,
    status,
    artifactProfile: bundle.artifactProfile,
    replayable,
    configHash: bundle.identity.configHash,
    paramsHash: bundle.identity.paramsHash,
    finalTick: bundle.finalTick,
    endReason: bundle.endReason,
    claimedFinalStateHash: bundle.finalStateHash,
    replayFinalStateHash,
    checkedCounts: {
      artifacts: bundle.artifacts.length,
      metricsRows: metricRows.length,
      agentRows: bundle.agents.length,
      decisionRows: decisionRowCount,
      eventRows: eventRowCount,
      snapshotRows: snapshotRowCount,
      replayedTicks,
    },
    reasons,
  };
  return {
    status,
    report,
    reportHash: computeVerificationReportHash(report),
  };
}

/**
 * 从远端（或本地内存）P4 Worker 下载 completed run 的全部清单、个体与 gzip 块，
 * 逐块验证 `compressed_sha256`、`uncompressed_sha256` 与 `artifactManifestHash`，
 * 执行 `verifyUploadBundle`，并在 `submit: true` 时回写 `POST /api/runs/:id/verification`。
 */
export async function verifyRemoteRun(
  options: VerifyRemoteOptions,
): Promise<RemoteVerificationOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const runResp = await fetchImpl(`${baseUrl}/api/runs/${options.runId}`);
  if (runResp.status !== 200) {
    throw new Error(`读取远端 run 失败: HTTP ${runResp.status}`);
  }
  const runDetail = (await runResp.json()) as Record<string, unknown>;
  if (runDetail['status'] !== 'completed') {
    throw new Error(`只有 completed run 可执行验证（当前状态: ${String(runDetail['status'])}）`);
  }

  const agentsResp = await fetchImpl(`${baseUrl}/api/runs/${options.runId}/agents`);
  if (agentsResp.status !== 200) {
    throw new Error(`读取远端 agents 失败: HTTP ${agentsResp.status}`);
  }
  const agentsBody = (await agentsResp.json()) as { agents?: UploadAgent[] };
  const agents = agentsBody.agents ?? [];

  const rawArtifactMeta = Array.isArray(runDetail['artifacts'])
    ? (runDetail['artifacts'] as Record<string, unknown>[])
    : [];
  const artifacts: UploadArtifact[] = [];
  const hashMismatchReasons: string[] = [];

  for (const meta of rawArtifactMeta) {
    const kind = String(meta['kind']) as UploadArtifactKind;
    const chunkId = String(meta['chunk_id']);
    const expectedCompressed = String(meta['compressed_sha256'] ?? '');
    const expectedUncompressed = String(meta['uncompressed_sha256'] ?? '');
    const artResp = await fetchImpl(
      `${baseUrl}/api/runs/${options.runId}/artifacts/${kind}/${chunkId}`,
    );
    if (artResp.status !== 200) {
      hashMismatchReasons.push(`下载 artifact ${kind}/${chunkId} 失败: HTTP ${artResp.status}`);
      continue;
    }
    const gzBytes = new Uint8Array(await artResp.arrayBuffer());
    const actualCompressed = sha256Hex(gzBytes);
    if (actualCompressed !== expectedCompressed) {
      hashMismatchReasons.push(`artifact ${kind}/${chunkId} 压缩 SHA-256 不匹配`);
      continue;
    }
    try {
      const ndjson = gunzipSync(gzBytes).toString('utf8');
      if (expectedUncompressed !== '' && sha256Hex(ndjson) !== expectedUncompressed) {
        hashMismatchReasons.push(`artifact ${kind}/${chunkId} 解压后未压缩 SHA-256 不匹配`);
      }
      artifacts.push({
        kind,
        chunkId,
        ndjson,
        startTick: typeof meta['start_tick'] === 'number' ? meta['start_tick'] : null,
        endTick: typeof meta['end_tick'] === 'number' ? meta['end_tick'] : null,
      });
    } catch {
      hashMismatchReasons.push(`artifact ${kind}/${chunkId} gzip 解压损坏`);
    }
  }

  const completeJson = isRecord(runDetail['complete']) ? runDetail['complete'] : {};
  const manifestList = rawArtifactMeta
    .map((m) => ({
      key: `${String(m['kind'])}/${String(m['chunk_id'])}`,
      sha256: String(m['compressed_sha256'] ?? ''),
      bytes: Number(m['bytes'] ?? 0),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const recomputedManifestHash = `sha256:${sha256Hex(JSON.stringify(manifestList))}`;
  if (
    typeof completeJson['artifactManifestHash'] === 'string' &&
    completeJson['artifactManifestHash'] !== recomputedManifestHash
  ) {
    hashMismatchReasons.push('远端 complete.artifactManifestHash 与 artifacts 清单不一致');
  }

  const reconstructed: RunUploadBundle = {
    schemaVersion: UPLOAD_BUNDLE_SCHEMA,
    config: runDetail['config'] as RunConfig,
    identity: {
      rulesVersion: String(runDetail['rulesVersion']),
      engineVersion: String(runDetail['engineVersion']),
      decisionSchemaVersion: String(runDetail['decisionSchemaVersion']),
      policyVersion: String(runDetail['policyVersion']),
      promptVersion:
        typeof runDetail['promptVersion'] === 'string' ? runDetail['promptVersion'] : null,
      requestedModel:
        typeof runDetail['requestedModel'] === 'string' ? runDetail['requestedModel'] : null,
      seed: String(runDetail['seed']),
      runtimeVersion: String(runDetail['runtimeVersion']),
      configHash: String(runDetail['configHash']),
      paramsHash: String(runDetail['paramsHash']),
      initialPopulationHash: String(runDetail['initialPopulationHash']),
      codeSha: String(runDetail['codeSha']),
    },
    artifactProfile: runDetail['artifactProfile'] as 'full' | 'metrics-only',
    finalTick: Number(runDetail['finalTick'] ?? 0),
    endReason: runDetail['endReason'] as 'scheduled' | 'extinct',
    finalAliveCount: Number(runDetail['finalAliveCount'] ?? 0),
    agents,
    expectedDueDecisions: Number(completeJson['expectedDueDecisions'] ?? 0),
    finalStateHash: String(runDetail['finalStateHash']),
    summaryHash: String(runDetail['summaryHash']),
    artifacts,
  };

  let outcome = verifyUploadBundle(reconstructed, {
    checkInitialPopulationHash: runDetail['runtimeAuthority'] === 'authoritative',
  });
  if (hashMismatchReasons.length > 0) {
    const mergedReport: VerificationReport = {
      ...outcome.report,
      status: 'rejected',
      reasons: [...hashMismatchReasons, ...outcome.report.reasons],
    };
    outcome = {
      status: 'rejected',
      report: mergedReport,
      reportHash: computeVerificationReportHash(mergedReport),
    };
  }

  let submitted = false;
  let serverStatus: string | null = null;
  if (options.submit === true) {
    if (options.runnerToken === undefined || options.runnerToken.length === 0) {
      throw new Error('提交远端验证状态需要提供 runnerToken');
    }
    const verifyResp = await fetchImpl(`${baseUrl}/api/runs/${options.runId}/verification`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.runnerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: outcome.status,
        reportHash: outcome.reportHash,
        checkedCounts: outcome.report.checkedCounts,
        replayFinalStateHash: outcome.report.replayFinalStateHash,
      }),
    });
    if (verifyResp.status !== 200) {
      throw new Error(`回写验证结果失败: HTTP ${verifyResp.status}`);
    }
    const verifyBody = (await verifyResp.json()) as { verificationStatus?: string };
    submitted = true;
    serverStatus = verifyBody.verificationStatus ?? outcome.status;
  }

  return {
    ...outcome,
    runId: options.runId,
    submitted,
    serverStatus,
  };
}
