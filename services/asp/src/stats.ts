/**
 * Order statistics, and nothing else.
 *
 * The accuracy record and the discount curve are sold as observations, not as a model, so every summary
 * they print is a function of the sorted sample alone: no distribution is assumed, nothing is fitted,
 * smoothed or extrapolated. A buyer holding the same observations must get the same numbers, so the
 * quantile is the definition their own tools reproduce by default -- Hyndman & Fan type 7, which is R's
 * `quantile()` and numpy's "linear": for n values sorted ascending, the p-quantile sits at position
 * h = (n - 1) p, on the straight line between order statistics x[floor h] and x[floor h + 1]. At p = 0.5
 * that is the ordinary median (the mean of the two middle values when n is even).
 */

/** Two decimal places, so 0.1 + 0.2 never prints as 0.30000000000000004 in a paid answer. */
export function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return r === 0 ? 0 : r;   // never -0: JSON would print it as 0 anyway, but deepEqual would not
}

/** Type-7 quantile of an ASCENDING sample. Null for an empty one: there is no quantile of nothing. */
export function quantileSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (!(p >= 0 && p <= 1)) throw new Error(`quantile p must be in [0,1], got ${p}`);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number | null {
  const m = quantileSorted(sortedAsc(values), 0.5);
  return m === null ? null : round2(m);
}

export interface Summary {
  p25: number | null;
  median: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

export const EMPTY_SUMMARY: Readonly<Summary> = Object.freeze({ p25: null, median: null, p75: null, min: null, max: null, mean: null });

/** Every order statistic of a sample, rounded for print. Callers decide how many of them a sample earns. */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { ...EMPTY_SUMMARY };
  const s = sortedAsc(values);
  const q = (p: number) => round2(quantileSorted(s, p)!);
  return {
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    min: round2(s[0]),
    max: round2(s[s.length - 1]),
    mean: round2(s.reduce((a, b) => a + b, 0) / s.length),
  };
}
