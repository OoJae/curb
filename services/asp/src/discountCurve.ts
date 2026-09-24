/**
 * The closure-discount curve, method curb.discount/1: how far the reopen price lands from the price at
 * the bell, as a function of how long the primary market was shut. Observations and order statistics.
 * NOTHING is fitted.
 *
 * Why no fit. The record started on 21 Sep 2026 and grows by a handful of closures a day, almost all of
 * them the same two shapes (the 65-minute Hong Kong lunch cut and the ~17-hour overnight). Any curve
 * through that would be a shape we chose, dressed as a measurement -- and the whole point of Scorecard
 * is that Curb's claims are graded, not asserted. So `fit` is null, always; every observation is returned
 * in full so a buyer can fit whatever they like; and a bucket prints only the statistics its sample size
 * earns:
 *
 *     n < 3        insufficient   n only; every statistic null
 *     3 <= n < 12  indicative     the median only
 *     n >= 12      reportable     p25, median, p75, min, max, mean
 *
 * Why no backfill. An observation exists only where Curb committed a mark on chain BEFORE the reopen and
 * Scorecard settled it afterwards. Closures before the keeper went live, or ones it did not witness from
 * the cut, are absent rather than reconstructed from price history: a backfilled mark is not a mark, and
 * a curve built from reconstructions would claim the anti-backfill evidence (commit block < settle
 * block) that it does not have.
 *
 * Duration. A row carries its commit time and the reopen it was committed with (settleAfter), not when
 * the market shut. That comes from MarketClock (index/closures.ts): the last RegimeChanged into CLOSED
 * strictly before committedAt. Its `at` is the block time of the attestation that flipped the regime, so
 * it trails the issuer's own cut by one attestation round (seconds near a boundary; the attestor ticks
 * every 5 s there). Until that index has scanned past a row's commit block the start is "pending-index":
 * the observation is still listed, with durationS null and the reason, and it is in no bucket.
 */
import type { ScorecardRow, ScorecardSnapshot } from "./index/scorecard.ts";
import type { ClosureIndexStatus, ClosureStart, ClosureStartStatus } from "./index/closures.ts";
import { round2, summarize, EMPTY_SUMMARY } from "./stats.ts";
import type { Summary } from "./stats.ts";

export const CURVE_SCHEMA = "curb.asp.discount/1";
export const CURVE_PREVIEW_SCHEMA = "curb.asp.discount.preview/1";
export const CURVE_METHOD = "curb.discount/1";
/** The keeper's first live tick: nothing before this instant can be an observation. */
export const RECORD_STARTED_AT_MS = Date.parse("2026-09-21T15:17:00Z");
export const DEFAULT_MIN_MINUTES = 30;
export const MIN_MIN_MINUTES = 30;
export const MAX_MIN_MINUTES = 10_080;

/** Half-open [minS, maxS): a closure of exactly 2 h is in "2h-8h". */
export const BUCKETS: ReadonlyArray<{ label: string; minS: number; maxS: number | null }> = [
  { label: "30m-2h", minS: 1_800, maxS: 7_200 },
  { label: "2h-8h", minS: 7_200, maxS: 28_800 },
  { label: "8h-24h", minS: 28_800, maxS: 86_400 },
  { label: "24h-72h", minS: 86_400, maxS: 259_200 },
  { label: ">72h", minS: 259_200, maxS: null },
];

export type BucketStatus = "insufficient" | "indicative" | "reportable";

export function bucketStatus(n: number): BucketStatus {
  return n < 3 ? "insufficient" : n < 12 ? "indicative" : "reportable";
}

/** Only the statistics a sample of this size earns; the rest are null, not guessed. */
export function gated(values: readonly number[]): Summary {
  const status = bucketStatus(values.length);
  if (status === "insufficient") return { ...EMPTY_SUMMARY };
  const all = summarize(values);
  return status === "indicative" ? { ...EMPTY_SUMMARY, median: all.median } : all;
}

export function bucketOf(durationS: number): string | null {
  for (const b of BUCKETS) if (durationS >= b.minS && (b.maxS === null || durationS < b.maxS)) return b.label;
  return null;
}

/**
 * (base - price) / base in basis points, signed, truncated toward zero at 0.01 bp. Integer arithmetic on
 * the E18 strings, so two machines print the same digits. Null when the base is not positive.
 */
export function discountBpsOf(baseE18: string, priceE18: string): number | null {
  const base = BigInt(baseE18);
  if (base <= 0n) return null;
  return round2(Number(((base - BigInt(priceE18)) * 1_000_000n) / base) / 100);
}

