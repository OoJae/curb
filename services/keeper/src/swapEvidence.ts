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
import { SWAP_TOPIC0, poolAbi, priceFromSqrt, vwap } from "./sources/pools.ts";
import type { PoolSpec, SwapRow } from "./sources/pools.ts";
import type { MulticallSnapshot } from "./sources/chain.ts";
import { cutIsScheduled, holidayKey } from "./venueTime.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { PeriodLimits } from "./reopen.ts";
import type { ExchangeSchedule } from "./regime.ts";

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

/**
 * How far the observed cut instant (`cutAtMs`, the keeper's clock right after its reads) may lie from the block time of
 * the pool read it commits as the cut read: floor(cutAtMs / 1000) - cutRead.blockTimestamp must be in [MIN, MAX] s
 * (strict S22). Honest rows sit at 0-2 s (the 13 Nov recess: 1 s; the 233 archived rows: 0-2 s by block count); the
 * keeper's reads before it stamps the cut are bounded by about 42 s (8 s head reads, two multicalls at up to 16 s
 * each), and the minus side absorbs a keeper clock a few seconds behind the chain. A cut read outside the bound is
 * not committed (evidence.ts drops it), so the bound never costs the keeper its own row. Without it, cutAtMs, which
 * fixes mark/2's cross-market cut minute, would be bound to nothing on chain.
 */
export const CUT_READ_LAG_MIN_S = -5;
export const CUT_READ_LAG_MAX_S = 60;

/** floor(cutAtMs / 1000) - blockTimestamp: seconds from the cut read's block to the observed cut. */
export const cutReadLagS = (cutAtMs: number, blockTimestamp: number): number => Math.floor(cutAtMs / 1000) - blockTimestamp;
/** Does a cut read belong to a cut observed at `cutAtMs` (S22)? */
export const cutReadLagOk = (cutAtMs: number, blockTimestamp: number): boolean => {
  const d = cutReadLagS(cutAtMs, blockTimestamp);
  return Number.isFinite(d) && d >= CUT_READ_LAG_MIN_S && d <= CUT_READ_LAG_MAX_S;
};

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

// --- checking a committed swaps leaf ------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const isBlockNo = (x: unknown): x is number => isInt(x) && x >= 0;
const isDec = (x: unknown): x is string => typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x);
const isHash32 = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
/** A committed decimal integer as a bigint; null when it is not one. */
const big = (x: unknown): bigint | null => (typeof x === "string" && /^-?[0-9]+$/.test(x) ? BigInt(x) : null);
const iso = (ms: unknown): string => {
  const n = Number(ms);
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? new Date(n).toISOString() : String(ms);
};
const show = (x: unknown): string => {
  try { return JSON.stringify(x) ?? "undefined"; } catch { return String(x); }
};

/** A swap row as a bundle commits it. */
interface CommittedSwap { blockNumber: number; logIndex: number; equityAbs: string; priceE18: string }
const isSwap = (r: unknown): r is CommittedSwap =>
  isObj(r) && isBlockNo(r.blockNumber) && isBlockNo(r.logIndex) && isDec(r.equityAbs) && isDec(r.priceE18);
const toSwapRow = (r: CommittedSwap): SwapRow =>
  ({ blockNumber: r.blockNumber, logIndex: r.logIndex, equityAbs: BigInt(r.equityAbs), priceE18: BigInt(r.priceE18) });
const precedes = (a: CommittedSwap, b: CommittedSwap) =>
  a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex);

/**
 * A committed swap list: its rows when every row is well formed and strictly increasing by (blockNumber,
 * logIndex), else null; plus every problem, including rows outside `range` or inside a gap.
 */
