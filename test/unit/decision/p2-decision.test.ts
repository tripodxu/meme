import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asAgentId, asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import { rngUnit } from '../../../src/core/rng/rng.js';
import { RNG_EVENT_TAGS } from '../../../src/core/rng/tags.js';
import { StratifyError, errorCodes } from '../../../src/core/control/errors.js';
import { AttemptBudget, JevLivePolicy } from '../../../src/decision/live.js';
import { buildDecisionState, PROMPT_VERSION } from '../../../src/decision/serialize.js';
import {
  buildRequestBody,
  callJev,
  DEFAULT_UPSTREAM_ENDPOINT,
  estimateInputTokens,
  parseJevResponse,
  resolveEndpoint,
  selectTop1,
  selectTopK,
  TOKEN_ESTIMATOR_VERSION,
  type CircuitFailureWindow,
  type FallbackRateWindow,
  type JevBudget,
  type JevClientDeps,
} from '../../../src/decision/jev-client.js';
import type { DecisionInput } from '../../../src/decision/policy.js';
import { runSingle } from '../../../src/runner/run-cell.js';

const SEED = asSeed('jev-client-seed');

function baseOptions(
  overrides: Partial<Parameters<typeof callJev>[2]> = {},
): Parameters<typeof callJev>[2] {
  return {
    requestTimeoutMs: 1000,
    maxTotalAttempts: 4,
    networkRetryLimit: 3,
    rateLimitRetryLimit: 4,
    serverErrorRetryLimit: 2,
    baseBackoffMs: 1,
    jitterMs: () => 0,
    budget: okBudget(),
    failureWindow: okCircuit(),
    fallbackRateWindow: okFallbackRate(),
    ...overrides,
  };
}

function okBudget(): JevBudget & { reserved: number; settled: number } {
  return {
    reserved: 0,
    settled: 0,
    reserve() {
      this.reserved += 1;
      return true;
    },
    settle(_reservedTokens: number, actualTokens: number) {
      this.settled = actualTokens;
    },
    keepReserved() {},
    get exhausted() {
      return false;
    },
  };
}

function okCircuit(): CircuitFailureWindow {
  let consecutive = 0;
  return {
    recordTransportFailure() {
      consecutive += 1;
    },
    recordSuccess() {
      consecutive = 0;
    },
    get open() {
      return consecutive >= 5;
    },
  };
}

function okFallbackRate(): FallbackRateWindow {
  return {
    recordFallback() {},
    recordDue() {},
    get exceeded() {
      return false;
    },
  };
}

function countingCircuit(): CircuitFailureWindow & {
  transportFailures: number;
  successes: number;
} {
  let consecutive = 0;
  return {
    transportFailures: 0,
    successes: 0,
    recordTransportFailure() {
      this.transportFailures += 1;
      consecutive += 1;
    },
    recordSuccess() {
      this.successes += 1;
      consecutive = 0;
    },
    get open() {
      return consecutive >= 5;
    },
  };
}

function countingFallbackRate(): FallbackRateWindow & { due: number; fallback: number } {
  return {
    due: 0,
    fallback: 0,
    recordFallback() {
      this.fallback += 1;
    },
    recordDue() {
      this.due += 1;
    },
    get exceeded() {
      return false;
    },
  };
}

function depsWith(fetchImpl: typeof fetch, overrides: Partial<JevClientDeps> = {}): JevClientDeps {
  return {
    fetchImpl,
    sleep: async () => {},
    nowMs: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
    ...overrides,
  };
}

async function makeInput(): Promise<{ input: DecisionInput; apiKey: string }> {
  const config = createDemoConfig({ population: { initialPopulation: 6 } });
  const state = createSimulation(config, SEED);
  const agent = state.society.agents[0];
  if (agent === undefined) throw new Error('roster 过小');
  const legal = enumerateLegalActions(state, agent.id);
  const decisionState = buildDecisionState(state, agent.id, legal, []);
  return {
    apiKey: 'sk-test-not-a-real-key',
    input: {
      runId: 'local-jev-test',
      seed: SEED,
      config,
      tick: 0,
      agentId: agent.id,
      stateHash: 'sha256:aa',
      actionSetHash: 'sha256:bb',
      legal,
      state: decisionState,
      simState: state,
      topK: 1,
      requestedModel: 'jev-1.13.0',
      promptVersion: PROMPT_VERSION,
      promptStyle: 'neutral',
      recentEvents: [],
    },
  };
}

