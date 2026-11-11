import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDemoConfig } from '../../src/core/config/defaults.js';
import type { RunConfig } from '../../src/core/config/types.js';
import { computeConfigHash, computeParamsHash } from '../../src/core/config/hash.js';
import { asSeed } from '../../src/core/control/ids.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../../src/core/control/versions.js';
import { computeInitialPopulationHash } from '../../src/core/hash/state-hash.js';
import { deriveInitialPopulation } from '../../src/core/init/population.js';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from '../../src/worker/types.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function migrationSql(): string {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
    .join('\n');
}

type Row = Record<string, unknown>;

interface StatementState {
  sql: string;
  params: unknown[];
}

function statement(db: DatabaseSync, state: StatementState): D1PreparedStatement {
  const materialize = (): Row[] => {
    const prepared = db.prepare(state.sql);
    return prepared.all(...(state.params as never[])) as Row[];
  };
  return {
    bind(...values: readonly unknown[]): D1PreparedStatement {
      return statement(db, { sql: state.sql, params: values.map(normalize) });
    },
    async first<T = unknown>(column?: string): Promise<T | null> {
      const rows = materialize();
      const row = rows[0];
      if (row === undefined) return null;
      if (column !== undefined) return (row[column] ?? null) as T | null;
      return row as T;
    },
    async all<T = unknown>(): Promise<D1Result<T>> {
      return { results: materialize() as T[], success: true };
    },
    async run(): Promise<D1Result<unknown>> {
      const prepared = db.prepare(state.sql);
      const info = prepared.run(...(state.params as never[]));
      return {
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      };
    },
  };
}

function normalize(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

/** 用本机 node:sqlite 近似 Cloudflare D1，跑真实 migrations/0001_init.sql。 */
export function createTestD1(): D1Database & { readonly raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql());
  return {
    raw: db,
    prepare(query: string): D1PreparedStatement {
      return statement(db, { sql: query, params: [] });
    },
    async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
      db.exec('BEGIN');
      try {
        const results: D1Result<T>[] = [];
        for (const item of statements) {
          results.push((await item.run()) as D1Result<T>);
        }
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query: string): Promise<{ count: number; duration: number }> {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}

export function createTestR2(): R2Bucket & { readonly size: number } {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string | undefined; uploaded: Date }
  >();
  const describe = (key: string, uploaded: Date, bytes: Uint8Array): R2Object => {
    const etag = `"${key.length.toString(16)}-${bytes.length.toString(16)}"`;
    return { key, size: bytes.length, etag, httpEtag: etag, uploaded };
  };
  const bucket = {
    get size(): number {
      return objects.size;
    },
    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
      options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ): Promise<R2Object | null> {
      let bytes: Uint8Array;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else {
        bytes = new Uint8Array(await new Response(value).arrayBuffer());
      }
      const uploaded = new Date();
      objects.set(key, { bytes, uploaded, contentType: options?.httpMetadata?.contentType });
      return describe(key, uploaded, bytes);
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const entry = objects.get(key);
      if (entry === undefined) return null;
      const base = describe(key, entry.uploaded, entry.bytes);
      return {
        ...base,
        body: new Response(entry.bytes.slice().buffer).body as ReadableStream,
        async arrayBuffer(): Promise<ArrayBuffer> {
          const copy = new Uint8Array(entry.bytes.byteLength);
          copy.set(entry.bytes);
          return copy.buffer;
        },
        async text(): Promise<string> {
          return new TextDecoder().decode(entry.bytes);
        },
      };
    },
    async head(key: string): Promise<R2Object | null> {
      const entry = objects.get(key);
      return entry === undefined ? null : describe(key, entry.uploaded, entry.bytes);
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
  };
  return bucket;
}

export const TEST_RUNNER_TOKEN = 'test-runner-token';

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createTestD1(),
    ARTIFACTS: createTestR2(),
    RUNNER_TOKEN: TEST_RUNNER_TOKEN,
    ENVIRONMENT: 'test',
    VERSION: 'test',
    RUNTIME_VERSION: 'test-runtime',
    JEV_UPSTREAM_URL: 'https://jev.test/v1/choice',
    JEV_ALLOWED_MODELS: 'jev-small,jev-medium',
    ...overrides,
  };
}

export interface RunBodyOptions {
  readonly config?: RunConfig;
  readonly seed?: string;
  readonly experiment?: { experimentId: string; cellKey: string; seed: string };
  readonly artifactProfile?: 'full' | 'metrics-only';
}

/** 构造通过 `validateRunCreate` 的 run 创建体（哈希全部重算）。 */
export function makeRunBody(options: RunBodyOptions = {}): Record<string, unknown> {
  const config = options.config ?? createDemoConfig();
  const seed = options.seed ?? 'seed-0001';
  const population = deriveInitialPopulation(config, asSeed(seed));
  return {
    schemaVersion: 'run-v1',
    config: JSON.parse(JSON.stringify(config)) as RunConfig,
    identity: {
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      policyVersion: config.decision.policy,
      promptVersion: null,
      requestedModel: null,
      seed,
      runtimeVersion: 'test-runtime',
      configHash: computeConfigHash(config),
      paramsHash: computeParamsHash(config),
      initialPopulationHash: computeInitialPopulationHash(asSeed(seed), population),
      codeSha: 'test-code-sha',
    },
    schedule: {
      totalTicks: config.schedule.totalTicks,
      statsStride: config.schedule.statsStride,
      snapshotStride: config.schedule.snapshotStride,
    },
    experiment: options.experiment ?? null,
    artifactProfile: options.artifactProfile ?? 'full',
  };
}

export interface CreatedRun {
  readonly runId: string;
  readonly writeToken: string;
}

export const BASE = 'https://stratify.test';
