import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { deriveInitialPopulation } from '../../../src/core/init/population.js';
import {
  computeInitialPopulationHash,
  computeAuthoritativeStateHash,
} from '../../../src/core/hash/state-hash.js';
import {
  DEFAULT_LABEL_THRESHOLDS,
  LABEL_THRESHOLDS_VERSION,
  type LabelThresholds,
  computeLabelThresholdsHash,
} from '../../../src/core/labels/thresholds.js';
import { HASH_DOMAIN_INPUT_SCHEMAS } from '../../../src/core/hash/schemas.js';
import { HASH_DOMAINS } from '../../../src/core/hash/domains.js';

const SEED_A = asSeed('hash-seed-a');
const SEED_B = asSeed('hash-seed-b');

describe('initialPopulationHash（02 §8）', () => {
  it('同 config+seed 结果一致；跨运行端纯函数', () => {
    const p1 = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_A);
    const p2 = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_A);
    expect(computeInitialPopulationHash(SEED_A, p1)).toBe(computeInitialPopulationHash(SEED_A, p2));
  });

  it('不同 seed 产生不同 hash', () => {
    const pA = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_A);
    const pB = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_B);
    expect(computeInitialPopulationHash(SEED_A, pA)).not.toBe(
      computeInitialPopulationHash(SEED_B, pB),
    );
  });

  it('initialAgeMode 改变 hash（两种模式都消费 init_age）', () => {
    const newbornConfig = createDemoConfig({ population: { initialAgeMode: 'newborn' } });
    const pUniform = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_A);
    const pNewborn = deriveInitialPopulation(newbornConfig, SEED_A);
    expect(computeInitialPopulationHash(SEED_A, pUniform)).not.toBe(
      computeInitialPopulationHash(SEED_A, pNewborn),
    );
  });

  it('改变 initialValue 改变 hash', () => {
    const richConfig = createDemoConfig({ population: { initialValue: 10 } });
    const pDefault = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_A);
    const pRich = deriveInitialPopulation(richConfig, SEED_A);
    expect(computeInitialPopulationHash(SEED_A, pDefault)).not.toBe(
      computeInitialPopulationHash(SEED_A, pRich),
    );
  });

  it('网络差异反映在 hash 中', () => {
    const noNetworkConfig = createDemoConfig({ network: { maxDegree: 0, initialDegree: 0 } });
    const pDefault = deriveInitialPopulation(DEFAULT_RUN_CONFIG, SEED_A);
    const pEmpty = deriveInitialPopulation(noNetworkConfig, SEED_A);
    expect(computeInitialPopulationHash(SEED_A, pDefault)).not.toBe(
      computeInitialPopulationHash(SEED_A, pEmpty),
    );
  });
});

describe('authoritativeStateHash（02 §8）', () => {
  it('同输入一致，clone 后一致', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED_A);
    const encoded = JSON.parse(JSON.stringify(encodeForTest(state)));
    expect(computeAuthoritativeStateHash(state)).toBe(
      computeAuthoritativeStateHash(decodeForTest(encoded)),
    );
  });

  it('seed 改变 hash（seed 属于权威状态）', () => {
    const s1 = createSimulation(DEFAULT_RUN_CONFIG, SEED_A);
    const s2 = createSimulation(DEFAULT_RUN_CONFIG, SEED_B);
    expect(computeAuthoritativeStateHash(s1)).not.toBe(computeAuthoritativeStateHash(s2));
  });
});

describe('labelThresholdsHash（02 §8 / 07 §10）', () => {
  it('默认阈值表 hash 稳定且版本为 labels-v3', () => {
    expect(computeLabelThresholdsHash()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(LABEL_THRESHOLDS_VERSION).toBe('labels-v3');
  });

  it('阈值变化改变 hash', () => {
    const tampered: LabelThresholds = {
      ...DEFAULT_LABEL_THRESHOLDS,
      labels: {
        ...DEFAULT_LABEL_THRESHOLDS.labels,
        bipolar: { ...DEFAULT_LABEL_THRESHOLDS.labels.bipolar, giniMin: 0.45 },
      },
    };
    expect(computeLabelThresholdsHash(tampered)).not.toBe(computeLabelThresholdsHash());
  });
});

describe('hash domain 输入 schema 覆盖（02 §8）', () => {
  it('每个声明 domain 都有字段级 schema 条目', () => {
    const documented = new Set(HASH_DOMAIN_INPUT_SCHEMAS.map((schema) => schema.domain));
    for (const domain of Object.values(HASH_DOMAINS)) {
      expect(documented.has(domain)).toBe(true);
    }
  });
});

// 测试辅助：避免在多个用例中重复 import
import { encodeSimState } from '../../../src/core/model/serialize.js';
import { decodeSimState } from '../../../src/core/model/serialize.js';

function encodeForTest(state: Parameters<typeof encodeSimState>[0]): unknown {
  return encodeSimState(state);
}
function decodeForTest(value: unknown): ReturnType<typeof decodeSimState> {
  return decodeSimState(value);
}
