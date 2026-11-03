import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import { buildDecisionState } from '../../../src/decision/serialize.js';
import {
  buildRequestBody,
  callJev,
  parseJevResponse,
  selectTop1,
  type CircuitFailureWindow,
  type FallbackRateWindow,
  type JevBudget,
  type JevClientDeps,
} from '../../../src/decision/jev-client.js';
import type { DecisionInput } from '../../../src/decision/policy.js';

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
    settle(tokens: number) {
      this.settled = tokens;
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
      topK: 1,
      requestedModel: 'jev-1.13.0',
      promptVersion: 'prompt-v2',
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
    const result = await callJev(
      input,
      apiKey,
      baseOptions(),
      deps,
      'neutral',
      new AbortController().signal,
    );
    expect(sleeps).toContain(2000);
    expect(calls).toBeGreaterThanOrEqual(2);

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
    void result;
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
