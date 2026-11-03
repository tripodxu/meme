#!/usr/bin/env node
/**
 * G-A 失败的只读轨迹诊断（探索性分析，07 §6.1；不用于任何判定）。
 * 对 baseline 配置跑 3 个种子，输出 refIncome/阶级占比/mUp 的分段轨迹，
 * 用于报告「P0(w3)=0」的机制路径，不修改任何参数或产物。
 */
import { buildBaseConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';

const config = buildBaseConfig(40, 3650);
for (const seed of ['p15-seed-001', 'p15-seed-002', 'p15-seed-003']) {
  const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
  const pick = (label) => {
    const w = outcome.report.windows.find((window) => window.label === label);
    return w === undefined
      ? null
      : {
          P: w.classShares.map((v) => Number(v.toFixed(4))),
          G: Number(w.gini.toFixed(3)),
          mUp: Number(w.mUp.toFixed(3)),
          mDown: Number(w.mDown.toFixed(3)),
          O: Number(w.openness.toFixed(3)),
          edgeCount: Number(w.edgeCountAverage.toFixed(1)),
          deathRate: Number(w.deathRate.toFixed(4)),
        };
  };
  console.log(
    JSON.stringify({
      seed,
      w1: pick('w1'),
      w2: pick('w2'),
      w2b: pick('w2b'),
      w3: pick('w3'),
      aliveAtEnd: outcome.report.aliveAtEnd,
    }),
  );
}
