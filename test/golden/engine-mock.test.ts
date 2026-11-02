import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../src/core/config/defaults.js';
import { computeParamsHash } from '../../src/core/config/hash.js';
import { asSeed } from '../../src/core/control/ids.js';
import { RULES_VERSION } from '../../src/core/control/versions.js';
import { createSimulation } from '../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../src/core/legal-actions.js';
import { step } from '../../src/core/engine/engine.js';
import { computeAuthoritativeStateHash } from '../../src/core/hash/state-hash.js';
import { decideMockWeighted } from '../../src/decision/mock.js';
import type { SimState } from '../../src/core/model/state.js';
import type { AgentId } from '../../src/core/control/ids.js';

/**
 * golden：40 人默认 mock 运行（08 §5，rules-v4）。
 * fixture 冻结 tick 0/1/10/120/400 的状态哈希与聚合指标；
 * 更新必须人工审查差异并说明原因，不得一键覆盖。
 * v3 历史 fixture（mock-run-rules-v3.json）保留只读，不参与当前断言。
 */

interface GoldenFixture {
  readonly description: string;
  readonly rulesVersion: string;
  readonly paramsHash: string;
  readonly seed: string;
  readonly checkpoints: readonly {
    readonly tick: number;
    readonly finalStateHash: string;
    readonly stats: Record<string, unknown>;
  }[];
  readonly mortality: {
    readonly uniform3650: number;
    readonly newborn3650: number;
  };
}

const FIXTURE_PATH = '../fixtures/engine/mock-run-rules-v4.json';
const UPDATE = process.env['STRATIFY_UPDATE_GOLDEN'] === '1';

function loadFixture(): GoldenFixture | null {
  try {
    return JSON.parse(
      readFileSync(fileURLToPath(new URL(FIXTURE_PATH, import.meta.url)), 'utf8'),
    ) as GoldenFixture;
  } catch {
    return null;
  }
}

function mockDecisions(state: SimState): Map<AgentId, { selectedAction: string }> {
  const decisions = new Map<AgentId, { selectedAction: string }>();
  if (state.society.tick % state.config.decision.interval !== 0) {
    return decisions;
  }
  for (const agent of state.society.agents) {
    if (!agent.alive) continue;
    const legal = enumerateLegalActions(state, agent.id);
    const decision = decideMockWeighted({
      runId: 'local-golden',
      seed: state.seed,
      state,
      agentId: agent.id,
      stateHash: 'sha256:golden',
      actionSetHash: 'sha256:golden',
      legal,
    });
    decisions.set(agent.id, { selectedAction: decision.selectedAction });
  }
  return decisions;
}

interface RunCheckpoint {
  tick: number;
  finalStateHash: string;
  stats: Record<string, unknown>;
}

/** 运行到指定检查点 tick，收集状态哈希与该 tick 的 stats。 */
function runToCheckpoints(ticks: readonly number[]): RunCheckpoint[] {
  const targets = [...ticks].sort((a, b) => a - b);
  let state = createSimulation(DEFAULT_RUN_CONFIG, asSeed('golden-mock-seed'));
  const checkpoints: RunCheckpoint[] = [];
  for (const target of targets) {
    while (state.society.tick <= target) {
      const result = step(state, mockDecisions(state), { runId: 'local-golden' });
      state = result.state;
      if (result.endReason !== null) break;
    }
    // tick t 完成后的状态：society.tick == t+1；stats 记录在最后一步。
    const finalHash = computeAuthoritativeStateHash(state);
    checkpoints.push({
      tick: target,
      finalStateHash: finalHash,
      stats: lastStatsOf(state, target),
    });
  }
  return checkpoints;
}

/** 重新步进收集 tick=t 的 stats（简单起见重放小段）。 */
function lastStatsOf(state: SimState, target: number): Record<string, unknown> {
  let cursor = createSimulation(DEFAULT_RUN_CONFIG, asSeed('golden-mock-seed'));
  let stats: Record<string, unknown> = {};
  while (cursor.society.tick <= target) {
    const result = step(cursor, mockDecisions(cursor), { runId: 'local-golden' });
    if (cursor.society.tick === target) {
      stats = { ...result.stats };
    }
    cursor = result.state;
    if (result.endReason !== null) break;
  }
  return stats;
}

