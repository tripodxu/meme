#!/usr/bin/env node
/**
 * 冻结 rules-v5 own 模式参照状态（G-D 对照基准，一次性脚本）。
 *
 * 用当前构建（rules-v5）按 P1.5 baseline 预注册配置跑 5 个种子 × 3650 tick，
 * 把最终权威状态的**语义字段**（society 全部字段 + 内嵌 config + agents）写入
 * `test/fixtures/engine/rules-v5-own-reference.json`。rules-v6 落地后，
 * `--gate D`（scripts/p15-gates.mjs）用 `referenceMode='own'`（迁移语义）复跑
 * 同一 (config, seed)，逐字段逐位对照本 fixture，证明 own 模式未产生任何数值差异。
 *
 * 一次性：本脚本只在 rules-v5 构建下可运行（版本守卫）；重生成参照必须
 * checkout 对应 commit 重建 dist 后再执行。finalStateHash 记录 v5 口径的
 * 权威状态哈希，仅供审计参考——schema v2 增补 refIncome 后不可逐位比较
 *（changes/0008 §G-D 实现说明）。
 */
import { writeFileSync } from 'node:fs';

import { RULES_VERSION, ENGINE_VERSION } from '../dist/core/control/versions.js';
import { buildBaseConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { encodeSimState } from '../dist/core/model/serialize.js';
import { asSeed } from '../dist/core/control/ids.js';

if (RULES_VERSION !== 'rules-v5') {
  throw new Error(
    `本脚本必须在 rules-v5 构建下运行（当前 ${RULES_VERSION}）；` +
      '请 checkout 升级前 commit 并重建 dist。',
  );
}

const SEEDS = ['p15-seed-001', 'p15-seed-002', 'p15-seed-003', 'p15-seed-004', 'p15-seed-005'];
const config = buildBaseConfig(40, 3650);

const runs = [];
for (const seed of SEEDS) {
  const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
  const encoded = encodeSimState(outcome.finalState);
  runs.push({
    seed,
    finalStateHash: outcome.report.finalStateHash,
    extinct: outcome.report.extinct,
    endReason: outcome.report.endReason,
    // v5 序列化的语义内容：schemaVersion/configHash/paramsHash 属于版本信封，
    // rules-v6（state-v2 + config-v3 + 注册表增长）下不可比，不进入对照。
    config: encoded.config,
    society: encoded.society,
  });
  process.stderr.write(`[v5-ref] seed=${seed} hash=${outcome.report.finalStateHash}\n`);
}

const fixture = {
  description:
    'rules-v5 own 模式参照状态（G-D 硬门禁对照基准）；由 scripts/generate-v5-own-reference.mjs ' +
    '在 rules-v5 构建下生成，禁止就地改写。对照口径见 docs/changes/0008。',
  rulesVersion: RULES_VERSION,
  engineVersion: ENGINE_VERSION,
  configNote:
    'config 为 stratify-config-v2 原文；gate 侧按迁移语义补 need.referenceMode=own/graceDays=0/referenceSmoothing=0.2。',
  runs,
};
const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
writeFileSync('test/fixtures/engine/rules-v5-own-reference.json', serialized, 'utf8');
process.stderr.write(
  `[v5-ref] written test/fixtures/engine/rules-v5-own-reference.json (${serialized.length} bytes)\n`,
);
