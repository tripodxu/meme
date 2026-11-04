import type { RunConfig } from '../core/config/types.js';
import type { AgentId, Seed } from '../core/control/ids.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';
import { rngUnit } from '../core/rng/rng.js';
import { RNG_EVENT_TAGS } from '../core/rng/tags.js';
import type { DecisionInput } from './policy.js';
import { buildActionCriteria, buildInstructions, PROMPT_VERSION } from './serialize.js';
import type { DecisionRecord, FallbackReason, PromptStyle } from './types.js';

/**
 * P2-03~05：Jev HTTP 客户端（04 §3.3/§4/§6/§7）。
 *
 * - 上游端点 `https://api.typesafe.ai/v1/systemone`（VPS 直连；浏览器经同源代理，P4-08）；
 * - `fetchImpl` 注入以便故障注入测试（401/403/429/529/5xx/超时/非法 JSON/空概率/未知选项）；
 * - 重试/退避/熔断/预算按 04 §6/§7；Key 只进 Authorization 头，不落日志/URL/错误对象。
 */

/** 单次请求预算与重试参数（04 §6 表；全部可配置并入 run manifest）。 */
export interface JevClientOptions {
  /**
   * 上游端点，默认 `DEFAULT_UPSTREAM_ENDPOINT`（04 §3.3）。
   *
   * 必须可配置的原因：官方域名按地域返回 451（`Typesafe is not available in
   * your region`），受限网络只能经自建网关转发；端点不同不改变决策语义，但
   * 影响可达性与实际模型名，必须随 run manifest 记录。
   */
  readonly endpoint?: string;
  readonly requestTimeoutMs: number;
  readonly maxTotalAttempts: number;
  readonly networkRetryLimit: number;
  readonly rateLimitRetryLimit: number;
  readonly serverErrorRetryLimit: number;
  readonly baseBackoffMs: number;
  readonly jitterMs: () => number;
  /**
   * run 级绝对截止时间（epoch ms），由 `maxRunMinutes` 换算；live run 必须设置（04 §7）。
   * 到达截止时间后不再发起新 attempt，按 `budget_exhausted` 回退并由策略暂停 run。
   */
  readonly deadlineMs?: number;
  /** 共享预算（04 §7）：每次 attempt 前原子预留；success(usage) 核销。 */
  readonly budget: JevBudget;
  readonly failureWindow: CircuitFailureWindow;
  readonly fallbackRateWindow: FallbackRateWindow;
}

export interface JevBudget {
  /**
   * 预留一次 attempt：1 call + `estimatedInputTokens`。
   * 在途预留与已核销 token 之和会超过上限时返回 false（fail-closed，04 §7）。
   */
  reserve(estimatedInputTokens: number): boolean;
  /** 成功：释放预留并按实际 usage 核销；actual>reserved 时记录 overage。 */
  settle(reservedInputTokens: number, actualInputTokens: number): void;
  /** 失败/取消/usage 缺失：保留预留并按估算计入已消耗（覆盖可能的上游消耗）。 */
  keepReserved(reservedInputTokens: number): void;
  /** usage 缺失计数（04 §7）；非必须实现。 */
  recordUsageUnknown?(): void;
  readonly exhausted: boolean;
}

/**
 * 无官方 tokenizer 时的保守估算版本（04 §7）；进入 run manifest。
 *
 * 版本沿革：
 * - `utf8-half-v1`（`bytes/2`）：**实测不保守**。真实 payload 1524 字节估算 762，
 *   上游实际 `input_tokens=908`，低估 16%。`AttemptBudget` 一旦 `overageDetected`
 *   就永久 `exhausted`（04 §7 的 fail-closed），于是第一个真实调用就会锁死整个
 *   live run——P2-07 冒烟在第二次决策即 `budget_exhausted`，attempts=0。
 * - `utf8-three-quarter-v1`（`bytes×3/4`）：对英文 JSON 高估约 26%，对中文 payload
 *   高估更多；满足「估算 >= 上游实际」这一前提，overage 才能回到真正的异常告警。
 */
export const TOKEN_ESTIMATOR_VERSION = 'utf8-three-quarter-v1';

/** `max(1, ceil(UTF8(payload).byteLength*3/4))`，只用于调度预算，不冒充上游账单。 */
export function estimateInputTokens(payload: string): number {
  return Math.max(1, Math.ceil((new TextEncoder().encode(payload).length * 3) / 4));
}

