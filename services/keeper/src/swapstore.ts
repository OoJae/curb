/**
 * The closure swap store: every Swap of a closure's pool in [cutBlock - 900, pinned], one JSON line per swap, with the
 * block ranges it is known to cover recorded beside it in the state (`Closure.coverage`).
 *
 * File: DATA_DIR/closures/<wrapper-lowercase>-<cutBlock>.jsonl, one `{"b":<block>,"i":<logIndex>,"q":"<equityAbs>",
 * "p":"<priceE18>"}` per line (the format the old build reads). The domain is `b >= domainFrom(c)`: the closing window
 * [cutBlock - 900, cutBlock] and the closure (cutBlock, ...).
 *
 * The one invariant everything here keeps: **the file's distinct valid rows in the domain are at least
 * `coverage.rows`**. Rows reach the file (written and fsynced) before coverage claims the blocks they came from, and
 * `coverage.rows` is the count taken right after that append. So:
 *  - a torn last line (a crash or a full disk mid-append) was never claimed: it is cut off before the next append;
 *  - a file holding fewer rows than its coverage claims (a rollback, a restored state, a deleted file) cannot be
 *    trusted: coverage is reset and the closure is rebuilt by the backfill or the commit-time fill;
 *  - a garbled terminated line means some row may be lost: reset likewise;
 *  - an append that throws claims nothing, so a full disk leaves a gap that is scanned again, never a silent hole;
 *  - a block with a log no endpoint decoded is never claimed;
 *  - a reorg costs only the blocks from the reorged one up, which the same scan supplies again.
 * None of these refuses a row: each becomes a gap, which the evidence assembly fills while time allows and then
 * commits honestly (W4a).
 */
import {
  appendFileSync, closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAddress } from "ethers";
import { addRange, gapsWithin, inRanges, normalizeRanges, subtractBlocks, subtractRange } from "./ranges.ts";
import type { Range } from "./ranges.ts";
import { MIN_REQUEST_MS, minKnownHead, scanRange, HISTORICAL_DEPTH } from "./sources/logscan.ts";
import type { ScanResult } from "./sources/logscan.ts";
import type { PoolSpec, SwapRow } from "./sources/pools.ts";
import { LOG_RANGE } from "./sources/chain.ts";

/** == ceil(MARK_METHODS[MARK_METHOD_VERSION].closingVwapWindowMs / 1000): one X Layer block per second (a test pins it). */
export const CLOSING_BLOCKS = 900;
export const domainFrom = (c: { cutBlock: number }) => Math.max(0, c.cutBlock - CLOSING_BLOCKS);

export interface Coverage {
  ranges: Array<[number, number]>;      // inclusive, sorted, disjoint, merged; all inside [domainFrom(c), ∞)
  rows: number;                         // distinct valid rows in the closure file when coverage was last claimed
}
export interface ClosureState {
  wrapper: string; symbol: string; cutBlock: number; coverage?: Coverage;
  plan?: unknown; committed?: unknown; witnessedCut?: boolean;
}
export interface Tracked { c: ClosureState; pool: string /* checksummed */ }
export type LogFn = (event: string, fields?: Record<string, unknown>) => void;
/** File writes the store makes through an injectable seam, so tests can fail an append half-way. */
export interface StoreIo { appendData(fd: number, data: string): void }
const nodeIo: StoreIo = { appendData: (fd, data) => appendFileSync(fd, data) };

export interface IngestReport {
  appended: number; late: number; dupes: number; holes: number; reorgAt: number | null;
  appendErrors: Array<{ symbol: string; error: string }>;
  resets: string[];
  /** Closures whose coverage this ingest changed (claimed, or truncated by a reorg): the caller saves state if > 0. */
  claimed: number;
}

interface ParsedLine { b: number; i: number; q: string; p: string }
interface Parsed {
  valid: ParsedLine[];        // terminated, valid lines, in file order (duplicates included)
  invalid: number;            // terminated lines that do not parse as a row: corruption
  conflicts: number;          // the same (b, i) twice with different q or p: corruption
  tornTail: boolean;          // an unterminated last line (NUL bytes included)
  terminatedBytes: number;    // length of the file up to and including its last "\n"
  exists: boolean;
}
interface Entry {
  keys: Set<string>; inDomain: number;
  dirty: boolean;             // an append threw, or a torn tail was seen: re-read and repair before the next touch
  reorgsSeen: number;         // how many of the store's reorgs this file has been truncated for
}

