import {
  DEFAULT_RUN_CONFIG,
  createDemoConfig,
  mergeConfig,
  type DeepPartialConfig,
} from '../core/config/defaults.js';
import type { RunConfig } from '../core/config/types.js';
import type { OfflinePolicyId } from './types.js';

/**
 * 浏览器预设。科学口径见 docs/07：在 G6 通过前不存在“已校准”预设，
 * 所有预设都必须显式显示“未校准”。
 */
export interface WebPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly calibrated: false;
  readonly policy: OfflinePolicyId;
  readonly seed: string;
  readonly config: RunConfig;
  /** 与默认配置的差异路径，供 UI 高亮。 */
  readonly changedPaths: readonly string[];
}

function build(
  id: string,
  name: string,
  description: string,
  policy: OfflinePolicyId,
  patch: DeepPartialConfig,
  base: RunConfig = DEFAULT_RUN_CONFIG,
): WebPreset {
  const config = mergeConfig(base, patch);
  return {
    id,
    name,
    description,
    calibrated: false,
    policy,
    seed: `${id}-seed-001`,
    config,
    changedPaths: collectChangedPaths(DEFAULT_RUN_CONFIG, config),
  };
}

function collectChangedPaths(base: unknown, next: unknown, prefix = ''): string[] {
  if (base === next) return [];
  if (
    typeof base !== 'object' ||
    base === null ||
    typeof next !== 'object' ||
    next === null ||
    Array.isArray(base) ||
    Array.isArray(next)
  ) {
    if (Array.isArray(base) && Array.isArray(next)) {
      return JSON.stringify(base) === JSON.stringify(next) ? [] : [prefix || '$'];
    }
    return prefix === '' ? ['$'] : [prefix];
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    changed.push(
      ...collectChangedPaths(
        (base as Record<string, unknown>)[key],
        (next as Record<string, unknown>)[key],
        path,
      ),
    );
  }
  return changed;
}

const demo = createDemoConfig();

export const WEB_PRESETS: readonly WebPreset[] = Object.freeze([
  build(
    'demo',
    '演示 · 40 人 120 tick',
    '浏览器默认规模，适合检查交互与图表；不是结构实验。',
    'mock-weighted-v1',
    {},
    demo,
  ),
  build(
    'standard',
    '标准 · 200 人 730 tick',
    '单参数筛查常用规模；仍属未校准演示预设。',
    'mock-weighted-v1',
    {
      population: { initialPopulation: 200 },
      schedule: { totalTicks: 730 },
    },
  ),
  build(
    'structural',
    '结构实验 · 1000 人 3650 tick',
    '结构实验默认提示规模；浏览器运行会较慢，建议使用本地 runner。',
    'mock-weighted-v1',
    {
      population: { initialPopulation: 1000 },
      schedule: { totalTicks: 3650 },
    },
  ),
  build(
    'ablation-beta0',
    '消融 · 无网络机会 β=0',
    '机制消融对照，不是结构实验预设。',
    'mock-weighted-v1',
    { networkOpportunity: { beta: 0 } },
  ),
  build(
    'ablation-fixed-openness',
    '消融 · O 固定',
    '关闭开放度慢更新，用于对照。',
    'mock-weighted-v1',
    { openness: { updateMode: 'fixed' } },
  ),
  build('ablation-eta0', '消融 · 无阶级拥挤 η=0', '关闭 Congestion 反馈。', 'mock-weighted-v1', {
    dynamics: { congestionExponent: 0 },
  }),
  build(
    'ablation-kappa0',
    '消融 · 无财富分化反馈 κ=0',
    '关闭 Polarization 反馈。',
    'mock-weighted-v1',
    { dynamics: { polarizationExponent: 0 } },
  ),
  build('ablation-psi-flat', '消融 · ψ=1', '移除阶级持有成本乘子。', 'mock-weighted-v1', {
    need: { needMultiplier: [1, 1, 1, 1, 1] },
  }),
  build(
    'behavior-d2',
    'D2 · 行为异质性（未验证）',
    '开启风险/跨层特质与 mock-weighted-v2；P6-07 未产生可复现结构分离。',
    'mock-weighted-v2',
    {
      behavior: {
        riskTraitSigma: 0.3,
        crossClassTraitSigma: 0.3,
        riskCompeteSensitivity: 2,
        crossClassCompeteSensitivity: 2,
      },
    },
  ),
]);

export function findPreset(id: string): WebPreset | undefined {
  return WEB_PRESETS.find((preset) => preset.id === id);
}
