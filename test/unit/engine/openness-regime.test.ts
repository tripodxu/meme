import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { computeParamsHash } from '../../../src/core/config/hash.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { CONFIG_SCHEMA_VERSION } from '../../../src/core/control/versions.js';
import { asSeed, type AgentId } from '../../../src/core/control/ids.js';
import { step } from '../../../src/core/engine/engine.js';
import {
  maybeUpdateOpenness,
  nextInstitutionalRegime,
} from '../../../src/core/feedback/slow-variables.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import { encodeSimState } from '../../../src/core/model/serialize.js';
import type { SimState } from '../../../src/core/model/state.js';
import { getParamDefinition } from '../../../src/core/params.js';
import { decideMockWeighted } from '../../../src/decision/mock.js';
import type { RunConfig } from '../../../src/core/config/types.js';

function mockDecisions(state: SimState): Map<AgentId, { selectedAction: string }> {
  const decisions = new Map<AgentId, { selectedAction: string }>();
  if (state.society.tick % state.config.decision.interval !== 0) {
    return decisions;
  }
  for (const agent of state.society.agents) {
    if (!agent.alive) continue;
    const legal = enumerateLegalActions(state, agent.id);
    const decision = decideMockWeighted({
      runId: 'regime-test',
      seed: state.seed,
      state,
      agentId: agent.id,
      stateHash: 'sha256:test',
      actionSetHash: 'sha256:test',
      legal,
    });
    decisions.set(agent.id, { selectedAction: decision.selectedAction });
  }
  return decisions;
}

function withOpenness(overrides: Partial<RunConfig['openness']>): RunConfig {
  return {
    ...DEFAULT_RUN_CONFIG,
    openness: { ...DEFAULT_RUN_CONFIG.openness, ...overrides },
  };
}

const hysteresis = withOpenness({ regimeMode: 'hysteresis', regimeBias: 4 });

