export interface BandScale {
  readonly bandwidth: number;
  x(key: string): number;
  center(key: string): number;
  ticks(): readonly { readonly value: string; readonly at: number }[];
}

export function bandScale(
  domain: readonly string[],
  range: readonly [number, number],
  padding = 0.25,
): BandScale {
  const count = Math.max(1, domain.length);
  const step = (range[1] - range[0]) / count;
  const bandwidth = Math.max(4, step * (1 - padding));
  return {
    bandwidth,
    x: (key: string) => {
      const idx = domain.indexOf(key);
      return range[0] + (idx < 0 ? 0 : idx) * step + (step - bandwidth) / 2;
    },
    center: (key: string) => {
      const idx = domain.indexOf(key);
      return range[0] + (idx < 0 ? 0 : idx) * step + step / 2;
    },
    ticks: () =>
      domain.map((value, idx) => ({
        value,
        at: range[0] + idx * step + step / 2,
      })),
  };
}