export type ExcludedReason =
  | `closure-start-${Exclude<ClosureStartStatus, "known">}`
  | "shorter-than-minMinutes"
  | "non-positive-duration"
  | "no-closing-vwap";

export interface Observation {
  id: string;
  symbol: string | null;
  wrapper: string;
  closureStartStatus: ClosureStartStatus;
  closureStartAt: number | null;
  closureStartBlock: number | null;
  closureStartTx: string | null;
  committedAt: number;
  committedBlock: number;
  settleAfter: number;
  settledAt: number;
  settledBlock: number;
  durationS: number | null;
  bucket: string | null;
  closingVwapE18: string;
  markE18: string;
  reopenPrintE18: string;
  discountBps: number | null;
  markDiscountBps: number | null;
  usable: boolean;
  excludedReason: ExcludedReason | null;
}

export interface Bucket {
  n: number;
  label: string;
  minDurationS: number;
  maxDurationS: number | null;
  status: BucketStatus;
  discountBps: Summary;
  markDiscountBps: Summary;
}

export interface CurveAnswer {
  schema: typeof CURVE_SCHEMA;
  method: typeof CURVE_METHOD;
  scorecard: string;
  chainId: number;
  asOfBlock: number;
  asOfBlockHash: string;
  asOfMs: number;
  symbol: string | null;
  minMinutes: number;
  recordStartedAtMs: number;
  recordStartedAt: string;
  n: number;
  nUsable: number;
  /** Committed rows in scope that are not settled yet, so not observations yet. */
  pendingSettlement: number;
  index: {
    status: "current" | "backfilling";
    startBlock: number;
    lastScannedBlock: number;
    headBlock: number | null;
    progressPct: number | null;
  };
  buckets: Bucket[];
  fit: null;
  observations: Observation[];
  definitions: Record<string, string>;
  disclosure: string;
  warnings: string[];
}

export interface CurvePreview {
  schema: typeof CURVE_PREVIEW_SCHEMA;
  n: number;
  nUsable: number;
  buckets: Array<{ label: string; n: number; status: BucketStatus }>;
}

/** What the curve needs from the RegimeChanged index; ClosureIndex implements it. */
export interface ClosureView {
  status(): ClosureIndexStatus;
  closureStart(wrapper: string, committedAtS: number, committedBlock: number): ClosureStart;
}

export interface CurveInput {
  snapshot: ScorecardSnapshot;
  closures: ClosureView;
  chainId: number;
  symbols: ReadonlyMap<string, string>;
  filter: { symbol: string; wrapper: string } | null;
  minMinutes: number;
  nowMs: number;
  warnings?: string[];
}

export function observe(r: ScorecardRow, symbol: string | null, closures: ClosureView, minMinutes: number): Observation {
  const s = r.settlement!;
  const start = closures.closureStart(r.wrapper, r.committedAt, r.committedBlock);
  const known = start.status === "known" ? start.transition! : null;
  const durationS = known ? r.settleAfter - known.at : null;
  const discountBps = discountBpsOf(r.closingVwapE18, s.reopenPrintE18);
  const markDiscountBps = discountBpsOf(r.closingVwapE18, r.markE18);

  let excludedReason: ExcludedReason | null = null;
  if (start.status !== "known") excludedReason = `closure-start-${start.status}`;
  else if (durationS! <= 0) excludedReason = "non-positive-duration";
  else if (durationS! < minMinutes * 60) excludedReason = "shorter-than-minMinutes";
  else if (discountBps === null || markDiscountBps === null) excludedReason = "no-closing-vwap";

  return {
    id: r.id,
    symbol,
    wrapper: r.wrapper,
    closureStartStatus: start.status,
    closureStartAt: known?.at ?? null,
    closureStartBlock: known?.block ?? null,
    closureStartTx: known?.tx ?? null,
    committedAt: r.committedAt,
    committedBlock: r.committedBlock,
    settleAfter: r.settleAfter,
    settledAt: s.settledAt,
    settledBlock: s.settledBlock,
    durationS,
    bucket: durationS !== null && durationS > 0 ? bucketOf(durationS) : null,
    closingVwapE18: r.closingVwapE18,
    markE18: r.markE18,
    reopenPrintE18: s.reopenPrintE18,
    discountBps,
    markDiscountBps,
    usable: excludedReason === null,
    excludedReason,
  };
}