describe('rules-v13 institutional regime state machine', () => {
  it('continuous 模式从不改变制度', () => {
    const config = withOpenness({ regimeMode: 'continuous' });
    for (const current of ['closed', 'open'] as const) {
      expect(nextInstitutionalRegime(config, current, 1, -1)).toBe(current);
      expect(nextInstitutionalRegime(config, current, 0, 1)).toBe(current);
    }
  });

  it('closed→open 需要同时满足两个进入条件', () => {
    expect(nextInstitutionalRegime(hysteresis, 'closed', 0.24, 0.19)).toBe('closed');
    expect(nextInstitutionalRegime(hysteresis, 'closed', 0.25, 0.21)).toBe('closed');
    expect(nextInstitutionalRegime(hysteresis, 'closed', 0.25, 0.2)).toBe('open');
    expect(nextInstitutionalRegime(hysteresis, 'closed', 0.8, -0.5)).toBe('open');
  });

  it('open→closed 只需要任一退出条件', () => {
    expect(nextInstitutionalRegime(hysteresis, 'open', 0.16, 0.29)).toBe('open');
    expect(nextInstitutionalRegime(hysteresis, 'open', 0.15, 0.29)).toBe('closed');
    expect(nextInstitutionalRegime(hysteresis, 'open', 0.9, 0.3)).toBe('closed');
  });

  it('滞回带内保持原制度，不抖动', () => {
    for (const mUp of [0.16, 0.2, 0.24]) {
      for (const segregation of [0.21, 0.25, 0.29]) {
        expect(nextInstitutionalRegime(hysteresis, 'closed', mUp, segregation)).toBe('closed');
        expect(nextInstitutionalRegime(hysteresis, 'open', mUp, segregation)).toBe('open');
      }
    }
  });

  it('open 制度抬高 O 目标、closed 制度压低 O 目标', () => {
    const input = {
      tick: 10,
      lastOpennessUpdateTick: 0,
      openness: 0.5,
      mUp: 0.5,
      gini: 0.25,
      segregation: 0.3,
    };
    const continuous = maybeUpdateOpenness(
      withOpenness({ regimeMode: 'continuous', regimeBias: 4 }),
      { ...input, regime: 'closed' },
    ).openness;
    const open = maybeUpdateOpenness(hysteresis, { ...input, regime: 'open' }).openness;
    const closed = maybeUpdateOpenness(hysteresis, { ...input, regime: 'closed' }).openness;
    expect(open).toBeGreaterThan(continuous);
    expect(closed).toBeLessThan(continuous);
  });

  it('updateMode=fixed 时制度不参与、O 恒为 initial', () => {
    const config = withOpenness({
      updateMode: 'fixed',
      initial: 0.4,
      regimeMode: 'hysteresis',
      regimeBias: 9,
    });
    expect(
      maybeUpdateOpenness(config, {
        tick: 10,
        lastOpennessUpdateTick: 0,
        openness: 0.9,
        mUp: 0.5,
        gini: 0.25,
        segregation: 0.3,
        regime: 'open',
      }).openness,
    ).toBe(0.4);
  });

  it('参数注册表登记全部制度参数并进入 paramsHash', () => {
    for (const name of [
      'openness.regimeMode',
      'openness.regimeBias',
      'openness.regimeEnterOpenMobility',
      'openness.regimeExitOpenMobility',
      'openness.regimeEnterOpenSegregation',
      'openness.regimeExitOpenSegregation',
    ]) {
      expect(getParamDefinition(name)).toBeDefined();
    }
    expect(getParamDefinition('openness.regimeMode')?.domain).toEqual({
      kind: 'enum',
      values: ['continuous', 'hysteresis'],
    });
    const base = computeParamsHash(DEFAULT_RUN_CONFIG);
    const changed = computeParamsHash(withOpenness({ regimeBias: 1 }));
    expect(changed).not.toBe(base);
  });

  it('v7 配置迁移补制度默认值并通过校验', () => {
    const v7 = structuredClone(DEFAULT_RUN_CONFIG) as unknown as Record<string, unknown>;
    v7['schemaVersion'] = 'stratify-config-v7';
    const openness = { ...(v7['openness'] as Record<string, unknown>) };
    for (const key of [
      'regimeMode',
      'regimeBias',
      'regimeEnterOpenMobility',
      'regimeExitOpenMobility',
      'regimeEnterOpenSegregation',
      'regimeExitOpenSegregation',
    ]) {
      delete openness[key];
    }
    v7['openness'] = openness;
    const result = validateRunConfig(v7);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues)).toBe(true);
    if (result.ok) {
      expect(result.config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
      expect(result.config.openness).toEqual(DEFAULT_RUN_CONFIG.openness);
      expect(result.config.behavior).toEqual(DEFAULT_RUN_CONFIG.behavior);
    }
  });

  it('进入/退出阈值顺序反了会被拒绝', () => {
    const badMobility = withOpenness({
      regimeMode: 'hysteresis',
      regimeEnterOpenMobility: 0.1,
      regimeExitOpenMobility: 0.2,
    });
    const badSegregation = withOpenness({
      regimeMode: 'hysteresis',
      regimeEnterOpenSegregation: 0.4,
      regimeExitOpenSegregation: 0.3,
    });
    for (const config of [badMobility, badSegregation]) {
      const result = validateRunConfig(config);
      expect(result.ok).toBe(false);
    }
  });

  it('引擎在决策周期推进制度并写入下一状态', () => {
    const config = withOpenness({
      initial: 0.2,
      regimeMode: 'hysteresis',
      regimeBias: 0,
      regimeEnterOpenMobility: 0,
      regimeExitOpenMobility: 0,
      regimeEnterOpenSegregation: 1,
      regimeExitOpenSegregation: 1,
    });
    let state = createSimulation(config, asSeed('regime-engine'));
    expect(state.society.institutionalRegime).toBe('closed');
    state = step(state, mockDecisions(state), { runId: 'regime-engine' }).state;
    expect(state.society.institutionalRegime).toBe('open');

    // updateMode=fixed 时制度保持不变。
    let fixed = createSimulation(
      withOpenness({ ...config.openness, updateMode: 'fixed' }),
      asSeed('regime-engine'),
    );
    fixed = step(fixed, mockDecisions(fixed), { runId: 'regime-engine' }).state;
    expect(fixed.society.institutionalRegime).toBe('closed');
  });

  it('regimeBias=0 时与 continuous 逐位一致；θR>0 时轨迹分叉', () => {
    const base = withOpenness({
      initial: 0.2,
      regimeMode: 'hysteresis',
      regimeBias: 0,
      regimeEnterOpenMobility: 0,
      regimeExitOpenMobility: 0,
      regimeEnterOpenSegregation: 1,
      regimeExitOpenSegregation: 1,
    });
    const continuous = withOpenness({ ...base.openness, regimeMode: 'continuous' });
    const biased = withOpenness({ ...base.openness, regimeBias: 4 });

    const run = (config: RunConfig) => {
      let state = createSimulation(config, asSeed('regime-parity'));
      // 走到 tick 10：tick 0 的 Δt=0 不改变 O，第二次决策周期才体现制度偏置。
      while (state.society.tick <= 10) {
        state = step(state, mockDecisions(state), { runId: 'regime-parity' }).state;
      }
      return state;
    };
    const unbiased = encodeSimState(run(base)).society;
    const plain = encodeSimState(run(continuous)).society;
    expect(unbiased.openness).toBe(plain.openness);
    // tick 0 进入 open 后，tick 10 因 Mup=0 触发退出条件回到 closed（滞回带外）。
    expect(unbiased.institutionalRegime).toBe('closed');
    expect(plain.institutionalRegime).toBe('closed');

    // closed 制度施加 -θR 偏置，使 O 低于无制度的 continuous 对照。
    const divergent = encodeSimState(run(biased)).society;
    expect(divergent.openness).not.toBe(plain.openness);
    expect(divergent.openness).toBeLessThan(plain.openness);
  });
});
