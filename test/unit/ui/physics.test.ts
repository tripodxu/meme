import { describe, expect, it } from 'vitest';

import { separateLaneNodes } from '../../../src/ui/arena/physics.js';

describe('separateLaneNodes 节点碰撞分离（P2）', () => {
  it('将完全重合的同层节点推开至安全距离并保持在泳道边界内', () => {
    const nodes = [
      { x: 100, y: 50, radius: 6, minX: 40, maxX: 300, minY: 20, maxY: 90 },
      { x: 100, y: 50, radius: 6, minX: 40, maxX: 300, minY: 20, maxY: 90 },
      { x: 100, y: 50, radius: 6, minX: 40, maxX: 300, minY: 20, maxY: 90 },
    ];
    separateLaneNodes(nodes, 6);
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(40);
      expect(n.x).toBeLessThanOrEqual(300);
      expect(n.y).toBeGreaterThanOrEqual(20);
      expect(n.y).toBeLessThanOrEqual(90);
    }
    const d01 = Math.hypot(nodes[0]!.x - nodes[1]!.x, nodes[0]!.y - nodes[1]!.y);
    expect(d01).toBeGreaterThan(5);
  });
});
