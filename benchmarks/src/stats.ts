/** The value at quantile `q` of sorted numbers, with linear interpolation between the two nearest ranks. */
export const quantile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const low = sorted[below] ?? Number.NaN;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;
  return low + (high - low) * (position - below);
};

export interface Spread {
  readonly n: number;
  readonly median: number;
  readonly q1: number;
  readonly q3: number;
  readonly min: number;
  readonly max: number;
}

export const spread = (values: readonly number[]): Spread => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    min: sorted[0] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
};
