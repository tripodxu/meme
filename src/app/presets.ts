import {
  DEFAULT_RUN_CONFIG,
  createDemoConfig,
  mergeConfig,
  type DeepPartialConfig,
} from '../core/config/defaults.js';
import type { RunConfig } from '../core/config/types.js';
import type { OfflinePolicyId } from './types.js';

/**
 * 浏览器预设。科学口径见 docs/07 与 docs/research/2026-11-24-p6-15-g6-d1-calibration-report.md：
 * - 修复 runSingle 策略回落（changes/0106）后，在真实 mock-weighted-v1 与 rules-v19 默认配置下：
 *   1) P6-15（p6-15-983b3698，N=40，660/660）聚类在旧条件 4（ADR 0006）与新条件 4（ADR 0010）
 *      双口径下均通过（k=2 [30,150]、ARI=1.000、sil=0.6602、TV(P)=0.7279；k=3 ARI=0.6115, sil=0.3163）；
 *   2) 微扰吸收在 N=40（P6-15）/ N=200（R4 Part A）/ N=1000（P6-13 Part A）均 100% 成立（TV=0, D≈1e-10）；
 *   3) 体制 II 阶级持有成本消融 ψ=1 经独立确认轮 P6-15b（p6-15b-ea8fbe20，N=600，官方 evaluateStageB）
 *      严格确认：w2b TV(P)=0.2425（CI [0.2358,0.2502]、p=0.00008）、100% 超 D95、五阶级 30/30 全同向。
 * - 因此仅两套冻结的两体制代表预设（regime1_pyramid、regime2_continuum，configHash/paramsHash 与 P6-15
 *   预注册逐位一致）标为 calibrated: true（严格限定于 D1 两体制目标、mock-weighted-v1、generationalMode='none'）；
 * - 其余全部预设（demo/standard/structural/五消融/behavior-d2/沙盒剧本）继续保持 calibrated: false。
 */
export interface WebPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly calibrated: boolean;
  readonly policy: OfflinePolicyId;
  readonly seed: string;
  readonly config: RunConfig;
  /** 与默认配置的差异路径，供 UI 高亮。 */
  readonly changedPaths: readonly string[];
}

/** 交互沙盒剧场的探索挑战剧本（同样严格标注未校准探索用途）。 */
export interface SandboxScenario {
  readonly id: string;
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly challengeGoal: string;
  readonly calibrated: false;
  readonly policy: OfflinePolicyId;
  readonly seed: string;
  readonly config: RunConfig;
  /** 推荐玩家化身的阶级偏好（如 0 表示优先附身底层个体）。 */
  readonly suggestedAvatarClass: number;
  readonly interactiveDefault: boolean;
}

