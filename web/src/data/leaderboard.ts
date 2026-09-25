/**
 * /data/leaderboard.json: the input to /scorecard's Benchmarks section, written by tools/leaderboard/build.ts
 * and deployed with the site. It is same-origin, so CSP connect-src 'self' covers it.
 *
 * It holds two records and keeps them apart:
 *   onChain   Scorecard v2 at one block, with its strict recount asserted equal to skill() at build time.
 *             The page prefers its own live read of the same rows and falls back to this snapshot, saying so.
 *   backtest  tools/research/hk-closures: a historical backtest of mark/2 against the HKEX official open,
 *             walk-forward and in-sample. It is not on chain and is never added to an on-chain count.
 *
 * Fetched once per view. The file changes only when the site is redeployed.
 */
import type { ScorecardRow } from "./types.ts";

export const LEADERBOARD_SCHEMA = "curb.leaderboard/1";
export const LEADERBOARD_URL = "/data/leaderboard.json";

export type Outcome = "win" | "tie" | "loss";
export type EstimatorKey = "lastClose" | "perp" | "adr" | "mark2";
export const ESTIMATOR_KEYS: readonly EstimatorKey[] = ["lastClose", "perp", "adr", "mark2"];

export interface EstimatorScore {
  n: number;
  /** Mean |estimate − HK open| / HK close, in bp. */
  maeBp: number;
  /** Strict, as Scorecard counts: a win needs a smaller error than the last close. Null for the last close itself. */
  vsLastClose: { wins: number; ties: number; losses: number; winRate: number } | null;
  /** Of the closures where the estimator called a direction and the open moved. Null for the last close. */
  direction: { calls: number; hits: number; hitRate: number | null } | null;
  absErrorBp: { p50: number; p68: number; p90: number };
}
export type GroupScores = Record<EstimatorKey, EstimatorScore>;

export interface BacktestBand {
  n: number;
  mark2Band: { covered: number; rate: number; bandBp: { min: number; p50: number; max: number } };
  flat25: { covered: number; rate: number };
  contractMetricFlips: number;
}

export interface BacktestRun {
  label: string;
  n: number;
  /** wTCENTx, wXIAOx, wMEITx and "pooled". */
  groups: Record<string, GroupScores>;
  byKind: Record<string, GroupScores>;
  band: BacktestBand;
}

export interface LeaderboardTally {
  rows: number;
  settled: number;
  pending: number;
  expired: number;
  vsLastPrint: { wins: number; ties: number; losses: number };
  vsClosingVwap: { wins: number; ties: number; losses: number };
  meanCurbErrorBps: number | null;
  meanLastPrintErrorBps: number | null;
  /** Settled rows whose mark differed from the last print at all. */
  markMoved: number;
  band: { minBps: number | null; maxBps: number | null; covered: number; settled: number };
}

export interface Leaderboard {
  schema: typeof LEADERBOARD_SCHEMA;
  generatedAt: string;
  generatedBy: string;
  /** sha256 of every input file, by repo path. */
  inputs: Record<string, string>;
  onChain: {
    label: string;
    chainId: number;
    scorecard: string;
    block: { number: number; hash: string; timestamp: number };
    closureCount: number;
    skill: { settled: number; beatLast: number; beatVwap: number };
    recountMatchesSkill: boolean;
    all: LeaderboardTally;
    /** Keyed by method id ("curb.scorecard.mark/1"), or by digest when the method is unknown. */
    byMethod: Record<string, LeaderboardTally>;
    integrity: {
      duplicateClosures: { wrapper: string; reopenAt: string; ids: string[] }[];
      expiredUnsettled: number;
      settlers: { address: string; label: string | null; rows: number }[];
    };
  };
  band: {
    rule: string;
    committed: { minBps: number | null; maxBps: number | null; covered: number; settled: number };
    backtest: Record<"walkForward" | "inSample", { covered: number; n: number; medianBandBps: number; p68ErrorBp: number }>;
  };
  backtest: {
    label: string;
    source: string;
    doc: string;
    sample: { firstCut: string; lastReopen: string; closures: number; byAsset: Record<string, number>; excluded: string };
    metric: string;
    estimators: Record<EstimatorKey, { label: string; note: string }>;
    walkForward: BacktestRun & {
      minTrain: number;
      firstReopen: string;
      lastReopen: string;
      warmupExcluded: number;
      publishedBeta: { first: number; last: number; min: number; max: number };
    };
    inSample: BacktestRun & { beta: number };
  };
}

