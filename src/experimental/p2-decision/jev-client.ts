import type { RunConfig } from '../../core/config/types.js';
import { errorCodes, StratifyError } from '../../core/control/errors.js';
import { DECISION_SCHEMA_VERSION } from '../../core/control/versions.js';
import type { DecisionInput } from './policy.js';
import { buildActionCriteria, buildInstructions, PROMPT_VERSION } from './serialize.js';
import type { DecisionRecord, FallbackReason, PromptStyle } from '../../decision/types.js';

/**
 * P2-03~05：Jev HTTP 客户端（04 §3.3/§4/§6/§7）。
 *
 * - 上游端点 `https://api.typesafe.ai/v1/systemone`（VPS 直连；浏览器经同源代理，P4-08）；
 * - `fetchImpl` 注入以便故障注入测试（401/403/429/529/5xx/超时/非法 JSON/空概率/未知选项）；
 * - 重试/退避/熔断/预算按 04 §6/§7；Key 只进 Authorization 头，不落日志/URL/错误对象。
 */

/** 单次请求预算与重试参数（04 §6 表；全部可配置并入 run manifest）。 */
export interface JevClientOptions {
  readonly requestTimeoutMs: number;
  readonly maxTotalAttempts: number;
  readonly networkRetryLimit: number;
  readonly rateLimitRetryLimit: number;
  readonly serverErrorRetryLimit: number;
  readonly baseBackoffMs: number;
  readonly jitterMs: () => number;
  /** 共享预算（04 §7）：每次 attempt 前原子预留；success(usage) 核销。 */
  readonly budget: JevBudget;
  readonly failureWindow: CircuitFailureWindow;
  readonly fallbackRateWindow: FallbackRateWindow;
  /** live run 必须配置；缺失属于配置错误。 */
  readonly maxCalls?: number;
}

export interface JevBudget {
  /** 预留一次 attempt；返回 false 表示预算耗尽（不再发请求）。 */
  reserve(): boolean;
  /** 成功后按实际 usage 核销预留。 */
  settle(inputTokens: number): void;
  /** 失败/取消保留预留（覆盖可能的上游消耗）。 */
  keepReserved(): void;
  readonly exhausted: boolean;
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

const UPSTREAM_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 稳定码→可重试分类（04 §6）。 */
function classify(
  status: number,
  retryAfterSeconds: number | null,
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
    // Retry-After 只接受整数秒 0<=v<=20；>20 或非法不等待重试（04 §6）。
    if (retryAfterSeconds !== null && retryAfterSeconds >= 0 && retryAfterSeconds <= 20) {
      return { retryable: true, reason: 'http_429', delayMs: retryAfterSeconds * 1000 };
    }
    if (retryAfterSeconds !== null && retryAfterSeconds > 20) {
      return { retryable: false, reason: 'retry_after_exceeded', delayMs: null };
    }
    return { retryable: true, reason: 'http_429', delayMs: null };
  }
  if (status >= 500) return { retryable: true, reason: 'upstream_5xx', delayMs: null };
  return { retryable: false, reason: null, delayMs: null };
}