const DECIMAL = /^\d+$/;
const MAX_BLOCK = Number.MAX_SAFE_INTEGER;
const keyOf = (b: number, i: number) => `${b}:${i}`;
const lineOf = (r: SwapRow) => JSON.stringify({ b: r.blockNumber, i: r.logIndex, q: r.equityAbs.toString(), p: r.priceE18.toString() });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parseLine(line: string): ParsedLine | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }   // an invalid line is counted by the caller as corruption
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { b, i, q, p } = v as Record<string, unknown>;
  if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) return null;
  if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0) return null;
  if (typeof q !== "string" || !DECIMAL.test(q) || typeof p !== "string" || !DECIMAL.test(p)) return null;
  return { b, i, q, p };
}

function parseFile(path: string): Parsed {
  if (!existsSync(path)) return { valid: [], invalid: 0, conflicts: 0, tornTail: false, terminatedBytes: 0, exists: false };
  const buf = readFileSync(path);
  const terminatedBytes = buf.lastIndexOf(0x0a) + 1;
  const parts = buf.toString("utf8").split("\n");
  const tail = parts.pop()!;                                 // "" when the file ends with "\n"
  const valid: ParsedLine[] = [];
  const seen = new Map<string, ParsedLine>();
  let invalid = 0, conflicts = 0;
  for (const line of parts) {
    const r = parseLine(line);
    if (!r) { invalid++; continue; }
    const k = keyOf(r.b, r.i);
    const prev = seen.get(k);
    if (prev && (prev.q !== r.q || prev.p !== r.p)) conflicts++;
    if (!prev) seen.set(k, r);
    valid.push(r);
  }
  return { valid, invalid, conflicts, tornTail: tail.length > 0, terminatedBytes, exists: true };
}

/** Cut a torn tail off in place: the file keeps exactly its terminated lines. Needs no free space (a full disk is
 *  the usual cause of a torn tail), and leaves the same bytes a rewrite of the valid lines would. */
