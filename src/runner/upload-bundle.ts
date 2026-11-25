import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { StratifyError, errorCodes } from '../core/control/errors.js';
import type { RunConfig } from '../core/config/types.js';
import type {
  RunUploadBundle,
  UploadAgent,
  UploadArtifact,
  UploadArtifactKind,
  UploadExperiment,
  UploadIdentity,
} from './uploader.js';

/**
 * P5b 本地上传清单：`run-upload-bundle-file-v1`。
 *
 * 元数据直接内联，artifact/agent 用相对 bundle 文件的路径引用，避免把
 * 全分辨率 metrics 塞进一个巨大 JSON。所有引用路径必须位于 bundle 文件
 * 所在目录内；加载器拒绝 `..` 逃逸。
 */
export const UPLOAD_BUNDLE_FILE_SCHEMA = 'run-upload-bundle-file-v1' as const;

export interface UploadArtifactRef {
  readonly kind: UploadArtifactKind;
  readonly chunkId: string;
  readonly path: string;
  readonly startTick?: number | null;
  readonly endTick?: number | null;
}

export interface UploadBundleFile {
  readonly schemaVersion: typeof UPLOAD_BUNDLE_FILE_SCHEMA;
  readonly config: RunConfig;
  readonly identity: UploadIdentity;
  readonly experiment?: UploadExperiment | null;
  readonly artifactProfile: 'full' | 'metrics-only';
  readonly finalTick: number;
  readonly endReason: 'scheduled' | 'extinct';
  readonly finalAliveCount: number;
  readonly expectedDueDecisions: number;
  readonly finalStateHash: string;
  readonly summaryHash: string;
  /** 内联数组或 `{path}`；文件内容为 `UploadAgent[]` 或 `{agents: UploadAgent[]}`。 */
  readonly agents: readonly UploadAgent[] | { readonly path: string };
  readonly artifacts: readonly UploadArtifactRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new StratifyError(errorCodes.CONFIG_INVALID, message);
}

function resolveInside(bundleDir: string, reference: string): string {
  if (reference.length === 0) fail('bundle 中的文件路径不得为空');
  const resolved = resolve(bundleDir, reference);
  const rel = relative(bundleDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail(`bundle 文件路径逃逸目录: ${reference}`);
  }
  if (!existsSync(resolved)) fail(`bundle 引用的文件不存在: ${reference}`);
  return resolved;
}

function readAgents(bundleDir: string, value: UploadBundleFile['agents']): UploadAgent[] {
  if (Array.isArray(value)) return value as UploadAgent[];
  if (!isRecord(value) || typeof value['path'] !== 'string') {
    fail('agents 必须是数组或 {path}');
  }
  const text = readFileSync(resolveInside(bundleDir, value['path']), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail('agents 文件不是合法 JSON');
  }
  if (Array.isArray(parsed)) return parsed as UploadAgent[];
  if (isRecord(parsed) && Array.isArray(parsed['agents'])) {
    return parsed['agents'] as UploadAgent[];
  }
  fail('agents 文件必须是数组或 {agents: []}');
}

export function loadUploadBundle(bundlePath: string): RunUploadBundle {
  if (!existsSync(bundlePath)) fail(`bundle 不存在: ${bundlePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bundlePath, 'utf8')) as unknown;
  } catch {
    fail(`bundle 不是合法 JSON: ${bundlePath}`);
  }
  if (!isRecord(parsed)) fail('bundle 必须是对象');
  if (parsed['schemaVersion'] !== UPLOAD_BUNDLE_FILE_SCHEMA) {
    fail(`bundle schemaVersion 必须为 ${UPLOAD_BUNDLE_FILE_SCHEMA}`);
  }
  const file = parsed as unknown as UploadBundleFile;
  if (!Array.isArray(file.artifacts) || file.artifacts.length === 0) {
    fail('bundle.artifacts 不得为空');
  }
  const bundleDir = dirname(resolve(bundlePath));
  const artifacts: UploadArtifact[] = file.artifacts.map((ref, index) => {
    if (typeof ref.path !== 'string') {
      fail(`bundle.artifacts[${index}] 缺少 path`);
    }
    const ndjson = readFileSync(resolveInside(bundleDir, ref.path), 'utf8');
    if (ndjson.trim().length === 0) fail(`artifact 文件为空: ${ref.path}`);
    return {
      kind: ref.kind,
      chunkId: ref.chunkId,
      ndjson,
      startTick: ref.startTick ?? null,
      endTick: ref.endTick ?? null,
    };
  });
  return {
    schemaVersion: 'run-upload-bundle-v1',
    config: file.config,
    identity: file.identity,
    experiment: file.experiment ?? null,
    artifactProfile: file.artifactProfile,
    finalTick: file.finalTick,
    endReason: file.endReason,
    finalAliveCount: file.finalAliveCount,
    agents: readAgents(bundleDir, file.agents),
    expectedDueDecisions: file.expectedDueDecisions,
    finalStateHash: file.finalStateHash,
    summaryHash: file.summaryHash,
    artifacts,
  };
}