export async function getLeaderboard(signal?: AbortSignal): Promise<Leaderboard> {
  const res = await fetch(LEADERBOARD_URL, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${LEADERBOARD_URL}: http ${res.status}`);
  const doc = (await res.json()) as Partial<Leaderboard> | null;
  if (doc?.schema !== LEADERBOARD_SCHEMA) throw new Error(`${LEADERBOARD_URL}: schema ${String(doc?.schema)}, want ${LEADERBOARD_SCHEMA}`);
  return doc as Leaderboard;
}

// ── the on-chain tally, by method ──────────────────────────────────────────────────────────────

export interface MethodTally {
  /** "curb.scorecard.mark/1", a digest for an unknown method, or "all". */
  method: string;
  rows: number;
  settled: number;
  pending: number;
  wins: number;
  ties: number;
  losses: number;
  markMoved: number;
  meanCurbErrorBps: number | null;
  meanLastPrintErrorBps: number | null;
  bandMinBps: number | null;
  bandMaxBps: number | null;
  bandCovered: number;
}

const mean1 = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, v) => a + v, 0) / xs.length) * 10) / 10 : null);

function tallyRows(method: string, rows: ScorecardRow[]): MethodTally {
  const settled = rows.filter((r) => r.status === "settled");
  const bands = settled.map((r) => r.bandBps);
  return {
    method,
    rows: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    wins: settled.filter((r) => r.vsLastPrint === "win").length,
    ties: settled.filter((r) => r.vsLastPrint === "tie").length,
    losses: settled.filter((r) => r.vsLastPrint === "loss").length,
    markMoved: settled.filter((r) => r.markE18 !== r.lastPrintE18).length,
    meanCurbErrorBps: mean1(settled.flatMap((r) => (r.curbErrorBps === null ? [] : [r.curbErrorBps]))),
    meanLastPrintErrorBps: mean1(settled.flatMap((r) => (r.lastPrintErrorBps === null ? [] : [r.lastPrintErrorBps]))),
    bandMinBps: bands.length ? Math.min(...bands) : null,
    bandMaxBps: bands.length ? Math.max(...bands) : null,
    // The band holds when the reopen landed inside it: the contract's own error against the committed band.
    bandCovered: settled.filter((r) => r.curbErrorBps !== null && r.curbErrorBps <= r.bandBps).length,
  };
}

/** The live tally from the rows the page read from chain: one entry per method in method order, then "all". */
export function tallyLive(rows: ScorecardRow[]): MethodTally[] {
  const methods = [...new Set(rows.map((r) => r.method ?? r.methodDigest))].sort();
  return [...methods.map((m) => tallyRows(m, rows.filter((r) => (r.method ?? r.methodDigest) === m))), tallyRows("all", rows)];
}

function fromSnapshot(method: string, t: LeaderboardTally): MethodTally {
  return {
    method,
    rows: t.rows,
    settled: t.settled,
    pending: t.pending + t.expired,
    wins: t.vsLastPrint.wins,
    ties: t.vsLastPrint.ties,
    losses: t.vsLastPrint.losses,
    markMoved: t.markMoved,
    meanCurbErrorBps: t.meanCurbErrorBps,
    meanLastPrintErrorBps: t.meanLastPrintErrorBps,
    bandMinBps: t.band.minBps,
    bandMaxBps: t.band.maxBps,
    bandCovered: t.band.covered,
  };
}

/** The same shape from the build-time snapshot, for when the live read has not landed or has failed. */
export function tallySnapshot(lb: Leaderboard): MethodTally[] {
  const methods = Object.keys(lb.onChain.byMethod).sort();
  return [...methods.map((m) => fromSnapshot(m, lb.onChain.byMethod[m])), fromSnapshot("all", lb.onChain.all)];
}
