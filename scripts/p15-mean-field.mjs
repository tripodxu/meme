#!/usr/bin/env node
/**
 * P1.5-02 数值验证 + 07 §12 要求的补充探索扫描（明确标记 exploratory）。
 *
 * 1. 均值场验证：baseline 单种子，检验拥挤负反馈符号与顶层 margin 预测。
 * 2. 探索扫描（非预注册、不进入 G1.5 判定）：crossDays/decay/O 制动变体，
 *    为规则负责人（rules-v4 评审）提供方向性证据。
 */
import { performance } from 'node:perf_hooks';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { checkCongestionSigns, topClassMargin } from '../dist/runner/mean-field.js';

function log(message) {
  process.stderr.write(`[p15-mf] ${message}\n`);
}

// ---- 1. 均值场验证（baseline, 5 种子）----
// 顶层 margin 必须用仿真观测到的 E[c] 计算环境持有人乘子；不传 E 等价于
// envMultiplier=1（v3 语义），会把「顶层可持续性裕度」高估数倍（changes/0004）。
const baseline = DEFAULT_RUN_CONFIG;
const noEnvConfig = mergeConfig(DEFAULT_RUN_CONFIG, { need: { envExponent: 0 } });
// 中位生产力探针：F(hard=1) 取自 effortFunction，ge 中位数为 1。
const GE_PROBE = [0.5, 1, 1, 1, 1, 2, 3];

const mfSeeds = ['mf-1', 'mf-2', 'mf-3', 'mf-4', 'mf-5'];
let signOk = 0;
let signTotal = 0;
const p4Values = [];
const mupValues = [];
const eByClassSamples = [];
for (const seed of mfSeeds) {
  const config = mergeConfig(DEFAULT_RUN_CONFIG, {
    schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 1000 },
  });
  const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
  const w3 = outcome.report.windows.find((window) => window.label === 'w3');
  if (w3 === undefined || w3.missingTicks > 0) continue;
  for (const check of checkCongestionSigns(baseline, w3.classShares)) {
    if (check.applicable) {
      signTotal += 1;
      if (check.signMatches) signOk += 1;
    }
  }
  p4Values.push(w3.classShares[4]);
  mupValues.push(w3.mUp);
  eByClassSamples.push(w3.eByClass);
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

// E 的逐阶级均值（各阶级 E 的算术平均，与 07 §5 窗口均值口径一致）。
const classCount = (eByClassSamples[0] ?? []).length;
const meanEByClass = Array.from({ length: classCount }, (_, c) =>
  mean(eByClassSamples.map((sample) => sample[c] ?? 0)),
);
const marginNoEnv = topClassMargin(noEnvConfig, GE_PROBE, 1);
const marginWithEnv =
  meanEByClass.length > 0 && (meanEByClass[0] ?? 0) > 0
    ? topClassMargin(baseline, GE_PROBE, 1, meanEByClass)
    : null;
log(`topClassMargin(median ge≈1,F≈1) 无环境乘子(v3 对照)=${marginNoEnv.toFixed(3)}`);
log(
  marginWithEnv === null
    ? 'topClassMargin(含 env0 乘子)=不可用（E 缺观测）'
    : `topClassMargin(含 env0 乘子, E=w3 观测)=${marginWithEnv.toFixed(3)} (<1 ⇒ 旋转门预测)`,
);
log(`w3 E by class=${meanEByClass.map((value) => value.toFixed(2)).join(',')}`);
log(`congestion sign matches: ${signOk}/${signTotal}`);
log(`w3 P4 mean=${mean(p4Values).toFixed(3)}  w3 Mup mean=${mean(mupValues).toFixed(3)}`);

// ---- 2. 探索扫描（exploratory，1 种子/cell，完整 3650 tick）----
const exploratoryCells = [
  { key: 'exploratory:crossDays=half', overrides: { ascent: { crossDays: [15, 20, 25, 30] } } },
  { key: 'exploratory:crossDays=double', overrides: { ascent: { crossDays: [60, 80, 100, 120] } } },
  {
    key: 'exploratory:decay=steeper',
    overrides: { lifespan: { decay: [2.0, 1.6, 1.2, 0.9, 0.7] } },
  },
  { key: 'exploratory:decay=flat1', overrides: { lifespan: { decay: [1, 1, 1, 1, 1] } } },
  { key: 'exploratory:thetaM=2', overrides: { openness: { mobilityWeight: 2 } } },
  { key: 'exploratory:Mref=0.5', overrides: { openness: { mobilityReference: 0.5 } } },
  { key: 'exploratory:psi=6', overrides: { need: { needMultiplier: [1, 2, 3, 4.5, 6] } } },
  { key: 'exploratory:lossRate=0.15', overrides: { competition: { lossRate: 0.15 } } },
];

const results = [];
for (const cell of exploratoryCells) {
  const config = mergeConfig(DEFAULT_RUN_CONFIG, {
    ...cell.overrides,
    schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 1000 },
  });
  const runStart = performance.now();
  const outcome = runSingle(config, asSeed('expl-1'), { policy: 'mock-weighted-v1' });
  const w1 = outcome.report.windows.find((window) => window.label === 'w1');
  const w3 = outcome.report.windows.find((window) => window.label === 'w3');
  const pick = w3 !== undefined && w3.missingTicks === 0 ? w3 : w1;
  results.push({
    key: cell.key,
    elapsedMs: Math.round(performance.now() - runStart),
    extinct: outcome.report.extinct,
    w1:
      pick === undefined
        ? null
        : {
            classShares: pick.classShares,
            gini: pick.gini,
            mUp: pick.mUp,
            mDown: pick.mDown,
            segregation: pick.segregation,
            openness: pick.openness,
            labels: outcome.report.labelsByWindow[pick.label] ?? [],
          },
  });
  log(
    `${cell.key.padEnd(34)} P4=${(pick.classShares[4] ?? 0).toFixed(2)} G=${pick.gini.toFixed(2)} Mup=${pick.mUp.toFixed(2)} O=${pick.openness.toFixed(2)} labels=${JSON.stringify(outcome.report.labelsByWindow[pick.label] ?? [])}`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 'p15-meanfield-v2',
      marginNoEnv,
      marginWithEnv,
      meanEByClass,
      signOk,
      signTotal,
      w3P4Mean: mean(p4Values),
      w3MupMean: mean(mupValues),
      exploratory: results,
    },
    null,
    2,
  )}\n`,
);
