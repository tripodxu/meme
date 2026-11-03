import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../../../src/core/config/defaults.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { RULES_VERSION } from '../../../src/core/control/versions.js';
import { runSingle } from '../../../src/runner/run-cell.js';
import { encodeSimState } from '../../../src/core/model/serialize.js';

/**
 * G-D（W1 交接单 §4.1）：`referenceMode='own'` 与 rules-v5 **逐位一致**——硬门禁。
 *
 * 参照基准：`test/fixtures/engine/rules-v5-own-reference.json`，由
 * `scripts/generate-v5-own-reference.mjs` 在 rules-v5 构建下生成
 *（P1.5 baseline 配置，p15-seed-001..005，3650 tick，mock-weighted-v1）。
 *
 * 对照口径（changes/0008 §G-D 实现说明）：state schema v2 增补 society.refIncome、
 * config schema v3 增补 3 个 need 字段、paramsHash 随注册表增长——序列化信封
 * 不可跨版本逐位比较；因此逐字段比较**语义状态**：agents 全字段、society 除
 * refIncome 外全部字段（含 flowWindow）。refIncome 另行断言保持初始值。
 * 本文件跑 2 个种子；5 个种子全量对照在 `scripts/p15-gates.mjs --gate D`。
 */

interface V5ReferenceFixture {
  readonly rulesVersion: string;
  readonly engineVersion: string;
  readonly runs: readonly {
    readonly seed: string;
    readonly finalStateHash: string;
    readonly extinct: boolean;
    readonly endReason: string | null;
    readonly config: Record<string, unknown>;
    readonly society: Record<string, unknown>;
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/engine/rules-v5-own-reference.json', import.meta.url)),
    'utf8',
  ),
) as V5ReferenceFixture;

/**
 * 把 v5 config（schemaVersion v2 + rulesVersion v5）按迁移语义升到当前构建 own 模式：
 * schemaVersion v3、rulesVersion=当前版本（rules-v7）、need 补 referenceMode='own'/graceDays=0/
 * referenceSmoothing=0.2——与 validateRunConfig 的 v2→v3 迁移完全同口径。
 */
function toV6Own(rawConfig: Record<string, unknown>): ReturnType<typeof validateOrThrow> {
  const { schemaVersion: _schema, rulesVersion: _rules, ...rest } = rawConfig;
  void _schema;
  void _rules;
  const need = rest['need'] as Record<string, unknown>;
  return validateOrThrow(
    mergeConfig(DEFAULT_RUN_CONFIG, {
      ...(rest as DeepPartialConfig),
      schemaVersion: 'stratify-config-v3',
      rulesVersion: RULES_VERSION,
      need: { ...need, referenceMode: 'own', referenceSmoothing: 0.2, graceDays: 0 } as never,
    } as unknown as DeepPartialConfig),
  );
}

function validateOrThrow(config: ReturnType<typeof mergeConfig>) {
  const result = validateRunConfig(config);
  if (!result.ok) {
    throw new Error(`配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

describe('G-D：own 模式与 rules-v5 逐位一致（语义状态全字段）', () => {
  it('fixture 版本锚点正确，且基准配置的 need 核心字段与当前默认一致（防漂移）', () => {
    expect(fixture.rulesVersion).toBe('rules-v5');
    expect(fixture.engineVersion).toBe('engine-v0.3.0');
    const referenceNeed = (fixture.runs[0]?.config as Record<string, unknown>)['need'] as Record<
      string,
      unknown
    >;
    const defaultNeed = DEFAULT_RUN_CONFIG.need;
    expect(referenceNeed['threshold']).toBe(defaultNeed.threshold);
    expect(referenceNeed['belowNeedLimit']).toBe(defaultNeed.belowNeedLimit);
    expect(referenceNeed['bufferDays']).toBe(defaultNeed.bufferDays);
    expect(referenceNeed['needMultiplier']).toEqual(defaultNeed.needMultiplier);
    expect(referenceNeed['envExponent']).toBe(defaultNeed.envExponent);
  });

  for (const reference of fixture.runs.slice(0, 2)) {
    it(
      `seed=${reference.seed}：agents 与 society（除 refIncome）逐位一致`,
      { timeout: 120_000 },
      () => {
        const config = toV6Own(reference.config);
        const outcome = runSingle(config, asSeed(reference.seed), { policy: 'mock-weighted-v1' });
        const encoded = encodeSimState(outcome.finalState);

        // agents：全部字段逐位一致（Object.is 级别的浮点比较）
        expect(encoded.society.agents).toEqual(reference.society['agents']);

        // society：除 refIncome 外全部字段
        const actualSociety = { ...encoded.society } as Record<string, unknown>;
        delete actualSociety['refIncome'];
        expect(actualSociety).toEqual(reference.society);

        // refIncome：own 模式保持初始值 B×env0[c]
        expect(encoded.society.refIncome).toEqual(
          config.opportunity.env0.map((env) => config.opportunity.dailyBase * env),
        );

        // run 终态锚点：extinct/endReason 与 v5 一致（finalStateHash 属版本信封，不比）
        expect(outcome.report.extinct).toBe(reference.extinct);
        expect(outcome.report.endReason).toBe(reference.endReason);
      },
    );
  }
});
