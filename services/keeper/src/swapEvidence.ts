/**
 * Swap evidence, version 2: what a mark row commits about the pool's Swap logs, and how a stranger checks it.
 *
 * Every row before deploy 2 was written by a keeper build that decoded no Swap log at all (DECISIONS D-15):
 * its swap lists are empty whether or not the pool traded. From deploy 2 the swaps leaf also commits the
 * block ranges that were scanned, the gaps left in them, the count and digest of the full closure list and
 * the pool read at the cut, so a verifier can check that the committed mark input is exactly what the
 * committed lists imply. Which rule applies is decided by the block of the row's pinned chain read (its
 * "era"), never by what the bundle chooses to contain.
 *
 * Pure: no network, no clock, no state.
 */
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { poolAbi } from "./sources/pools.ts";
import type { MulticallSnapshot } from "./sources/chain.ts";

export const SWAP_EVIDENCE_VERSION = "curb.scorecard.swaps/2";

/**
 * The first block whose pinned chain read is held to the swap-evidence rules.
 *
 * PLACEHOLDER in the keeper release commit; set once by the verifier commit that follows deploy 2 (spec
 * 12.4b), to the chain head at the moment the new keeper was started with the old one gone. The keeper
 * never reads it: its own self-check passes the era explicitly. While it is the placeholder every row is
 * pre-fix to a verifier, and nothing is pushed or published in that state.
 */
export const SWAP_EVIDENCE_FROM_BLOCK: number = Number.MAX_SAFE_INTEGER;

/**
 * Read-block intervals at or after SWAP_EVIDENCE_FROM_BLOCK that were nonetheless written by a pre-fix
 * build (a rollback). Only ever appended to, the same day as the rollback.
 */
export const PRE_FIX_READ_RANGES: ReadonlyArray<readonly [number, number]> = [];

/** D3: a closure list longer than the cap commits its first HEAD and last TAIL rows, plus the full count and digest. */
export const CLOSURE_COMMIT_CAP = 10_000;
export const CLOSURE_COMMIT_HEAD = 5_000;
export const CLOSURE_COMMIT_TAIL = 5_000;

export type EvidenceEra = "pre-swap-fix" | "swap-evidence";

/**
 * The era of a row read at block `b`. Fails closed: anything that is not a safe integer is held to the
 * strict rules, so a bundle cannot reach the lenient path by omitting or garbling its read block.
 */
export function eraOf(b: number, from: number, ranges: ReadonlyArray<readonly [number, number]>): EvidenceEra {
  if (!Number.isSafeInteger(b)) return "swap-evidence";
  if (b < from) return "pre-swap-fix";
  return ranges.some(([x, y]) => b >= x && b <= y) ? "pre-swap-fix" : "swap-evidence";
}

export const eraOfReadBlock = (b: number): EvidenceEra => eraOf(b, SWAP_EVIDENCE_FROM_BLOCK, PRE_FIX_READ_RANGES);

/** The opening tick's slot0 read of the closure's pool, with the block it was read at. */
export interface CutRead {
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  /** slot0() returnData, hex, exactly as the pinned multicall returned it. */
  slot0: string;
}

export interface BlockRange { fromBlock: number; toBlock: number }

/** The keys deploy 2 adds to the swaps leaf (spec 1.4). All values are strings, booleans, null or safe integers. */
export interface SwapEvidenceFields {
  evidence: typeof SWAP_EVIDENCE_VERSION;
  /** Checksummed; must equal the REGISTRY pool. */
  pool: string;
  topic0: string;
  cutBlockHash: string | null;
  cutRead: CutRead | null;
  /** Inclusive; toBlock == cutBlock. */
  closingRange: BlockRange;
  /** False: the closing window is not committed (incomplete or inconsistent scan) and closingSwaps is []. */
  closingComplete: boolean;
  /** Inclusive; fromBlock == cutBlock + 1, toBlock == the CHAIN_CALL block. */
  closureRange: BlockRange;
  /** == (gaps.length == 0). */
  complete: boolean;
  /** Inclusive [from, to] pairs inside closureRange: blocks whose Swap logs were not scanned. */
  gaps: Array<[number, number]>;
  counts: { closingLogs: number; closureLogs: number };
  /** The full closure count, == markinput.swapsDuringClosure. */
  closureCount: number;
  closureOmitted: null | { fromIndex: number; toIndex: number };
  /** keccak256 of the FULL ordered closure list (swapLine per row, "\n"-joined). */
  closureDigest: string;
}

