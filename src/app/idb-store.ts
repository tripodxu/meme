import type { TickEvent } from '../core/events.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import type { Snapshot } from '../core/replay/snapshot.js';
import type { DecisionRecord } from '../decision/types.js';
import type { WebRunBundle } from './types.js';

export interface StoredChunkCounts {
  readonly snapshots: number;
  readonly stats: number;
  readonly decisions: number;
  readonly events: number;
}

export interface StoredRunMeta {
  readonly runId: string;
  readonly updatedAt: string;
  readonly tick: number;
  readonly totalTicks: number;
  readonly status: string;
  readonly configHash: string;
  readonly seed: string;
  readonly policy: string;
  readonly chunkCounts?: StoredChunkCounts;
}

export type ChunkKind = 'snapshots' | 'stats' | 'decisions' | 'events';

interface StoredChunkRecord {
  readonly key: string;
  readonly runId: string;
  readonly kind: ChunkKind;
  readonly chunkIndex: number;
  readonly items: readonly unknown[];
}

type BundleHeaderOnly = Omit<
  WebRunBundle,
  'stats' | 'events' | 'decisions' | 'periodicSnapshots'
> & {
  readonly chunked?: true;
  readonly expectedChunks?: StoredChunkCounts;
};

const DB_NAME = 'stratify-web-v1';
const DB_VERSION = 3;
const STORE = 'runs';
const META_STORE = 'runs_meta';
const CHUNK_STORE = 'run_chunks';

const STATS_PER_CHUNK = 500;
const DECISIONS_PER_CHUNK = 500;
const EVENTS_PER_CHUNK = 250;
const SNAPSHOTS_PER_CHUNK = 4;