function cutTornTail(path: string, terminatedBytes: number) {
  const fd = openSync(path, "r+");
  try { ftruncateSync(fd, terminatedBytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** tmp + fsync + rename + dir fsync. */
function replaceFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content);
    const fd = openSync(tmp, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const dfd = openSync(dirname(path), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

/** A closure's coverage as stored, made safe to use: ranges normalised and clipped to the domain; an unusable `rows`
 *  means the claim cannot be checked, so the coverage is dropped (a re-scan, never an invented block). */
function coverageOf(c: ClosureState, log?: LogFn): Coverage {
  const cov = c.coverage as Partial<Coverage> | undefined | null;
  if (cov === undefined || cov === null) return (c.coverage = { ranges: [], rows: 0 });
  const rows = typeof cov === "object" ? cov.rows : undefined;
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 0) {
    log?.("swap-coverage-invalid", { symbol: c.symbol, cutBlock: c.cutBlock, coverage: JSON.stringify(cov).slice(0, 200) });
    return (c.coverage = { ranges: [], rows: 0 });
  }
  let ranges = normalizeRanges(Array.isArray(cov.ranges) ? cov.ranges : []);
  if (domainFrom(c) > 0) ranges = subtractRange(ranges, 0, domainFrom(c) - 1);
  const out = c.coverage as Coverage;
  out.ranges = ranges;
  return out;
}

export class ClosureSwapStore {
  private readonly dataDir: string;
  private readonly log: LogFn;
  private readonly io: StoreIo;
  private readonly cache = new Map<string, Entry>();
  /** The first block of every reorg this process has seen, in order. Each closure's file is truncated from the
   *  lowest one it has not yet been truncated for, at its next ingest (whichever scan detected it). */
  private readonly reorgs: number[] = [];

  constructor(dataDir: string, log: LogFn, io: StoreIo = nodeIo) {
    this.dataDir = dataDir;
    this.log = log;
    this.io = io;
  }

  path(c: Pick<ClosureState, "wrapper" | "cutBlock">): string {
    return join(this.dataDir, "closures", `${c.wrapper.toLowerCase()}-${c.cutBlock}.jsonl`);
  }

  /**
   * First touch of a closure's file in this process (and the first touch after an append that threw): repair a torn
   * tail, build the key set, and reset the closure when the file is corrupt or holds fewer rows than its coverage
   * claims. The caller raises sev-1 `keeper:swap-file-lost:<symbol>` on `reset`.
   */
  ensure(c: ClosureState): { reset: boolean; repaired: boolean; rows: number } {
    const cov = coverageOf(c, this.log);
    const path = this.path(c);
    const cached = this.cache.get(path);
    if (cached && !cached.dirty) return { reset: false, repaired: false, rows: cached.inDomain };

    const f = parseFile(path);
    if (f.invalid > 0 || f.conflicts > 0) {
      this.resetClosure(c, "corrupt", { invalid: f.invalid, conflicts: f.conflicts, coverageRows: cov.rows });
      return { reset: true, repaired: false, rows: 0 };
    }
    let repaired = false;
    if (f.tornTail) {
      cutTornTail(path, f.terminatedBytes);
      repaired = true;
      this.log("swap-file-repaired", { symbol: c.symbol, file: path, dropped: 1, tornTail: true });
    }
    const e = this.entryFrom(c, f.valid, cached);
    if (e.inDomain < cov.rows) {
      this.resetClosure(c, f.exists ? "fewer-rows-than-coverage" : "file-missing", { rows: e.inDomain, coverageRows: cov.rows });
      return { reset: true, repaired, rows: 0 };
    }
    this.cache.set(path, e);
    return { reset: false, repaired, rows: e.inDomain };
  }

  /** "b:i" is in the file (after ensure). */
  has(c: ClosureState, key: string): boolean {
    return this.entry(c).keys.has(key);
  }

  /** Distinct valid rows with b >= domainFrom(c). */
  count(c: ClosureState): number {
    return this.entry(c).inDomain;
  }

  /**
   * Append rows as whole "\n"-terminated lines and fsync. Never appends a (b, i) already in the file, nor a row that
   * would not read back as valid. THROWS on an I/O error, after which nothing is claimed and the next touch repairs.
   */
  append(c: ClosureState, rows: SwapRow[]): void {
    const e = this.entry(c);
    const from = domainFrom(c);
    const lines: string[] = [];
    const added: Array<[string, number]> = [];
    const batch = new Set<string>();
    for (const r of rows) {
      if (!Number.isSafeInteger(r.blockNumber) || r.blockNumber < 0 || !Number.isSafeInteger(r.logIndex) || r.logIndex < 0
          || typeof r.equityAbs !== "bigint" || r.equityAbs < 0n || typeof r.priceE18 !== "bigint" || r.priceE18 < 0n) {
        this.log("swap-row-invalid", { symbol: c.symbol, blockNumber: r.blockNumber, logIndex: r.logIndex });
        continue;
      }
      const k = keyOf(r.blockNumber, r.logIndex);
      if (e.keys.has(k) || batch.has(k)) continue;
      batch.add(k);
      lines.push(lineOf(r) + "\n");
      added.push([k, r.blockNumber]);
    }
    if (lines.length === 0) return;
    const path = this.path(c);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "a");
      try {
        this.io.appendData(fd, lines.join(""));
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } catch (err) {
      e.dirty = true;                                            // the next touch re-reads and cuts any torn tail
      throw err;
    }
    for (const [k, b] of added) { e.keys.add(k); if (b >= from) e.inDomain++; }
  }

  /**
   * Valid rows with domainFrom <= b <= toBlock, deduplicated, sorted by (b, i), read from the file as it is now. The
   * same check as `ensure` runs again (a file deleted or emptied while running): if it fails, the closure is reset and
   * no rows are returned.
   */
  read(c: ClosureState, toBlock: number): { rows: SwapRow[]; reset: boolean } {
    const first = this.ensure(c);
    if (first.reset) return { rows: [], reset: true };
    const cov = coverageOf(c, this.log);
    const path = this.path(c);
    const f = parseFile(path);
    if (f.invalid > 0 || f.conflicts > 0) {
      this.resetClosure(c, "corrupt", { invalid: f.invalid, conflicts: f.conflicts, coverageRows: cov.rows, at: "read" });
      return { rows: [], reset: true };
    }
    const e = this.entryFrom(c, f.valid, this.cache.get(path));
    if (e.inDomain < cov.rows) {
      this.resetClosure(c, f.exists ? "fewer-rows-than-coverage" : "file-missing", { rows: e.inDomain, coverageRows: cov.rows, at: "read" });
      return { rows: [], reset: true };
    }
    e.dirty = f.tornTail;                                        // never append after a torn tail: the next touch cuts it
    this.cache.set(path, e);
    const from = domainFrom(c);
    const seen = new Set<string>();
    const rows: SwapRow[] = [];
    for (const r of f.valid) {
      if (r.b < from || r.b > toBlock) continue;
      const k = keyOf(r.b, r.i);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ blockNumber: r.b, logIndex: r.i, equityAbs: BigInt(r.q), priceE18: BigInt(r.p) });
    }
    rows.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
    return { rows, reset: false };
  }

  /**
   * Keep only rows with b < `b` (atomic rewrite); coverage loses [b, ∞); coverage.rows = count. If the rewrite
   * fails, the whole closure is reset instead (a stale row must never shadow the re-scanned one); throws only if
   * even the file cannot be removed.
   */
  truncateFrom(c: ClosureState, b: number): void {
    this.entry(c);
    const cov = coverageOf(c, this.log);
    const path = this.path(c);
    try {
      const f = parseFile(path);
      if (f.invalid > 0 || f.conflicts > 0) {
        this.resetClosure(c, "corrupt", { invalid: f.invalid, conflicts: f.conflicts, at: "truncate" });
        return;
      }
      const kept = f.valid.filter((r) => r.b < b);
      if (f.exists) replaceFile(path, kept.map((r) => JSON.stringify(r) + "\n").join(""));
      this.cache.set(path, this.entryFrom(c, kept, this.cache.get(path)));
      cov.ranges = subtractRange(cov.ranges, b, MAX_BLOCK);
      cov.rows = this.count(c);
      this.log("swap-file-truncated", { symbol: c.symbol, fromBlock: b, dropped: f.valid.length - kept.length, rows: cov.rows });
    } catch (err) {
      this.log("swap-file-truncate-failed", { symbol: c.symbol, fromBlock: b, error: errText(err) });
      this.resetClosure(c, "truncate-failed", { fromBlock: b });
    }
  }

  /** Delete the file and forget it. */
  remove(c: Pick<ClosureState, "wrapper" | "cutBlock">): void {
    const path = this.path(c);
    this.cache.delete(path);
    rmSync(path, { force: true });
  }

  private entry(c: ClosureState): Entry {
    const e = this.cache.get(this.path(c));
    if (e && !e.dirty) return e;
    this.ensure(c);
    return this.cache.get(this.path(c)) ?? this.emptyEntry(c);
  }

  /** Record a reorg first seen at block `b` (by any scan). */
  noteReorg(b: number): void {
    this.reorgs.push(b);
  }

  /**
   * Truncate this closure's file from the lowest reorg block it has not been truncated for yet; returns that block,
   * or null when there is none. A file first touched after a reorg was noted starts up to date.
   */
  applyReorgs(c: ClosureState): number | null {
    const e = this.entry(c);
    if (e.reorgsSeen >= this.reorgs.length) return null;
    const at = Math.min(...this.reorgs.slice(e.reorgsSeen));
    this.truncateFrom(c, at);
    this.entry(c).reorgsSeen = this.reorgs.length;
    return at;
  }

  private emptyEntry(c: ClosureState): Entry {
    const e: Entry = { keys: new Set(), inDomain: 0, dirty: false, reorgsSeen: this.reorgs.length };
    this.cache.set(this.path(c), e);
    return e;
  }

  private entryFrom(c: ClosureState, valid: ParsedLine[], prev?: Entry): Entry {
    const from = domainFrom(c);
    const keys = new Set<string>();
    let inDomain = 0;
    for (const r of valid) {
      const k = keyOf(r.b, r.i);
      if (keys.has(k)) continue;
      keys.add(k);
      if (r.b >= from) inDomain++;
    }
    return { keys, inDomain, dirty: false, reorgsSeen: prev?.reorgsSeen ?? this.reorgs.length };
  }

  /** Remove the file, empty the key set and the coverage. Throws only if the file cannot be removed. */
  private resetClosure(c: ClosureState, reason: string, fields: Record<string, unknown>) {
    const path = this.path(c);
    this.log("swap-file-reset", { symbol: c.symbol, cutBlock: c.cutBlock, file: path, reason, ...fields });
    c.coverage = { ranges: [], rows: 0 };
    this.cache.set(path, { keys: new Set(), inDomain: 0, dirty: false, reorgsSeen: this.reorgs.length });
    rmSync(path, { force: true });
  }
}