export const DISCLOSURE =
  "curb.discount/1 is descriptive, not a model. Each observation is one closure Curb marked on chain before the reopen and " +
  "Scorecard settled afterwards against the pool's own reopen price. There is no fit: fit is always null, and no curve is " +
  "fitted, smoothed or extrapolated; a bucket prints only the order statistics its sample size supports (fewer than 3 " +
  "closures: none; 3 to 11: the median; 12 or more: p25, median, p75, min, max, mean). There is no backfill: closures before " +
  "the record started, or ones Curb did not mark before they reopened, are absent rather than reconstructed, because a " +
  "backfilled mark is not a mark. A closure's duration runs from MarketClock's RegimeChanged into CLOSED (its block time, " +
  "which trails the issuer's cut by one attestation round) to the reopen the row was committed with. Until the " +
  "RegimeChanged indexer has finished backfilling from MarketClock's first attestation, some durations may be missing: " +
  "index.status says whether it has, and each affected observation is still listed, with durationS null and " +
  "excludedReason \"closure-start-pending-index\", and counted in no bucket.";

export function buildCurve(i: CurveInput): CurveAnswer {
  const snap = i.snapshot;
  const symbolOf = (w: string) => i.symbols.get(w.toLowerCase()) ?? null;
  const scope = i.filter ? snap.rows.filter((r) => r.wrapper.toLowerCase() === i.filter!.wrapper.toLowerCase()) : snap.rows;
  const settled = scope.filter((r) => r.settlement !== null).sort((a, b) => a.index - b.index);
  const observations = settled.map((r) => observe(r, symbolOf(r.wrapper), i.closures, i.minMinutes));
  const usable = observations.filter((o) => o.usable);

  const buckets: Bucket[] = BUCKETS.map((b) => {
    const inB = usable.filter((o) => o.bucket === b.label);
    return {
      n: inB.length,
      label: b.label,
      minDurationS: b.minS,
      maxDurationS: b.maxS,
      status: bucketStatus(inB.length),
      discountBps: gated(inB.map((o) => o.discountBps!)),
      markDiscountBps: gated(inB.map((o) => o.markDiscountBps!)),
    };
  });

  const ix = i.closures.status();
  const warnings = [...(i.warnings ?? [])];
  const pending = observations.filter((o) => o.closureStartStatus === "pending-index").length;
  if (pending) {
    warnings.push(
      `${pending} of ${observations.length} observations have no duration yet: the RegimeChanged index has scanned to block ` +
      `${ix.lastScannedBlock}${ix.progressPct === null ? "" : ` (${ix.progressPct}% of the backfill)`} and these rows were committed after it`,
    );
  }
  const odd = observations.filter((o) => o.closureStartStatus === "not-closed-at-commit" || o.closureStartStatus === "no-closed-transition").length;
  if (odd) warnings.push(`${odd} observation(s) have no CLOSED run in MarketClock's log covering their commit; they are listed and excluded, not guessed`);

  return {
    schema: CURVE_SCHEMA,
    method: CURVE_METHOD,
    scorecard: snap.scorecard,
    chainId: i.chainId,
    asOfBlock: snap.block.number,
    asOfBlockHash: snap.block.hash,
    asOfMs: i.nowMs,
    symbol: i.filter?.symbol ?? null,
    minMinutes: i.minMinutes,
    recordStartedAtMs: RECORD_STARTED_AT_MS,
    recordStartedAt: new Date(RECORD_STARTED_AT_MS).toISOString(),
    n: observations.length,
    nUsable: usable.length,
    pendingSettlement: scope.length - settled.length,
    index: {
      status: ix.caughtUp ? "current" : "backfilling",
      startBlock: ix.startBlock,
      lastScannedBlock: ix.lastScannedBlock,
      headBlock: ix.headBlock,
      progressPct: ix.progressPct,
    },
    buckets,
    fit: null,
    observations,
    definitions: {
      durationS: "settleAfter - closureStartAt: from the block time of MarketClock's last RegimeChanged into CLOSED before the commit, to the reopen the row was committed with",
      discountBps: "(closingVwap - reopenPrint) / closingVwap * 10000, signed, truncated toward zero at 0.01 bp; positive means the reopen came in below the closing VWAP",
      markDiscountBps: "(closingVwap - mark) / closingVwap * 10000, same convention: the discount Curb's committed mark implied",
      buckets: "half-open duration ranges [minDurationS, maxDurationS) in seconds; only usable observations (excludedReason null) are counted",
      quantiles: "Hyndman-Fan type 7 over the bucket's sorted values (R's default, numpy's linear), rounded to 0.01 bp",
      minMinutes: "observations shorter than this are listed but excluded from every bucket",
    },
    disclosure: DISCLOSURE,
    warnings,
  };
}

export function curvePreviewOf(a: CurveAnswer): CurvePreview {
  return {
    schema: CURVE_PREVIEW_SCHEMA,
    n: a.n,
    nUsable: a.nUsable,
    buckets: a.buckets.map((b) => ({ label: b.label, n: b.n, status: b.status })),
  };
}