function okResponse(model = 'jev-1.13.0', probabilities?: Record<string, number>): Response {
  const body = {
    model,
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      action: {
        probabilities: probabilities ?? { accumulate: 0.7, ascend: 0.3 },
        confidence: 0.9,
      },
    },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('Jev 客户端故障注入（04 §4/§6/§7）', () => {
  it('正常响应：exact 概率、usage 核销、模型落日志', async () => {
    const { input, apiKey } = await makeInput();
    const budget = okBudget();
    const calls: Request[] = [];
    const deps = depsWith(async (_url, init) => {
      calls.push(new Request('https://x', init));
      return okResponse();
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ budget }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(result.fellBack).toBe(false);
    expect(result.record.source).toBe('jev_live');
    expect(result.record.probabilitySource).toBe('exact');
    expect(result.record.selectedAction).toBe('accumulate');
    expect(result.record.responseModel).toBe('jev-1.13.0');
    expect(result.record.usage?.inputTokens).toBe(100);
    expect(budget.settled).toBe(100);
    // Key 不进 URL/请求体日志以外的地方：Authorization 头存在
    const headers = calls[0]?.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
  });

  it('401/403 不重试且立即回退', async () => {
    const { input, apiKey } = await makeInput();
    for (const status of [401, 403]) {
      let calls = 0;
      const deps = depsWith(async () => {
        calls += 1;
        return new Response('denied', { status });
      });
      const result = await callJev(
        input,
        apiKey,
        baseOptions(),
        deps,
        'neutral',
        new AbortController().signal,
      );
      expect(calls).toBe(1);
      expect(result.fellBack).toBe(true);
      expect(result.record.fallbackReason).toBe(status === 401 ? 'http_401' : 'http_403');
      expect(result.record.source).toBe('fallback');
      expect(result.record.selectedAction).toBe('accumulate');
    }
  });

  it('429 尊重整数秒 Retry-After；>20 记 retry_after_exceeded 不重试', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const sleeps: number[] = [];
    const deps = depsWith(
      async () => {
        calls += 1;
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } });
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    const retried = await callJev(
      input,
      apiKey,
      baseOptions(),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(sleeps).toContain(2000);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(retried.fellBack).toBe(true);

    let calls2 = 0;
    const deps2 = depsWith(async () => {
      calls2 += 1;
      return new Response('nope', { status: 429, headers: { 'Retry-After': '60' } });
    });
    const result2 = await callJev(
      input,
      apiKey,
      baseOptions(),
      deps2,
      'neutral',
      new AbortController().signal,
    );
    expect(calls2).toBe(1);
    expect(result2.record.fallbackReason).toBe('retry_after_exceeded');
  });

  it('5xx 分类限次重试；混合错误共享全局 4 次上限', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const deps = depsWith(async () => {
      calls += 1;
      return calls <= 2
        ? new Response('boom', { status: 500 })
        : new Response('rate', { status: 429 });
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ serverErrorRetryLimit: 2, rateLimitRetryLimit: 4 }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBeLessThanOrEqual(4);
    expect(result.fellBack).toBe(true);
  });

  it('网络错误退避重试，达到分类上限回退 network_error', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const deps = depsWith(
      async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
      { sleep: async () => {} },
    );
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ networkRetryLimit: 3, maxTotalAttempts: 4 }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBe(3);
    expect(result.record.fallbackReason).toBe('network_error');
    expect(result.record.attempts).toBe(3);
  });

  it('超时按 timeout 回退；每次 attempt 只记一次 transport 失败', async () => {
    const { input, apiKey } = await makeInput();
    const failureWindow = countingCircuit();
    let calls = 0;
    const deps = depsWith(async () => {
      calls += 1;
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ networkRetryLimit: 2, failureWindow }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    expect(result.record.fallbackReason).toBe('timeout');
    expect(result.transportFailure).toBe(true);
    // 循环内逐 attempt 记账，收尾不得再补记一次（04 §6）。
    expect(failureWindow.transportFailures).toBe(2);
  });

  it('网络错误达到上限：transport 失败数等于 attempt 数，无额外记账', async () => {
    const { input, apiKey } = await makeInput();
    const failureWindow = countingCircuit();
    const deps = depsWith(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ networkRetryLimit: 3, failureWindow }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(result.record.fallbackReason).toBe('network_error');
    expect(result.transportFailure).toBe(true);
    expect(failureWindow.transportFailures).toBe(3);
  });

  it('退避节奏：网络 0.5/1s、429 无头 1/2/4s、5xx 固定 0.5s', async () => {
    const { input, apiKey } = await makeInput();
    const signal = new AbortController().signal;

    const netSleeps: number[] = [];
    await callJev(
      input,
      apiKey,
      baseOptions({ baseBackoffMs: 500, networkRetryLimit: 3 }),
      depsWith(
        async () => {
          throw new TypeError('fetch failed');
        },
        {
          sleep: async (ms) => {
            netSleeps.push(ms);
          },
        },
      ),
      'neutral',
      signal,
    );
    expect(netSleeps).toEqual([500, 1000]);

    const rateSleeps: number[] = [];
    await callJev(
      input,
      apiKey,
      baseOptions({ baseBackoffMs: 500, rateLimitRetryLimit: 4, maxTotalAttempts: 5 }),
      depsWith(async () => new Response('rate', { status: 429 }), {
        sleep: async (ms) => {
          rateSleeps.push(ms);
        },
      }),
      'neutral',
      signal,
    );
    expect(rateSleeps).toEqual([1000, 2000, 4000]);

    const serverSleeps: number[] = [];
    await callJev(
      input,
      apiKey,
      baseOptions({ baseBackoffMs: 500, serverErrorRetryLimit: 2 }),
      depsWith(async () => new Response('boom', { status: 503 }), {
        sleep: async (ms) => {
          serverSleeps.push(ms);
        },
      }),
      'neutral',
      signal,
    );
    expect(serverSleeps).toEqual([500]);
  });

  it('400/404/422 记 http_client_error 且不重试', async () => {
    const { input, apiKey } = await makeInput();
    for (const status of [400, 404, 422]) {
      let calls = 0;
      const result = await callJev(
        input,
        apiKey,
        baseOptions(),
        depsWith(async () => {
          calls += 1;
          return new Response('bad request', { status });
        }),
        'neutral',
        new AbortController().signal,
      );
      expect(calls).toBe(1);
      expect(result.record.fallbackReason).toBe('http_client_error');
    }
  });

  it('熔断打开时 live 策略暂停 run（jev_circuit_open）', async () => {
    const { input, apiKey } = await makeInput();
    const openCircuit: CircuitFailureWindow = {
      recordTransportFailure() {},
      recordSuccess() {},
      get open() {
        return true;
      },
    };
    const policy = new JevLivePolicy(
      apiKey,
      baseOptions({ failureWindow: openCircuit }),
      depsWith(async () => okResponse()),
    );
    const error: unknown = await policy.decide(input, new AbortController().signal).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as StratifyError).code).toBe(errorCodes.JEV_CIRCUIT_OPEN);
  });

  it('回退率超阈值时 live 策略暂停 run（jev_fallback_rate_exceeded）', async () => {
    const { input, apiKey } = await makeInput();
    const exceeded: FallbackRateWindow = {
      recordFallback() {},
      recordDue() {},
      get exceeded() {
        return true;
      },
    };
    const policy = new JevLivePolicy(
      apiKey,
      baseOptions({ fallbackRateWindow: exceeded }),
      depsWith(async () => okResponse()),
    );
    const error: unknown = await policy.decide(input, new AbortController().signal).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as StratifyError).code).toBe(errorCodes.JEV_FALLBACK_RATE_EXCEEDED);
  });

  it('401/403 立即停止 live run，错误码稳定且不含 Key', async () => {
    const { input, apiKey } = await makeInput();
    for (const status of [401, 403]) {
      const policy = new JevLivePolicy(
        apiKey,
        baseOptions(),
        depsWith(async () => new Response('denied', { status })),
      );
      const error: unknown = await policy.decide(input, new AbortController().signal).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StratifyError);
      expect((error as StratifyError).code).toBe(errorCodes.JEV_AUTH_FAILED);
      // 04 §10：错误消息/对象不得携带 Key 内容。
      expect((error as Error).message).not.toContain(apiKey);
    }
  });

  it('非法 Retry-After（HTTP-date）记 retry_after_invalid 且不重试', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const deps = depsWith(async () => {
      calls += 1;
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      });
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions(),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(result.fellBack).toBe(true);
    expect(result.record.fallbackReason).toBe('retry_after_invalid');
    expect(result.transportFailure).toBe(false);
  });

  it('回退率窗口：成功只记 due，模型质量回退只记 fallback', async () => {
    const { input, apiKey } = await makeInput();
    const okWindow = countingFallbackRate();
    const ok = await callJev(
      input,
      apiKey,
      baseOptions({ fallbackRateWindow: okWindow }),
      depsWith(async () => okResponse()),
      'neutral',
      new AbortController().signal,
    );
    expect(ok.fellBack).toBe(false);
    expect(okWindow.due).toBe(1);
    expect(okWindow.fallback).toBe(0);

    const badWindow = countingFallbackRate();
    const bad = await callJev(
      input,
      apiKey,
      baseOptions({ fallbackRateWindow: badWindow }),
      depsWith(async () => new Response('not json', { status: 200 })),
      'neutral',
      new AbortController().signal,
    );
    expect(bad.fellBack).toBe(true);
    expect(bad.transportFailure).toBe(false);
    expect(badWindow.due).toBe(0);
    expect(badWindow.fallback).toBe(1);
  });

  it('AbortSignal 取消立即回退 cancelled 且不再发请求', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const deps = depsWith(async () => {
      calls += 1;
      return okResponse();
    });
    const result = await callJev(input, apiKey, baseOptions(), deps, 'neutral', controller.signal);
    expect(calls).toBe(0);
    expect(result.record.fallbackReason).toBe('cancelled');
  });

  it('非法 JSON/空概率/负概率/未知选项安全回退', async () => {
    const { input, apiKey } = await makeInput();
    const cases: Array<[Response, string]> = [
      [new Response('not json', { status: 200 }), 'invalid_json'],
      [new Response(JSON.stringify({ model: 'm' }), { status: 200 }), 'invalid_schema'],
      [
        new Response(JSON.stringify({ answers: { action: { probabilities: {} } } }), {
          status: 200,
        }),
        'no_legal_option',
      ],
      [
        new Response(
          JSON.stringify({ answers: { action: { probabilities: { accumulate: -1 } } } }),
          { status: 200 },
        ),
        'non_finite_probability',
      ],
      [
        new Response(JSON.stringify({ answers: { action: { probabilities: { attack: 1 } } } }), {
          status: 200,
        }),
        'no_legal_option',
      ],
    ];
    for (const [response, reason] of cases) {
      const deps = depsWith(async () => response);
      const result = await callJev(
        input,
        apiKey,
        baseOptions(),
        deps,
        'neutral',
        new AbortController().signal,
      );
      expect(result.record.fallbackReason).toBe(reason);
    }
  });

  it('usage 缺失按预留结算并回退 usage_missing', async () => {
    const { input, apiKey } = await makeInput();
    const deps = depsWith(
      async () =>
        new Response(
          JSON.stringify({ model: 'm', answers: { action: { probabilities: { accumulate: 1 } } } }),
          { status: 200 },
        ),
    );
    const result = await callJev(
      input,
      apiKey,
      baseOptions(),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(result.record.fallbackReason).toBe('usage_missing');
  });

  it('token 估算：max(1, ceil(UTF8*3/4))', () => {
    // `{"a":1}` 是 7 字节 → ceil(5.25)=6
    expect(estimateInputTokens('{"a":1}')).toBe(6);
    expect(estimateInputTokens('')).toBe(1);
    expect(TOKEN_ESTIMATOR_VERSION).toBe('utf8-three-quarter-v1');
  });

  it('估算器对真实 payload 必须保守（P2-07 实测：1524 字节 → 上游 908 tokens）', () => {
    // 旧版 `utf8-half-v1` 给出 762 < 908，直接触发 overage 并永久锁死 live run。
    const realPayload = 'x'.repeat(1524);
    expect(estimateInputTokens(realPayload)).toBeGreaterThanOrEqual(908);
  });

  it('AttemptBudget：预留/核销/超估算 overage/失败保留', () => {
    const budget = new AttemptBudget(2, 100);
    expect(budget.reserve(40)).toBe(true);
    // 在途预留 + 已消耗不得超过上限
    expect(budget.reserve(70)).toBe(false);
    budget.settle(40, 60);
    expect(budget.overage).toBe(true);
    expect(budget.exhausted).toBe(true);
    expect(budget.reserve(1)).toBe(false);

    const kept = new AttemptBudget(2, 100);
    expect(kept.reserve(30)).toBe(true);
    kept.keepReserved(30);
    kept.recordUsageUnknown();
    expect(kept.usageUnknownCount).toBe(1);
    // 保留的估算已计入消耗：30+80>100
    expect(kept.reserve(80)).toBe(false);
    expect(kept.reserve(70)).toBe(true);
  });

  it('429/5xx 重试的预留全部结算，不漏计在途 token', async () => {
    const { input, apiKey } = await makeInput();
    const retrying = new AttemptBudget(10, 10_000_000);
    let calls = 0;
    const success = await callJev(
      input,
      apiKey,
      baseOptions({ budget: retrying, rateLimitRetryLimit: 4 }),
      depsWith(async () => {
        calls += 1;
        return calls <= 2 ? new Response('rate', { status: 429 }) : okResponse();
      }),
      'neutral',
      new AbortController().signal,
    );
    expect(success.fellBack).toBe(false);
    // 两次失败 attempt 的预留必须转为已消耗，而不是残留在途额度。
    expect(retrying.inFlightTokens).toBe(0);
    expect(retrying.exhausted).toBe(false);

    const failing = new AttemptBudget(10, 10_000_000);
    await callJev(
      input,
      apiKey,
      baseOptions({ budget: failing, serverErrorRetryLimit: 2 }),
      depsWith(async () => new Response('boom', { status: 503 })),
      'neutral',
      new AbortController().signal,
    );
    expect(failing.inFlightTokens).toBe(0);
  });

  it('usage 缺失时 live 策略暂停 run（jev_usage_missing）', async () => {
    const { input, apiKey } = await makeInput();
    const policy = new JevLivePolicy(
      apiKey,
      baseOptions(),
      depsWith(
        async () =>
          new Response(
            JSON.stringify({
              model: 'm',
              answers: { action: { probabilities: { accumulate: 1 } } },
            }),
            { status: 200 },
          ),
      ),
    );
    const error: unknown = await policy.decide(input, new AbortController().signal).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as StratifyError).code).toBe(errorCodes.JEV_USAGE_MISSING);
  });

  it('run 截止时间已到：不再发请求，按 budget_exhausted 回退', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ deadlineMs: -1 }),
      depsWith(async () => {
        calls += 1;
        return okResponse();
      }),
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBe(0);
    expect(result.record.fallbackReason).toBe('budget_exhausted');
    expect(result.transportFailure).toBe(false);
  });

  it('预算耗尽时 live 策略暂停 run（jev_budget_exhausted）', async () => {
    const { input, apiKey } = await makeInput();
    const exhaustedBudget: JevBudget = {
      reserve: () => false,
      settle: () => {},
      keepReserved() {},
      get exhausted() {
        return false;
      },
    };
    const policy = new JevLivePolicy(
      apiKey,
      baseOptions({ budget: exhaustedBudget }),
      depsWith(async () => okResponse()),
    );
    const error: unknown = await policy.decide(input, new AbortController().signal).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as StratifyError).code).toBe(errorCodes.JEV_BUDGET_EXHAUSTED);
  });

  it('预算耗尽不再发请求（budget_exhausted）', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const exhaustedBudget: JevBudget = {
      reserve: () => false,
      settle: () => {},
      keepReserved() {},
      get exhausted() {
        return true;
      },
    };
    const deps = depsWith(async () => {
      calls += 1;
      return okResponse();
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ budget: exhaustedBudget }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBe(0);
    expect(result.record.fallbackReason).toBe('budget_exhausted');
  });

  it('熔断窗口 open 时直接回退', async () => {
    const { input, apiKey } = await makeInput();
    let calls = 0;
    const openCircuit: CircuitFailureWindow = {
      recordTransportFailure() {},
      recordSuccess() {},
      get open() {
        return true;
      },
    };
    const deps = depsWith(async () => {
      calls += 1;
      return okResponse();
    });
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ failureWindow: openCircuit }),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(calls).toBe(0);
    expect(result.record.fallbackReason).not.toBeNull();
  });

  it('请求体白名单：state/model/questions(action)，criteria 与 legalActions 一致', async () => {
    const { input } = await makeInput();
    const body = buildRequestBody(input.config, input, 'jev-1.13.0', 'neutral') as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    const questions = body['questions'] as Record<string, unknown>;
    expect(Object.keys(questions)).toEqual(['action']);
    const action = questions['action'] as Record<string, unknown>;
    expect(action['type']).toBe('choice');
    const criteria = action['criteria'] as Record<string, string>;
    expect(Object.keys(criteria)).toContain('accumulate');
    for (const target of input.legal.targets) {
      expect(Object.keys(criteria)).toContain(`compete:${target}`);
    }
  });

  it('society.classPopulationShares 为决策时点存活份额（prompt-v3）', () => {
    const config = createDemoConfig({ population: { initialPopulation: 12 } });
    const run = runSingle(config, SEED, { policy: 'random-uniform-v1', maxTicks: 200 });
    const state = run.finalState;
    const alive = state.society.agents.filter((agent) => agent.alive);
    expect(alive.length).toBeGreaterThan(0);
    const agent = alive[0];
    if (agent === undefined) throw new Error('roster 无存活个体');
    const legal = enumerateLegalActions(state, agent.id);
    const decisionState = buildDecisionState(state, agent.id, legal, []);
    const counts = new Array<number>(config.population.classCount).fill(0);
    for (const candidate of alive) {
      counts[candidate.classIndex] = (counts[candidate.classIndex] ?? 0) + 1;
    }
    expect(decisionState.society.classPopulationShares).toEqual(
      counts.map((count) => count / alive.length),
    );
    // 该运行已发生死亡/流动：当前份额必须不同于初始份额（否则本用例无法捕获回归）。
    expect(decisionState.society.classPopulationShares).not.toEqual(
      state.society.initialClassShares,
    );
    expect(PROMPT_VERSION).toBe('prompt-v3');
  });

  it('topK>1：前 K 归一化后用 jev_topk 地址采样', () => {
    const seed = asSeed('topk-select-seed');
    const agentId = asAgentId('a-0001');
    const probabilities = { accumulate: 0.5, ascend: 0.5, descend: 0 };
    const legal = ['accumulate', 'ascend', 'descend'];
    expect(selectTopK(probabilities, legal, 1, seed, 7, agentId)).toBe('accumulate');
    const unit = rngUnit(seed, 7, agentId, RNG_EVENT_TAGS.jevTopk, 0);
    expect(selectTopK(probabilities, legal, 2, seed, 7, agentId)).toBe(
      unit < 0.5 ? 'accumulate' : 'ascend',
    );
    // 第 3 个选项概率为 0，不得进入 topK。
    expect(selectTopK(probabilities, legal, 2, seed, 7, agentId)).not.toBe('descend');
  });

  it('callJev 在 topK=2 时使用同一采样结果', async () => {
    const { input, apiKey } = await makeInput();
    const [first, second] = input.legal.actions;
    if (first === undefined || second === undefined) throw new Error('合法行动不足 2 个');
    const probabilities = { [first]: 0.5, [second]: 0.5 };
    const result = await callJev(
      { ...input, topK: 2 },
      apiKey,
      baseOptions(),
      depsWith(async () => okResponse('jev-1.13.0', probabilities)),
      'neutral',
      new AbortController().signal,
    );
    expect(result.fellBack).toBe(false);
    expect(result.record.topK).toBe(2);
    expect(result.record.selectedAction).toBe(
      selectTopK(probabilities, input.legal.actions, 2, input.seed, input.tick, input.agentId),
    );
  });

  it('响应解析与 top1 选择', async () => {
    expect(
      parseJevResponse({ answers: { action: { probabilities: { accumulate: 1 } } } }, [
        'accumulate',
      ]).kind,
    ).toBe('ok');
    expect(selectTop1({ accumulate: 0.4, ascend: 0.6 }, ['accumulate', 'ascend'])).toBe('ascend');
    // 并列按 legalActions 顺序
    expect(selectTop1({ ascend: 0.5, accumulate: 0.5 }, ['accumulate', 'ascend'])).toBe(
      'accumulate',
    );
  });
});