const isLive = (c: ClosureState) => !c.plan && !c.committed && c.witnessedCut !== false;

/**
 * Put one scan's rows into every tracked open closure whose pool it covered. Rows reach the file before coverage
 * claims their blocks; a failed append claims nothing; a hole is never claimed (and stops being covered if it was);
 * a block hash that changed for a (pool, block, logIndex) seen before truncates every tracked closure from that block.
 */
export function ingest(store: ClosureSwapStore, tracked: Tracked[], scan: ScanResult, recentHashes: Map<string, string>): IngestReport {
  const report: IngestReport = { appended: 0, late: 0, dupes: 0, holes: 0, reorgAt: null, appendErrors: [], resets: [], claimed: 0 };
  const live = tracked.filter((t) => isLive(t.c));
  const resets = new Set<string>();
  for (const h of scan.holes.values()) report.holes += h.length;

  // 1. reorg check, across all pools of the scan
  let reorgAt: number | null = null;
  for (const [pool, rows] of scan.rows) {
    for (const r of rows) {
      if (r.blockHash === null) continue;
      const hk = `${pool}:${r.blockNumber}:${r.logIndex}`;
      const prev = recentHashes.get(hk);
      if (prev !== undefined && prev !== r.blockHash) reorgAt = reorgAt === null ? r.blockNumber : Math.min(reorgAt, r.blockNumber);
      recentHashes.set(hk, r.blockHash);
    }
  }
  const keepFrom = scan.to - 200;
  for (const hk of recentHashes.keys()) if (Number(hk.split(":")[1]) < keepFrom) recentHashes.delete(hk);
  if (reorgAt !== null) { report.reorgAt = reorgAt; store.noteReorg(reorgAt); }

  // 2. per tracked closure: apply any reorg not yet applied to its file (only blocks >= it; this scan or a later fill
  //    re-adds them), then the rows of its pool, if this scan covered its pool
  for (const t of live) {
    const c = t.c;
    try {
      if (store.ensure(c).reset) resets.add(c.symbol);
      if (store.applyReorgs(c) !== null) report.claimed++;
      const pool = getAddress(t.pool);
      const rows = scan.rows.get(pool);
      if (!rows) continue;
      const lo = Math.max(scan.from, domainFrom(c));
      const hi = scan.servedTo;
      if (hi < lo) continue;
      const covered = c.coverage!.ranges;
      const fresh: SwapRow[] = [];
      for (const r of rows) {
        if (r.blockNumber < lo || r.blockNumber > hi) continue;
        if (store.has(c, keyOf(r.blockNumber, r.logIndex))) { report.dupes++; continue; }
        if (inRanges(covered, r.blockNumber)) report.late++;   // the block was claimed, yet this log was not in the file
        fresh.push({ blockNumber: r.blockNumber, logIndex: r.logIndex, equityAbs: r.equityAbs, priceE18: r.priceE18 });
      }
      try {
        store.append(c, fresh);
      } catch (err) {
        report.appendErrors.push({ symbol: c.symbol, error: errText(err) });   // nothing claimed, key set unchanged
        continue;
      }
      report.appended += fresh.length;
      const holes = scan.holes.get(pool) ?? [];
      let ranges: Range[] = c.coverage!.ranges;
      for (const [x, y] of subtractBlocks([[lo, hi]], holes)) ranges = addRange(ranges, x, y);
      ranges = subtractBlocks(ranges, holes);                    // a block holding an undecoded log is never covered
      c.coverage = { ranges, rows: store.count(c) };
      report.claimed++;
    } catch (err) {
      // ensure or a reorg truncation could not touch the file: nothing more is claimed for this closure
      report.appendErrors.push({ symbol: c.symbol, error: `store: ${errText(err)}` });
    }
  }
  report.resets = [...resets];
  return report;
}

