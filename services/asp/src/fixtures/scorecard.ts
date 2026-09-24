/**
 * Test fixtures for the Scorecard routes: rows, snapshots and a RegimeChanged view, built in memory.
 *
 * The defaults are the first live row read from Scorecard v2 on 24 Sep 2026 (wTCENTx, the 22 Sep Hong
 * Kong lunch recess): mark, last print and closing VWAP are equal because the pool did not trade while
 * the primary market was shut, so the row ties both baselines. Lives under src/fixtures, which the Docker
 * image excludes.
 */
import { closureStartOf } from "../index/closures.ts";
import type { ClosureIndexStatus, RegimeTransition } from "../index/closures.ts";
import type { ScorecardRow, ScorecardSettlement, ScorecardSnapshot } from "../index/scorecard.ts";
import type { ClosureView } from "../discountCurve.ts";
import { Regime } from "../regime.ts";
import { methodDigestOf } from "../sources/scorecard.ts";

export const SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
export const TCENT = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
/** keccak256("curb.scorecard.mark/1"): 0x5982b5ee..., as the live rows carry it. */
export const MARK1 = methodDigestOf("curb.scorecard.mark/1").toLowerCase();

let seq = 0;
export const hex32 = (n: number | bigint) => "0x" + BigInt(n).toString(16).padStart(64, "0");

export function settlement(p: Partial<ScorecardSettlement> = {}): ScorecardSettlement {
  return {
    settledAt: 1_790_053_521, settledBlock: 71_283_000, reopenPrintE18: "58237918997832996539",
    curbErrorBps: 0, lastPrintErrorBps: 0, closingVwapErrorBps: 0, staleOracleErrorBps: 4_294_967_295, source: 1,
    ...p,
  };
}

/** 22 Sep 2026 04:50:18Z commit, 05:00:00Z reopen: the live row 0. */
export function row(p: Partial<ScorecardRow> = {}): ScorecardRow {
  const i = seq++;
  return {
    index: i,
    id: hex32(0xc0ffee00 + i),
    wrapper: TCENT,
    committedAt: 1_790_052_618,
    committedBlock: 71_282_000,
    settleAfter: 1_790_053_200,
    markE18: "58243189692637603411",
    bandBps: 25,
    inputRoot: hex32(0xabc000 + i),
    methodDigest: MARK1,
    lastPrintE18: "58243189692637603411",
    closingVwapE18: "58243189692637603411",
    staleOracleE18: "0",
    settlement: settlement(),
    ...p,
  };
}

/** Rows get their index from their position, as closureIds would assign it. */
export function snapshot(rows: ScorecardRow[], p: Partial<ScorecardSnapshot> = {}): ScorecardSnapshot {
  const indexed = rows.map((r, i) => ({ ...r, index: i }));
  let settled = 0, beatLast = 0, beatVwap = 0;
  for (const r of indexed) {
    if (!r.settlement) continue;
    settled++;
    // Scorecard.settle(), verbatim: strict.
    if (r.settlement.curbErrorBps < r.settlement.lastPrintErrorBps) beatLast++;
    if (r.settlement.curbErrorBps < r.settlement.closingVwapErrorBps) beatVwap++;
  }
  return {
    scorecard: SCORECARD,
    block: { number: 71_450_876, hash: hex32(0xb10c), timestamp: 1_790_222_000 },
    readAtMs: 1_790_222_000_000,
    closureCount: indexed.length,
    skill: { settled, beatLast, beatVwap },
    rows: indexed,
    ...p,
  };
}

export function transition(p: Partial<RegimeTransition> & { at: number; block: number }): RegimeTransition {
  return { wrapper: TCENT, from: Regime.MARKET, to: Regime.CLOSED, logIndex: 0, tx: hex32(p.block), ...p };
}

/** A ClosureView over an in-memory log, complete up to `lastScannedBlock`, with the real lookup rule. */
export function closureView(transitions: RegimeTransition[], lastScannedBlock: number, headBlock: number | null = lastScannedBlock + 5): ClosureView {
  const sorted = [...transitions].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const status: ClosureIndexStatus = {
    startBlock: 70_617_365, lastScannedBlock, headBlock,
    caughtUp: headBlock !== null && lastScannedBlock >= headBlock - 5,
    blocksRemaining: headBlock === null ? null : Math.max(0, headBlock - 5 - lastScannedBlock),
    progressPct: headBlock === null ? null : Math.floor(((lastScannedBlock - 70_617_364) / Math.max(1, headBlock - 5 - 70_617_364)) * 1000) / 10,
    transitions: sorted.length, lastError: null, lastStepAtMs: null,
  };
  return {
    status: () => status,
    closureStart: (w, at, block) => closureStartOf(sorted, lastScannedBlock, w, at, block),
  };
}
