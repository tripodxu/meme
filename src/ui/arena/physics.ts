export interface SeparationNode {
  x: number;
  y: number;
  readonly radius: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * 轻量 2D 碰撞分离：防止同一阶层泳道内节点堆叠重叠（纯函数，无副作用）。
 */
export function separateLaneNodes(nodes: readonly SeparationNode[], iterations = 4): void {
  const count = nodes.length;
  if (count <= 1) return;
  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < count; i += 1) {
      const a = nodes[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < count; j += 1) {
        const b = nodes[j];
        if (b === undefined) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDist = a.radius + b.radius + 2.5;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue;
        const dist = Math.sqrt(distSq) || 0.01;
        const overlap = (minDist - dist) * 0.45;
        const nx = distSq < 0.001 ? (i % 2 === 0 ? 1 : -1) * 0.4 : dx / dist;
        const ny = distSq < 0.001 ? (j % 2 === 0 ? 0.6 : -0.6) : dy / dist;
        a.x = clamp(a.x - nx * overlap * 0.4, a.minX, a.maxX);
        a.y = clamp(a.y - ny * overlap, a.minY, a.maxY);
        b.x = clamp(b.x + nx * overlap * 0.4, b.minX, b.maxX);
        b.y = clamp(b.y + ny * overlap, b.minY, b.maxY);
      }
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  if (max <= min) return (min + max) * 0.5;
  return Math.min(max, Math.max(min, v));
}