function build(
  id: string,
  name: string,
  description: string,
  policy: OfflinePolicyId,
  patch: DeepPartialConfig,
  base: RunConfig = DEFAULT_RUN_CONFIG,
  calibrated = false,
): WebPreset {
  const config = mergeConfig(base, patch);
  return {
    id,
    name,
    description,
    calibrated,
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
    '结构实验默认提示规模；浏览器离线可流畅推进，正式批次建议使用本地 runner。',
    'mock-weighted-v1',
    {
      population: { initialPopulation: 1000 },
      schedule: { totalTicks: 3650 },
    },
  ),
  build(
    'regime1_pyramid',
    '已校准（D1）· 体制 I（位移守恒金字塔）',
    'P6-15 Cluster 0 代表（N=40, T=10950, k=2 ARI=1.000, sil=0.6602, 微扰 100% 吸收；仅限 D1 两体制 / mock-weighted-v1 / generationalMode=none）。',
    'mock-weighted-v1',
    {
      population: { initialPopulation: 40 },
      ascent: { displacementShare: 1.0, scarcityWeight: 0 },
      schedule: { totalTicks: 10950, statsStride: 1, snapshotStride: 10950 },
    },
    DEFAULT_RUN_CONFIG,
    true,
  ),
  build(
    'regime2_continuum',
    '已校准（D1）· 体制 II（非守恒封闭连续统代表）',
    'P6-15 Cluster 1 代表（N=40, T=10950, TV(P)=0.7279, 微扰 100% 吸收；P6-15b 确认 ψ=1 消融 TV(P)=0.2425 / 100% 超 D95；仅限 D1 两体制 / mock-weighted-v1）。',
    'mock-weighted-v1',
    {
      population: { initialPopulation: 40 },
      ascent: { displacementShare: 0.5, scarcityWeight: 15 },
      schedule: { totalTicks: 10950, statsStride: 1, snapshotStride: 10950 },
    },
    DEFAULT_RUN_CONFIG,
    true,
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

export const SANDBOX_SCENARIOS: readonly SandboxScenario[] = Object.freeze([
  {
    id: 'ascend-odyssey',
    badge: '主角逆袭挑战',
    title: '寒门跃迁：跨越阶层壁垒',
    subtitle: '60 人 · 360 tick · 化身底层个体亲手抉择积累、竞争与升阶时机',
    challengeGoal:
      '探索目标：在不触发连续低于需求线被动跌落的前提下，化身 Class 0 个体升至 Class 2 以上。',
    calibrated: false,
    policy: 'mock-weighted-v2',
    seed: 'odyssey-seed-001',
    config: mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 60 },
      schedule: { totalTicks: 360, statsStride: 1, snapshotStride: 60 },
      decision: { interval: 10 },
      behavior: {
        riskTraitSigma: 0.25,
        crossClassTraitSigma: 0.25,
        riskCompeteSensitivity: 1.5,
        crossClassCompeteSensitivity: 1.5,
      },
    }),
    suggestedAvatarClass: 0,
    interactiveDefault: true,
  },
  {
    id: 'fortress-tide',
    badge: '生态演化剧场',
    title: '围城与潮汐：高门槛占用博弈',
    subtitle: '80 人 · 730 tick · 开启稀缺占用壁垒与位移准入，观察阶层拉锯',
    challengeGoal:
      '探索目标：观察高门槛下上层在位者守擂与跨层社交网络随开放度 O 的动态收缩与重连。',
    calibrated: false,
    policy: 'mock-weighted-v2',
    seed: 'fortress-seed-002',
    config: mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 80 },
      schedule: { totalTicks: 730, statsStride: 5, snapshotStride: 100 },
      decision: { interval: 10 },
      ascent: { displacementShare: 1, scarcityWeight: 2, occupancyMemoryDays: 60 },
      need: { threshold: 0.75 },
    }),
    suggestedAvatarClass: 1,
    interactiveDefault: false,
  },
  {
    id: 'maverick-arena',
    badge: 'D2 异质性竞技',
    title: '冒险家与守成者：特质分化场',
    subtitle: '64 人 · 540 tick · 强风险偏好与跨层博弈，高频财富转移与阶层洗牌',
    challengeGoal:
      '探索目标：追踪高 riskTolerance 个体的竞争轨迹，对比稳健积累派的长期存活与阶层留存。',
    calibrated: false,
    policy: 'mock-weighted-v2',
    seed: 'maverick-seed-003',
    config: mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 64 },
      schedule: { totalTicks: 540, statsStride: 2, snapshotStride: 90 },
      decision: { interval: 10 },
      behavior: {
        riskTraitSigma: 0.4,
        crossClassTraitSigma: 0.4,
        riskCompeteSensitivity: 2.8,
        crossClassCompeteSensitivity: 2.4,
      },
    }),
    suggestedAvatarClass: 1,
    interactiveDefault: true,
  },
  {
    id: 'butterfly-fork',
    badge: '平行宇宙实验',
    title: '蝴蝶效应：单变量微扰分叉台',
    subtitle: '48 人 · 400 tick · 推进至中期后一键克隆平行宇宙，追踪轨迹偏离',
    challengeGoal:
      '探索目标：运行至 Tick 100 后暂停，对焦点个体注入 ΔValue=+0.0001 微扰分叉，在对比页观察两条宇宙线差异。',
    calibrated: false,
    policy: 'mock-weighted-v1',
    seed: 'butterfly-seed-004',
    config: mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 48 },
      schedule: { totalTicks: 400, statsStride: 1, snapshotStride: 50 },
      decision: { interval: 10 },
    }),
    suggestedAvatarClass: 0,
    interactiveDefault: false,
  },
]);

export function findPreset(id: string): WebPreset | undefined {
  return WEB_PRESETS.find((preset) => preset.id === id);
}

export function findScenario(id: string): SandboxScenario | undefined {
  return SANDBOX_SCENARIOS.find((scenario) => scenario.id === id);
}