function readList(list: unknown, range: BlockRange | null, gaps: Array<[number, number]>): { rows: CommittedSwap[] | null; problems: string[] } {
  if (!Array.isArray(list)) return { rows: null, problems: ["the list is missing or is not a list"] };
  const problems: string[] = [];
  let ordered = true;
  for (let k = 0; k < list.length; k++) {
    const r = list[k];
    if (!isSwap(r)) return { rows: null, problems: [`row ${k} is not {blockNumber, logIndex, equityAbs, priceE18} in decimal integers`] };
    if (k > 0 && isSwap(list[k - 1]) && !precedes(list[k - 1], r)) {
      ordered = false;
      problems.push(`row ${k} (${r.blockNumber}:${r.logIndex}) does not follow row ${k - 1} in (blockNumber, logIndex) order`);
    }
    if (range && (r.blockNumber < range.fromBlock || r.blockNumber > range.toBlock)) {
      problems.push(`row ${k} at block ${r.blockNumber} is outside ${range.fromBlock}..${range.toBlock}`);
    }
    const g = gaps.find(([a, b]) => r.blockNumber >= a && r.blockNumber <= b);
    if (g) problems.push(`row ${k} at block ${r.blockNumber} is inside the gap ${g[0]}..${g[1]}`);
  }
  return { rows: ordered ? (list as CommittedSwap[]) : null, problems: problems.slice(0, 3).concat(problems.length > 3 ? [`and ${problems.length - 3} more`] : []) };
}

type RegistrySpec = Pick<PoolSpec, "pool" | "equityIsToken0" | "equityDecimals" | "stableDecimals">;

/** The REGISTRY entry for `wrapper`, when it is complete enough to price a slot0 read. */
export function registrySpecOf(registry: unknown, wrapper: string): RegistrySpec | null {
  if (!isObj(registry) || !Array.isArray(registry.pools)) return null;
  const p = registry.pools.find((x) => isObj(x) && typeof x.wrapper === "string" && x.wrapper.toLowerCase() === wrapper.toLowerCase());
  if (!isObj(p) || typeof p.pool !== "string" || typeof p.equityIsToken0 !== "boolean") return null;
  if (!isInt(p.equityDecimals) || !isInt(p.stableDecimals) || p.equityDecimals < 0 || p.stableDecimals < 0 || p.equityDecimals > 36 || p.stableDecimals > 36) return null;
  return { pool: p.pool, equityIsToken0: p.equityIsToken0, equityDecimals: p.equityDecimals, stableDecimals: p.stableDecimals };
}

/** Price of a slot0 returnData under a REGISTRY spec; null when it does not decode. */
function slot0Price(returnData: unknown, spec: RegistrySpec): bigint | null {
  if (typeof returnData !== "string") return null;
  try { return priceFromSqrt(BigInt(poolAbi.decodeFunctionResult("slot0", returnData)[0]), spec); }
  catch { return null; }
}

const fmtRange = (r: unknown): string => (isObj(r) ? `${show(r.fromBlock)}..${show(r.toBlock)}` : show(r));
const fmtGaps = (gaps: Array<[number, number]>): string => gaps.map(([a, b]) => `${a}..${b}`).join(", ");

/** "rows read from block N", or what to say while N is still the placeholder. */
const eraFrom = (n: number): string => (n === Number.MAX_SAFE_INTEGER ? "rows in the swap-evidence era" : `rows read from block ${n}`);

export interface SwapEvidenceCheckInput {
  symbol: string;
  wrapper: string;
  /** The CLAIM's settleAfterS. */
  settleAfterS: number;
  /** The committed leaves, parsed (null or undefined when absent). */
  swaps: unknown;
  markinput: unknown;
  venue: unknown;
  /** The whole REGISTRY leaf. */
  registry: unknown;
  /** Every CHAIN_CALL leaf in the bundle (strict rows must have exactly one). */
  chainCalls: unknown[];
  params: unknown;
  /** For the failure text only; defaults to SWAP_EVIDENCE_FROM_BLOCK. */
  swapEvidenceFromBlock?: number;
}

export interface SwapEvidenceCheck {
  failures: string[];
  notes: string[];
  /** The leaf's `complete` and `closingComplete`, when they are booleans. */
  complete: boolean | null;
  closingComplete: boolean | null;
}