function backoffDelay(attempt: number, options: JevClientOptions, jitter: boolean): number {
  // 网络/超时退避 0.5/1s；429/529 无 Retry-After 退避 1/2/4s；其他 5xx 0.5s（04 §6）。
  const base = options.baseBackoffMs * Math.pow(2, Math.min(attempt, 2));
  return base + (jitter ? options.jitterMs() : 0);
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
  const body = buildRequestBody(input.config, input, input.requestedModel, promptStyle);
  let networkErrors = 0;
  let rateLimitErrors = 0;
  let serverErrors = 0;
  let attempts = 0;
  let lastReason: FallbackReason | null = null;
  let lastRaw: unknown = null;
  let lastModel: string | null = null;
  let lastUsage: { inputTokens?: number; outputTokens?: number } = {};

  const finishFallback = (reason: FallbackReason): JevCallResult => {
    options.fallbackRateWindow.recordFallback();
    return {
      transportFailure: false,
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
    if (options.budget.exhausted) {
      return finishFallback('budget_exhausted');
    }
    if (options.failureWindow.open) {
      return finishFallback(lastReason ?? 'network_error');
    }
    if (!options.budget.reserve()) {
      return finishFallback('budget_exhausted');
    }
    attempts += 1;
    let status = 0;
    let retryAfter: number | null = null;
    try {
      const timeoutSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(options.requestTimeoutMs),
      ]);
      const response = await deps.fetchImpl(UPSTREAM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: timeoutSignal,
      });
      status = response.status;
      const retryAfterHeader = response.headers.get('Retry-After');
      if (retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)) {
        retryAfter = Number(retryAfterHeader);
      }
      if (!response.ok) {
        const verdict = classify(status, retryAfter);
        if (!verdict.retryable) {
          options.budget.keepReserved();
          const reason: FallbackReason =
            verdict.reason ?? (status >= 400 ? 'invalid_schema' : 'network_error');
          return finishFallback(reason);
        }
        lastReason = verdict.reason ?? 'upstream_5xx';
        if (lastReason === 'http_429') {
          rateLimitErrors += 1;
          options.failureWindow.recordTransportFailure();
          if (rateLimitErrors >= options.rateLimitRetryLimit) break;
          const delay = verdict.delayMs ?? backoffDelay(rateLimitErrors - 1, options, true);
          await deps.sleep(delay, signal);
          continue;
        }
        if (lastReason === 'upstream_5xx') {
          serverErrors += 1;
          options.failureWindow.recordTransportFailure();
          if (serverErrors >= options.serverErrorRetryLimit) break;
          await deps.sleep(backoffDelay(serverErrors - 1, options, true), signal);
          continue;
        }
      }
      const text = await response.text();
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        options.budget.keepReserved();
        return finishFallback('invalid_json');
      }
      const parsed = parseJevResponse(parsedBody, input.legal.actions);
      if (parsed.kind === 'invalid') {
        // 模型质量回退不计 transport 熔断（04 §6）。
        options.budget.keepReserved();
        return finishFallback(parsed.reason);
      }
      lastRaw = parsed.raw;
      lastModel = parsed.model;
      lastUsage = parsed.usage;
      // usage 缺失按预留结算并标记 usage_missing（04 §7）。
      if (parsed.usage.inputTokens === undefined) {
        options.budget.keepReserved();
        return { ...finishFallback('usage_missing'), transportFailure: false, fellBack: true };
      }
      options.budget.settle(parsed.usage.inputTokens);
      options.failureWindow.recordSuccess();
      options.fallbackRateWindow.recordDue();
      const selected = selectTop1(parsed.probabilities, input.legal.actions);
      if (selected === null) {
        return finishFallback('empty_legal_probability');
      }
      const normalized: Record<string, number> = {};
      const total = Object.values(parsed.probabilities).reduce((sum, p) => sum + p, 0);
      for (const [key, p] of Object.entries(parsed.probabilities)) {
        normalized[key] = p / total;
      }
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
    } catch {
      options.budget.keepReserved();
      if (signal.aborted) {
        return finishFallback('cancelled');
      }
      networkErrors += 1;
      options.failureWindow.recordTransportFailure();
      lastReason = 'network_error';
      if (networkErrors >= options.networkRetryLimit) break;
      await deps.sleep(backoffDelay(networkErrors - 1, options, true), signal);
    }
  }
  options.failureWindow.recordTransportFailure();
  return finishFallback(lastReason ?? 'network_error');
}

/** 便捷错误：不携带 Key（04 §10）。 */
export function jevConfigError(message: string): StratifyError {
  return new StratifyError(errorCodes.CONFIG_INVALID, message);
}
