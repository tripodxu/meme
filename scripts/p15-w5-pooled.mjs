#!/usr/bin/env node
/**
 * W5 方法学复核：按 W4 协议把 w2b 与 w3 两个窗口一起聚类（pooled），
 * 与 W5 主脚本的 w3-only + 最近质心时序检查对照。
 *
 * 只读 out/p15-w5-classshare.json，不跑模拟。
 * 输出：out/p15-w5-classshare-pooled.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import {
  fitStandardizer,
  wardCluster,
  silhouetteScore,
  bisectStability,
  seededShuffle,
} from '../dist/runner/cluster.js';

const SOURCE = 'out/p15-w5-classshare.json';
const OUTPUT = 'out/p15-w5-classshare-pooled.json';
const w5 = JSON.parse(readFileSync(SOURCE, 'utf8'));

const points = [];
const meta = [];
for (const row of w5.rows) {
  const key = `${row.cellKey}|${row.seed}`;
  points.push(row.w2bShares);
  meta.push({ key, cell: row.cellKey, window: 'w2b' });
  points.push(row.w3Shares);
  meta.push({ key, cell: row.cellKey, window: 'w3' });
}

const scaler = fitStandardizer(points);
const z = points.map((row) => scaler.standardize(row));
const assignment = wardCluster(z, 3);
const silhouette = Math.round(silhouetteScore(z, assignment) * 1000) / 1000;
const aris = Array.from(
  { length: 20 },
  (_, offset) => bisectStability(z, 3, [seededShuffle(z.length, 20261103 + offset)], 0.7).ari,
);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const ariMedian = Math.round(mean(aris) * 1000) / 1000;
const ariMin = Math.round(Math.min(...aris) * 1000) / 1000;

const sizes = {};
const cells = {};
const runsByCluster = {};
for (let index = 0; index < points.length; index += 1) {
  const cluster = assignment[index];
  sizes[cluster] = (sizes[cluster] ?? 0) + 1;
  const cell = meta[index].cell;
  cells[cluster] = cells[cluster] ?? {};
  cells[cluster][cell] = (cells[cluster][cell] ?? 0) + 1;
  runsByCluster[cluster] = runsByCluster[cluster] ?? new Set();
  runsByCluster[cluster].add(meta[index].key);
}
const minRuns = Math.min(...Object.values(runsByCluster).map((set) => set.size));

const byRun = {};
for (let index = 0; index < points.length; index += 1) {
  const key = meta[index].key;
  byRun[key] = byRun[key] ?? {};
  byRun[key][meta[index].window] = assignment[index];
}
const temporalSame = Object.values(byRun).filter((entry) => entry.w2b === entry.w3).length;
const temporalRate = temporalSame / Object.keys(byRun).length;

const output = {
  schemaVersion: 'p15-w5-classshare-pooled-v1',
  exploratory: true,
  source: SOURCE,
  note: 'W5 方法学复核：W4 协议为 w2b+w3 pooled 聚类；本文件与 w3-only 主脚本对照，不改变 W5 的失败判定。',
  points: points.length,
  k: 3,
  silhouette,
  stability: { ariMedian, ariMin, shuffles: 20 },
  sizes,
  cells,
  minClusterRuns: minRuns,
  temporalConsistency: {
    matches: temporalSame,
    total: Object.keys(byRun).length,
    rate: temporalRate,
  },
  verdict:
    ariMin >= 0.7 && ariMedian >= 0.7 && temporalRate >= 0.8 && minRuns >= 5
      ? 'pooled 协议通过（仍非 P6-05/校准声明）'
      : 'pooled 协议未通过',
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output)}\n`);