/**
 * The strict checks S1-S21 (era `swap-evidence`): every failure means NOT REPRODUCED; notes never change the
 * verdict. Total: a malformed leaf is a failure, never a throw.
 */
export function checkSwapEvidence(i: SwapEvidenceCheckInput): SwapEvidenceCheck {
  const out: SwapEvidenceCheck = { failures: [], notes: [], complete: null, closingComplete: null };
  const fail = (m: string) => { out.failures.push(`swap evidence for ${i.symbol}: ${m}`); };
  try {
    strictChecks(i, out, fail);
  } catch (e) {
    fail(`the swap evidence could not be checked (${e instanceof Error ? e.message : String(e)})`);
  }
  return out;
}

function strictChecks(i: SwapEvidenceCheckInput, out: SwapEvidenceCheck, fail: (m: string) => void): void {
  const sw = i.swaps;
  const mi = isObj(i.markinput) ? i.markinput : {};
  const note = (m: string) => { out.notes.push(m); };

  // S1: the leaf is a v2 swaps leaf at all.
  if (!isObj(sw) || sw.evidence !== SWAP_EVIDENCE_VERSION) {
    const why = !isObj(sw) ? "there is no swaps leaf" : `the swaps leaf names evidence ${show(sw.evidence ?? null)}, not ${SWAP_EVIDENCE_VERSION}`;
    fail(`the row commits no scan ranges (required for ${eraFrom(i.swapEvidenceFromBlock ?? SWAP_EVIDENCE_FROM_BLOCK)}): ${why}`);
    return;
  }

  // S2: the right pool and the Swap event.
  const spec = registrySpecOf(i.registry, i.wrapper);
  if (!spec) fail(`the REGISTRY has no usable pool entry for ${i.wrapper}`);
  else if (typeof sw.pool !== "string" || sw.pool.toLowerCase() !== spec.pool.toLowerCase()) fail(`pool ${show(sw.pool)} is not the REGISTRY pool ${spec.pool}`);
  if (sw.topic0 !== SWAP_TOPIC0) fail(`topic0 ${show(sw.topic0)} is not the Swap event topic ${SWAP_TOPIC0}`);

  // S3: the closing window is the method's, ending at the cut block.
  const cutBlock = sw.cutBlock;
  if (!isBlockNo(cutBlock)) { fail(`the committed cutBlock ${show(cutBlock)} is not a block number, so no closing range can be checked`); return; }
  const windowMs = isObj(i.params) ? i.params.closingVwapWindowMs : undefined;
  if (!isInt(windowMs) || windowMs <= 0) { fail(`PARAMS.closingVwapWindowMs ${show(windowMs)} is not a positive integer, so no closing range can be checked`); return; }
  const closing = closingRangeFor(cutBlock, windowMs);
  if (!isObj(sw.closingRange) || sw.closingRange.fromBlock !== closing.fromBlock || sw.closingRange.toBlock !== closing.toBlock) {
    fail(`closing range ${fmtRange(sw.closingRange)} is not ${closing.fromBlock}..${closing.toBlock} (the ${closing.toBlock - closing.fromBlock} blocks before the cut block, and the cut block)`);
  }

  // S4: exactly one pinned chain read; the closure range runs from the block after the cut to it.
  const chain = i.chainCalls.length === 1 && isObj(i.chainCalls[0]) ? i.chainCalls[0] : null;
  const blk = chain && isObj(chain.block) ? chain.block : null;
  const pinned = blk && isBlockNo(blk.number) ? blk.number : null;
  if (pinned === null) {
    fail(`the bundle has no single usable pinned chain read (${i.chainCalls.length} CHAIN_CALL leaves${i.chainCalls.length === 1 ? ", without a safe-integer block number" : ""})`);
  }
  const kr = sw.closureRange;
  if (!isObj(kr) || kr.fromBlock !== cutBlock + 1 || !isBlockNo(kr.toBlock) || (pinned !== null && kr.toBlock !== pinned)) {
    fail(`closure range ${fmtRange(kr)} is not ${cutBlock + 1}..${pinned ?? "<the pinned chain read's block>"}`);
  }
  const closure: BlockRange | null = pinned !== null ? { fromBlock: cutBlock + 1, toBlock: pinned }
    : isObj(kr) && isBlockNo(kr.toBlock) ? { fromBlock: cutBlock + 1, toBlock: kr.toBlock } : null;

  // S5: the gaps, and `complete` says whether there are any.
  const gaps: Array<[number, number]> = [];
  let gapsOk = Array.isArray(sw.gaps);
  if (!Array.isArray(sw.gaps)) fail(`gaps ${show(sw.gaps)} is not a list`);
  else {
    for (let k = 0; k < sw.gaps.length; k++) {
      const g = sw.gaps[k];
      if (!Array.isArray(g) || g.length !== 2 || !isBlockNo(g[0]) || !isBlockNo(g[1]) || g[0] > g[1]) { fail(`gaps[${k}] ${show(g)} is not an inclusive block range`); gapsOk = false; break; }
      const [a, b] = g as [number, number];
      if (closure && (a < closure.fromBlock || b > closure.toBlock)) fail(`gaps[${k}] ${a}..${b} is outside the closure range ${closure.fromBlock}..${closure.toBlock}`);
      const prev = gaps.at(-1);
      if (prev && a <= prev[1] + 1) fail(`gaps[${k}] ${a}..${b} is not sorted, disjoint and separated from ${prev[0]}..${prev[1]}`);
      gaps.push([a, b]);
    }
  }
  if (typeof sw.complete !== "boolean") fail(`complete ${show(sw.complete)} is not a boolean saying whether gaps is empty`);
  else {
    out.complete = sw.complete;
    if (gapsOk && sw.complete !== (gaps.length === 0)) fail(`complete is ${sw.complete} but gaps lists ${gaps.length} range(s)`);
  }

  // S6: closing swaps.
  const C = readList(sw.closingSwaps, closing, []);
  for (const p of C.problems) fail(`closing swaps: ${p}`);
  if (typeof sw.closingComplete !== "boolean") fail(`closing swaps: closingComplete ${show(sw.closingComplete)} is not a boolean`);
  else {
    out.closingComplete = sw.closingComplete;
    if (!sw.closingComplete && Array.isArray(sw.closingSwaps) && sw.closingSwaps.length > 0) {
      fail(`closing swaps: closingComplete is false but ${sw.closingSwaps.length} closing swaps are committed`);
    }
  }

  // S7: closure swaps.
  const K = readList(sw.closureSwaps, closure, gapsOk ? gaps : []);
  for (const p of K.problems) fail(`closure swaps: ${p}`);

  // S9: the committed count is the count the mark used.
  const n = sw.closureCount;
  const nOk = isBlockNo(n);
  if (!nOk) fail(`closureCount ${show(n)} is not a count, so swapsDuringClosure cannot be checked`);
  else if (n !== mi.swapsDuringClosure) fail(`closureCount ${n} is not the committed swapsDuringClosure ${show(mi.swapsDuringClosure)}`);

  // S8: the cut read binds midAtCut to a pool read at the cut block; the counts match the lists.
  const midAt = big(mi.midAtCutE18);
  const midNow = big(mi.midNowE18);
  const cr = sw.cutRead;
  if (cr === undefined) fail("cut read: the leaf has no cutRead (null when there is none)");
  else if (cr !== null) {
    if (!isObj(cr) || !isBlockNo(cr.blockNumber) || !isHash32(cr.blockHash) || !isInt(cr.blockTimestamp) || typeof cr.slot0 !== "string") {
      fail(`cut read ${show(cr)} is not {blockNumber, blockHash, blockTimestamp, slot0}`);
    } else {
      if (cr.blockNumber !== cutBlock) fail(`cut read is at block ${cr.blockNumber}, not the cut block ${cutBlock}`);
      if (!isHash32(sw.cutBlockHash) || cr.blockHash.toLowerCase() !== sw.cutBlockHash.toLowerCase()) {
        fail(`cut read block hash ${cr.blockHash} is not cutBlockHash ${show(sw.cutBlockHash)}`);
      }
      if (spec) {
        const p = slot0Price(cr.slot0, spec);
        if (p === null) fail("cut read: its slot0 does not decode");
        else if (midAt === null || p !== midAt) fail(`cut read prices the pool at ${p}, not the committed midAtCut ${show(mi.midAtCutE18)}`);
      }
      // S22: the observed cut instant belongs to the cut read's block. cutAtMs fixes mark/2's cross-market cut minute;
      // without this it is bound to nothing on chain, and a row could move its cut inside the closed period.
      if (!isInt(sw.cutAtMs) || !cutReadLagOk(sw.cutAtMs, cr.blockTimestamp)) {
        fail(`cut time ${iso(sw.cutAtMs)} is ${isInt(sw.cutAtMs) ? cutReadLagS(sw.cutAtMs, cr.blockTimestamp) : "?"} s after the cut read's block time `
          + `${iso(cr.blockTimestamp * 1000)}; it must be within ${CUT_READ_LAG_MIN_S}..${CUT_READ_LAG_MAX_S} s`);
      }
    }
  }
  const wantCounts = { closingLogs: Array.isArray(sw.closingSwaps) ? sw.closingSwaps.length : null, closureLogs: n };
  const cnt = sw.counts;
  if (!isObj(cnt) || Object.keys(cnt).length !== 2 || cnt.closingLogs !== wantCounts.closingLogs || cnt.closureLogs !== wantCounts.closureLogs) {
    fail(`counts ${show(cnt)} is not ${show(wantCounts)}`);
  }

  // S10: the full list or D3's head and tail, and the digest.
  const om = sw.closureOmitted;
  const krows = Array.isArray(sw.closureSwaps) ? sw.closureSwaps.length : null;
  if (om === undefined) fail("the leaf does not say which closure rows are omitted (closureOmitted is null when none are)");
  else if (om === null) {
    if (nOk && krows !== null && krows !== n) fail(`no closure row is marked omitted, but the closure list commits ${krows} of closureCount ${n} rows`);
    if (K.rows) {
      const d = swapListDigest(K.rows);
      if (typeof sw.closureDigest !== "string" || sw.closureDigest.toLowerCase() !== d) fail(`closureDigest ${show(sw.closureDigest)} is not the digest of the committed closure list (${d})`);
    }
  } else {
    if (!isObj(om) || !nOk || n <= CLOSURE_COMMIT_CAP || om.fromIndex !== CLOSURE_COMMIT_HEAD || om.toIndex !== n - CLOSURE_COMMIT_TAIL - 1 || Object.keys(om).length !== 2) {
      fail(`the omitted closure rows ${show(om)} are not {fromIndex: ${CLOSURE_COMMIT_HEAD}, toIndex: closureCount - ${CLOSURE_COMMIT_TAIL} - 1} of a list longer than ${CLOSURE_COMMIT_CAP} (closureCount ${show(n)})`);
    }
    if (krows !== CLOSURE_COMMIT_HEAD + CLOSURE_COMMIT_TAIL) fail(`closure rows are marked omitted but the list commits ${krows} rows, not ${CLOSURE_COMMIT_HEAD + CLOSURE_COMMIT_TAIL}`);
    if (!isHash32(sw.closureDigest)) fail(`closureDigest ${show(sw.closureDigest)} is not a 32-byte digest`);
  }

  // S11-S13: the committed mark input is what the closing list implies.
  if (C.rows) {
    const v = vwap(C.rows.map(toSwapRow));
    const cv = mi.closingVwapE18 === null ? null : big(mi.closingVwapE18);
    if (!(v === null && mi.closingVwapE18 === null) && !(v !== null && cv !== null && v === cv)) {
      fail(`committed closingVwap ${show(mi.closingVwapE18)} is not the volume-weighted price of the ${C.rows.length} committed closing swaps (${v ?? "none"})`);
    }
    const lastClosing = C.rows.length ? BigInt(C.rows[C.rows.length - 1].priceE18) : null;
    const wantLast = lastClosing ?? midAt;
    const lp = big(mi.lastPrintE18);
    if (lp === null || wantLast === null || lp !== wantLast) {
      fail(`committed lastPrint ${show(mi.lastPrintE18)} is not ${lastClosing !== null ? "the price after the last closing swap" : "the mid at the cut"} (${wantLast ?? "unknown"})`);
    }
    if (lastClosing !== null && (midAt === null || lastClosing !== midAt)) {
      fail(`the last closing swap leaves the pool at ${lastClosing}, not at the committed mid at the cut ${show(mi.midAtCutE18)}`);
    }
  }

  // S14: a pool price moves only on a swap.
  if (nOk && typeof sw.complete === "boolean") {
    if (n === 0) {
      if (midNow === null || midAt === null || midNow !== midAt) {
        fail(`no closure swap is recorded but midNow ${show(mi.midNowE18)} is not midAtCut ${show(mi.midAtCutE18)} (a pool price moves only on a swap)`);
      }
    } else if (sw.complete && K.rows) {
      const last = K.rows[K.rows.length - 1];
      if (!last || midNow === null || BigInt(last.priceE18) !== midNow) {
        fail(`the last closure swap leaves the pool at ${last?.priceE18 ?? "nothing"}, not at the committed midNow ${show(mi.midNowE18)}`);
      }
    }
  }

  // S15: midNow is the REGISTRY pool's slot0 in the pinned chain read.
  if (spec) {
    if (!chain) fail("slot0 of the REGISTRY pool cannot be read: there is no single pinned chain read");
    else {
      let label = "";
      try { label = `slot0:${getAddress(spec.pool)}`; } catch { /* reported below */ }
      const call = Array.isArray(chain.calls) ? chain.calls.find((c) => isObj(c) && c.label === label) : undefined;
      if (!label || !isObj(call) || call.success !== true) fail(`the pinned chain read has no successful slot0 result for the REGISTRY pool ${spec.pool}`);
      else {
        const p = slot0Price(call.returnData, spec);
        if (p === null || midNow === null || p !== midNow) fail(`slot0 of the REGISTRY pool at the pinned read prices to ${p ?? "nothing"}, not the committed midNow ${show(mi.midNowE18)}`);
      }
    }
  }

  // S17: cutBlockHash.
  if (sw.cutBlockHash === undefined || (sw.cutBlockHash !== null && !isHash32(sw.cutBlockHash))) {
    fail(`cutBlockHash ${show(sw.cutBlockHash)} is neither null nor a 32-byte hash`);
  }

  // S16, S18-S21: the venue evidence behind settleAfter, bound to the cut.
  const v = i.venue;
  if (!isObj(v) || !isObj(v.schedule) || !isObj(v.limitsPerPeriod) || typeof v.mic !== "string") {
    fail("no usable venue leaf: settleAfter cannot be re-derived from a committed schedule");
  } else {
    const S = { mic: v.mic, schedule: v.schedule } as unknown as ExchangeSchedule;
    // S18, with the same clock slack the keeper's cut check uses (venueTime.ts cutIsScheduled).
    let scheduled: boolean | null = null;
    try { scheduled = isInt(v.cutAtMs) ? cutIsScheduled(v.limitsPerPeriod as PeriodLimits, S, v.cutAtMs) : null; } catch { scheduled = null; }
    if (scheduled === null) fail(`the committed schedule cannot be evaluated at the cut ${show(v.cutAtMs)}`);
    else if (!scheduled) fail(`the committed schedule says the market was open at the cut ${iso(v.cutAtMs)}`);
    if (!isInt(v.cutAtMs) || v.cutAtMs !== sw.cutAtMs) fail(`the venue's cut time ${show(v.cutAtMs)} is not the swaps leaf's cut time ${show(sw.cutAtMs)}`);
    if (v.predictedReopenMs !== i.settleAfterS * 1000) fail(`the venue's predicted reopen ${show(v.predictedReopenMs)} is not settleAfter x 1000 (${i.settleAfterS * 1000})`);
    if (sw.settleAfterS !== i.settleAfterS) fail(`the swaps leaf's settleAfterS ${show(sw.settleAfterS)} is not the claim's ${i.settleAfterS}`);
    if (v.holidaysKept !== undefined) {
      const hol = Array.isArray(v.schedule.holidays) ? v.schedule.holidays : [];
      const have = new Set(hol.filter(isObj).map((h) => holidayKey(h as { startsAt: string; endsAt: string; kind: string })));
      if (!Array.isArray(v.holidaysKept)) fail(`holidaysKept ${show(v.holidaysKept)} is not a list`);
      else {
        for (const h of v.holidaysKept) {
          const k = isObj(h) ? holidayKey(h as { startsAt: string; endsAt: string; kind: string }) : show(h);
          if (!have.has(k)) fail(`holidaysKept entry ${k} is not in the committed schedule's holidays`);
        }
      }
    }
  }

  // Notes: what an honest row may still leave out. Never a failure.
  if (sw.complete === false && gapsOk) note(`closure scan incomplete: gaps ${fmtGaps(gaps)}; swapsDuringClosure counts the swaps recorded outside them`);
  if (sw.closingComplete === false) note("closing window not committed (incomplete or inconsistent scan); closingVwap is null and falls back to the last print");
  if (isObj(om) && nOk) {
    note(`closure list truncated: the first ${groupDigits(CLOSURE_COMMIT_HEAD)} and last ${groupDigits(CLOSURE_COMMIT_TAIL)} of ${groupDigits(n)} are committed; closureDigest commits all ${groupDigits(n)}`);
  }
  if (cr === null) note("the cut mid is not bound to a committed pool read (closure opened before this keeper build)");
  if (pinned !== null && blk && isInt(blk.timestamp)) {
    // From the observed cut instant always (never from cutRead.blockTimestamp, which S22 only bounds to it).
    const t0 = isInt(sw.cutAtMs) ? Math.floor(sw.cutAtMs / 1000) : null;
    if (t0 !== null) {
      const d = (blk.timestamp - t0) - (pinned - cutBlock);
      if (Math.abs(d) > 60) {
        note(`between the cut and the read the chain did not run at one block per second (${d > 0 ? "+" : ""}${d} s off); the ${closing.toBlock - closing.fromBlock}-block closing window may not be ${Math.round(windowMs / 60_000)} minutes`);
      }
    }
  }
}

