/**
 * Inclusive integer block ranges: what a closure's swap file is known to cover.
 *
 * A range list is sorted, disjoint and merged (adjacent ranges join: [1,5] and [6,9] are [1,9]). Every function
 * here is pure and total: it never mutates its input, and it normalises what it is given first, so a list read
 * back from the state file that is out of order, overlapping or holds a malformed entry cannot make the keeper
 * believe it covers a block it never scanned. A malformed entry (not two safe integers, or from > to) is dropped:
 * dropping coverage costs a re-scan, inventing it would cost a row.
 */
export type Range = [number, number];

const isBlock = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** Sorted, disjoint, merged copy of `r`; malformed entries are dropped. */
export function normalizeRanges(r: ReadonlyArray<readonly [number, number]> | null | undefined): Range[] {
  if (!Array.isArray(r)) return [];
  const ok: Range[] = [];
  for (const x of r) {
    if (!Array.isArray(x) || x.length !== 2) continue;
    const [a, b] = x;
    if (!isBlock(a) || !isBlock(b) || a > b) continue;
    ok.push([a, b]);
  }
  ok.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Range[] = [];
  for (const [a, b] of ok) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) { if (b > last[1]) last[1] = b; }
    else out.push([a, b]);
  }
  return out;
}

/** `r` plus [from, to]. `[[1,5]] + [6,9] -> [[1,9]]`. An empty or malformed [from, to] adds nothing. */
export function addRange(r: ReadonlyArray<readonly [number, number]>, from: number, to: number): Range[] {
  if (!isBlock(from) || !isBlock(to) || from > to) return normalizeRanges(r);
  return normalizeRanges([...r, [from, to]]);
}

/** `r` minus [from, to]. `[[1,9]] - [4,5] -> [[1,3],[6,9]]`. */
export function subtractRange(r: ReadonlyArray<readonly [number, number]>, from: number, to: number): Range[] {
  const n = normalizeRanges(r);
  if (!isBlock(from) || !isBlock(to) || from > to) return n;
  const out: Range[] = [];
  for (const [a, b] of n) {
    if (b < from || a > to) { out.push([a, b]); continue; }
    if (a < from) out.push([a, from - 1]);
    if (b > to) out.push([to + 1, b]);
  }
  return out;
}

/** `r` minus single blocks. `[[1,10]] - [3,7] -> [[1,2],[4,6],[8,10]]`. */
export function subtractBlocks(r: ReadonlyArray<readonly [number, number]>, blocks: ReadonlyArray<number>): Range[] {
  let out = normalizeRanges(r);
  for (const b of blocks) if (isBlock(b)) out = subtractRange(out, b, b);
  return out;
}

/** The parts of [from, to] that `r` does not cover. `gapsWithin([[3,5],[8,9]], 1, 10) -> [[1,2],[6,7],[10,10]]`. */
export function gapsWithin(r: ReadonlyArray<readonly [number, number]>, from: number, to: number): Range[] {
  if (!isBlock(from) || !isBlock(to) || from > to) return [];
  const out: Range[] = [];
  let cur = from;
  for (const [a, b] of normalizeRanges(r)) {
    if (b < cur) continue;
    if (a > to) break;
    if (a > cur) out.push([cur, a - 1]);
    cur = b + 1;
    if (cur > to) return out;
  }
  out.push([cur, to]);
  return out;
}

/** True when block `b` is inside one of the ranges. */
export function inRanges(r: ReadonlyArray<readonly [number, number]>, b: number): boolean {
  for (const [x, y] of normalizeRanges(r)) {
    if (b < x) return false;
    if (b <= y) return true;
  }
  return false;
}

/** Number of blocks the ranges hold. */
export function blockCount(r: ReadonlyArray<readonly [number, number]>): number {
  let n = 0;
  for (const [a, b] of normalizeRanges(r)) n += b - a + 1;
  return n;
}