/**
 * P2-07 真实冒烟前置：官方端点按地域返回 451（`Typesafe is not available in your
 * region`），受限网络只能经自建网关转发，因此端点必须可配置而非硬编码。
 */
describe('上游端点可配置（P2-07）', () => {
  it('未配置时回落到官方端点', () => {
    expect(resolveEndpoint(undefined)).toBe(DEFAULT_UPSTREAM_ENDPOINT);
    expect(DEFAULT_UPSTREAM_ENDPOINT).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('接受自建 https 网关', () => {
    const gateway = 'https://jev.logicc.top/v1/systemone';
    expect(resolveEndpoint(gateway)).toBe(gateway);
  });

  it.each([
    ['http://jev.example.test/v1/systemone', '远端明文'],
    ['http://127.0.0.1:8080/v1/systemone', '本地明文'],
  ])('拒绝明文端点，避免 Bearer Key 走明文：%s', (endpoint) => {
    expect(() => resolveEndpoint(endpoint)).toThrowError(StratifyError);
    expect(() => resolveEndpoint(endpoint)).toThrowError(/https/);
  });

  it('拒绝内嵌凭据的端点（Key 只经 Authorization 头）', () => {
    expect(() => resolveEndpoint('https://user:pass@jev.example.test/v1/systemone')).toThrowError(
      /用户信息/,
    );
  });

  it('拒绝非法 URL', () => {
    expect(() => resolveEndpoint('not-a-url')).toThrowError(/合法 URL/);
  });

  it('callJev 实际请求配置的端点，而非硬编码地址', async () => {
    const { input, apiKey } = await makeInput();
    const seen: string[] = [];
    const result = await callJev(
      input,
      apiKey,
      baseOptions({ endpoint: 'https://gateway.example.test/v1/systemone' }),
      depsWith(async (target) => {
        seen.push(String(target));
        return okResponse();
      }),
      'neutral',
      new AbortController().signal,
    );
    expect(seen).toEqual(['https://gateway.example.test/v1/systemone']);
    expect(result.fellBack).toBe(false);
  });

  it('端点非法时在预留预算与发起请求之前失败', async () => {
    const { input, apiKey } = await makeInput();
    const budget = okBudget();
    let called = 0;
    await expect(
      callJev(
        input,
        apiKey,
        baseOptions({ endpoint: 'http://insecure.example.test/v1/systemone', budget }),
        depsWith(async () => {
          called += 1;
          return okResponse();
        }),
        'neutral',
        new AbortController().signal,
      ),
    ).rejects.toThrowError(StratifyError);
    expect(called).toBe(0);
    expect(budget.reserved).toBe(0);
  });
});
