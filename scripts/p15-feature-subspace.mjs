#!/usr/bin/env node
/**
 * W4 特征子空间分析（只读，不跑模拟）。
 *
 * 背景：W4 的预注册特征向量（class shares + gini/top/mUp/mDown/S/O）在 k=2 得到
 * A vs B∪C；但 B 与 C 的差异主要在阶级占比。本脚本对同一份 W4 产物比较不同
 * 特征子空间的 k=2…5 结构与稳定性，用于判断“第三类”是否被特征选择掩盖。
 *
 * 输出：out/p15-w4-feature-subspace.json（探索层；不构成 G1.5/P6-05 判定）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { featureVector } from '../dist/runner/distance.js';
import {
  fitStandardizer,
  wardCluster,
  silhouetteScore,
  bisectStability,
  seededShuffle,
} from '../dist/runner/cluster.js';

const SOURCE = 'out/p15-v10-full.json';
const OUTPUT = 'out/p15-w4-feature-subspace.json';
const artifact = JSON.parse(readFileSync(SOURCE, 'utf8'));

const points = [];
for (const cell of artifact.cells) {
  for (const seed of cell.seeds) {
    if (!seed.w2b?.available || !seed.w3?.available) continue;
    points.push({ cell: cell.cellKey, seed: seed.seed, w2b: seed.w2b, w3: seed.w3 });
  }
}

const FEATURE_SETS = {
  class: (point) => [...point.w3.classShares],
  network: (point) => [
    point.w3.segregation,
    point.w3.openness,
    point.w3.crossClassEdgeShare,
    point.w3.edgeCountAverage / 100,
    point.w3.mUp,
    point.w3.mDown,
  ],
  classNet: (point) => [
    ...point.w3.classShares,
    point.w3.segregation,
    point.w3.openness,
    point.w3.crossClassEdgeShare,
  ],
  full: (point) => featureVector(point.w3),
  traj: (point) => [
    ...point.w3.classShares.map((value, index) => value - (point.w2b.classShares[index] ?? 0)),
    point.w3.segregation - point.w2b.segregation,
    point.w3.openness - point.w2b.openness,
  ],
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const results = {};
for (const [name, project] of Object.entries(FEATURE_SETS)) {
  const raw = points.map(project);
  const scaler = fitStandardizer(raw);
  const z = raw.map((row) => scaler.standardize(row));
  const runs = [];
  for (let k = 2; k <= 5; k += 1) {
    const assignment = wardCluster(z, k);
    const sizes = {};
    const composition = {};
    assignment.forEach((cluster, index) => {
      sizes[cluster] = (sizes[cluster] ?? 0) + 1;
      const cell = points[index].cell;
      composition[cluster] = composition[cluster] ?? {};
      composition[cluster][cell] = (composition[cluster][cell] ?? 0) + 1;
    });
    const aris = Array.from(
      { length: 20 },
      (_, offset) => bisectStability(z, k, [seededShuffle(z.length, 20261103 + offset)], 0.7).ari,
    );
    runs.push({
      k,
      silhouette: Math.round(silhouetteScore(z, assignment) * 1000) / 1000,
      ariMedian: Math.round(mean(aris) * 1000) / 1000,
      ariMin: Math.round(Math.min(...aris) * 1000) / 1000,
      sizes,
      composition,
    });
  }
  results[name] = runs;
}

mkdirSync('out', { recursive: true });
const output = {
  schemaVersion: 'p15-w4-feature-subspace-v1',
  exploratory: true,
  source: SOURCE,
  note: '探索层（07 §6.1）：只读特征子空间分析；不构成 G1.5/P6-05 判定，更换特征集即新 experimentId。',
  points: points.length,
  featureSets: results,
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
