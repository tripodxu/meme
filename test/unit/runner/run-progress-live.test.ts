import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { errorCodes, StratifyError } from '../../../src/core/control/errors.js';
import type { DecisionInput, DecisionPolicy } from '../../../src/decision/policy.js';
import type { DecisionRecord } from '../../../src/decision/types.js';
import { MockPolicy } from '../../../src/decision/policies.js';
import { memoryCheckpointHost, memoryCheckpointHostSync } from '../../../src/runner/checkpoint.js';
import { runSingleWithPolicy } from '../../../src/runner/run-cell.js';
import { loadRunProgress } from '../../../src/runner/run-progress.js';

const CONFIG = createDemoConfig({ schedule: { totalTicks: 40 } });
const SEED = asSeed('live-ckpt-seed');

/** 异步策略替身：行为与 MockPolicy 相同的加权选择，但经 Promise 返回（live 形态）。 */
class AsyncMockPolicy implements DecisionPolicy {
  readonly policyVersion = 'async-mock-v1';
  private readonly inner = new MockPolicy();

  async decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord> {
    await Promise.resolve();
    return this.inner.decide(input) as DecisionRecord;
  }
}

function makeCancelledRecord(input: DecisionInput, policyVersion: string): DecisionRecord {
  return {
    schemaVersion: 'stratify-decision-v1',
    runId: input.runId,
    tick: input.tick,
    agentId: input.agentId,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    legalActions: [...input.legal.actions],
    policyVersion,
    promptVersion: null,
    promptStyle: input.promptStyle,
    requestedAction: null,
    selectedAction: input.legal.actions[0] ?? 'accumulate',
    source: 'fallback',
    probabilitySource: 'none',
    requestedModel: input.requestedModel,
    responseModel: null,
    probabilities: null,
    confidence: null,
    topK: input.topK,
    usage: {},
    latencyMs: 0,
    attempts: 0,
    fallbackReason: 'cancelled',
    rawResponse: null,
  };
}

