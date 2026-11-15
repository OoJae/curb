/**
 * The swap evidence a row commits, assembled from what the closure's file and coverage hold (pure).
 *
 * The keeper must never sign a commit whose mark input contradicts its own committed evidence. So the input is
 * DERIVED here from the swap lists, never the other way round: lastPrint is the price after the last closing
 * swap (else the mid at the cut), closingVwap is the VWAP of the closing list, and swapsDuringClosure is the
 * length of the closure list. Then the four invariants a V3 pool guarantees are checked against the two pool
 * reads the row also commits (I1: the last closure swap leaves the pool at midNow; I2: no closure swap means
 * midNow == midAtCut; I3: the last closing swap leaves it at midAtCut; I8: no closing swap means the last open
 * reading is midAtCut).
 *
 * When data is missing (a gap) or inconsistent, it waits while waiting can help (`defer`; the per-tick scan,
 * the backfill and fillForCommit work on it). At the must-commit point it commits an honestly degraded row
 * instead of none: gaps are committed as gaps, an inconsistent closing window is not committed at all, a
 * suspect closure tail becomes a gap. The one refusal left is D2's: no closure swap recorded while the pool's
 * price moved, which a row could only commit by knowingly omitting a move the keeper can see happened.
 *
 * No network, no clock, no state.
 */
import { getAddress } from "ethers";
import { blockCount, gapsWithin, inRanges } from "./ranges.ts";
import { SWAP_TOPIC0, vwap } from "./sources/pools.ts";
import type { SwapRow } from "./sources/pools.ts";
import { SWAP_EVIDENCE_VERSION, closingRangeFor, commitList, swapListDigest } from "./swapEvidence.ts";
import type { CutRead, SwapEvidenceFields } from "./swapEvidence.ts";

export interface AssemblyInput {
  symbol: string;
  /** Checksummed. */
  pool: string;
  cutBlock: number;
  cutBlockHash: string | null;
  cutRead: CutRead | null;
  /** poolSnap.block.number: where midNow was read. */
  pinnedBlock: number;
  /** MARK_METHODS[method].closingVwapWindowMs (900 000 for mark/2). */
  closingWindowMs: number;
  /** store.read(c, pinnedBlock).rows: domainFrom <= b <= pinnedBlock, deduped, sorted (b, i). */
  rows: SwapRow[];
  /** c.coverage.ranges after fillForCommit. */
  ranges: Array<[number, number]>;
  midAtCutE18: bigint;
  midNowE18: bigint;
  preCutMidE18: bigint | null;
  /** W4b: no later tick can still plan and leave time to send. */
  mustCommit: boolean;
}

export type AssemblyResult =
  | { kind: "defer"; reason: string }
  | { kind: "refuse"; alarmKey: string; message: string }
  | {
      kind: "commit"; complete: boolean; closingComplete: boolean; gaps: Array<[number, number]>; degraded: string[];
      input: { lastPrintE18: bigint; closingVwapE18: bigint | null; swapsDuringClosure: number };
      /** closureSwaps = commitList(K).committed: the full list, or D3's first and last 5,000 rows. */
      closingSwaps: SwapRow[]; closureSwaps: SwapRow[];
      swapEvidence: SwapEvidenceFields;
    };

const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const fmtGaps = (g: Array<[number, number]>) => (g.length ? g.map(([a, b]) => `${a}..${b}`).join(", ") : "none");

/** Sorted by (blockNumber, logIndex), one row per key: what store.read promises, enforced again here. */
function sortedUnique(rows: SwapRow[]): SwapRow[] {
  const out = [...rows].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return out.filter((r, k) => k === 0 || r.blockNumber !== out[k - 1].blockNumber || r.logIndex !== out[k - 1].logIndex);
}