/** A swap row as the keeper holds it (bigints) or as a bundle commits it (decimal strings). */
export interface SwapLike {
  blockNumber: number;
  logIndex: number;
  equityAbs: bigint | string;
  priceE18: bigint | string;
}

/**
 * Closing window for a cut at `cutBlock`: the `ceil(windowMs / 1000)` blocks before it and the cut block itself
 * (one block per second on X Layer; mark/2's 900 000 ms gives 900 blocks).
 */
export function closingRangeFor(cutBlock: number, closingWindowMs: number): BlockRange {
  return { fromBlock: Math.max(0, cutBlock - Math.ceil(closingWindowMs / 1000)), toBlock: cutBlock };
}

/** One row of the digest: decimal integers, colon-separated. */
export const swapLine = (r: SwapLike): string => `${r.blockNumber}:${r.logIndex}:${r.equityAbs}:${r.priceE18}`;

/**
 * keccak256 over the "\n"-joined swap lines of an ordered list.
 * Empty list: keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.
 */
export const swapListDigest = (rows: SwapLike[]): string => keccak256(toUtf8Bytes(rows.map(swapLine).join("\n")));

/** D3: the closure rows a leaf commits, and which indices of the full list it leaves out. */
export function commitList<T>(rows: T[]): { committed: T[]; omitted: null | { fromIndex: number; toIndex: number } } {
  if (rows.length <= CLOSURE_COMMIT_CAP) return { committed: rows, omitted: null };
  return {
    committed: [...rows.slice(0, CLOSURE_COMMIT_HEAD), ...rows.slice(rows.length - CLOSURE_COMMIT_TAIL)],
    omitted: { fromIndex: CLOSURE_COMMIT_HEAD, toIndex: rows.length - CLOSURE_COMMIT_TAIL - 1 },
  };
}

/**
 * The cut read for a closure opened at this tick: the `slot0:<checksummed pool>` result of the tick's pinned
 * pool multicall, with that multicall's block. Null when the read failed or does not decode, so a closure never
 * commits a cut read that does not price.
 */
export function cutReadOf(snapshot: MulticallSnapshot | null | undefined, pool: string): CutRead | null {
  try {
    if (!snapshot || !snapshot.block || !Array.isArray(snapshot.results)) return null;
    const label = `slot0:${getAddress(pool)}`;
    const r = snapshot.results.find((x) => x.label === label);
    if (!r || r.success !== true || typeof r.returnData !== "string") return null;
    poolAbi.decodeFunctionResult("slot0", r.returnData);
    const { number, hash, timestamp } = snapshot.block;
    if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(timestamp)) return null;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
    return { blockNumber: number, blockHash: hash, blockTimestamp: timestamp, slot0: r.returnData };
  } catch {
    return null;
  }
}

/**
 * (a - b) / b in basis points, signed, one decimal, rounded half away from zero, exact in bigint:
 * hundredths of a bp truncated toward zero, then rounded to tenths. "+5.0", "-373.9", "0.0".
 */
export function formatBps(a: bigint, b: bigint): string {
  if (b === 0n) return "n/a";
  const h = ((a - b) * 1_000_000n) / b;
  const mag = h < 0n ? -h : h;
  const t = (mag + 5n) / 10n;
  if (t === 0n) return "0.0";
  return `${h < 0n ? "-" : "+"}${t / 10n}.${t % 10n}`;
}

/** 15000 -> "15,000", independent of the host's locale. */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  return (n < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