/** How a pre-fix note says when the row's evidence was read. */
function preFixWhere(readBlock: number | null, from: number): string {
  if (readBlock === null) return "evidence read at an unknown block";
  if (readBlock < from) {
    return from === Number.MAX_SAFE_INTEGER
      ? `evidence read at block ${readBlock}; this build sets no first block for the swap-evidence era`
      : `evidence read at block ${readBlock}, before block ${from}`;
  }
  if (PRE_FIX_READ_RANGES.some(([x, y]) => readBlock >= x && readBlock <= y)) {
    return `evidence read at block ${readBlock}, inside a read interval recorded as pre-fix after a rollback`;
  }
  return `evidence read at block ${readBlock}, classified pre-fix by the caller`;
}

/**
 * The lenient notes E0-E5 (era `pre-swap-fix`): what an old row's evidence does and does not record. Never a
 * failure, and total: a malformed leaf yields fewer notes, never a throw.
 */
export function preFixNotes(i: { swaps: unknown; markinput: unknown; readBlock: number | null; swapEvidenceFromBlock?: number }): string[] {
  const out: string[] = [];
  try {
    const sw = isObj(i.swaps) ? i.swaps : {};
    const mi = isObj(i.markinput) ? i.markinput : {};
    const C: unknown[] = Array.isArray(sw.closingSwaps) ? sw.closingSwaps : [];
    const K: unknown[] = Array.isArray(sw.closureSwaps) ? sw.closureSwaps : [];
    const where = preFixWhere(i.readBlock, i.swapEvidenceFromBlock ?? SWAP_EVIDENCE_FROM_BLOCK);
    // E0 says the build decoded nothing, which is only true of a leaf without v2 evidence (every archived row).
    // A v2 leaf seen here (the era's first block not yet set, or a test) gets E0' instead.
    const v2 = sw.evidence !== undefined;
    if (C.length === 0 && K.length === 0 && !v2) {
      out.push(`pre-fix row (${where}): the keeper build that wrote it decoded no pool Swap logs (DECISIONS D-15). Its swap lists are empty whether or not the pool traded; no-drift, no-closing-vwap and closingVwap = lastPrint record what that keeper saw, not what the pool did.`);
    } else {
      out.push(`pre-fix row (${where}): swap ${C.length + K.length > 0 ? "lists" : "evidence"} present but not checked.`);
    }
    const midAt = big(mi.midAtCutE18);
    const midNow = big(mi.midNowE18);
    const last = big(mi.lastPrintE18);
    if (K.length === 0 && midAt !== null && midNow !== null && midNow !== midAt) {
      out.push(`the bundle's own pool reads moved ${formatBps(midNow, midAt)} bp between the cut and the commit while it lists 0 swaps.`);
    }
    if (C.length === 0 && midAt !== null && last !== null && last !== midAt) {
      out.push(`lastPrint is the keeper's last pre-cut reading, ${formatBps(last, midAt)} bp from the pool mid at the cut block.`);
    }
    if (isInt(mi.swapsDuringClosure) && mi.swapsDuringClosure !== K.length) {
      out.push(`committed swapsDuringClosure=${mi.swapsDuringClosure} but closureSwaps lists ${K.length} rows.`);
    }
    const rows = C.every(isSwap) ? (C as CommittedSwap[]).map(toSwapRow) : null;
    const cv = big(mi.closingVwapE18);
    if (rows && cv !== null) {
      const v = vwap(rows);
      if (v === null || v !== cv) out.push(`committed closingVwap ${mi.closingVwapE18} is not the volume-weighted price of the ${rows.length} committed closing swaps (${v ?? "none"}).`);
    }
    if (rows && rows.length > 0 && last !== null && last !== rows[rows.length - 1].priceE18) {
      out.push(`committed lastPrint ${mi.lastPrintE18} is not the price after the last committed closing swap (${rows[rows.length - 1].priceE18}).`);
    }
  } catch { /* a note is never worth a failure */ }
  return out;
}

