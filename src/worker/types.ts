/** Worker 运行时绑定的最小类型面；避免把 Cloudflare 全局类型与 DOM lib 混用。 */

export interface D1Meta {
  readonly duration?: number;
  readonly changes?: number;
  readonly last_row_id?: number;
}

export interface D1Result<T = unknown> {
  readonly results?: T[];
  readonly success: boolean;
  readonly meta?: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<R2Object | null>;
  get(key: string, options?: { onlyIf?: { etagMatches?: string } }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  readonly DB: D1Database;
  readonly ARTIFACTS: R2Bucket;
  readonly RUNNER_TOKEN?: string;
  readonly JEV_UPSTREAM_URL?: string;
  readonly JEV_ALLOWED_MODELS?: string;
  readonly ENVIRONMENT?: string;
  readonly VERSION?: string;
  /** 服务器权威 hash 运行时；与 run 的 runtimeVersion 不同则标记 non-authoritative（ADR 0001）。 */
  readonly RUNTIME_VERSION?: string;
}

export type WorkerBindings = { Bindings: Env; Variables: { requestId: string } };
