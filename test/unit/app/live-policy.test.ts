import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import {
  createBrowserLivePolicy,
  exceedsLiveSuggestion,
  LIVE_SUGGESTED_LIMITS,
} from '../../../src/app/live-policy.js';
import { RunController } from '../../../src/app/run-controller.js';
import { runSingleWithPolicy } from '../../../src/runner/run-cell.js';
import { app as workerApp } from '../../../src/worker/index.js';
import { createTestEnv } from '../../helpers/worker-env.js';

const KEY = 'test-key-not-real';

function jevResponse(): Response {
  return new Response(
    JSON.stringify({
      model: 'jev-small',
      usage: { input_tokens: 42, output_tokens: 3 },
      answers: {
        action: {
          probabilities: {
            accumulate: 0.25,
            ascend: 0.25,
            descend: 0.25,
            compete: 0.25,
          },
          confidence: 0.5,
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('浏览器 live 策略（同源代理）', () => {
  it('拒绝空 Key 与非法预算', () => {
    expect(() =>
      createBrowserLivePolicy({
        apiKey: '',
        model: 'jev-small',
        maxCalls: 1,
        maxInputTokens: 1000,
        maxRunMinutes: 1,
      }),
    ).toThrow(/API Key/);
    expect(() =>
      createBrowserLivePolicy({
        apiKey: KEY,
        model: 'jev-small',
        maxCalls: 0,
        maxInputTokens: 1000,
        maxRunMinutes: 1,
      }),
    ).toThrow(/maxCalls/);
    expect(() =>
      createBrowserLivePolicy({
        apiKey: KEY,
        model: 'jev-small',
        maxCalls: 1,
        maxInputTokens: 0,
        maxRunMinutes: 1,
      }),
    ).toThrow(/maxInputTokens/);
    expect(() =>
      createBrowserLivePolicy({
        apiKey: KEY,
        model: 'jev-small',
        maxCalls: 1,
        maxInputTokens: 1000,
        maxRunMinutes: 0,
      }),
    ).toThrow(/maxRunMinutes/);
  });

  it('只向注入的同源端点发 POST，Key 进 X-Api-Key 而非 URL/body', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jevResponse(),
    );
    vi.stubGlobal('fetch', fetchMock);

    const endpoint = 'https://stratify.test/api/jev';
    const view = createBrowserLivePolicy({
      apiKey: KEY,
      model: 'jev-1.13.0',
      maxCalls: 100,
      maxInputTokens: 100_000,
      maxRunMinutes: 5,
      endpoint,
    });
    const config = createDemoConfig({ schedule: { totalTicks: 20 } });
    const outcome = await runSingleWithPolicy(config, asSeed('live-seed-1'), {
      policy: view.policy,
      runId: 'local-live-test',
      requestedModel: 'jev-1.13.0',
      promptStyle: 'neutral',
    });
    expect(outcome.decisions.length).toBeGreaterThan(0);
    expect(outcome.decisions.every((record) => record.source !== 'fallback')).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe(endpoint);
      expect(String(url)).not.toContain(KEY);
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Api-Key']).toBe(KEY);
      expect(headers['Authorization']).toBeUndefined();
      expect(String(init?.body ?? '')).not.toContain(KEY);
    }
    expect(view.budget.usage().callsUsed).toBeGreaterThan(0);
  });

  it('端到端贯通 Worker /api/jev 校验并转换为上游 Bearer System One 请求', async () => {
    const env = createTestEnv();
    const upstreamCalls: { url: string; headers: Record<string, string>; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://stratify.test/api/jev') {
          return workerApp.request(url, init, env);
        }
        upstreamCalls.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body ?? ''),
        });
        return jevResponse();
      }),
    );

    const view = createBrowserLivePolicy({
      apiKey: KEY,
      model: 'jev-1.13.0',
      maxCalls: 50,
      maxInputTokens: 100_000,
      maxRunMinutes: 5,
      endpoint: 'https://stratify.test/api/jev',
    });
    const config = createDemoConfig({
      population: { initialPopulation: 10 },
      schedule: { totalTicks: 10 },
    });
    const outcome = await runSingleWithPolicy(config, asSeed('live-e2e-wire'), {
      policy: view.policy,
      runId: 'local-live-wire',
      requestedModel: 'jev-1.13.0',
      promptStyle: 'neutral',
    });
    expect(outcome.decisions).toHaveLength(10);
    expect(outcome.decisions.every((record) => record.source === 'jev_live')).toBe(true);
    expect(upstreamCalls).toHaveLength(10);
    expect(upstreamCalls[0]?.url).toBe('https://jev.test/v1/systemone');
    expect(upstreamCalls[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(upstreamCalls[0]?.body).not.toContain(KEY);
  });

  it('超过 06 建议规模时要求显式确认', () => {
    const within = createDemoConfig({
      population: { initialPopulation: LIVE_SUGGESTED_LIMITS.maxPopulation },
      schedule: { totalTicks: LIVE_SUGGESTED_LIMITS.maxTicks },
      decision: { interval: LIVE_SUGGESTED_LIMITS.minDecisionInterval },
    });
    expect(exceedsLiveSuggestion(within)).toBe(false);
    expect(exceedsLiveSuggestion(createDemoConfig())).toBe(true);
    expect(
      exceedsLiveSuggestion(
        createDemoConfig({
          population: { initialPopulation: LIVE_SUGGESTED_LIMITS.maxPopulation + 1 },
        }),
      ),
    ).toBe(true);
    expect(
      exceedsLiveSuggestion(
        createDemoConfig({ schedule: { totalTicks: LIVE_SUGGESTED_LIMITS.maxTicks + 1 } }),
      ),
    ).toBe(true);
    expect(
      exceedsLiveSuggestion(
        createDemoConfig({ decision: { interval: LIVE_SUGGESTED_LIMITS.minDecisionInterval - 1 } }),
      ),
    ).toBe(true);
  });

  it('控制器 snapshot/export 不含 Key', () => {
    const controller = new RunController({
      policy: 'jev_live',
      live: {
        apiKey: KEY,
        model: 'jev-small',
        maxCalls: 10,
        maxInputTokens: 10_000,
        maxRunMinutes: 1,
        endpoint: 'https://stratify.test/api/jev',
      },
    });
    const result = controller.prepare(
      createDemoConfig({ schedule: { totalTicks: 20 } }),
      'live-seed-2',
      'jev_live',
      {
        apiKey: KEY,
        model: 'jev-small',
        maxCalls: 10,
        maxInputTokens: 10_000,
        maxRunMinutes: 1,
        endpoint: 'https://stratify.test/api/jev',
      },
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(controller.snapshot())).not.toContain(KEY);
    expect(JSON.stringify(controller.exportBundle())).not.toContain(KEY);
    controller.reset();
  });
});