describe('live run 内进度检查点（runSingleWithPolicy，P6-04 前置）', () => {
  it('kill 后恢复：报告、决策日志与不中断对照逐字一致', async () => {
    const control = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AsyncMockPolicy(),
      runId: 'local-ckpt-control0000000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });

    const host = memoryCheckpointHost();
    const path = 'live.progress.json';
    const first = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AsyncMockPolicy(),
      runId: 'local-ckpt-first00000000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      maxTicks: 15,
      runCheckpoint: { host, path, everyTicks: 5, cellKey: 'baseline' },
    });
    expect(first.report.endTick).toBe(14);
    expect(host.files.has(path)).toBe(true);
    const stored = JSON.parse(host.files.get(path) as string) as {
      meta: { tickCompleted: number };
      decisionRecords: unknown[];
    };
    // maxTicks=15：tick 14 完成后 state.tick=15 恰为 everyTicks 倍数，落盘至 15。
    expect(stored.meta.tickCompleted).toBe(15);
    // 决策日志随检查点保存（live 审计链）。
    expect(stored.decisionRecords.length).toBeGreaterThan(0);

    const resumed = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AsyncMockPolicy(),
      runId: 'local-ckpt-resume00000000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      runCheckpoint: { host, path, everyTicks: 5, cellKey: 'baseline' },
    });
    expect(host.files.has(path)).toBe(false);
    expect(JSON.stringify(resumed.report)).toBe(JSON.stringify(control.report));
    // 决策日志完整（恢复段 + 续跑段 = 对照）；runId 是标识符，剥离后逐字比较。
    expect(resumed.decisions.length).toBe(control.decisions.length);
    const strip = (records: readonly DecisionRecord[]) =>
      JSON.stringify(records.map((record) => ({ ...record, runId: '' })));
    expect(strip(resumed.decisions)).toBe(strip(control.decisions));
    expect(resumed.stats.length).toBe(control.stats.length);
  });

  it('取消保留检查点；续跑完成且与对照一致', async () => {
    const control = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AsyncMockPolicy(),
      runId: 'local-cancel-control000000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    const host = memoryCheckpointHost();
    const path = 'live.progress.json';
    const controller = new AbortController();
    // gate 策略：tick>=5 的第一次 decide 阻塞到 abort（保证 checkpoint@5 已存在），
    // 返回 cancelled 回退记录（与真实 client 的取消语义一致）。
    class GateUntilAbortPolicy implements DecisionPolicy {
      readonly policyVersion = 'gate-abort-v1';
      private gated = false;
      async decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord> {
        if (input.tick >= 5 && !this.gated) {
          this.gated = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return makeCancelledRecord(input, this.policyVersion);
        }
        return new AsyncMockPolicy().decide(input, signal);
      }
    }
    const summaryPromise = runSingleWithPolicy(CONFIG, SEED, {
      policy: new GateUntilAbortPolicy(),
      runId: 'local-cancel-run000000000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      signal: controller.signal,
      runCheckpoint: { host, path, everyTicks: 5, cellKey: 'baseline' },
    });
    // tick 5 的首个 decide 已挂起（checkpoint@5 已落盘）后再取消。
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const cancelledRun = await summaryPromise;
    console.log(
      'DEBUG endTick=',
      cancelledRun.report.endTick,
      'cancelled=',
      cancelledRun.report.cancelled,
      'extinct=',
      cancelledRun.report.extinct,
    );
    expect(cancelledRun.report.cancelled).toBe(true);
    expect(host.files.has(path)).toBe(true);

    const resumed = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AsyncMockPolicy(),
      runId: 'local-cancel-resume0000000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      runCheckpoint: { host, path, everyTicks: 5, cellKey: 'baseline' },
    });
    expect(JSON.stringify(resumed.report)).toBe(JSON.stringify(control.report));
    expect(resumed.decisions.length).toBe(control.decisions.length);
    {
      const strip = (records: readonly DecisionRecord[]) =>
        records.map((record) => ({ ...record, runId: '' }));
      const a = strip(resumed.decisions);
      const b = strip(control.decisions);
      const bad = a.findIndex(
        (record, index) => JSON.stringify(record) !== JSON.stringify(b[index]),
      );
      if (bad >= 0) {
        console.log('DIFF at', bad, JSON.stringify(a[bad]), 'VS', JSON.stringify(b[bad]));
      }
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(host.files.has(path)).toBe(false);
  });

  it('损坏检查点按不存在处理，meta 不匹配抛错', async () => {
    const host = memoryCheckpointHost();
    host.files.set('live.progress.json', '{broken');
    const control = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AsyncMockPolicy(),
      runId: 'local-corrupt-control00000000000',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      runCheckpoint: { host, path: 'live.progress.json', everyTicks: 5, cellKey: 'baseline' },
    });
    expect(control.report.endTick).toBe(39);
    expect(host.files.has('live.progress.json')).toBe(false);

    // meta 不匹配（cellKey 伪造）必须抛错：手工放置一个其他 cellKey 的合法载荷。
    const loaded = loadRunProgress(memoryCheckpointHostSync(), 'missing', {});
    expect(loaded).toBeNull();
    const state = (
      await runSingleWithPolicy(CONFIG, SEED, {
        policy: new AsyncMockPolicy(),
        runId: 'local-meta-state000000000000000',
        requestedModel: 'mock',
        promptStyle: 'neutral',
        maxTicks: 10,
      })
    ).finalState;
    const { buildRunProgressPayload } = await import('../../../src/runner/run-progress.js');
    const payload = buildRunProgressPayload(
      {
        cellKey: 'other',
        seed: SEED,
        configHash: 'sha256:' + '0'.repeat(64),
        tickCompleted: 10,
        savedAtSequence: 1,
      },
      state,
      { stats: [], flows: [], decisions: [] },
    );
    host.writeTemp('live.progress.json', JSON.stringify(payload));
    await host.promote('live.progress.json', 'live.progress.json');
    await expect(
      runSingleWithPolicy(CONFIG, SEED, {
        policy: new AsyncMockPolicy(),
        runId: 'local-meta-check000000000000000',
        requestedModel: 'mock',
        promptStyle: 'neutral',
        runCheckpoint: { host, path: 'live.progress.json', everyTicks: 5, cellKey: 'baseline' },
      }),
    ).rejects.toThrowError(/cellKey 不匹配/);
  });

  it('宿主写失败响亮报错（不静默丢检查点）', async () => {
    let calls = 0;
    const memory = memoryCheckpointHost();
    const failing = {
      writeTemp: async (path: string, payload: string) => {
        calls += 1;
        if (calls === 2) {
          throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '注入磁盘写失败');
        }
        await memory.writeTemp(path, payload);
      },
      promote: memory.promote.bind(memory),
      read: memory.read.bind(memory),
      exists: memory.exists.bind(memory),
      remove: memory.remove.bind(memory),
    };
    await expect(
      runSingleWithPolicy(CONFIG, SEED, {
        policy: new AsyncMockPolicy(),
        runId: 'local-fail-control00000000000000',
        requestedModel: 'mock',
        promptStyle: 'neutral',
        runCheckpoint: {
          host: failing,
          path: 'live.progress.json',
          everyTicks: 5,
          cellKey: 'baseline',
        },
      }),
    ).rejects.toThrowError(/磁盘写失败/);
    await expect(memory.exists('live.progress.json')).resolves.toBe(true);
  });
});
