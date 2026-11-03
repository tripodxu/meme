#!/usr/bin/env node
/**
 * W1 机制门禁 G-A/G-B/G-C/G-D（`2026-11-03-p15-w0-w1-handoff.md` §4.1）。
 *
 * 用法：
 *   node scripts/p15-gates.mjs --gate A   # baseline 3650 tick × 30 种子；同时产出 G-C
 *   node scripts/p15-gates.mjs --gate B   # 5 参数 × 3 档 × 30 种子（约 11 个不同配置）
 *   node scripts/p15-gates.mjs --gate C   # 独立重跑 baseline 并判 G-C
 *   node scripts/p15-gates.mjs --gate D   # own 模式 vs rules-v5 参照 fixture 逐位对照
 *
 * 输出：out/p15-gates.json（按 gate 分节合并写入；机器可读）。
 *
 * 种子集：GATE_SEEDS（p15-seed-001..030，探索层冻结列表）——确认轮种子
 *（D-07：p15r3-seed-001..030）保留给 W2 预注册，不在此复用。
 * 判据全部来自 src/runner/gates.ts 的 GATE_CRITERIA；本脚本只做 I/O，
 * 不含任何判定字面量。
 *
 * 红线（handoff §6）：不许跳过 G-A/G-B 直接做正式判定；参数只许在 G-B 扫，
 * 不许回填默认值；CI 不绿不得标记完成。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { buildBaseConfig, PREREG_SEEDS } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { validateRunConfig } from '../dist/core/config/validate.js';
import { RULES_VERSION, ENGINE_VERSION } from '../dist/core/control/versions.js';
import { encodeSimState } from '../dist/core/model/serialize.js';
import {
  compareSemanticState,
  evaluateGateA,
  evaluateGateB,
  evaluateGateC,
  evaluateGateD,
  GATE_SEEDS,
} from '../dist/runner/gates.js';

const args = process.argv.slice(2);
const gate = args.includes('--gate') ? args[args.indexOf('--gate') + 1] : null;
if (!['A', 'B', 'C', 'D'].includes(gate)) {
  process.stderr.write('用法: node scripts/p15-gates.mjs --gate A|B|C|D\n');
  process.exit(1);
}

function log(message) {
  process.stderr.write(`[gates] ${message}\n`);
}

if (RULES_VERSION !== 'rules-v7') {
  throw new Error(`门禁按 rules-v7 冻结判据编写；当前构建 ${RULES_VERSION}`);
}

// 种子一致性：GATE_SEEDS 必须与冻结的 p15-seed 列表前 30 项一致（防两处漂移）。
for (let i = 0; i < GATE_SEEDS.length; i += 1) {
  if (GATE_SEEDS[i] !== PREREG_SEEDS[i]) {
    throw new Error(
      `GATE_SEEDS[${i}] 与 PREREG_SEEDS 不一致: ${GATE_SEEDS[i]} vs ${PREREG_SEEDS[i]}`,
    );
  }
}

const POPULATION = 40;
const TICKS = 3650;

function validateOrThrow(config, label) {
  const result = validateRunConfig(config);
  if (!result.ok) {
    throw new Error(`${label} 配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/** 运行一批 (config × GATE_SEEDS)，返回门禁输入与逐 seed 摘要。 */
function runBatch(config, label) {
  const runs = [];
  for (const seed of GATE_SEEDS) {
    const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
    const w2b = outcome.report.windows.find((window) => window.label === 'w2b');
    const w3 = outcome.report.windows.find((window) => window.label === 'w3');
    if (w2b === undefined || w3 === undefined) {
      throw new Error(`${label} seed=${seed} 缺少预注册窗口（w2b/w3）`);
    }
    runs.push({ seed, w2b, w3, report: outcome.report });
    log(
      `${label} seed=${seed} aliveAtEnd=${outcome.report.aliveAtEnd} extinct=${outcome.report.extinct}`,
    );
  }
  return runs;
}

function classSharesMean(runs, label) {
  const available = runs.filter((run) => run.w3.missingTicks === 0);
  if (available.length === 0) {
    throw new Error(`${label} 无可用 w3 窗口`);
  }
  const classCount = available[0].w3.classShares.length;
  return Array.from(
    { length: classCount },
    (_, c) =>
      available.reduce((sum, run) => sum + (run.w3.classShares[c] ?? 0), 0) / available.length,
  );
}

