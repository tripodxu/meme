import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { computeConfigHash } from '../../../src/core/config/hash.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { agentIdFromIndex, agentIndexFromId } from '../../../src/core/model/agent.js';
import {
  buildRunIdentity,
  buildRunIdentityFromConfig,
} from '../../../src/core/control/identity.js';

describe('agentId 工具（03 §2.1）', () => {
  it('a-0000 起顺序分配并可还原序号', () => {
    expect(agentIdFromIndex(0)).toBe('a-0000');
    expect(agentIdFromIndex(42)).toBe('a-0042');
    expect(agentIdFromIndex(12345)).toBe('a-12345');
    expect(agentIndexFromId(agentIdFromIndex(7))).toBe(7);
  });

  it('非法序号抛错', () => {
    expect(() => agentIdFromIndex(-1)).toThrowError();
    expect(() => agentIdFromIndex(1.5)).toThrowError();
  });
});

describe('RunIdentity（02 §10）', () => {
  it('组装身份块且版本与 config 一致', () => {
    const identity = buildRunIdentityFromConfig(DEFAULT_RUN_CONFIG, asSeed('s'), {
      initialPopulationHash: 'sha256:aa',
      policyVersion: DEFAULT_RUN_CONFIG.decision.policy,
      promptVersion: null,
      requestedModel: 'mock',
      runtimeVersion: 'node@22.21.0',
      codeSha: 'test-sha',
    });
    expect(identity.schemaVersion).toBe('stratify-run-identity-v1');
    expect(identity.rulesVersion).toBe(DEFAULT_RUN_CONFIG.rulesVersion);
    expect(identity.configHash).toBe(computeConfigHash(DEFAULT_RUN_CONFIG));
    expect(identity.seed).toBe('s');
    expect(identity.promptVersion).toBeNull();
  });

  it('buildRunIdentity 保留显式提供的 hash', () => {
    const identity = buildRunIdentity({
      config: DEFAULT_RUN_CONFIG,
      configHash: 'sha256:11',
      paramsHash: 'sha256:22',
      initialPopulationHash: 'sha256:33',
      seed: asSeed('s'),
      policyVersion: 'mock-weighted-v1',
      promptVersion: 'prompt-v3',
      requestedModel: 'jev-1.13.0',
      runtimeVersion: 'node@22.21.0',
      codeSha: 'sha',
    });
    expect(identity.configHash).toBe('sha256:11');
    expect(identity.paramsHash).toBe('sha256:22');
    expect(identity.initialPopulationHash).toBe('sha256:33');
    expect(identity.promptVersion).toBe('prompt-v3');
    expect(identity.requestedModel).toBe('jev-1.13.0');
  });
});
