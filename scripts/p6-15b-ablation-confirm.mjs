#!/usr/bin/env node
/**
 * P6-15b：体制 II（B-share50-w15）阶级持有成本消融（ψ=1）的独立确认轮（N=600，07 §8 / §11）。
 *
 * 科学动机（07 §8 第 3–4 条、§9 功效分析、changes/0107）：
 * - P6-15（N=40，真实 mock-weighted-v1）中五项消融的筛选显示：体制 II 的 ψ=1 产生显著
 *   结构退化（w3 median TV(P)=0.1790，CI [0.1529,0.1981]，30/30 种子 P[1] 下降 / P[4] 上升）；
 *   但 N=40 有限样本噪声导致 baseline D95=0.1501 过宽，未过严苛 07 §8 第 3 条（overD95=100%）。
 * - 07 §9 功效 pilot（5 独立种子 p6-15b-pwr-001..005）显示：在官方 Stage B 主窗 w2b=[1825,2554]、
 *   N=400 下 basePairD max=0.0515、ψ=1 TV(P)=0.216–0.242、D=0.061–0.095（5/5 超最大基线 D）。
 *   为保证 30 种子（435 对）下对 D95 留足统计功效余量，本独立确认轮预注册冻结 N=600。
 *
 * 设计（冻结后运行前不得修改）：
 * - 规则与策略：rules-v19 默认配置 + 体制 II（displacementShare=0.5, scarcityWeight=15），
 *   显式锁定 policy='mock-weighted-v1' 并在运行期逐决策校验 DecisionRecord.policyVersion；
 * - 格点：baseline vs psi_1（need.needMultiplier=[1,1,1,1,1]），2 cell × 30 全新确认种子
 *   p6-15b-conf-001..030 = 60 run，N=600，3650 tick；
 * - 判读：直接调用官方 `evaluateStageB`（src/runner/p6-analysis.ts），主窗 w2b=[1825,2554]、
 *   主指标 TV(P) ≥ 0.10、10,000 次配对 bootstrap 95% CI 不跨 0、100,000 次符号翻转置换检验、
 *   100% 超 baseline D95（beyondBandMinRate=1）、叠加 changes/0043 主导阶级同向率 ≥ 90%；
 *   w3=[2555,3284] 仅作相邻窗口描述，不参与确认。
 *
 * 用法：
 *   node scripts/p6-15b-ablation-confirm.mjs --freeze
 *   node scripts/p6-15b-ablation-confirm.mjs --run
 *   node scripts/p6-15b-ablation-confirm.mjs --analyze
 *   node scripts/p6-15b-ablation-confirm.mjs --status
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { computeConfigHash, computeParamsHash } from '../dist/core/config/hash.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../dist/core/control/versions.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { hashValue } from '../dist/core/hash/hash.js';
import {
  computeLabelThresholdsHash,
  LABEL_THRESHOLDS_VERSION,
} from '../dist/core/labels/thresholds.js';
import { evaluateStageB, median } from '../dist/runner/p6-analysis.js';
import { runSingle } from '../dist/runner/run-cell.js';

const POLICY = 'mock-weighted-v1';
const POPULATION = 600;
const TOTAL_TICKS = 3650;
const PREREG_PATH = 'out/p6-15b-prereg.json';
const RAW_PATH = 'out/p6-15b-raw.json';
const RESULT_PATH = 'out/p6-15b-result.json';
const PARTS_DIR = 'out/p6-15b-parts';

const SEEDS = Array.from({ length: 30 }, (_, i) => `p6-15b-conf-${String(i + 1).padStart(3, '0')}`);

const REGIME_OVERRIDES = { ascent: { displacementShare: 0.5, scarcityWeight: 15 } };

const CELLS = [
  { cellKey: 'baseline', design: 'baseline', overrides: {} },
  {
    cellKey: 'psi_1',
    design: 'single',
    overrides: { need: { needMultiplier: [1, 1, 1, 1, 1] } },
  },
];

function buildPrereg() {
  const baseCfg = mergeConfig(DEFAULT_RUN_CONFIG, {
    ...REGIME_OVERRIDES,
    population: { initialPopulation: POPULATION },
    schedule: { totalTicks: TOTAL_TICKS, statsStride: 1, snapshotStride: TOTAL_TICKS },
  });
  const cells = CELLS.map((cell) => {
    const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
      ...REGIME_OVERRIDES,
      ...cell.overrides,
      population: { initialPopulation: POPULATION },
      schedule: { totalTicks: TOTAL_TICKS, statsStride: 1, snapshotStride: TOTAL_TICKS },
    });
    return {
      cellKey: cell.cellKey,
      design: cell.design,
      overrides: cell.overrides,
      fullConfigHash: computeConfigHash(cfg),
      paramsHash: computeParamsHash(cfg),
    };
  });

  const manifest = {
    schemaVersion: 'p6-15b-ablation-confirm-prereg-v1',
    experimentType: 'ablation_stageB_confirmation',
    hypothesis:
      '在真实 mock-weighted-v1 策略与 rules-v19 体制 II（B-share50-w15，N=600，3650 tick）下，' +
      '移除阶级持有成本（ψ=1，need.needMultiplier=[1,1,1,1,1]）在独立确认种子集 p6-15b-conf-001..030 上' +
      '于主窗口 w2b=[1825,2554] 产生结构退化：主指标 TV(P) 中位数 ≥ 0.10、10,000 次配对 bootstrap 95% 区间不跨 0、' +
      '100% 配对种子 D 超出同配置 baseline D95 波动带，且主导变化阶级 P[1] 下降方向在 ≥ 90% 种子上一致（07 §8/§11）。' +
      'w3=[2555,3284] 仅作相邻窗口描述，不参与确认。',
    primaryMetric: 'TV(P)',
    primaryWindow: 'w2b',
    adjacentWindow: 'w3',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: POLICY,
    population: POPULATION,
    totalTicks: TOTAL_TICKS,
    regimeKey: 'R2_B_share50_w15',
    regimeOverrides: REGIME_OVERRIDES,
    baseConfigHash: computeConfigHash(baseCfg),
    baseParamsHash: computeParamsHash(baseCfg),
    labelThresholdVersion: LABEL_THRESHOLDS_VERSION,
    labelThresholdsHash: computeLabelThresholdsHash(),
    seeds: SEEDS,
    differenceThresholds: {
      tv: 0.1,
      gini: 0.03,
      mUp: 0.05,
      segregation: 0.05,
      openness: 0.05,
    },
    statistics: {
      evaluator: 'evaluateStageB',
      bootstrapIterations: 10000,
      permutationIterations: 100000,
      analysisSeed: 20261124,
      beyondBandMinRate: 1,
      dominantClassDirectionMinRate: 0.9,
      expectedDominantClass: 1,
      expectedDominantSign: -1,
    },
    cells,
    budgets: { totalRuns: 60 },
  };

  const preregistrationHash = hashValue(HASH_DOMAINS.preregistration, manifest);
  const experimentId = `p6-15b-${preregistrationHash.slice(7, 15)}`;
  return { experimentId, preregistrationHash, manifest };
}

function buildTasks() {
  const tasks = [];
  for (const seed of SEEDS) {
    for (const cell of CELLS) {
      tasks.push({
        id: `${cell.cellKey}__${seed}`,
        cellKey: cell.cellKey,
        overrides: cell.overrides,
        seed,
      });
    }
  }
  return tasks;
}

function createPolicyVerifyingSink(expectedPolicy) {
  let observedPolicy = null;
  let dueDecisions = 0;
  let fallbackDecisions = 0;
  return {
    sink: {
      onInitialSnapshot() {},
      onTickSettled({ decisions }) {
        for (const d of decisions) {
          dueDecisions += 1;
          if (d.source === 'fallback') fallbackDecisions += 1;
          if (observedPolicy === null) {
            observedPolicy = d.policyVersion;
          } else if (d.policyVersion !== observedPolicy) {
            throw new Error(`策略漂移：期望 ${observedPolicy}，收到 ${d.policyVersion}`);
          }
          if (d.policyVersion !== expectedPolicy) {
            throw new Error(`策略校验失败：期望 ${expectedPolicy}，收到 ${d.policyVersion}`);
          }
        }
      },
      onFinalState() {},
    },
    summary() {
      return {
        observedPolicy,
        dueDecisions,
        fallbackDecisions,
        fallbackRate: dueDecisions > 0 ? fallbackDecisions / dueDecisions : 0,
      };
    },
  };
}

function extractWindowMetrics(report, label) {
  const win = report.windows.find((w) => w.label === label);
  if (!win || win.missingTicks > 0 || win.tickCount === 0 || win.classShares.length !== 5) {
    return null;
  }
  return {
    classShares: [...win.classShares],
    gini: win.gini,
    mUp: win.mUp,
    mDown: win.mDown,
    segregation: win.networkEmpty ? null : win.segregation,
    openness: win.openness,
    fallbackRate: win.fallbackRate,
    missingTicks: win.missingTicks,
    observedTicks: win.observedTicks,
    tickCount: win.tickCount,
    labels: [...(report.labelsByWindow[label] ?? [])],
  };
}

function writeAtomicJson(targetPath, data) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, 'utf8');
  renameSync(tmpPath, targetPath);
}

function runOneTask(task, preregistrationHash) {
  const t0 = Date.now();
  const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
    ...REGIME_OVERRIDES,
    ...task.overrides,
    population: { initialPopulation: POPULATION },
    schedule: { totalTicks: TOTAL_TICKS, statsStride: 1, snapshotStride: TOTAL_TICKS },
  });
  const verifier = createPolicyVerifyingSink(POLICY);
  const out = runSingle(cfg, asSeed(task.seed), {
    policy: POLICY,
    artifactSink: verifier.sink,
  });
  const w2b = extractWindowMetrics(out.report, 'w2b');
  const w3 = extractWindowMetrics(out.report, 'w3');
  if (!out.report.extinct && (w2b === null || w3 === null)) {
    throw new Error(`任务 ${task.id} 非灭绝但 w2b/w3 窗口不完整`);
  }
  return {
    id: task.id,
    preregistrationHash,
    cellKey: task.cellKey,
    seed: task.seed,
    extinct: out.report.extinct,
    aliveAtEnd: out.report.aliveAtEnd,
    finalStateHash: out.report.finalStateHash,
    w2b,
    w3,
    ...verifier.summary(),
    wallMs: Date.now() - t0,
  };
}

if (!isMainThread) {
  const { tasks, preregistrationHash, partsDir } = workerData;
  let completed = 0;
  for (const task of tasks) {
    const partPath = join(partsDir, `${task.id}.json`);
    if (existsSync(partPath)) {
      try {
        const existing = JSON.parse(readFileSync(partPath, 'utf8'));
        if (existing.preregistrationHash === preregistrationHash && existing.id === task.id) {
          completed += 1;
          parentPort.postMessage({ type: 'skip', id: task.id, completed });
          continue;
        }
      } catch {
        // 损坏分片重算
      }
    }
    const record = runOneTask(task, preregistrationHash);
    writeAtomicJson(partPath, record);
    completed += 1;
    parentPort.postMessage({ type: 'done', id: task.id, wallMs: record.wallMs, completed });
  }
  parentPort.postMessage({ type: 'finished', completed });
} else {
  const round4 = (v) => Number(v.toFixed(4));

  const loadCompleted = (allTasks, expectedHash) => {
    const byId = new Map();
    if (existsSync(RAW_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(RAW_PATH, 'utf8'));
        if (raw.preregistrationHash === expectedHash && Array.isArray(raw.records)) {
          for (const rec of raw.records) {
            if (rec && rec.preregistrationHash === expectedHash && typeof rec.id === 'string') {
              byId.set(rec.id, rec);
            }
          }
        }
      } catch {
        // 忽略损坏 raw
      }
    }
    if (existsSync(PARTS_DIR)) {
      for (const task of allTasks) {
        const partPath = join(PARTS_DIR, `${task.id}.json`);
        if (!existsSync(partPath)) continue;
        try {
          const rec = JSON.parse(readFileSync(partPath, 'utf8'));
          if (rec.preregistrationHash === expectedHash && rec.id === task.id) {
            byId.set(task.id, rec);
          }
        } catch {
          // 跳过损坏分片
        }
      }
    }
    return byId;
  };

  const runAnalyze = (prereg, allTasks, writeRaw = false) => {
    const byId = loadCompleted(allTasks, prereg.preregistrationHash);
    const records = allTasks.map((t) => byId.get(t.id)).filter(Boolean);
    const complete = records.length === allTasks.length;

    if (!complete) {
      const partial = {
        experimentId: prereg.experimentId,
        preregistrationHash: prereg.preregistrationHash,
        progress: `${records.length}/${allTasks.length}`,
        complete: false,
      };
      mkdirSync('out', { recursive: true });
      writeFileSync(RESULT_PATH, `${JSON.stringify(partial, null, 2)}\n`, 'utf8');
      return partial;
    }

    if (writeRaw) {
      writeAtomicJson(RAW_PATH, {
        experimentId: prereg.experimentId,
        preregistrationHash: prereg.preregistrationHash,
        policyVersion: POLICY,
        rulesVersion: RULES_VERSION,
        population: POPULATION,
        records,
      });
    }

    const observedPolicies = [...new Set(records.map((r) => r.observedPolicy))];
    const totalFallbacks = records.reduce((s, r) => s + (r.fallbackDecisions ?? 0), 0);
    const policyValid =
      observedPolicies.length === 1 && observedPolicies[0] === POLICY && totalFallbacks === 0;

    const analysisRuns = records.map((r) => ({
      cellKey: r.cellKey,
      seed: r.seed,
      extinct: r.extinct,
      ...(r.w2b ? { w2b: r.w2b } : {}),
      ...(r.w3 ? { w3: r.w3 } : {}),
    }));

    const evaluation = evaluateStageB(
      {
        cellKey: 'R2_B_share50_w15::psi_1',
        targetCellKey: 'psi_1',
        prereg: {
          primaryMetric: prereg.manifest.primaryMetric,
          seeds: prereg.manifest.seeds,
          differenceThresholds: prereg.manifest.differenceThresholds,
          hypothesis: prereg.manifest.hypothesis,
          cells: prereg.manifest.cells,
        },
        runs: analysisRuns,
        totals: { due: 60, ok: 60, failed: 0, resumed: 0 },
      },
      {
        bootstrapIterations: prereg.manifest.statistics.bootstrapIterations,
        bootstrapSeed: prereg.manifest.statistics.analysisSeed,
        permutationIterations: prereg.manifest.statistics.permutationIterations,
        beyondBandMinRate: prereg.manifest.statistics.beyondBandMinRate,
      },
    );

    const baseBySeed = new Map(
      records.filter((r) => r.cellKey === 'baseline').map((r) => [r.seed, r]),
    );
    const psiBySeed = new Map(records.filter((r) => r.cellKey === 'psi_1').map((r) => [r.seed, r]));

    const classDeltasW2b = [0, 1, 2, 3, 4].map((c) => {
      const vals = SEEDS.map(
        (seed) => psiBySeed.get(seed).w2b.classShares[c] - baseBySeed.get(seed).w2b.classShares[c],
      );
      const med = median(vals);
      const sign = Math.sign(med);
      const agree = sign === 0 ? 0 : vals.filter((v) => Math.sign(v) === sign).length / vals.length;
      return { classIndex: c, medianDelta: round4(med), signAgreeRate: round4(agree) };
    });
    const dominantClass = [...classDeltasW2b].sort(
      (a, b) => Math.abs(b.medianDelta) - Math.abs(a.medianDelta),
    )[0];
    const p1Deltas = SEEDS.map(
      (seed) => psiBySeed.get(seed).w2b.classShares[1] - baseBySeed.get(seed).w2b.classShares[1],
    );
    const p4Deltas = SEEDS.map(
      (seed) => psiBySeed.get(seed).w2b.classShares[4] - baseBySeed.get(seed).w2b.classShares[4],
    );
    const dominantDirectionOk =
      dominantClass.classIndex === 1 &&
      dominantClass.medianDelta < 0 &&
      dominantClass.signAgreeRate >= 0.9;

    const baselineLabelCountsW2b = {};
    const psiLabelCountsW2b = {};
    for (const seed of SEEDS) {
      for (const lbl of baseBySeed.get(seed).w2b.labels ?? []) {
        baselineLabelCountsW2b[lbl] = (baselineLabelCountsW2b[lbl] ?? 0) + 1;
      }
      for (const lbl of psiBySeed.get(seed).w2b.labels ?? []) {
        psiLabelCountsW2b[lbl] = (psiLabelCountsW2b[lbl] ?? 0) + 1;
      }
    }

    const strictConfirmed = evaluation.confirmed && dominantDirectionOk && policyValid;
    const result = {
      experimentId: prereg.experimentId,
      preregistrationHash: prereg.preregistrationHash,
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      policyVersion: POLICY,
      population: POPULATION,
      progress: '60/60',
      complete: true,
      cumulativeTaskCpuSeconds: round4(records.reduce((s, r) => s + (r.wallMs ?? 0), 0) / 1000),
      policyAudit: { policyValid, observedPolicies, totalFallbacks },
      evaluation,
      classStructureW2b: {
        baselineMedianP: [0, 1, 2, 3, 4].map((c) =>
          round4(median(SEEDS.map((s) => baseBySeed.get(s).w2b.classShares[c]))),
        ),
        psi1MedianP: [0, 1, 2, 3, 4].map((c) =>
          round4(median(SEEDS.map((s) => psiBySeed.get(s).w2b.classShares[c]))),
        ),
        classDeltasW2b,
        dominantClass,
        dominantDirectionOk,
        p1DecreaseRate: round4(p1Deltas.filter((d) => d < 0).length / p1Deltas.length),
        p4IncreaseRate: round4(p4Deltas.filter((d) => d > 0).length / p4Deltas.length),
        psi1LegacyP4DecreasePredictionHolds:
          median(p4Deltas) < 0 && p4Deltas.filter((d) => d < 0).length / p4Deltas.length >= 0.9,
        baselineLabelCountsW2b,
        psiLabelCountsW2b,
      },
      strictConfirmed,
    };

    mkdirSync('out', { recursive: true });
    writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  };

  const args = process.argv.slice(2);
  const doFreeze = args.includes('--freeze');
  const doRun = args.includes('--run');
  const doAnalyze = args.includes('--analyze');
  const doStatus = args.includes('--status');

  if (!doFreeze && !doRun && !doAnalyze && !doStatus) {
    process.stderr.write(
      '用法: node scripts/p6-15b-ablation-confirm.mjs [--freeze | --run | --analyze | --status]\n',
    );
    process.exit(1);
  }

  const prereg = buildPrereg();
  const allTasks = buildTasks();

  if (doFreeze) {
    mkdirSync('out', { recursive: true });
    writeFileSync(PREREG_PATH, `${JSON.stringify(prereg, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `Frozen ${PREREG_PATH}\nexperimentId=${prereg.experimentId}\npreregistrationHash=${prereg.preregistrationHash}\n`,
    );
    process.exit(0);
  }

  if (doStatus) {
    const byId = loadCompleted(allTasks, prereg.preregistrationHash);
    process.stdout.write(
      `${JSON.stringify(
        {
          experimentId: prereg.experimentId,
          preregistrationHash: prereg.preregistrationHash,
          completed: `${byId.size}/${allTasks.length}`,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }

  if (doAnalyze) {
    if (existsSync(PREREG_PATH)) {
      const frozen = JSON.parse(readFileSync(PREREG_PATH, 'utf8'));
      if (frozen.preregistrationHash !== prereg.preregistrationHash) {
        throw new Error(
          `预注册哈希漂移：冻结=${frozen.preregistrationHash}，当前=${prereg.preregistrationHash}`,
        );
      }
    }
    const result = runAnalyze(prereg, allTasks, true);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }

  if (doRun) {
    if (!existsSync(PREREG_PATH)) {
      throw new Error(`缺少冻结预注册文件 ${PREREG_PATH}；请先执行 --freeze`);
    }
    const frozen = JSON.parse(readFileSync(PREREG_PATH, 'utf8'));
    if (frozen.preregistrationHash !== prereg.preregistrationHash) {
      throw new Error(
        `预注册哈希不匹配：冻结=${frozen.preregistrationHash}，当前=${prereg.preregistrationHash}`,
      );
    }

    mkdirSync(PARTS_DIR, { recursive: true });
    const existing = loadCompleted(allTasks, prereg.preregistrationHash);
    const pending = allTasks.filter((t) => !existing.has(t.id));
    process.stderr.write(
      `P6-15b (${prereg.experimentId}) N=${POPULATION}: total=${allTasks.length}, done=${existing.size}, pending=${pending.length}\n`,
    );

    if (pending.length > 0) {
      const envWorkers = Number(process.env.P6_15B_WORKERS);
      const workersCount =
        Number.isInteger(envWorkers) && envWorkers >= 1
          ? envWorkers
          : Math.min(availableParallelism(), 2);
      const actualWorkers = Math.min(workersCount, pending.length);
      const buckets = Array.from({ length: actualWorkers }, () => []);
      pending.forEach((task, idx) => buckets[idx % actualWorkers].push(task));

      const tStart = Date.now();
      let doneNow = 0;
      const selfPath = fileURLToPath(import.meta.url);
      await Promise.all(
        buckets.map(
          (chunk, workerIdx) =>
            new Promise((resolve, reject) => {
              const w = new Worker(selfPath, {
                workerData: {
                  tasks: chunk,
                  preregistrationHash: prereg.preregistrationHash,
                  partsDir: PARTS_DIR,
                },
              });
              w.on('message', (msg) => {
                if (msg.type === 'done') {
                  doneNow += 1;
                  if (doneNow % 6 === 0 || doneNow === pending.length) {
                    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
                    process.stderr.write(
                      `[P6-15b] ${doneNow}/${pending.length} done (last=${msg.id}, w${workerIdx}, ${elapsed}s)\n`,
                    );
                  }
                } else if (msg.type === 'finished') {
                  resolve();
                }
              });
              w.on('error', reject);
              w.on('exit', (code) => {
                if (code !== 0) reject(new Error(`Worker ${workerIdx} exited with code ${code}`));
              });
            }),
        ),
      );
    }

    const result = runAnalyze(prereg, allTasks, true);
    process.stdout.write(
      `P6-15b complete: progress=${result.progress}, strictConfirmed=${result.strictConfirmed}, primaryTV=${result.evaluation?.primary?.median}, beyondBandRate=${result.evaluation?.beyondBandRate}\n`,
    );
  }
}