/**
 * The holiday fallback for pre-fix rows only (E6). When the committed schedule walked from the cut misses the
 * committed settleAfter, accept iff it reopens before the commit instant AND, walked from the commit instant
 * (how the pre-fix keeper computed it), it gives exactly the committed settleAfter. Returns the note, or null
 * when the fallback does not apply (the `reopen mismatch` failure then stands).
 *
 * What it does NOT prove: that the closure was continuous since the cut. A keeper down across a reopen writes the
 * same shape. The note says only what the bytes show; the cause for the six known rows lives in D-16.
 */
export function holidayFallbackNote(
  venue: { mic: string; limitsPerPeriod: PeriodLimits; schedule: ExchangeSchedule["schedule"] },
  fromCut: number | null, evaluatedAtMs: number, settleAfterS: number,
): string | null {
  if (fromCut === null || !Number.isFinite(evaluatedAtMs) || !(fromCut < evaluatedAtMs)) return null;
  const fromEval = nextCapReturnMs(venue.limitsPerPeriod, { mic: venue.mic, schedule: venue.schedule } as ExchangeSchedule, evaluatedAtMs);
  if (fromEval === null || Math.floor(fromEval / 1000) !== settleAfterS) return null;
  return `reopen re-derived from the commit instant: walked from the cut, the committed schedule gives ${iso(fromCut)}, before the commit at ${iso(evaluatedAtMs)}; walked from the commit instant it gives the committed settleAfter ${iso(settleAfterS * 1000)}, which is how the keeper computed it. The bundle does not show whether a holiday dropped from the issuer's list or the closure was not continuous.`;
}