/** baseline 配置（rules-v6 class 参照系默认值）。 */
function baselineConfig() {
  return validateOrThrow(buildBaseConfig(POPULATION, TICKS), 'baseline');
}

function mergeOverride(base, path, value) {
  // path 形如 'need.bufferDays'（两层）；need.needMultiplier 为数组整体替换。
  const [section, leaf] = path.split('.');
  return validateOrThrow(mergeConfig(base, { [section]: { [leaf]: value } }), `override ${path}`);
}

/** G-B 网格：5 参数 × 3 档（handoff §4.1 建议档位；中间档=baseline）。 */
function gateBGrid() {
  const base = baselineConfig();
  const multiplierScale = (multiplier, scale) => {
    // ψ[0]=1 是注册表结构约束（firstElement=1）；缩放 ψ[1..] 并钳制到 [1,6]，
    // 保持非递减（changes/0008 记录；不得把缩放回填进默认值——handoff §6 红线 4）。
    return [1, ...multiplier.slice(1).map((value) => Math.min(6, Math.max(1, value * scale)))];
  };
  const grid = [];
  const push = (parameter, cellKey, value) => {
    grid.push({ parameter, cellKey, config: mergeOverride(base, parameter, value) });
  };
  // need.bufferDays ∈ {10,30,60}
  push('need.bufferDays', 'need.bufferDays=10', 10);
  push('need.bufferDays', 'baseline(bufferDays=30)', base.need.bufferDays);
  push('need.bufferDays', 'need.bufferDays=60', 60);
  // need.threshold ∈ {0.3,0.5,0.8}
  push('need.threshold', 'need.threshold=0.3', 0.3);
  push('need.threshold', 'baseline(threshold=0.5)', base.need.threshold);
  push('need.threshold', 'need.threshold=0.8', 0.8);
  // need.graceDays ∈ {0,15,30}
  push('need.graceDays', 'need.graceDays=0', 0);
  push('need.graceDays', 'baseline(graceDays=30)', base.need.graceDays);
  push('need.graceDays', 'need.graceDays=15', 15);
  // need.referenceSmoothing ∈ {0.05,0.2,0.6}
  push('need.referenceSmoothing', 'need.referenceSmoothing=0.05', 0.05);
  push('need.referenceSmoothing', 'baseline(referenceSmoothing=0.2)', base.need.referenceSmoothing);
  push('need.referenceSmoothing', 'need.referenceSmoothing=0.6', 0.6);
  // needMultiplier 整体缩放 ×{0.7,1.0,1.4}
  push('need.needMultiplier', 'needMultiplier×0.7', multiplierScale(base.need.needMultiplier, 0.7));
  push('need.needMultiplier', 'baseline(needMultiplier×1.0)', [...base.need.needMultiplier]);
  push('need.needMultiplier', 'needMultiplier×1.4', multiplierScale(base.need.needMultiplier, 1.4));
  return grid;
}

function runGateA() {
  const config = baselineConfig();
  const runs = runBatch(config, 'baseline');
  const gateA = evaluateGateA(runs);
  const gateC = evaluateGateC(runs);
  return { gateA, gateC, runs };
}

function runGateB() {
  const grid = gateBGrid();
  const levels = [];
  for (const cell of grid) {
    const runs = runBatch(cell.config, cell.cellKey);
    levels.push({
      cellKey: cell.cellKey,
      parameter: cell.parameter,
      levelIndex: levels.filter((level) => level.parameter === cell.parameter).length,
      classSharesMean: classSharesMean(runs, cell.cellKey),
    });
    log(`${cell.cellKey} P 均值=${JSON.stringify(levels[levels.length - 1].classSharesMean)}`);
  }
  const gateB = evaluateGateB(levels);
  return { gateB, levels };
}

/**
 * G-D：own 模式 vs rules-v5 参照（test/fixtures/engine/rules-v5-own-reference.json）。
 * 配置按迁移语义升版（schemaVersion v3 / rulesVersion v6 / need 补 own/0.2/0），
 * 与 validateRunConfig 的 v2→v3 迁移同口径；逐字段比较语义状态。
 */
