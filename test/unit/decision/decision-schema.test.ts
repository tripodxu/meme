import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import {
  DECISION_STATE_JSON_SCHEMA,
  DECISION_STATE_SCHEMA_FILE,
} from '../../../src/decision/schema.js';
import {
  buildDecisionState,
  PROMPT_VERSION,
  type DecisionState,
} from '../../../src/decision/serialize.js';

/**
 * P2-02：`prompt-v3` 的决策 state JSON Schema 已冻结并与序列化器一致（04 §3.2）。
 * 冻结副本由 `src/decision/schema.ts` 生成；本测试同时校验文件同步与实例合法性。
 */

const SEED = asSeed('decision-schema-seed');

const frozenSchema = JSON.parse(
  readFileSync(new URL(`../../../${DECISION_STATE_SCHEMA_FILE}`, import.meta.url), 'utf8'),
) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(frozenSchema);

function sampleState(): DecisionState {
  const config = createDemoConfig({ population: { initialPopulation: 6 } });
  const state = createSimulation(config, SEED);
  const agent = state.society.agents[0];
  if (agent === undefined) throw new Error('roster 过小');
  const legal = enumerateLegalActions(state, agent.id);
  return buildDecisionState(state, agent.id, legal, []);
}

function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe('决策 state JSON Schema（P2-02 / 04 §3.2）', () => {
  it('冻结文件与生成常量一致，且绑定 prompt-v3', () => {
    expect(frozenSchema).toEqual(DECISION_STATE_JSON_SCHEMA);
    expect(PROMPT_VERSION).toBe('prompt-v3');
    expect(frozenSchema['$id']).toContain('prompt-v3');
  });

  it('序列化器产出的 state 通过 schema 校验', () => {
    const valid = validate(sampleState());
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('拒绝额外字段（模型输入不得夹带新字段）', () => {
    const bad = clone(sampleState());
    bad['extra'] = 1;
    expect(validate(bad)).toBe(false);
  });

  it('拒绝错误类型（needRatio 必须是 number|null）', () => {
    const bad = clone(sampleState());
    const self = bad['self'] as Record<string, unknown>;
    self['needRatio'] = 'n/a';
    expect(validate(bad)).toBe(false);
  });

  it('recentEvents 最多 5 条', () => {
    const bad = clone(sampleState());
    const event = {
      tick: 0,
      type: 'wealth_changed',
      actorId: 'a-0001',
      targetId: null,
      deltaValue: 1,
      fromClass: null,
      toClass: null,
    };
    bad['recentEvents'] = [event, event, event, event, event, event];
    expect(validate(bad)).toBe(false);
  });

  it('缺少必填字段被拒绝', () => {
    const bad = clone(sampleState());
    delete bad['self'];
    expect(validate(bad)).toBe(false);
  });
});
