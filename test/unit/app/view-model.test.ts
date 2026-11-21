import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import type { TickEvent } from '../../../src/core/events.js';
import {
  competitionByDirection,
  lorenzCurvePoints,
  parsePairedBatchForest,
  remainingLifeBins,
  sanitizeSecrets,
  statsToCsv,
} from '../../../src/app/view-model.js';
import { RunController } from '../../../src/app/run-controller.js';

describe('view-model 高阶视图纯派生与安全脱敏（06 §5–§7）', () => {
  it('sanitizeSecrets 递归遮蔽 apiKey / token / authorization 等敏感字段', () => {
    const raw = {
      model: 'jev-small',
      apiKey: 'jv-secret-123',
      nested: {
        Authorization: 'Bearer secret-token',
        access_token: 'tok-999',
        safeMetric: 0.42,
      },
    };
    const cleaned = sanitizeSecrets(raw) as Record<string, unknown>;
    expect(cleaned['model']).toBe('jev-small');
    expect(cleaned['apiKey']).toBe('[REDACTED]');
    const nested = cleaned['nested'] as Record<string, unknown>;
    expect(nested['Authorization']).toBe('[REDACTED]');
    expect(nested['access_token']).toBe('[REDACTED]');
    expect(nested['safeMetric']).toBe(0.42);
    expect(JSON.stringify(cleaned)).not.toContain('jv-secret-123');
    expect(JSON.stringify(cleaned)).not.toContain('secret-token');
  });

  it('competitionByDirection 按三类发起方向准确聚合场次、胜率与净摩擦损耗', () => {
    const events: TickEvent[] = [
      {
        type: 'competition_resolved',
        tick: 1,
        seq: 1,
        initiatorId: 'a-0000',
        targetId: 'a-0001',
        initiatorClass: 0,
        targetClass: 1,
        direction: 'low_to_high',
        winProbability: 0.4,
        roll: 0.2,
        winner: 'initiator',
        loss: 10,
        gain: 8,
        efficiency: 0.8,
      } as unknown as TickEvent,
      {
        type: 'competition_resolved',
        tick: 2,
        seq: 1,
        initiatorId: 'a-0002',
        targetId: 'a-0003',
        initiatorClass: 2,
        targetClass: 2,
        direction: 'same_class',
        winProbability: 0.5,
        roll: 0.9,
        winner: 'target',
        loss: 6,
        gain: 4.5,
        efficiency: 0.75,
      } as unknown as TickEvent,
    ];
    const rows = competitionByDirection(events);
    const lowHigh = rows.find((r) => r.direction === 'low_to_high');
    const same = rows.find((r) => r.direction === 'same_class');
    const highLow = rows.find((r) => r.direction === 'high_to_low');
    expect(lowHigh?.count).toBe(1);
    expect(lowHigh?.winRate).toBe(1);
    expect(lowHigh?.netFriction).toBeCloseTo(2, 6);
    expect(same?.count).toBe(1);
    expect(same?.winRate).toBe(0);
    expect(same?.netFriction).toBeCloseTo(1.5, 6);
    expect(highLow?.count).toBe(0);
    expect(highLow?.winRate).toBeNull();
  });

  it('lorenzCurvePoints 与 remainingLifeBins 从权威状态派生合法分布，statsToCsv 输出表头与数据行', async () => {
    const config = createDemoConfig({
      population: { initialPopulation: 10 },
      schedule: { totalTicks: 4, statsStride: 1, snapshotStride: 2 },
    });
    const controller = new RunController();
    controller.prepare(config, 'vm-seed');
    const initState = controller.getState();
    // tick=0 全员初始财富为 0，退化为均等对角线 2 端点
    expect(lorenzCurvePoints(initState)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    const bins = remainingLifeBins(initState);
    expect(bins.reduce((sum, b) => sum + b.value, 0)).toBe(10);

    controller.start();
    await controller.whenIdle();
    const pts = lorenzCurvePoints(controller.getState());
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]?.x).toBeCloseTo(1, 8);
    expect(pts[pts.length - 1]?.y).toBeCloseTo(1, 8);
    const csv = statsToCsv(controller.snapshot().stats);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('tick,aliveCount,gini,medianValue');
  });

  it('parsePairedBatchForest 严格实施 pairedSeeds >= 30 的推断资格护栏', () => {
    const underpowered = parsePairedBatchForest({
      title: '小样本探索',
      pairedSeeds: 12,
      metrics: [{ metric: 'gini', estimate: 0.05, ciLow: 0.01, ciHigh: 0.09 }],
    });
    expect(underpowered).not.toBeNull();
    expect(underpowered?.eligibleForInference).toBe(false);

    const powered = parsePairedBatchForest({
      title: '30 种子正式配对',
      pairedSeeds: 30,
      metrics: [
        { metric: 'gini', estimate: 0.08, ciLow: 0.03, ciHigh: 0.13, sameSignFraction: 0.87 },
      ],
    });
    expect(powered).not.toBeNull();
    expect(powered?.eligibleForInference).toBe(true);
    expect(powered?.metrics[0]?.sameSignFraction).toBe(0.87);

    expect(parsePairedBatchForest({ pairedSeeds: 30, metrics: [] })).toBeNull();
  });
});
