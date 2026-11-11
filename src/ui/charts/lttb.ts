/**
 * LTTB（Largest-Triangle-Three-Buckets）时序降采样。
 * 只用于显示；导出与指标计算始终使用原始序列（06 §9）。
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export function lttb<T extends Point>(data: readonly T[], threshold: number): T[] {
  if (threshold >= data.length || threshold < 3) return [...data];
  const sampled: T[] = [data[0] as T];
  const every = (data.length - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i += 1) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, data.length);
    let avgX = 0;
    let avgY = 0;
    let count = 0;
    for (let j = avgStart; j < avgEnd; j += 1) {
      const point = data[j];
      if (point === undefined) continue;
      avgX += point.x;
      avgY += point.y;
      count += 1;
    }
    if (count > 0) {
      avgX /= count;
      avgY /= count;
    }
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const pointA = data[a] as Point;
    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      const point = data[j];
      if (point === undefined) continue;
      const area = Math.abs(
        (pointA.x - avgX) * (point.y - pointA.y) - (pointA.x - point.x) * (avgY - pointA.y),
      );
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }
    const selected = data[maxIndex];
    if (selected !== undefined) sampled.push(selected);
    a = maxIndex;
  }
  sampled.push(data[data.length - 1] as T);
  return sampled;
}

/** 按容器像素宽度选择阈值：每个像素最多一个点，最少 3 点。 */
export function pixelThreshold(widthPx: number): number {
  return Math.max(3, Math.round(widthPx));
}
