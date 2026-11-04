/**
 * 冻结的 W4（rules-v10）预注册 manifest。
 *
 * 来源：`out/p15-v10-full.json.manifest`，preregistrationHash
 * `sha256:ece0a98b70444f05769740e3c1b0838bc77d35fec434f897a6f0ef4730a36135`。
 * 该文件是历史证据的可复现载体：**不得**随当前 DEFAULT_RUN_CONFIG、版本常量或
 * 参数注册表变化而重算。新实验必须新增 manifest，而不是改写这里。
 */
import type { PreregManifest } from './preregistration.js';

export const LEGACY_W4_MANIFEST = {
  schemaVersion: 'experiment-v2',
  hypothesis:
    'rules-v10（占用锚定）两区域网格（A: share=1；B/C: share=0.5 + scarcityWeight 10/15/60/80/100）内存在 >=2 类可复现（20 次半样本 ARI median>=0.70，含 k=2 硬门槛）且非退化（非全死亡/空网络）的结构指纹聚类；k=2 的分裂预测为 A vs B∪C；方向预测 A 的 P0(w3)>=0.40、B/C 的 P0(w3)<=0.15 且 mUp(w3)<=0.40。k=3 仅作描述（探索显示 B/C 边界不可复现，本轮不据此声称三类）。',
  primaryMetric: 'TV(P)',
  experimentType: 'rule_sensitivity',
  rulesVersion: 'rules-v10',
  engineVersion: 'engine-v0.8.0',
  decisionSchemaVersion: 'stratify-decision-v1',
  policyVersion: 'mock-weighted-v1',
  promptVersion: 'prompt-none-v1',
  promptStyle: 'neutral',
  populationSize: 40,
  totalTicks: 3650,
  baseConfigHash: 'sha256:aeebc402a25319b183d1f563a5cc19528c1dc921ffc641b9c4555e4f614d701f',
  artifactProfile: 'full',
  seeds: [
    'p15r4-seed-001',
    'p15r4-seed-002',
    'p15r4-seed-003',
    'p15r4-seed-004',
    'p15r4-seed-005',
    'p15r4-seed-006',
    'p15r4-seed-007',
    'p15r4-seed-008',
    'p15r4-seed-009',
    'p15r4-seed-010',
    'p15r4-seed-011',
    'p15r4-seed-012',
    'p15r4-seed-013',
    'p15r4-seed-014',
    'p15r4-seed-015',
    'p15r4-seed-016',
    'p15r4-seed-017',
    'p15r4-seed-018',
    'p15r4-seed-019',
    'p15r4-seed-020',
    'p15r4-seed-021',
    'p15r4-seed-022',
    'p15r4-seed-023',
    'p15r4-seed-024',
    'p15r4-seed-025',
    'p15r4-seed-026',
    'p15r4-seed-027',
    'p15r4-seed-028',
    'p15r4-seed-029',
    'p15r4-seed-030',
  ],
  pairing: 'same-seed-derived-initial-population-and-addressed-random',
  warmupTicks: 1825,
  warmupDiagnostic:
    'attractor stability: same-run w2/w3 feature points fall in the same cluster (limit-cycle system)',
  windows: [
    {
      label: 'w2b',
      start: 1825,
      end: 2554,
    },
    {
      label: 'w3',
      start: 2555,
      end: 3284,
    },
  ],
  labelThresholdVersion: 'labels-v3',
  labelThresholdsHash: 'sha256:e9dd3407fa9aa889222a839f4a39437c92e2edaff1ebbf52066b0f58f9b12168',
  clustering: {
    distance: 'euclidean',
    algorithm: 'ward-lw-v1',
    standardization: 'z-score(pooled)',
    featureWindows: ['w2b', 'w3'],
    kRange: [2, 5],
    stabilityMinAri: 0.7,
    stabilityShuffles: 20,
    minClusterRuns: 5,
    temporalConsistencyMinRate: 0.8,
    d03Note:
      '聚类协议按 07 §8.1 冻结：Ward(Lance–Williams, ward-lw-v1) + Euclidean、z-score(pooled)、k∈[2,5]、稳定性 20 次取 median 且必报 min；更换实现＝新 experimentId。',
  },
  differenceThresholds: {
    gini: 0.03,
    tv: 0.1,
    mUp: 0.05,
    segregation: 0.05,
    openness: 0.05,
  },
  budgets: {
    maxRuns: 180,
    maxWallMinutes: 120,
    maxStorageBytes: 2000000000,
  },
  exclusionRules: {
    excludeExtinctRuns: true,
    excludeUnavailableWindows: true,
    excludeNetworkEmptyFromSegregation: true,
    maxTechnicalRetries: 1,
  },
  cells: [
    {
      cellKey: 'A-share1',
      design: 'baseline',
      hypothesis: '闭合位移体制（displacementShare=1）的底重金字塔（预测 P0(w3)>=0.40）',
      overrides: {},
      changedPaths: [],
      fullConfigHash: 'sha256:aeebc402a25319b183d1f563a5cc19528c1dc921ffc641b9c4555e4f614d701f',
    },
    {
      cellKey: 'B-share50-w10',
      design: 'interaction',
      hypothesis:
        '开放准入 + 弱占用锚定（share=0.5, scarcityWeight=10）的底轻/上位中产（预测 P0<=0.15、mUp<=0.40）',
      overrides: {
        ascent: {
          displacementShare: 0.5,
          scarcityWeight: 10,
        },
      },
      changedPaths: ['ascent.displacementShare', 'ascent.scarcityWeight'],
      fullConfigHash: 'sha256:02709b70badcb7dc68162bda7f6cc0fa228974a4804d458669214dec068fdbf3',
    },
    {
      cellKey: 'B-share50-w15',
      design: 'interaction',
      hypothesis:
        '开放准入 + 弱占用锚定（share=0.5, scarcityWeight=15）的底轻/上位中产（预测 P0<=0.15、mUp<=0.40）',
      overrides: {
        ascent: {
          displacementShare: 0.5,
          scarcityWeight: 15,
        },
      },
      changedPaths: ['ascent.displacementShare', 'ascent.scarcityWeight'],
      fullConfigHash: 'sha256:61898664d6907092b11fe73ca27be379996efef67c589133360025b9c3814166',
    },
    {
      cellKey: 'C-share50-w60',
      design: 'interaction',
      hypothesis:
        '开放准入 + 强占用锚定（share=0.5, scarcityWeight=60）的中产隆起/小底层（预测 P0<=0.15、mUp<=0.40）',
      overrides: {
        ascent: {
          displacementShare: 0.5,
          scarcityWeight: 60,
        },
      },
      changedPaths: ['ascent.displacementShare', 'ascent.scarcityWeight'],
      fullConfigHash: 'sha256:5f0dad7f7af30a4c74283a63e663cf652b2487fbfecd88cee5f8629e53a337d7',
    },
    {
      cellKey: 'C-share50-w80',
      design: 'interaction',
      hypothesis:
        '开放准入 + 强占用锚定（share=0.5, scarcityWeight=80）的中产隆起/小底层（预测 P0<=0.15、mUp<=0.40）',
      overrides: {
        ascent: {
          displacementShare: 0.5,
          scarcityWeight: 80,
        },
      },
      changedPaths: ['ascent.displacementShare', 'ascent.scarcityWeight'],
      fullConfigHash: 'sha256:be95c0844dcff1524acef753836da0f09708f9f63a50c3e4840f3698e036a495',
    },
    {
      cellKey: 'C-share50-w100',
      design: 'interaction',
      hypothesis:
        '开放准入 + 强占用锚定（share=0.5, scarcityWeight=100）的中产隆起/小底层（预测 P0<=0.15、mUp<=0.40）',
      overrides: {
        ascent: {
          displacementShare: 0.5,
          scarcityWeight: 100,
        },
      },
      changedPaths: ['ascent.displacementShare', 'ascent.scarcityWeight'],
      fullConfigHash: 'sha256:538ac2ea85a88b8caf00035dfa0ba990a8242340a7a5e39dd8226d85f9e9d377',
    },
  ],
} as const satisfies PreregManifest;