function runGateD() {
  const fixturePath = 'test/fixtures/engine/rules-v5-own-reference.json';
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (fixture.rulesVersion !== 'rules-v5') {
    throw new Error(`参照 fixture 必须是 rules-v5 产物，实际 ${fixture.rulesVersion}`);
  }
  const comparisons = [];
  let roundTrip = true;
  for (const reference of fixture.runs) {
    const { schemaVersion, rulesVersion, ...rest } = reference.config;
    void schemaVersion;
    void rulesVersion;
    const config = validateOrThrow(
      mergeConfig(DEFAULT_RUN_CONFIG, {
        ...rest,
        schemaVersion: 'stratify-config-v3',
        rulesVersion: RULES_VERSION,
        need: {
          ...reference.config.need,
          referenceMode: 'own',
          referenceSmoothing: 0.2,
          graceDays: 0,
        },
      }),
      `G-D ${reference.seed}`,
    );
    const outcome = runSingle(config, asSeed(reference.seed), { policy: 'mock-weighted-v1' });
    const encoded = encodeSimState(outcome.finalState);
    const comparison = compareSemanticState(encoded.society, reference.society);
    // refIncome 保持初始值（own 模式不读取也不更新）
    const expectedRefIncome = config.opportunity.env0.map(
      (env) => config.opportunity.dailyBase * env,
    );
    const refIncomeHeldInitial =
      JSON.stringify(encoded.society.refIncome) === JSON.stringify(expectedRefIncome);
    comparisons.push({
      seed: reference.seed,
      equal: comparison.equal,
      firstDifference: comparison.firstDifference,
      refIncomeHeldInitial,
    });
    log(
      `seed=${reference.seed} equal=${comparison.equal} ` +
        `${comparison.firstDifference ?? ''} refIncomeHeld=${refIncomeHeldInitial}`,
    );
  }
  // 'class' 模式可序列化往返（handoff §4.1 G-D 第二判据）
  {
    const config = baselineConfig();
    const outcome = runSingle(config, asSeed(GATE_SEEDS[0]), { policy: 'mock-weighted-v1' });
    const encoded = encodeSimState(outcome.finalState);
    roundTrip = JSON.stringify(JSON.parse(JSON.stringify(encoded))) === JSON.stringify(encoded);
    log(`class 模式序列化往返=${roundTrip}`);
  }
  return evaluateGateD(comparisons, roundTrip);
}

function writeGates(section) {
  mkdirSync('out', { recursive: true });
  const path = 'out/p15-gates.json';
  let existing = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const merged = {
    schemaVersion: 'p15-gates-v1',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    ...(typeof existing === 'object' && existing !== null ? existing : {}),
    gates: { ...(existing.gates ?? {}), ...section },
  };
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;
  writeFileSync(path, serialized, 'utf8');
  log(`written ${path} (${serialized.length} bytes)`);
}

log(`rulesVersion=${RULES_VERSION} engineVersion=${ENGINE_VERSION} gate=${gate}`);
if (gate === 'A') {
  const { gateA, gateC } = runGateA();
  writeGates({ A: gateA, C: gateC });
  log(`G-A: ${gateA.detail} passed=${gateA.passed}`);
  log(`G-C: ${gateC.detail} passed=${gateC.passed}`);
  if (!gateA.passed) process.exitCode = 2;
} else if (gate === 'B') {
  const { gateB, levels } = runGateB();
  writeGates({ B: gateB, B_levels: levels });
  log(`G-B: ${gateB.detail} passed=${gateB.passed}`);
  if (!gateB.passed) process.exitCode = 2;
} else if (gate === 'C') {
  const config = baselineConfig();
  const runs = runBatch(config, 'baseline');
  const gateC = evaluateGateC(runs);
  writeGates({ C: gateC });
  log(`G-C: ${gateC.detail} passed=${gateC.passed}`);
  if (!gateC.passed) process.exitCode = 2;
} else {
  const gateD = runGateD();
  writeGates({ D: gateD });
  log(`G-D: ${gateD.detail} passed=${gateD.passed}`);
  if (!gateD.passed) process.exitCode = 2;
}
