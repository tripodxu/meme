import { DECISION_SCHEMA_VERSION } from '../core/control/versions.js';

/**
 * P2-02：决策 state 的正式 JSON Schema（04 §3.2，随 `prompt-v3` 冻结）。
 *
 * - 与 `buildDecisionState` 的字段集合、时间单位、可空语义一一对应；
 * - `additionalProperties: false`：模型输入不得悄悄夹带新字段；
 * - 变更字段含义或增删字段必须升级 `promptVersion`，并同步更新本 schema。
 *
 * 冻结副本：`schema/decision-state.prompt-v3.json`（由本常量生成，测试校验一致）。
 */

export const DECISION_STATE_SCHEMA_FILE = 'schema/decision-state.prompt-v3.json';

export const DECISION_STATE_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://stratify.local/schema/decision-state.prompt-v3.json',
  title: 'Stratify DecisionState (prompt-v3)',
  description: '发给 Jev 的完整决策 state（04 §3.2）；字段构造顺序由序列化器保证。',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'tick',
    'decisionIntervalDays',
    'self',
    'society',
    'costs',
    'targets',
    'recentEvents',
  ],
  properties: {
    schema: { const: DECISION_SCHEMA_VERSION },
    tick: { type: 'integer', minimum: 0 },
    decisionIntervalDays: { type: 'integer', minimum: 1 },
    self: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'classIndex',
        'highestClassEver',
        'value',
        'talent',
        'effort',
        'remainingLifeDays',
        'daysInClass',
        'needRatio',
        'belowNeedDays',
        'neighborCount',
      ],
      properties: {
        id: { type: 'string', minLength: 1 },
        classIndex: { type: 'integer', minimum: 0 },
        highestClassEver: { type: 'integer', minimum: 0 },
        value: { type: 'number' },
        talent: { type: 'number' },
        effort: { type: 'number' },
        remainingLifeDays: { type: 'number', minimum: 0 },
        daysInClass: { type: 'number', minimum: 0 },
        needRatio: { type: ['number', 'null'] },
        belowNeedDays: { type: 'number', minimum: 0 },
        neighborCount: { type: 'integer', minimum: 0 },
      },
    },
    society: {
      type: 'object',
      additionalProperties: false,
      required: ['openness', 'gini', 'classPopulationShares'],
      properties: {
        openness: { type: 'number', minimum: 0, maximum: 1 },
        gini: { type: 'number', minimum: 0, maximum: 1 },
        classPopulationShares: {
          type: 'array',
          minItems: 1,
          items: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    costs: {
      type: 'object',
      additionalProperties: false,
      required: ['ascend', 'descend'],
      properties: {
        ascend: { type: ['number', 'null'] },
        descend: { type: ['number', 'null'] },
      },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'classIndex', 'value', 'isNeighbor'],
        properties: {
          id: { type: 'string', minLength: 1 },
          classIndex: { type: 'integer', minimum: 0 },
          value: { type: 'number' },
          isNeighbor: { type: 'boolean' },
        },
      },
    },
    recentEvents: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tick', 'type', 'actorId', 'targetId', 'deltaValue', 'fromClass', 'toClass'],
        properties: {
          tick: { type: 'integer', minimum: 0 },
          type: {
            enum: ['wealth_changed', 'class_ascended', 'class_descended', 'competition_resolved'],
          },
          actorId: { type: 'string', minLength: 1 },
          targetId: { type: ['string', 'null'] },
          deltaValue: { type: ['number', 'null'] },
          fromClass: { type: ['integer', 'null'], minimum: 0 },
          toClass: { type: ['integer', 'null'], minimum: 0 },
        },
      },
    },
  },
};
