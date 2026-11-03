/**
 * P1.5 只读诊断：判断 G1.5 失败的性质，用于下一轮预注册设计。
 *
 * 只读 `out/p15-full.json`，不写任何产物、不改 dist。所有随机性来自
 * mulberry32(seed)，重复运行结果一致（与核心的 `R(seed,tick,...)` 无关，
 * 本脚本不参与模拟）。
 *
 * 输出五段：
 *   1. 特征空间谱（PCA 解释方差）与可聚类性（Hopkins）
 *   2. 不同 k 的轮廓系数与半样本 ARI 分布
 *   3. 基线阶级占比轨迹（检查底层是否被抽空）
 *   4. 每个 cell 的结构位置是否沿一维梯度连续排列
 *   5. 同一参数下不同初始条件是否收敛到同一表型（双稳态初筛）
 *
 * 用法：node scripts/p15-diagnose.mjs [artifactPath]
 * 耗时：约 3–5 分钟（朴素 Ward，子样本 n≈450）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { featureVector } = require('../dist/runner/distance.js');
const {
  fitStandardizer,
  wardCluster,
  silhouetteScore,
  adjustedRandIndex,
  seededShuffle,
  euclidean,
} = require('../dist/runner/cluster.js');

const path = process.argv[2] ?? 'out/p15-full.json';
const art = JSON.parse(readFileSync(path, 'utf8'));

/** mulberry32：诊断用确定性 PRNG，不使用 Math.random（08 §3）。 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const points = [];
const meta = [];
for (const cell of art.cells) {
  for (const seedResult of cell.seeds) {
    for (const key of art.manifest.clustering.featureWindows) {
      const w = seedResult[key];
      if (w !== null && w !== undefined && w.available) {
        points.push(featureVector(w));
        meta.push({ cell: cell.cellKey, seed: seedResult.seed, window: key });
      }
    }
  }
}
const scaler = fitStandardizer(points);
const z = points.map((row) => scaler.standardize(row));
const dims = z[0].length;
console.log(`artifact=${path}`);
console.log(`points=${z.length} dims=${dims}`);

/** 对称协方差前若干特征值（幂迭代 + 收缩），返回解释方差比。 */
function pcaSpectrum(matrix) {
  const n = matrix.length;
  const d = matrix[0].length;
  const mean = new Array(d).fill(0);
  for (const row of matrix) for (let j = 0; j < d; j += 1) mean[j] += row[j] / n;
  const cov = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const row of matrix) {
    for (let a = 0; a < d; a += 1) {
      for (let b = 0; b < d; b += 1) {
        cov[a][b] += ((row[a] - mean[a]) * (row[b] - mean[b])) / (n - 1);
      }
    }
  }
  const m = cov.map((r) => [...r]);
  const eig = [];
  for (let t = 0; t < d; t += 1) {
    let v = new Array(d).fill(0).map((_, i) => (i === t % d ? 1 : 0.5 / (i + 1)));
    let lambda = 0;
    for (let iter = 0; iter < 200; iter += 1) {
      const w = new Array(d).fill(0);
      for (let a = 0; a < d; a += 1) for (let b = 0; b < d; b += 1) w[a] += m[a][b] * v[b];
      const norm = Math.hypot(...w);
      if (norm === 0) break;
      v = w.map((x) => x / norm);
      lambda = norm;
    }
    eig.push(lambda);
    for (let a = 0; a < d; a += 1) {
      for (let b = 0; b < d; b += 1) m[a][b] -= lambda * v[a] * v[b];
    }
  }
  const total = eig.reduce((s, x) => s + x, 0);
  return eig.map((x) => x / total);
}

console.log('\n[1] 特征空间谱与可聚类性');
const spectrum = pcaSpectrum(z);
console.log('  解释方差比:', spectrum.map((x) => x.toFixed(3)).join(' '));
console.log(
  `  PC1=${(spectrum[0] * 100).toFixed(1)}% PC1+2=${((spectrum[0] + spectrum[1]) * 100).toFixed(1)}%`,
);

{
  const m = 150;
  const min = new Array(dims).fill(Infinity);
  const max = new Array(dims).fill(-Infinity);
  for (const row of z) {
    for (let j = 0; j < dims; j += 1) {
      if (row[j] < min[j]) min[j] = row[j];
      if (row[j] > max[j]) max[j] = row[j];
    }
  }
  const rnd = prng(12345);
  const order = seededShuffle(z.length, 999);
  const u = [];
  const w = [];
  for (const index of order.slice(0, m)) {
    const p = z[index];
    let best = Infinity;
    for (const q of z) {
      if (q === p) continue;
      const dist = euclidean(p, q);
      if (dist > 0 && dist < best) best = dist;
    }
    u.push(best);
    const random = min.map((lo, j) => lo + rnd() * (max[j] - lo));
    let nearest = Infinity;
    for (const q of z) nearest = Math.min(nearest, euclidean(random, q));
    w.push(nearest);
  }
  const su = u.reduce((a, b) => a + b, 0);
  const sw = w.reduce((a, b) => a + b, 0);
  const h = sw / (su + sw);
  console.log(`  Hopkins H=${h.toFixed(3)}（0.5 随机无簇，→1 强聚类倾向）`);
}

