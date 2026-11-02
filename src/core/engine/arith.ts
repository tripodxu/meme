/** 区间截断；min/max 来自参数注册表的合法域。 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