export interface CircuitFailureWindow {
  /** transport 失败计数（timeout/network/429/529/5xx）；按完成顺序记录最近 20 次。 */
  recordTransportFailure(): void;
  recordSuccess(): void;
  /** 最近 20 次 transport 失败>=10 或连续失败>=5。 */
  readonly open: boolean;
}

export interface FallbackRateWindow {
  recordFallback(): void;
  recordDue(): void;
  /** 最近 100 个到期决策回退率>20%。 */
  readonly exceeded: boolean;
}

export interface JevResponseOk {
  readonly kind: 'ok';
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
  readonly model: string | null;
  readonly usage: { inputTokens?: number; outputTokens?: number };
  readonly raw: unknown;
}

export type JevResponse =
  JevResponseOk | { readonly kind: 'invalid'; readonly reason: FallbackReason };

/** 官方 System One 端点（04 §3.3）；未显式配置端点时使用。 */
export const DEFAULT_UPSTREAM_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * 解析并校验上游端点（04 §10：Key 只进 Authorization 头）。
 *
 * - 只接受 `https:`：明文 `http:` 会把 Bearer Key 暴露在链路上；
 * - 拒绝 URL 内嵌 `user:pass`：凭据不得经 URL 传递，也不得进入日志与错误对象。
 */
export function resolveEndpoint(endpoint: string | undefined): string {
  if (endpoint === undefined) {
    return DEFAULT_UPSTREAM_ENDPOINT;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw jevConfigError('Jev 端点不是合法 URL');
  }
  if (parsed.protocol !== 'https:') {
    throw jevConfigError('Jev 端点必须使用 https（Bearer Key 不得经明文传输）');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw jevConfigError('Jev 端点不得内嵌用户信息（Key 只经 Authorization 头传递）');
  }
  return endpoint;
}

/** Retry-After 头：`present=false` 表示无头；`seconds=null` 表示非法 HTTP-date（04 §6）。 */
interface RetryAfterHeader {
  readonly present: boolean;
  readonly seconds: number | null;
}

/** 稳定码→可重试分类（04 §6）。 */
function classify(
  status: number,
  retryAfter: RetryAfterHeader | null,
): {
  retryable: boolean;
  reason: FallbackReason | null;
  delayMs: number | null;
} {
  if (status === 401) return { retryable: false, reason: 'http_401', delayMs: null };
  if (status === 403) return { retryable: false, reason: 'http_403', delayMs: null };
  if (status === 400 || status === 404 || status === 422) {
    return { retryable: false, reason: null, delayMs: null };
  }
  if (status === 429 || status === 529) {
    // Retry-After 只接受整数秒 0<=v<=20；>20 或非法 HTTP-date 不等待重试（04 §6）。
    if (retryAfter !== null && retryAfter.present) {
      if (retryAfter.seconds === null) {
        return { retryable: false, reason: 'retry_after_invalid', delayMs: null };
      }
      if (retryAfter.seconds > 20) {
        return { retryable: false, reason: 'retry_after_exceeded', delayMs: null };
      }
      return { retryable: true, reason: 'http_429', delayMs: retryAfter.seconds * 1000 };
    }
    return { retryable: true, reason: 'http_429', delayMs: null };
  }
  if (status >= 500) return { retryable: true, reason: 'upstream_5xx', delayMs: null };
  return { retryable: false, reason: null, delayMs: null };
}

/**
 * 退避（04 §6）：网络/超时 0.5/1s（加注入抖动）；429/529 无 Retry-After 1/2/4s；
 * 其他 5xx 固定 0.5s。`baseBackoffMs` 默认 500，由调用方配置并进入 manifest。
 */
function backoffDelay(
  attempt: number,
  options: JevClientOptions,
  kind: 'network' | 'rate' | 'server',
): number {
  const base = options.baseBackoffMs;
  if (kind === 'rate') {
    return base * Math.pow(2, Math.min(attempt + 1, 3));
  }
  if (kind === 'server') {
    return base;
  }
  return base * Math.pow(2, Math.min(attempt, 1)) + options.jitterMs();
}

export interface JevClientDeps {
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly nowMs: () => number;
}