console.log('\n[2] 轮廓与半样本 ARI（分层子样本，每 cell 前 8 种子 × 全部特征窗口）');
const byCell = new Map();
for (let i = 0; i < z.length; i += 1) {
  const arr = byCell.get(meta[i].cell) ?? [];
  if (arr.length < 16) arr.push(i);
  byCell.set(meta[i].cell, arr);
}
const sub = [...byCell.values()].flat().map((i) => z[i]);
console.log(`  子样本 n=${sub.length}`);
const started = Date.now();
for (const k of [2, 3, 4, 5]) {
  const assign = wardCluster(sub, k);
  const sil = silhouetteScore(sub, assign);
  const aris = [];
  for (let s = 0; s < 4; s += 1) {
    const order = seededShuffle(sub.length, 900 + s * 37);
    const half = Math.floor(sub.length / 2);
    const idxA = order.slice(0, half);
    const idxB = order.slice(half);
    const aA = wardCluster(
      idxA.map((i) => sub[i]),
      k,
    );
    const centroids = [];
    for (let c = 0; c < k; c += 1) {
      const members = idxA.filter((_, p) => aA[p] === c).map((i) => sub[i]);
      const c0 = new Array(dims).fill(0);
      for (const row of members) for (let j = 0; j < dims; j += 1) c0[j] += row[j] / members.length;
      centroids.push(c0);
    }
    const aB = wardCluster(
      idxB.map((i) => sub[i]),
      k,
    );
    const mapped = idxB.map((i) => {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const distance = euclidean(sub[i], centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      return best;
    });
    aris.push(adjustedRandIndex(aB, mapped));
  }
  const sorted = [...aris].sort((a, b) => a - b);
  console.log(
    `  k=${k} sil=${sil.toFixed(3)} ARI min/med/max = ${sorted[0].toFixed(3)}/${sorted[1].toFixed(3)}/${sorted[sorted.length - 1].toFixed(3)}  (${((Date.now() - started) / 1000).toFixed(0)}s)`,
  );
}

console.log('\n[3] 基线阶级占比轨迹（检查底层是否被抽空）');
{
  const base = art.cells.find((cell) => cell.cellKey === 'baseline');
  const windows = ['w1', 'w2b', 'w3'];
  for (const key of windows) {
    const rows = (base?.seeds ?? []).map((s) => s[key]).filter((w) => w !== null && w?.available);
    if (rows.length === 0) {
      console.log(`  ${key}: 无可用窗口`);
      continue;
    }
    const avg = (i) => rows.reduce((sum, w) => sum + w.classShares[i], 0) / rows.length;
    console.log(
      `  ${key.padEnd(4)} ${[0, 1, 2, 3, 4].map((i) => `P${i}=${avg(i).toFixed(3)}`).join(' ')}`,
    );
  }
  let maxP0 = 0;
  let where = '';
  for (const cell of art.cells) {
    for (const s of cell.seeds) {
      for (const key of windows) {
        const w = s[key];
        if (w !== null && w !== undefined && w.available && w.classShares[0] > maxP0) {
          maxP0 = w.classShares[0];
          where = `${cell.cellKey}/${s.seed}/${key}`;
        }
      }
    }
  }
  console.log(`  全网格 P0 最大值=${maxP0.toFixed(4)} @ ${where}`);
}

console.log('\n[4] cell 均值空间的 PC1 排序（看是否为连续梯度）');
{
  const cellMean = new Map();
  for (let i = 0; i < z.length; i += 1) {
    const entry = cellMean.get(meta[i].cell) ?? { sum: new Array(dims).fill(0), n: 0 };
    for (let j = 0; j < dims; j += 1) entry.sum[j] += z[i][j];
    entry.n += 1;
    cellMean.set(meta[i].cell, entry);
  }
  const cells = [...cellMean.entries()].map(([cell, v]) => ({
    cell,
    mean: v.sum.map((x) => x / v.n),
  }));
  const cm = cells.map((c) => c.mean);
  console.log(
    '  cell 空间解释方差:',
    pcaSpectrum(cm)
      .slice(0, 5)
      .map((x) => x.toFixed(2))
      .join(' '),
  );
  let v1 = new Array(dims).fill(0).map((_, i) => (i === 0 ? 1 : 0.3 / (i + 1)));
  const mean = new Array(dims).fill(0);
  for (const row of cm) for (let j = 0; j < dims; j += 1) mean[j] += row[j] / cm.length;
  for (let iter = 0; iter < 200; iter += 1) {
    const w = new Array(dims).fill(0);
    for (const row of cm) {
      const dot = row.reduce((s, x, j) => s + (x - mean[j]) * v1[j], 0);
      for (let j = 0; j < dims; j += 1) w[j] += dot * (row[j] - mean[j]);
    }
    const norm = Math.hypot(...w) || 1;
    v1 = w.map((x) => x / norm);
  }
  const projected = cells
    .map((c) => ({ cell: c.cell, p: c.mean.reduce((s, x, j) => s + x * v1[j], 0) }))
    .sort((a, b) => a.p - b.p);
  for (const entry of projected) console.log(`  ${entry.p.toFixed(2).padStart(6)}  ${entry.cell}`);
}

console.log('\n[5] 初始条件敏感性（同参数、不同 initialShares 的终态）');
{
  const keys = ['gini', 'openness', 'mUp', 'segregation'];
  for (const cell of art.cells) {
    if (!/initialShares|^baseline$/.test(cell.cellKey)) continue;
    const rows = cell.seeds.map((s) => s.w3).filter((w) => w !== null && w?.available);
    if (rows.length === 0) continue;
    const avg = (key) => rows.reduce((sum, w) => sum + w[key], 0) / rows.length;
    const p4 = rows.reduce((sum, w) => sum + w.classShares[4], 0) / rows.length;
    console.log(
      `  ${cell.cellKey.padEnd(32)} ${keys.map((key) => `${key}=${avg(key).toFixed(3)}`).join(' ')} P4=${p4.toFixed(3)}`,
    );
  }
}