function mortality3650(mode: 'uniform' | 'newborn'): number {
  const config =
    mode === 'uniform'
      ? DEFAULT_RUN_CONFIG
      : {
          ...DEFAULT_RUN_CONFIG,
          population: { ...DEFAULT_RUN_CONFIG.population, initialAgeMode: 'newborn' as const },
        };
  let state = createSimulation(config, asSeed('golden-mock-seed'));
  const initialAlive = state.society.agents.length;
  let deathsAtEnd = 0;
  while (state.society.tick < 3650) {
    const result = step(state, mockDecisions(state), { runId: 'local-golden' });
    state = result.state;
    if (result.endReason !== null) break;
  }
  deathsAtEnd = state.society.agents.filter((agent) => !agent.alive).length;
  void initialAlive;
  return deathsAtEnd / state.society.agents.length;
}

describe('golden: 40 人默认 mock 运行（rules-v3）', () => {
  const fixture = loadFixture();

  if (fixture === null || UPDATE) {
    it('生成 golden fixture（人工审查 diff 后提交）', () => {
      const checkpoints = runToCheckpoints([0, 1, 10, 120, 400]);
      const generated: GoldenFixture = {
        description:
          '40 人默认 mock 运行（seed=golden-mock-seed）；更新必须人工审查差异并说明原因。',
        rulesVersion: RULES_VERSION,
        paramsHash: computeParamsHash(DEFAULT_RUN_CONFIG),
        seed: 'golden-mock-seed',
        checkpoints,
        mortality: {
          uniform3650: mortality3650('uniform'),
          newborn3650: mortality3650('newborn'),
        },
      };
      writeFileSync(
        fileURLToPath(new URL(FIXTURE_PATH, import.meta.url)),
        `${JSON.stringify(generated, null, 2)}\n`,
        'utf8',
      );
      expect(generated.checkpoints).toHaveLength(5);
    }, 600_000);
    return;
  }

  it('rulesVersion 与 paramsHash 与当前代码一致', () => {
    expect(fixture.rulesVersion).toBe(RULES_VERSION);
    expect(fixture.paramsHash).toBe(computeParamsHash(DEFAULT_RUN_CONFIG));
  });

  for (const checkpoint of fixture.checkpoints) {
    it(`tick ${checkpoint.tick} 的状态哈希与指标一致`, () => {
      const [actual] = runToCheckpoints([checkpoint.tick]);
      if (actual === undefined) throw new Error('运行未产生检查点');
      expect(actual.finalStateHash).toBe(checkpoint.finalStateHash);
      const expected = checkpoint.stats as Record<string, number | number[]>;
      for (const key of Object.keys(expected)) {
        const actualValue = (actual.stats as Record<string, unknown>)[key];
        if (Array.isArray(expected[key])) {
          expect(actualValue).toEqual(expected[key]);
        } else if (typeof expected[key] === 'number') {
          expect(actualValue).toBeCloseTo(expected[key] as number, 9);
        }
      }
    }, 300_000);
  }

  it('uniform 3650 tick 死亡率 >=0.05；newborn <=0.01（08 §3.4）', () => {
    expect(fixture.mortality.uniform3650).toBeGreaterThanOrEqual(0.05);
    expect(fixture.mortality.newborn3650).toBeLessThanOrEqual(0.01);
    // 复跑验证当前代码仍满足机制可观测性下限
    expect(mortality3650('uniform')).toBeGreaterThanOrEqual(0.05);
    expect(mortality3650('newborn')).toBeLessThanOrEqual(0.01);
  }, 600_000);

  it('反馈 fixture：400 tick 后 E/O 已更新且 Mup/Mdown/S 位于合法域', () => {
    const [checkpoint] = runToCheckpoints([400]);
    if (checkpoint === undefined) throw new Error('运行未产生检查点');
    const stats = checkpoint.stats as Record<string, unknown>;
    const eByClass = stats['eByClass'] as number[];
    expect(eByClass).not.toEqual([1, 1.5, 2.2, 3.2, 4.5]); // E 已更新
    const openness = stats['openness'] as number;
    expect(openness).toBeGreaterThanOrEqual(0);
    expect(openness).toBeLessThanOrEqual(1);
    const segregation = stats['segregation'] as number;
    expect(segregation).toBeGreaterThanOrEqual(-1);
    expect(segregation).toBeLessThanOrEqual(1);
    expect(stats['mUp']).toBeGreaterThanOrEqual(0);
    expect(stats['mDown']).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