/** 构建上游请求体（04 §3.3）：state/model/questions(action choice)，英文 criteria。 */
export function buildRequestBody(
  config: RunConfig,
  input: DecisionInput,
  requestedModel: string,
  promptStyle: PromptStyle,
): unknown {
  return {
    state: input.state,
    model: requestedModel,
    questions: {
      action: {
        type: 'choice',
        instructions: buildInstructions(config, promptStyle),
        criteria: buildActionCriteria(
          config,
          input.state as Parameters<typeof buildActionCriteria>[1],
        ),
      },
    },
  };
}

/** 解析响应（04 §4）：仅保留合法选项、概率有限非负、usage 缺失不伪造。 */
export function parseJevResponse(body: unknown, legalActions: readonly string[]): JevResponse {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'invalid', reason: 'invalid_json' };
  }
  const record = body as Record<string, unknown>;
  const answers = record['answers'];
  if (typeof answers !== 'object' || answers === null) {
    return { kind: 'invalid', reason: 'invalid_schema' };
  }
  const action = (answers as Record<string, unknown>)['action'];
  if (typeof action !== 'object' || action === null) {
    return { kind: 'invalid', reason: 'invalid_schema' };
  }
  const rawProbabilities = (action as Record<string, unknown>)['probabilities'];
  if (typeof rawProbabilities !== 'object' || rawProbabilities === null) {
    return { kind: 'invalid', reason: 'empty_legal_probability' };
  }
  const legalSet = new Set(legalActions);
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawProbabilities as Record<string, unknown>)) {
    if (!legalSet.has(key)) {
      continue; // 忽略未知键（04 §4.2）
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { kind: 'invalid', reason: 'non_finite_probability' };
    }
    probabilities[key] = value;
  }
  if (Object.keys(probabilities).length === 0) {
    return { kind: 'invalid', reason: 'no_legal_option' };
  }
  const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
  if (total <= 0) {
    return { kind: 'invalid', reason: 'empty_legal_probability' };
  }
  const confidenceRaw = (action as Record<string, unknown>)['confidence'];
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : null;
  const usageRaw = record['usage'];
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usageRaw === 'object' && usageRaw !== null) {
    const usageRecord = usageRaw as Record<string, unknown>;
    const inputTokens = usageRecord['input_tokens'] ?? usageRecord['inputTokens'];
    const outputTokens = usageRecord['output_tokens'] ?? usageRecord['outputTokens'];
    if (typeof inputTokens === 'number') {
      usage['inputTokens'] = inputTokens;
    }
    if (typeof outputTokens === 'number') {
      usage['outputTokens'] = outputTokens;
    }
  }
  return {
    kind: 'ok',
    probabilities,
    confidence,
    model: typeof record['model'] === 'string' ? record['model'] : null,
    usage,
    raw: body,
  };
}

export interface JevCallResult {
  readonly record: DecisionRecord;
  /** transport 失败与回退用于窗口统计（熔断/回退率）。 */
  readonly transportFailure: boolean;
  readonly fellBack: boolean;
}

/** topK=1 选择：合法概率最高者，并列按 legalActions 稳定顺序（04 §4.4）。 */
export function selectTop1(
  probabilities: Readonly<Record<string, number>>,
  legalActions: readonly string[],
): string | null {
  let best: string | null = null;
  let bestP = -1;
  for (const action of legalActions) {
    const p = probabilities[action] ?? 0;
    if (p > bestP) {
      bestP = p;
      best = action;
    }
  }
  return bestP > 0 ? best : null;
}

/**
 * 选择最终行动（04 §4.4/§4.5）：
 * - `topK<=1`：合法概率最高者，并列按 legalActions 稳定顺序；
 * - `topK>1`：取概率前 K（并列仍按 legalActions 顺序），按非负概率归一化后
 *   用 `R(seed,tick,agentId,"jev_topk",0)` 采样，每次最终响应最多消费一次。
 */
export function selectTopK(
  probabilities: Readonly<Record<string, number>>,
  legalActions: readonly string[],
  topK: number,
  seed: Seed,
  tick: number,
  agentId: AgentId,
): string | null {
  const candidates = legalActions
    .map((action, index) => ({ action, index, p: probabilities[action] ?? 0 }))
    .filter((candidate) => candidate.p > 0)
    .sort((a, b) => b.p - a.p || a.index - b.index);
  if (candidates.length === 0) {
    return null;
  }
  const k = Math.min(Math.max(1, Math.trunc(topK)), candidates.length);
  if (k === 1) {
    return candidates[0]?.action ?? null;
  }
  const top = candidates.slice(0, k);
  const total = top.reduce((sum, candidate) => sum + candidate.p, 0);
  if (!(total > 0)) {
    return null;
  }
  const unit = rngUnit(seed, tick, agentId, RNG_EVENT_TAGS.jevTopk, 0);
  let cumulative = 0;
  for (const candidate of top) {
    cumulative += candidate.p / total;
    if (unit < cumulative) {
      return candidate.action;
    }
  }
  return top[top.length - 1]?.action ?? null;
}

