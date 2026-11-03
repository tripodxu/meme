import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../../../src/core/config/defaults.js';
import type { RunConfig } from '../../../src/core/config/types.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import {
  checkCongestionSigns,
  equilibriumE,
  oTargetGradients,
  topClassMargin,
} from '../../../src/runner/mean-field.js';

const CLASSES = 5;
/** F(hard=1)=1（effortFunction(shape,1) 恒为 1），使生产力探针只反映 ge。 */
const HARD = 1;
const GE_PROBE = [0.5, 1, 1, 1, 1, 2, 3];

function config(overrides: DeepPartialConfig = {}): RunConfig {
  const result = validateRunConfig(mergeConfig(DEFAULT_RUN_CONFIG, overrides));
  if (!result.ok) {
    throw new Error(`测试配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

const ENV0 = () => config().opportunity.env0;
const SHARES = () => config().population.classShares;
const GREF = () => config().dynamics.giniReference;
const PSI_TOP = () => config().need.needMultiplier[CLASSES - 1] ?? Number.NaN;

describe('equilibriumE：E–P 不动点', () => {
  it('稳态占比等于初始占比且 G=Gref 时，E 退化为 env0（拥挤=1、极化=1）', () => {
    const e = equilibriumE(config(), SHARES(), GREF());
    expect(e).toHaveLength(CLASSES);
    const env0 = ENV0();
    e.forEach((value, c) => {
      expect(value).toBeCloseTo(env0[c] ?? Number.NaN, 10);
    });
  });

  it('占比高于初始值 ⇒ 拥挤乘子 <1 ⇒ E 低于 env0（负反馈符号为负）', () => {
    const crowded = SHARES().map((share) => share * 2);
    const e = equilibriumE(config(), crowded, GREF());
    const env0 = ENV0();
    for (let c = 0; c < CLASSES; c += 1) {
      expect(e[c]!).toBeLessThan(env0[c] ?? Number.NaN);
    }
  });

  it('G 高于参考值 ⇒ 极化乘子按 z[c] 变号：高层抬升、底层下降（research p15-mean-field §2）', () => {
    const cfg = config();
    const base = equilibriumE(cfg, SHARES(), GREF());
    const polarized = equilibriumE(cfg, SHARES(), GREF() + 0.1);
    // ∂Polarization/∂G 同号于 z[c]：不是"两端同时抬升"，而是高层相对获益。
    expect(polarized[CLASSES - 1]!).toBeGreaterThan(base[CLASSES - 1]!);
    expect(polarized[0]!).toBeLessThan(base[0]!);
  });

  it('极端输入下仍有界且为正', () => {
    const extreme = equilibriumE(
      config(),
      SHARES().map(() => 1),
      999,
    );
    for (const value of extreme) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe('checkCongestionSigns：符号检验的可适用性', () => {
  it('占比上升 ⇒ congestion<1 且符号匹配', () => {
    const cfg = config();
    const checks = checkCongestionSigns(
      cfg,
      SHARES().map((share) => share * 1.5),
    );
    for (const check of checks) {
      expect(check.applicable).toBe(true);
      expect(check.congestion).toBeLessThan(1);
      expect(check.signMatches).toBe(true);
    }
  });

  it('占比小幅下降 ⇒ congestion>1 且符号匹配（不被地板/截断吸收的阶级）', () => {
    const cfg = config();
    const checks = checkCongestionSigns(
      cfg,
      SHARES().map((share) => share * 0.9),
    );
    const evaluated = checks.filter((check) => check.applicable);
    // 前四个阶级在 0.9 倍下既不触地板也不触 congestionMax；第五个跌破 floor 被排除。
    expect(evaluated).toHaveLength(CLASSES - 1);
    expect(checks[CLASSES - 1]!.floorBound).toBe(true);
    for (const check of evaluated) {
      expect(check.congestion).toBeGreaterThan(1);
      expect(check.signMatches).toBe(true);
    }
  });

  it('回归：跌破空阶级地板的格点被排除，不再制造伪不匹配', () => {
    // classShares[4]=0.02 恰等于 emptyClassPopulationFloor，减半后 P<floor，
    // Congestion 被 max(P,floor) 钉在 1；旧实现仍判 applicable 并记 signMatches=false。
    const cfg = config();
    const checks = checkCongestionSigns(
      cfg,
      SHARES().map((share) => share * 0.5),
    );
    const small = checks[CLASSES - 1]!;
    expect(small.floorBound).toBe(true);
    expect(small.congestion).toBe(1);
    expect(small.applicable).toBe(false);
    expect(small.signMatches).toBe(true);
  });

  it('被 congestionMax 截断的格点标记 clampBound', () => {
    const cfg = config();
    const checks = checkCongestionSigns(cfg, [0.05, 0.05, 0.05, 0.05, 0.05]);
    const clamped = checks.filter((check) => check.clampBound);
    expect(clamped.length).toBeGreaterThan(0);
    for (const check of clamped) {
      expect(check.applicable).toBe(false);
    }
  });

  it('占比不变时不参与检验', () => {
    const cfg = config();
    expect(checkCongestionSigns(cfg, SHARES()).every((check) => !check.applicable)).toBe(true);
  });

  it('观测占比缺失时按 0 处理而不是抛错', () => {
    const checks = checkCongestionSigns(config(), []);
    expect(checks).toHaveLength(CLASSES);
    expect(checks.every((check) => check.p === 0)).toBe(true);
  });

  it('初始占比为 0 的阶级不参与检验', () => {
    const cfg = config({ population: { classShares: [0.5, 0.3, 0.15, 0.05, 0] } });
    const checks = checkCongestionSigns(cfg, [0.4, 0.3, 0.2, 0.05, 0.05]);
    expect(checks[CLASSES - 1]!.applicable).toBe(false);
    expect(checks[0]!.applicable).toBe(true);
  });
});

describe('topClassMargin：顶层可持续性裕度', () => {
  it('envExponent=0 时不乘环境项', () => {
    const margin = topClassMargin(config({ need: { envExponent: 0 } }), GE_PROBE, HARD);
    // median(ge×F(1)) = 1
    expect(margin).toBeCloseTo(1 / PSI_TOP(), 10);
  });

  it('envExponent=1 时按 (E_top/E_0) 缩放', () => {
    const noEnv = topClassMargin(config({ need: { envExponent: 0 } }), GE_PROBE, HARD);
    const withEnv = topClassMargin(
      config({ need: { envExponent: 1 } }),
      GE_PROBE,
      HARD,
      [1, 1.2, 1.6, 2.2, 5],
    );
    expect(withEnv).toBeCloseTo(noEnv / 5, 10);
  });

  it('回归：envExponent≠0 且未提供 E 时抛错，不再静默退回 v3 语义', () => {
    // changes/0004：调用方漏传 eByClass 使 margin 高估约 4.5 倍，函数当时不报错。
    const cfg = config({ need: { envExponent: 1 } });
    expect(() => topClassMargin(cfg, GE_PROBE, HARD)).toThrow(/E\[c\]/);
  });

  it('底层 E 非正或阶级缺失时抛错', () => {
    const cfg = config({ need: { envExponent: 1 } });
    expect(() => topClassMargin(cfg, GE_PROBE, HARD, [0, 1, 1, 1, 2])).toThrow(/E\[0\]/);
    expect(() => topClassMargin(cfg, GE_PROBE, HARD, [1, 1])).toThrow(/E 缺少阶级/);
  });

  it('默认参数下 margin<1：中位个体在顶层入不敷出（旋转门预测）', () => {
    expect(topClassMargin(config(), GE_PROBE, HARD, [1, 1.2, 1.6, 2.2, 3])).toBeLessThan(
      topClassMargin(config({ need: { envExponent: 0 } }), GE_PROBE, HARD),
    );
  });
});

describe('oTargetGradients：O 环路符号', () => {
  it('∂O/∂Mup>0、∂O/∂G<0、∂O/∂S<0', () => {
    const gradients = oTargetGradients(config(), 0.5);
    expect(gradients.dO_dMup).toBeGreaterThan(0);
    expect(gradients.dO_dG).toBeLessThan(0);
    expect(gradients.dO_dS).toBeLessThan(0);
  });

  it('在 O 饱和端点斜率为 0', () => {
    for (const oTarget of [0, 1]) {
      const gradients = oTargetGradients(config(), oTarget);
      expect(gradients.dO_dMup).toBeCloseTo(0, 12);
      expect(gradients.dO_dG).toBeCloseTo(0, 12);
      expect(gradients.dO_dS).toBeCloseTo(0, 12);
    }
  });

  it('斜率量级与权重成正比', () => {
    const cfg = config();
    const base = oTargetGradients(cfg, 0.5);
    const doubled = oTargetGradients(
      config({ openness: { mobilityWeight: cfg.openness.mobilityWeight * 2 } }),
      0.5,
    );
    expect(doubled.dO_dMup).toBeCloseTo(base.dO_dMup * 2, 10);
  });
});
