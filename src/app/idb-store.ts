import type { WebRunBundle } from './types.js';

export interface StoredRunMeta {
  readonly runId: string;
  readonly updatedAt: string;
  readonly tick: number;
  readonly totalTicks: number;
  readonly status: string;
  readonly configHash: string;
  readonly seed: string;
  readonly policy: string;
}

const DB_NAME = 'stratify-web-v1';
const DB_VERSION = 1;
const STORE = 'runs';

/**
 * IndexedDB 适配器：只保存完整离线 bundle（配置、快照、统计、决策）。
 * 浏览器不支持 IndexedDB 时所有方法安全降级，调用方必须提示“刷新将丢失当前 run”。
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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  async save(bundle: WebRunBundle): Promise<void> {
    await this.transaction('readwrite', (store) => store.put(bundle));
  }

  async load(runId: string): Promise<WebRunBundle | null> {
    try {
      const result = await this.transaction<WebRunBundle | undefined>('readonly', (store) =>
        store.get(runId),
      );
      return result ?? null;
    } catch {
      return null;
    }
  }

  async list(): Promise<StoredRunMeta[]> {
    try {
      const rows = await this.transaction<WebRunBundle[]>('readonly', (store) => store.getAll());
      return rows
        .map((bundle) => ({
          runId: bundle.runId,
          updatedAt: bundle.exportedAt,
          tick: bundle.latestSnapshot?.state.society.tick ?? 0,
          totalTicks: bundle.config.schedule.totalTicks,
          status: bundle.status,
          configHash: bundle.configHash,
          seed: bundle.seed,
          policy: bundle.policy,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async remove(runId: string): Promise<void> {
    await this.transaction('readwrite', (store) => store.delete(runId));
  }

  async clear(): Promise<void> {
    await this.transaction('readwrite', (store) => store.clear());
  }
}
