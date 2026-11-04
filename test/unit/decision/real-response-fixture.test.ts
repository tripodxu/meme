import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  estimateInputTokens,
  parseJevResponse,
  TOKEN_ESTIMATOR_VERSION,
} from '../../../src/decision/jev-client.js';

/**
 * P2-03：真实上游响应 fixture（2026-11-04 捕获，不经 mock）。
 *
 * 来源与脱敏：`test/fixtures/decision/README.md`。请求体是 `buildRequestBody` 的
 * 真实输出；响应体是上游原样返回，不含任何凭据（Key 只在 Authorization 头里）。
 */

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

const request = readJson('../../fixtures/decision/systemone-request-2026-11-04.json');
const response = readJson('../../fixtures/decision/systemone-response-2026-11-04.json');

function legalActionsFromRequest(): string[] {
  const questions = request['questions'] as Record<string, unknown>;
  const action = questions['action'] as Record<string, unknown>;
  const criteria = action['criteria'] as Record<string, string>;
  return Object.keys(criteria);
}

/** 上游实际计入的 input tokens（真实 usage，不是估算）。 */
function actualInputTokens(): number {
  const usage = response['usage'] as Record<string, number>;
  return usage['input_tokens'] as number;
}

describe('真实 System One 响应（P2-03）', () => {
  it('parseJevResponse 能解析真实响应', () => {
    const parsed = parseJevResponse(response, legalActionsFromRequest());
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.usage.inputTokens).toBe(actualInputTokens());
    expect(parsed.usage.outputTokens).toBeGreaterThan(0);
    expect(parsed.model).toBe('jev-1.13-free');
    expect(parsed.confidence).not.toBeNull();
  });

  it('概率键与请求的 legalActions 完全对应，且非负有限', () => {
    const legalActions = legalActionsFromRequest();
    const parsed = parseJevResponse(response, legalActions);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(Object.keys(parsed.probabilities).sort()).toEqual([...legalActions].sort());
    for (const value of Object.values(parsed.probabilities)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(Object.values(parsed.probabilities).reduce((sum, p) => sum + p, 0)).toBeGreaterThan(0);
  });

  it('上游返回的 choice 落在 legalActions 内', () => {
    const answers = response['answers'] as Record<string, unknown>;
    const action = answers['action'] as Record<string, unknown>;
    expect(legalActionsFromRequest()).toContain(action['choice']);
  });

  it('真实 usage 不含 cost 语义以外的私有字段依赖（cost 可为 0）', () => {
    const usage = response['usage'] as Record<string, unknown>;
    expect(typeof usage['cost']).toBe('number');
  });

  /**
   * 回归：`utf8-half-v1`（bytes/2）对这条真实请求给出 1085 < 1200，会触发
   * overage 并永久锁死 live run。估算器必须对真实 payload 保守。
   */
  it('估算器对真实 payload 保守：估算 >= 上游实际 usage', () => {
    const compact = JSON.stringify(request);
    expect(TOKEN_ESTIMATOR_VERSION).toBe('utf8-three-quarter-v1');
    expect(estimateInputTokens(compact)).toBeGreaterThanOrEqual(actualInputTokens());
    // 旧口径会失败，保留该断言以防有人把比例调回去。
    expect(Math.ceil(new TextEncoder().encode(compact).length / 2)).toBeLessThan(
      actualInputTokens(),
    );
  });

  it('真实 payload 的 size 与 token 比例已登记，供后续校准', () => {
    const compact = JSON.stringify(request);
    const ratio = actualInputTokens() / new TextEncoder().encode(compact).length;
    // 2026-11-04 实测约 0.553 tokens/byte；估算系数 0.75 留出约 35% 余量。
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.75);
  });
});