/**
 * 单个到期决策的完整 live 调用：重试/退避/取消/熔断/预算/回退（04 §4/§6/§7）。
 * 决不把 Key 写入日志/URL/错误对象；原始响应只进 DecisionRecord.rawResponse。
 */
export async function callJev(
  input: DecisionInput,
  apiKey: string,
  options: JevClientOptions,
  deps: JevClientDeps,
  promptStyle: PromptStyle,
  signal: AbortSignal,
): Promise<JevCallResult> {
  const startedAt = deps.nowMs();
  // 提前解析：端点非法属于配置错误，必须在消耗预算与发起 attempt 之前失败。
  const endpoint = resolveEndpoint(options.endpoint);
  const body = buildRequestBody(input.config, input, input.requestedModel, promptStyle);
  const payload = JSON.stringify(body);
  const estimatedInputTokens = estimateInputTokens(payload);
  let networkErrors = 0;
  let rateLimitErrors = 0;
  let serverErrors = 0;
  let attempts = 0;
  let lastReason: FallbackReason | null = null;
  let lastRaw: unknown = null;
  let lastModel: string | null = null;
  let lastUsage: { inputTokens?: number; outputTokens?: number } = {};

  const finishFallback = (reason: FallbackReason, transportFailure = false): JevCallResult => {
    options.fallbackRateWindow.recordFallback();
    return {
      transportFailure,
      fellBack: true,
      record: {
        schemaVersion: DECISION_SCHEMA_VERSION,
        runId: input.runId,
        tick: input.tick,
        agentId: input.agentId,
        stateHash: input.stateHash,
        actionSetHash: input.actionSetHash,
        legalActions: [...input.legal.actions],
        policyVersion: 'jev-choice-v1',
        promptVersion: PROMPT_VERSION,
        promptStyle,
        requestedAction: null,
        selectedAction: 'accumulate',
        source: 'fallback',
        probabilitySource: 'none',
        requestedModel: input.requestedModel,
        responseModel: lastModel,
        probabilities: null,
        confidence: null,
        topK: input.topK,
        usage: lastUsage,
        latencyMs: deps.nowMs() - startedAt,
        attempts,
        fallbackReason: reason,
        rawResponse: lastRaw,
      },
    };
  };

  while (attempts < options.maxTotalAttempts) {
    if (signal.aborted) {
      return finishFallback('cancelled');
    }
    if (options.deadlineMs !== undefined && deps.nowMs() >= options.deadlineMs) {
      return finishFallback('budget_exhausted');
    }
    if (options.budget.exhausted) {
      return finishFallback('budget_exhausted');
    }
    if (options.failureWindow.open) {
      return finishFallback(lastReason ?? 'network_error');
    }
    if (!options.budget.reserve(estimatedInputTokens)) {
      return finishFallback('budget_exhausted');
    }
    attempts += 1;
    let status = 0;
    let retryAfter: RetryAfterHeader | null = null;
    try {
      const timeoutSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(options.requestTimeoutMs),
      ]);
      const response = await deps.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: payload,
        signal: timeoutSignal,
      });
      status = response.status;
      const retryAfterHeader = response.headers.get('Retry-After');
      retryAfter =
        retryAfterHeader === null
          ? null
          : {
              present: true,
              seconds: /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null,
            };
      if (!response.ok) {
        const verdict = classify(status, retryAfter);
        if (!verdict.retryable) {
          options.budget.keepReserved(estimatedInputTokens);
          // 400/404/422 等不可重试 4xx 是上游客户端错误，不是响应 schema 问题。
          const reason: FallbackReason =
            verdict.reason ?? (status >= 400 ? 'http_client_error' : 'network_error');
          return finishFallback(reason);
        }
        lastReason = verdict.reason ?? 'upstream_5xx';
        if (lastReason === 'http_429') {
          rateLimitErrors += 1;
          options.failureWindow.recordTransportFailure();
          // 每次 attempt 都已在 reserve() 预留；失败必须保留结算，否则预算漏计。
          options.budget.keepReserved(estimatedInputTokens);
          if (rateLimitErrors >= options.rateLimitRetryLimit) break;
          const delay = verdict.delayMs ?? backoffDelay(rateLimitErrors - 1, options, 'rate');
          await deps.sleep(delay, signal);
          continue;
        }
        if (lastReason === 'upstream_5xx') {
          serverErrors += 1;
          options.failureWindow.recordTransportFailure();
          options.budget.keepReserved(estimatedInputTokens);
          if (serverErrors >= options.serverErrorRetryLimit) break;
          await deps.sleep(backoffDelay(serverErrors - 1, options, 'server'), signal);
          continue;
        }
      }
      const text = await response.text();
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        options.budget.keepReserved(estimatedInputTokens);
        return finishFallback('invalid_json');
      }
      const parsed = parseJevResponse(parsedBody, input.legal.actions);
      if (parsed.kind === 'invalid') {
        // 模型质量回退不计 transport 熔断（04 §6）。
        options.budget.keepReserved(estimatedInputTokens);
        return finishFallback(parsed.reason);
      }
      lastRaw = parsed.raw;
      lastModel = parsed.model;
      lastUsage = parsed.usage;
      // usage 缺失按预留结算并标记 usage_missing（04 §7）。
      if (parsed.usage.inputTokens === undefined) {
        options.budget.keepReserved(estimatedInputTokens);
        options.budget.recordUsageUnknown?.();
        return { ...finishFallback('usage_missing'), transportFailure: false, fellBack: true };
      }
      options.budget.settle(estimatedInputTokens, parsed.usage.inputTokens);
      options.failureWindow.recordSuccess();
      const selected =
        input.topK > 1
          ? selectTopK(
              parsed.probabilities,
              input.legal.actions,
              input.topK,
              input.seed,
              input.tick,
              input.agentId,
            )
          : selectTop1(parsed.probabilities, input.legal.actions);
      if (selected === null) {
        return finishFallback('empty_legal_probability');
      }
      const normalized: Record<string, number> = {};
      const total = Object.values(parsed.probabilities).reduce((sum, p) => sum + p, 0);
      for (const [key, p] of Object.entries(parsed.probabilities)) {
        normalized[key] = p / total;
      }
      // 回退率窗口每次到期决策只记一次：成功记 due，回退记 fallback（04 §6）。
      options.fallbackRateWindow.recordDue();
      return {
        transportFailure: false,
        fellBack: false,
        record: {
          schemaVersion: DECISION_SCHEMA_VERSION,
          runId: input.runId,
          tick: input.tick,
          agentId: input.agentId,
          stateHash: input.stateHash,
          actionSetHash: input.actionSetHash,
          legalActions: [...input.legal.actions],
          policyVersion: 'jev-choice-v1',
          promptVersion: PROMPT_VERSION,
          promptStyle,
          requestedAction: selected,
          selectedAction: selected,
          source: 'jev_live',
          probabilitySource: 'exact',
          requestedModel: input.requestedModel,
          responseModel: parsed.model,
          probabilities: normalized,
          confidence: parsed.confidence,
          topK: input.topK,
          usage: parsed.usage,
          latencyMs: deps.nowMs() - startedAt,
          attempts,
          fallbackReason: null,
          rawResponse: parsed.raw,
        },
      };
    } catch (error) {
      options.budget.keepReserved(estimatedInputTokens);
      if (signal.aborted) {
        return finishFallback('cancelled');
      }
      // AbortSignal.timeout / fetch 超时可能抛 TimeoutError 或 AbortError（04 §6）。
      const isTimeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      networkErrors += 1;
      options.failureWindow.recordTransportFailure();
      lastReason = isTimeout ? 'timeout' : 'network_error';
      if (networkErrors >= options.networkRetryLimit) break;
      await deps.sleep(backoffDelay(networkErrors - 1, options, 'network'), signal);
    }
  }
  // 每次 attempt 的 transport 失败已在循环内记录，此处不得重复记账。
  return finishFallback(
    lastReason ?? 'network_error',
    lastReason === null ||
      lastReason === 'timeout' ||
      lastReason === 'network_error' ||
      lastReason === 'http_429' ||
      lastReason === 'upstream_5xx',
  );
}

/** 便捷错误：不携带 Key（04 §10）。 */
export function jevConfigError(message: string): StratifyError {
  return new StratifyError(errorCodes.CONFIG_INVALID, message);
}
