import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import {
  cloneSimState,
  decodeSimState,
  encodeSimState,
} from '../../../src/core/model/serialize.js';
import { computeAuthoritativeStateHash } from '../../../src/core/hash/state-hash.js';

const SEED = asSeed('serialize-seed');

describe('权威状态序列化（P1-02）', () => {
  it('JSON round-trip 不丢状态且哈希一致', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const encoded = JSON.parse(JSON.stringify(encodeSimState(state))) as unknown;
    const decoded = decodeSimState(encoded);
    expect(JSON.stringify(encodeSimState(decoded))).toBe(JSON.stringify(encodeSimState(state)));
    expect(computeAuthoritativeStateHash(decoded)).toBe(computeAuthoritativeStateHash(state));
  });

  it('cloneSimState 产生独立副本', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const clone = cloneSimState(state);
    expect(computeAuthoritativeStateHash(clone)).toBe(computeAuthoritativeStateHash(state));
    // 修改克隆不影响原状态
    const cloneAgent = clone.society.agents[0];
    const originalAgent = state.society.agents[0];
    if (cloneAgent === undefined || originalAgent === undefined) throw new Error('roster 为空');
    cloneAgent.value = 123.456;
    expect(originalAgent.value).toBe(0);
  });

  it('agents 按 id 升序序列化', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const encoded = encodeSimState(state);
    const ids = encoded.society.agents.map((agent) => agent.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('未知 schemaVersion 拒绝', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const encoded = encodeSimState(state) as unknown as Record<string, unknown>;
    encoded['schemaVersion'] = 'stratify-state-v999';
    expect(() => decodeSimState(encoded)).toThrowError(/未知状态 schemaVersion/);
  });

  it('内嵌配置非法时拒绝', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const encoded = encodeSimState(state) as unknown as Record<string, unknown>;
    const config = encoded['config'] as Record<string, unknown>;
    (config['population'] as Record<string, unknown>)['initialPopulation'] = 1;
    expect(() => decodeSimState(encoded)).toThrowError(/内嵌配置未通过校验/);
  });

  it('NaN/负财富/坏关系在解码边界被拒绝', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const base = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(encodeSimState(state))) as Record<string, unknown>;

    const nanValue = base();
    const nanAgent = (nanValue['society'] as Record<string, unknown>)['agents'] as Record<
      string,
      unknown
    >[];
    const nanFirst = nanAgent[0];
    if (nanFirst === undefined) throw new Error('roster 为空');
    nanFirst['value'] = 'not-a-number';
    expect(() => decodeSimState(nanValue)).toThrowError(/有限数/);

    const negative = base();
    const negAgent = (negative['society'] as Record<string, unknown>)['agents'] as Record<
      string,
      unknown
    >[];
    const negFirst = negAgent[0];
    if (negFirst === undefined) throw new Error('roster 为空');
    negFirst['value'] = -1;
    expect(() => decodeSimState(negative)).toThrowError(/不得为负/);

    const asymmetric = base();
    const agents = (asymmetric['society'] as Record<string, unknown>)['agents'] as Record<
      string,
      unknown
    >[];
    const withTie = agents.find((agent) => (agent['ties'] as string[]).length > 0);
    expect(withTie).toBeDefined();
    const neighbor = (withTie?.['ties'] as string[])[0];
    const neighborAgent = agents.find((agent) => agent['id'] === neighbor);
    if (neighborAgent === undefined) throw new Error('邻居缺失');
    neighborAgent['ties'] = (neighborAgent['ties'] as string[]).filter(
      (id) => id !== withTie?.['id'],
    );
    expect(() => decodeSimState(asymmetric)).toThrowError(/关系不对称/);

    const deadWithTies = base();
    const deadAgents = (deadWithTies['society'] as Record<string, unknown>)['agents'] as Record<
      string,
      unknown
    >[];
    const tieAgent = deadAgents.find((agent) => (agent['ties'] as string[]).length > 0);
    if (tieAgent === undefined) throw new Error('无边可测');
    tieAgent['alive'] = false;
    tieAgent['deathTick'] = 0;
    tieAgent['deathReason'] = 'age';
    expect(() => decodeSimState(deadWithTies)).toThrowError(/死亡个体不得保留关系/);
  });

  it('存活/死亡一致性在解码边界被拒绝', () => {
    const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
    const encoded = JSON.parse(JSON.stringify(encodeSimState(state))) as Record<string, unknown>;
    const agents = (encoded['society'] as Record<string, unknown>)['agents'] as Record<
      string,
      unknown
    >[];
    const first = agents[0];
    if (first === undefined) throw new Error('roster 为空');
    first['alive'] = false; // 无 deathTick
    expect(() => decodeSimState(encoded)).toThrowError(/死亡个体必须携带 deathTick/);
  });

  it('小规模非默认配置可 round-trip', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 6, classShares: [0.5, 0.2, 0.1, 0.1, 0.1] },
      network: { maxDegree: 2, initialDegree: 1 },
    });
    const state = createSimulation(config, SEED);
    const decoded = decodeSimState(JSON.parse(JSON.stringify(encodeSimState(state))) as unknown);
    expect(decoded.society.agents).toHaveLength(6);
    expect(computeAuthoritativeStateHash(decoded)).toBe(computeAuthoritativeStateHash(state));
  });
});