/** Rules R1-R8 of spec W4a.1, in order. */
export function assembleSwapEvidence(i: AssemblyInput): AssemblyResult {
  const closingRange = closingRangeFor(i.cutBlock, i.closingWindowMs);
  const closingFrom = closingRange.fromBlock;
  const rows = sortedUnique(i.rows);
  const degraded: string[] = [];

  // R1: what is not covered, in the closing window and in the closure.
  const cg = gapsWithin(i.ranges, closingFrom, i.cutBlock);
  let kg = gapsWithin(i.ranges, i.cutBlock + 1, i.pinnedBlock);

  // R2: gaps can still be filled.
  if ((cg.length > 0 || kg.length > 0) && !i.mustCommit) {
    return { kind: "defer", reason: `gaps remain: closing ${blockCount(cg)} blocks, closure ${blockCount(kg)} blocks` };
  }

  // R3: the closing list, only when the whole window is covered.
  let closingComplete = cg.length === 0;
  let C = closingComplete ? rows.filter((r) => r.blockNumber >= closingFrom && r.blockNumber <= i.cutBlock) : [];

  // R4: I3 and I8.
  if (closingComplete) {
    const last = C.at(-1);
    const i3 = last !== undefined && last.priceE18 !== i.midAtCutE18;
    const i8 = last === undefined && i.preCutMidE18 !== null && i.preCutMidE18 !== i.midAtCutE18;
    if (i3 || i8) {
      if (!i.mustCommit) {
        return {
          kind: "defer",
          reason: i3
            ? `closing inconsistent (I3): the last closing swap (${last!.blockNumber}:${last!.logIndex}) leaves the pool at ${last!.priceE18}, not at the cut mid ${i.midAtCutE18}`
            : `closing inconsistent (I8): no closing swap, but the last open reading ${i.preCutMidE18} is not the cut mid ${i.midAtCutE18}`,
        };
      }
      closingComplete = false;
      C = [];
      degraded.push("closing-inconsistent");
    }
  }

  // R5: the closure list, without anything inside a gap.
  let K = rows.filter((r) => r.blockNumber > i.cutBlock && r.blockNumber <= i.pinnedBlock && !inRanges(kg, r.blockNumber));

  // R6: I1 under complete coverage.
  const lastK = K.at(-1);
  if (kg.length === 0 && lastK !== undefined && lastK.priceE18 !== i.midNowE18) {
    if (!i.mustCommit) {
      return {
        kind: "defer",
        reason: `closure inconsistent (I1): the last closure swap (${lastK.blockNumber}:${lastK.logIndex}) leaves the pool at ${lastK.priceE18}, not at midNow ${i.midNowE18}`,
      };
    }
    const x = lastK.blockNumber;
    kg = [[x, i.pinnedBlock]];
    K = K.filter((r) => r.blockNumber < x);
    degraded.push("closure-inconsistent");
  }

  // R7: I2, D2's refusal at must-commit.
  if (K.length === 0 && i.midNowE18 !== i.midAtCutE18) {
    if (!i.mustCommit) {
      return { kind: "defer", reason: `price moved with no recorded swap (I2): midAtCut ${i.midAtCutE18}, midNow ${i.midNowE18}, gaps ${fmtGaps(kg)}` };
    }
    return {
      kind: "refuse", alarmKey: `keeper:swap-evidence-inconsistent:${i.symbol}`,
      message: `${i.symbol}: price moved implies swaps; none recorded (gaps ${fmtGaps(kg)}); midAtCut ${i.midAtCutE18}, midNow ${i.midNowE18}`,
    };
  }

  // R8: commit. A cut read that does not belong to this cut block is not committed (keeper-side guard; the
  // strict self-check would refuse it, and a null cut read is an honest, noted state).
  let cutBlockHash = i.cutBlockHash;
  if (cutBlockHash !== null && !HASH32.test(cutBlockHash)) { cutBlockHash = null; degraded.push("cut-block-hash-dropped"); }
  let cutRead = i.cutRead;
  if (cutRead !== null && (cutRead.blockNumber !== i.cutBlock || cutBlockHash === null || cutRead.blockHash.toLowerCase() !== cutBlockHash.toLowerCase())) {
    cutRead = null;
    degraded.push("cut-read-dropped");
  }
  const complete = kg.length === 0;
  const { committed, omitted } = commitList(K);
  const swapEvidence: SwapEvidenceFields = {
    evidence: SWAP_EVIDENCE_VERSION,
    pool: getAddress(i.pool),
    topic0: SWAP_TOPIC0,
    cutBlockHash,
    cutRead,
    closingRange,
    closingComplete,
    closureRange: { fromBlock: i.cutBlock + 1, toBlock: i.pinnedBlock },
    complete,
    gaps: kg.map(([a, b]) => [a, b] as [number, number]),
    counts: { closingLogs: C.length, closureLogs: K.length },
    closureCount: K.length,
    closureOmitted: omitted,
    closureDigest: swapListDigest(K),
  };
  return {
    kind: "commit", complete, closingComplete, gaps: swapEvidence.gaps, degraded,
    input: { lastPrintE18: C.length ? C[C.length - 1].priceE18 : i.midAtCutE18, closingVwapE18: vwap(C), swapsDuringClosure: K.length },
    closingSwaps: C, closureSwaps: committed, swapEvidence,
  };
}