/**
 * The commit-time fill (W2.6): the closure's own gaps in [domainFrom, pinnedBlock], the tail (the gap ending at the
 * pinned block) first, then the others lowest first, bounded by chunks and by a real deadline.
 */
export async function fillForCommit(store: ClosureSwapStore, t: Tracked, spec: PoolSpec, pinnedBlock: number,
  o: { rpcs: string[]; heads: number[]; maxChunks: number; deadlineMs: number; recentHashes: Map<string, string>;
       now?: () => number; fetchImpl?: typeof fetch }):
  Promise<{ reset: boolean; chunks: number; gapsLeft: Array<[number, number]>; stopReason: ScanResult["stopReason"]; error?: string }> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const gapsNow = () => gapsWithin(t.c.coverage?.ranges ?? [], domainFrom(t.c), pinnedBlock);
  let reset = false;
  let chunks = 0;
  let stopReason: ScanResult["stopReason"] = null;
  try {
    reset = store.ensure(t.c).reset;
    const gaps = gapsNow();
    if (gaps.length === 0) return { reset, chunks: 0, gapsLeft: [], stopReason: null };
    const tail = gaps.filter((g) => g[1] === pinnedBlock);
    const order = [...tail, ...gaps.filter((g) => g[1] !== pinnedBlock)];
    const floor = minKnownHead(o.heads);
    for (const g of order) {
      const chunksLeft = o.maxChunks - chunks;
      if (chunksLeft <= 0) { stopReason = "chunk-budget"; break; }
      const timeLeft = o.deadlineMs - (now() - t0);
      if (timeLeft < MIN_REQUEST_MS) { stopReason = "time-budget"; break; }
      const historical = floor !== null && g[1] <= floor - HISTORICAL_DEPTH;
      const r = await scanRange(o.rpcs, [spec], g[0], g[1], {
        maxChunks: chunksLeft, deadlineMs: timeLeft, heads: o.heads, endpointOrder: historical ? "roundRobin" : "first",
        now: o.now, fetchImpl: o.fetchImpl,
      });
      chunks += r.stats.chunks;
      const rep = ingest(store, [t], r, o.recentHashes);
      if (rep.resets.length > 0) reset = true;
      if (r.stopReason !== null) stopReason = r.stopReason;
      if (r.stopReason === "chunk-budget" || r.stopReason === "time-budget") break;
      // "unserved": move on to the next gap
    }
  } catch (err) {
    // Only the file system can land here (ensure could not read or repair the file). The fill is best effort: the
    // gaps it leaves are reported below and the evidence assembly decides what they mean (defer, or degrade).
    return { reset, chunks, gapsLeft: gapsNow(), stopReason: stopReason ?? "unserved", error: errText(err) };
  }
  return { reset, chunks, gapsLeft: gapsNow(), stopReason };
}

