import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { errorCodes } from '../../../src/core/control/errors.js';
import { computeConfigHash } from '../../../src/core/config/hash.js';
import { computeAuthoritativeStateHash } from '../../../src/core/hash/state-hash.js';
import { captureSnapshot, restoreSnapshot } from '../../../src/core/replay/snapshot.js';
import {
  applyParamPerturbation,
  applyWealthPerturbation,
  diffLeafPaths,
  firstDivergenceTick,
  runPerturbationBatch,
  runPerturbationPair,
} from '../../../src/runner/perturbation.js';
import type { TickStats } from '../../../src/core/macros/tick-metrics.js';
import { runSingle } from '../../../src/runner/run-cell.js';

const CONFIG = createDemoConfig({ schedule: { totalTicks: 40 } });
const SEED = 'perturb-seed';
const POLICY = 'mock-weighted-v1' as const;
const CHECKPOINT_TICK = 10;

describe('微扰声明与审计（P5-04）', () => {
  it('diffLeafPaths 精确报告叶子差异', () => {
    expect(diffLeafPaths({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
    expect(diffLeafPaths({ a: 1 }, { a: 2 })).toEqual(['a']);
    expect(diffLeafPaths({ b: { c: [1, 2] } }, { b: { c: [1, 9] } })).toEqual(['b.c[1]']);
    expect(diffLeafPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
  });

  it('param 扰动只改变声明字段且 configHash 变化', () => {
    const result = applyParamPerturbation(CONFIG, 'need.threshold', 1e-6);
    expect(result.changedPaths).toEqual(['need.threshold']);
    expect(result.applied).toBe(true);
    expect(result.treatmentValue).toBeCloseTo(result.baselineValue * (1 + 1e-6), 15);
    expect(computeConfigHash(result.treatment)).not.toBe(computeConfigHash(CONFIG));
  });

  it('param 扰动支持数组下标字段（P5-04 修复）', () => {
    const result = applyParamPerturbation(CONFIG, 'ascent.crossDays[0]', 1e-6);
    expect(result.changedPaths).toEqual(['ascent.crossDays[0]']);
    expect(result.applied).toBe(true);
    expect(result.treatment.ascent.crossDays[0]).toBeCloseTo(result.baselineValue * (1 + 1e-6), 15);
  });

  it('数组下标越界或路径非法拒绝', () => {
    expect(() => applyParamPerturbation(CONFIG, 'ascent.crossDays[99]', 1e-6)).toThrowError(
      /路径不存在|不是数组|有限数字/,
    );
    expect(() => applyParamPerturbation(CONFIG, 'ascent.crossDays[]', 1e-6)).toThrowError(
      /路径非法/,
    );
  });

  it('delta 为 0 或非有限数拒绝', () => {
    expect(() => applyParamPerturbation(CONFIG, 'need.threshold', 0)).toThrowError(
      expect.objectContaining({ code: errorCodes.CONFIG_INVALID }),
    );
    expect(() => applyParamPerturbation(CONFIG, 'need.threshold', Number.NaN)).toThrowError();
  });

  it('field 未登记、非数字路径或 init-only 段拒绝', () => {
    expect(() => applyParamPerturbation(CONFIG, 'unknownSection.x', 1e-6)).toThrowError(/未登记/);
    expect(() => applyParamPerturbation(CONFIG, 'need', 1e-6)).toThrowError(/顶层键\.子路径/);
    expect(() => applyParamPerturbation(CONFIG, 'population.initialPopulation', 1e-6)).toThrowError(
      /population\.\*/,
    );
  });

  it('wealth_absolute 扰动改变权威哈希且受影响者为存活者', () => {
    const state = runSingle(CONFIG, asSeed(SEED), { policy: POLICY, maxTicks: 5 }).finalState;
    const result = applyWealthPerturbation(state, 0.0001);
    expect(result.applied).toBe(true);
    const alive = state.society.agents.filter((agent) => agent.alive).length;
    expect(result.affectedAgents).toBe(alive);
    for (let index = 0; index < state.society.agents.length; index += 1) {
      const before = state.society.agents[index];
      const after = result.treatment.society.agents[index];
      if (before?.alive) {
        expect(after?.value).toBeCloseTo((before?.value ?? 0) + 0.0001, 12);
      } else {
        expect(after?.value).toBe(before?.value);
      }
    }
    // 输入状态不被修改（克隆隔离）。
    expect(computeAuthoritativeStateHash(state)).not.toBe(
      computeAuthoritativeStateHash(result.treatment),
    );
  });
});

describe('首次偏离（P5-04 修复）', () => {
  const row = (tick: number): TickStats => ({ tick }) as unknown as TickStats;

  it('一侧提前结束时返回多出行的 tick，而不是 null', () => {
    expect(firstDivergenceTick([row(0), row(1)], [row(0)])).toBe(1);
    expect(firstDivergenceTick([row(0)], [row(0), row(1)])).toBe(1);
    expect(firstDivergenceTick([row(0)], [row(0)])).toBeNull();
  });
});

describe('微扰配对执行（P5-04，07 §7）', () => {
  it('param 扰动：两侧同检查点克隆，报告逐项产出且首偏离 tick 合理', () => {
    const pair = runPerturbationPair(CONFIG, SEED, {
      policy: POLICY,
      checkpointTick: CHECKPOINT_TICK,
      declared: { kind: 'param', field: 'need.threshold', delta: 1e-3 },
    });
    expect(pair.invalid).toBe(false);
    expect(pair.checkpointTick).toBe(CHECKPOINT_TICK);
    expect(pair.checkpointStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pair.baseline.finalStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pair.treatment).not.toBeNull();
    expect(pair.baseline.report.aliveAtEnd).toBe(pair.treatment?.report.aliveAtEnd);
    // 小扰动可能被离散阈值吸收：firstDivergenceTick 允许为 null，但两侧报告都已产出。
    expect(pair.firstDivergenceTick === null || Number.isInteger(pair.firstDivergenceTick)).toBe(
      true,
    );
    if (pair.firstDivergenceTick !== null) {
      expect(pair.firstDivergenceTick).toBeGreaterThanOrEqual(CHECKPOINT_TICK);
    }
  });

  it('同一配对重复执行逐字一致（确定性）', () => {
    const first = runPerturbationPair(CONFIG, SEED, {
      policy: POLICY,
      checkpointTick: CHECKPOINT_TICK,
      declared: { kind: 'wealth_absolute', delta: 0.0001 },
    });
    const second = runPerturbationPair(CONFIG, SEED, {
      policy: POLICY,
      checkpointTick: CHECKPOINT_TICK,
      declared: { kind: 'wealth_absolute', delta: 0.0001 },
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.firstDivergenceTick).not.toBeNull();
  });

  it('maxTicks 不大于 checkpointTick 时拒绝', () => {
    expect(() =>
      runPerturbationPair(CONFIG, SEED, {
        policy: POLICY,
        checkpointTick: CHECKPOINT_TICK,
        maxTicks: CHECKPOINT_TICK,
        declared: { kind: 'param', field: 'need.threshold', delta: 1e-3 },
      }),
    ).toThrowError(/maxTicks/);
  });

  it('checkpointTick 越界拒绝', () => {
    expect(() =>
      runPerturbationPair(CONFIG, SEED, {
        policy: POLICY,
        checkpointTick: 0,
        declared: { kind: 'wealth_absolute', delta: 0.0001 },
      }),
    ).toThrowError(/checkpointTick/);
    expect(() =>
      runPerturbationPair(CONFIG, SEED, {
        policy: POLICY,
        checkpointTick: CONFIG.schedule.totalTicks,
        declared: { kind: 'wealth_absolute', delta: 0.0001 },
      }),
    ).toThrowError(/checkpointTick/);
  });

  it('克隆前两侧哈希一致：同一快照克隆 + 扰动仅作用于 treatment（07 §7.2）', () => {
    // 用 wealth 扰动的可观测性验证「克隆前一致」：treatment 的检查点哈希 = baseline 的检查点哈希。
    const pair = runPerturbationPair(CONFIG, SEED, {
      policy: POLICY,
      checkpointTick: CHECKPOINT_TICK,
      declared: { kind: 'wealth_absolute', delta: 0.0001 },
    });
    const manualCheckpoint = runSingle(CONFIG, asSeed(SEED), {
      policy: POLICY,
      maxTicks: CHECKPOINT_TICK,
    });
    expect(pair.checkpointStateHash).toBe(
      computeAuthoritativeStateHash(manualCheckpoint.finalState),
    );
    // 快照 round-trip 本身不改哈希（克隆一致性）。
    expect(
      computeAuthoritativeStateHash(restoreSnapshot(captureSnapshot(manualCheckpoint.finalState))),
    ).toBe(pair.checkpointStateHash);
  });
});

describe('微扰批处理入口（P5-04）', () => {
  it('批处理产出 perturbation-summary-v1 且 invalid 计数正确', () => {
    const summary = runPerturbationBatch(
      CONFIG,
      [
        { seed: 'p1', declared: { kind: 'wealth_absolute', delta: 0.0001 } },
        { seed: 'p2', declared: { kind: 'param', field: 'need.threshold', delta: 1e-6 } },
      ],
      { policy: POLICY, checkpointTick: CHECKPOINT_TICK },
    );
    expect(summary.schemaVersion).toBe('perturbation-summary-v1');
    expect(summary.checkpointTick).toBe(CHECKPOINT_TICK);
    expect(summary.totals).toEqual({ due: 2, ok: 2, invalid: 0 });
    expect(summary.pairs).toHaveLength(2);
    // 每对都记录声明变量，审计口径「实验只改变声明变量」。
    expect(summary.pairs[0]?.declared).toEqual({ kind: 'wealth_absolute', delta: 0.0001 });
    expect(summary.pairs[1]?.declared).toEqual({
      kind: 'param',
      field: 'need.threshold',
      delta: 1e-6,
    });
  });

  it('空任务列表拒绝', () => {
    expect(() =>
      runPerturbationBatch(CONFIG, [], { policy: POLICY, checkpointTick: CHECKPOINT_TICK }),
    ).toThrowError(/不得为空/);
  });
});