function sliceIntoChunks<T>(items: readonly T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

function makeChunkKey(runId: string, kind: ChunkKind, index: number): string {
  return `${runId}:${kind}:${String(index).padStart(5, '0')}`;
}

function toMeta(bundle: WebRunBundle, chunkCounts?: StoredChunkCounts): StoredRunMeta {
  const base: StoredRunMeta = {
    runId: bundle.runId,
    updatedAt: bundle.exportedAt,
    tick: bundle.latestSnapshot?.state.society.tick ?? 0,
    totalTicks: bundle.config.schedule.totalTicks,
    status: bundle.status,
    configHash: bundle.configHash,
    seed: bundle.seed,
    policy: bundle.policy,
  };
  return chunkCounts === undefined ? base : { ...base, chunkCounts };
}

/**
 * IndexedDB 适配器（v3 分块原子持久化，落实 06 §8 & §11.9）：
 * - `runs_meta`：轻量元数据与分块计数，秒级 `list()`；
 * - `run_chunks`：将 snapshots / stats / decisions / events 拆分为有界块写入；
 * - `runs`：保存权威头信息与快照兜底（向后兼容 v1/v2 单包记录）；
 * - 浏览器不支持 IndexedDB 时安全降级。
 */
export class IdbRunStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  static available(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    if (!IdbRunStore.available()) return Promise.reject(new Error('IndexedDB 不可用'));
    if (this.dbPromise !== null) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'runId' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'runId' });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
          chunkStore.createIndex('by_run', 'runId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  async save(bundle: WebRunBundle): Promise<void> {
    if (!IdbRunStore.available()) return;
    const db = await this.open();
    const hasChunks = db.objectStoreNames.contains(CHUNK_STORE);
    const hasMeta = db.objectStoreNames.contains(META_STORE);

    if (!hasChunks) {
      return new Promise<void>((resolve, reject) => {
        const names = hasMeta ? [STORE, META_STORE] : [STORE];
        const tx = db.transaction(names, 'readwrite');
        tx.objectStore(STORE).put(bundle);
        if (hasMeta) tx.objectStore(META_STORE).put(toMeta(bundle));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB save failed'));
      });
    }

    const statChunks = sliceIntoChunks(bundle.stats, STATS_PER_CHUNK);
    const decisionChunks = sliceIntoChunks(bundle.decisions, DECISIONS_PER_CHUNK);
    const eventChunks = sliceIntoChunks(bundle.events, EVENTS_PER_CHUNK);
    const periodicSnapshots = bundle.periodicSnapshots ?? [];
    const snapChunks = sliceIntoChunks(periodicSnapshots, SNAPSHOTS_PER_CHUNK);

    const chunkCounts: StoredChunkCounts = {
      snapshots:
        snapChunks.length + (bundle.initialSnapshot ? 1 : 0) + (bundle.latestSnapshot ? 1 : 0),
      stats: statChunks.length,
      decisions: decisionChunks.length,
      events: eventChunks.length,
    };

    const header: BundleHeaderOnly = {
      schemaVersion: bundle.schemaVersion,
      exportedAt: bundle.exportedAt,
      runId: bundle.runId,
      seed: bundle.seed,
      policy: bundle.policy,
      status: bundle.status,
      endReason: bundle.endReason,
      config: bundle.config,
      configHash: bundle.configHash,
      paramsHash: bundle.paramsHash,
      initialPopulationHash: bundle.initialPopulationHash,
      initialSnapshot: bundle.initialSnapshot,
      latestSnapshot: bundle.latestSnapshot,
      decisionsTruncated: bundle.decisionsTruncated,
      chunked: true,
      expectedChunks: chunkCounts,
    };

    const meta = toMeta(bundle, chunkCounts);

    return new Promise<void>((resolve, reject) => {
      const names = hasMeta ? [STORE, META_STORE, CHUNK_STORE] : [STORE, CHUNK_STORE];
      const tx = db.transaction(names, 'readwrite');
      const chunkStore = tx.objectStore(CHUNK_STORE);

      // 同一事务内先清理该 runId 旧分块，再原子写入新分块与 header
      const idx = chunkStore.index('by_run');
      const cursorReq = idx.openKeyCursor(IDBKeyRange.only(bundle.runId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor !== null) {
          chunkStore.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        const writeGroup = (kind: ChunkKind, groups: readonly (readonly unknown[])[]): void => {
          groups.forEach((items, index) => {
            const rec: StoredChunkRecord = {
              key: makeChunkKey(bundle.runId, kind, index),
              runId: bundle.runId,
              kind,
              chunkIndex: index,
              items,
            };
            chunkStore.put(rec);
          });
        };
        writeGroup('snapshots', snapChunks);
        writeGroup('stats', statChunks);
        writeGroup('decisions', decisionChunks);
        writeGroup('events', eventChunks);

        tx.objectStore(STORE).put(header);
        if (hasMeta) tx.objectStore(META_STORE).put(meta);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB chunked save failed'));
    });
  }

  async load(runId: string): Promise<WebRunBundle | null> {
    if (!IdbRunStore.available()) return null;
    try {
      const db = await this.open();
      const hasChunks = db.objectStoreNames.contains(CHUNK_STORE);
      const raw = await new Promise<(WebRunBundle & Partial<BundleHeaderOnly>) | undefined>(
        (resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(runId);
          req.onsuccess = () =>
            resolve(req.result as (WebRunBundle & Partial<BundleHeaderOnly>) | undefined);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB load failed'));
        },
      );
      if (raw === undefined) return null;
      if (raw.chunked !== true || !hasChunks) {
        return raw;
      }

      // 从分块表按序读取并核对分块完整性
      const chunks = await new Promise<StoredChunkRecord[]>((resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, 'readonly');
        const idx = tx.objectStore(CHUNK_STORE).index('by_run');
        const req = idx.getAll(IDBKeyRange.only(runId));
        req.onsuccess = () => resolve((req.result as StoredChunkRecord[]) ?? []);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB read chunks failed'));
      });
      chunks.sort((a, b) => a.kind.localeCompare(b.kind) || a.chunkIndex - b.chunkIndex);

      const byKind: Record<ChunkKind, StoredChunkRecord[]> = {
        snapshots: [],
        stats: [],
        decisions: [],
        events: [],
      };
      for (const c of chunks) {
        byKind[c.kind].push(c);
      }

      const expected = raw.expectedChunks;
      if (
        expected !== undefined &&
        (byKind.stats.length !== expected.stats ||
          byKind.decisions.length !== expected.decisions ||
          byKind.events.length !== expected.events)
      ) {
        // 分块缺失时不假装恢复成功（06 §11.9）
        return null;
      }

      const periodicSnapshots = byKind.snapshots.flatMap((c) => c.items as Snapshot[]);
      const stats = byKind.stats.flatMap((c) => c.items as TickStats[]);
      const decisions = byKind.decisions.flatMap((c) => c.items as DecisionRecord[]);
      const events = byKind.events.flatMap((c) => c.items as TickEvent[]);

      return {
        schemaVersion: raw.schemaVersion,
        exportedAt: raw.exportedAt,
        runId: raw.runId,
        seed: raw.seed,
        policy: raw.policy,
        status: raw.status,
        endReason: raw.endReason,
        config: raw.config,
        configHash: raw.configHash,
        paramsHash: raw.paramsHash,
        initialPopulationHash: raw.initialPopulationHash,
        initialSnapshot: raw.initialSnapshot,
        latestSnapshot: raw.latestSnapshot,
        periodicSnapshots,
        stats,
        events,
        decisions,
        decisionsTruncated: raw.decisionsTruncated,
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<StoredRunMeta[]> {
    if (!IdbRunStore.available()) return [];
    try {
      const db = await this.open();
      if (db.objectStoreNames.contains(META_STORE)) {
        const metas = await new Promise<StoredRunMeta[]>((resolve, reject) => {
          const tx = db.transaction(META_STORE, 'readonly');
          const req = tx.objectStore(META_STORE).getAll();
          req.onsuccess = () => resolve((req.result as StoredRunMeta[]) ?? []);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB list meta failed'));
        });
        if (metas.length > 0) {
          return [...metas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        }
      }
      const rows = await new Promise<WebRunBundle[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result as WebRunBundle[]) ?? []);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB list fallback failed'));
      });
      return rows.map((b) => toMeta(b)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async remove(runId: string): Promise<void> {
    if (!IdbRunStore.available()) return;
    const db = await this.open();
    const hasMeta = db.objectStoreNames.contains(META_STORE);
    const hasChunks = db.objectStoreNames.contains(CHUNK_STORE);
    const names = [STORE, ...(hasMeta ? [META_STORE] : []), ...(hasChunks ? [CHUNK_STORE] : [])];
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      tx.objectStore(STORE).delete(runId);
      if (hasMeta) tx.objectStore(META_STORE).delete(runId);
      if (hasChunks) {
        const chunkStore = tx.objectStore(CHUNK_STORE);
        const cursorReq = chunkStore.index('by_run').openKeyCursor(IDBKeyRange.only(runId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor !== null) {
            chunkStore.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB remove failed'));
    });
  }

  async clear(): Promise<void> {
    if (!IdbRunStore.available()) return;
    const db = await this.open();
    const hasMeta = db.objectStoreNames.contains(META_STORE);
    const hasChunks = db.objectStoreNames.contains(CHUNK_STORE);
    const names = [STORE, ...(hasMeta ? [META_STORE] : []), ...(hasChunks ? [CHUNK_STORE] : [])];
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      tx.objectStore(STORE).clear();
      if (hasMeta) tx.objectStore(META_STORE).clear();
      if (hasChunks) tx.objectStore(CHUNK_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
    });
  }
}