/**
 * The next backfill query: the eligible closure that is due first and has a gap in [domainFrom, cursor]; its lowest
 * gap, capped at `maxChunks` chunks; every eligible closure whose gaps intersect that range rides along (closures that
 * share a cut share one query). Null when nothing is left to fill.
 */
export function backfillJob(eligible: Array<Tracked & { dueMs: number }>, cursor: number, maxChunks: number):
  { from: number; to: number; pools: string[] } | null {
  if (!(maxChunks > 0)) return null;
  const gapsOf = (t: Tracked) => gapsWithin(t.c.coverage?.ranges ?? [], domainFrom(t.c), cursor);
  const sorted = [...eligible].sort((a, b) => (a.dueMs - b.dueMs) || (domainFrom(a.c) - domainFrom(b.c)));
  for (const first of sorted) {
    const g = gapsOf(first)[0];
    if (!g) continue;
    const from = g[0];
    const to = Math.min(g[1], from + LOG_RANGE * Math.floor(maxChunks) - 1);
    const pools: string[] = [];
    for (const t of eligible) {
      const p = getAddress(t.pool);
      if (pools.includes(p)) continue;
      if (gapsOf(t).some(([x, y]) => x <= to && y >= from)) pools.push(p);
    }
    return { from, to, pools };
  }
  return null;
}
