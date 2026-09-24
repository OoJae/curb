/**
 * When did each closure start? An incremental, persisted index of MarketClock's RegimeChanged log.
 *
 * A Scorecard row knows when its mark was committed and when capacity was predicted back (settleAfter),
 * but not when the primary market SHUT -- and the discount curve is a function of exactly that duration.
 * MarketClock records it: every attestation that flips a wrapper's regime emits
 * RegimeChanged(wrapper, from, to, at), with `at` the block time of the write. Under derive/2 (every round
 * since block 70,619,137, well before the keeper's first row) ANY zero-cap period attests as CLOSED, so a
 * Hong Kong afternoon closure is one CLOSED run from the 15:55 cut to the 09:30 reopen, not three runs
 * broken by zero-cap `extended` sessions. The closure a row graded therefore started at the LAST
 * RegimeChanged into CLOSED strictly before the row's committedAt.
 *
 * Scanned forward from MarketClock's first attestation (block 70,617,365), 100 blocks per eth_getLogs --
 * the public RPC's cap -- with the same per-endpoint head guard as `attestedRounds` and
 * `closuresCommitted`: a node that has not indexed a block answers eth_getLogs with an empty list, not an
 * error, so a chunk is only ever asked of an endpoint whose head (read before the batch; heads only move
 * forward) has reached the chunk's end. Accepting [] from a lagging node would record "no transition"
 * where there was one, and a closure would silently acquire the wrong start.
 *
 * Throughput, measured 24 Sep 2026: ~2 s per chunk warm on either public endpoint, and rpc.xlayer.tech
 * answers "over rate limit" past ~6 concurrent requests. The backfill is ~8,300 chunks -- over four hours
 * one at a time -- so a batch keeps `concurrency` chunks in flight spread across the endpoints (4 measured
 * 2-3.3 chunks/s: roughly 40-70 minutes for the whole backfill), and the cursor only advances over the
 * CONTIGUOUS prefix of chunks that succeeded -- a hole is re-asked next step, never skipped. Once caught
 * up it is one chunk every few ticks (X Layer makes ~1 block a second).
 *
 * The cursor trails the best head by `confirmations` blocks, as the keeper's swap scan does, so a shallow
 * reorg cannot write a transition the chain later drops. {lastScannedBlock, transitions} is persisted with
 * persistReplace after every batch, so a restart resumes where it stopped and the backfill is paid once
 * per volume. It runs on its own loop, never on a request's path: until it is caught up, a row whose
 * commit block lies past the cursor has a closure start of "pending-index", and says so.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress } from "ethers";
import { clockAbi, endpointLabel, LOG_RANGE, rpcAny } from "../sources/chain.ts";
import { Regime } from "../regime.ts";
import { persistReplace } from "../persist.ts";
import type { Log } from "../log.ts";
import { silentLog } from "../log.ts";

export const REGIME_INDEX_SCHEMA = "curb.asp.regime-index/1";
/** MarketClock's first attestation (DEPLOYMENTS.md): nothing before it can be a transition. */
export const MARKETCLOCK_FIRST_BLOCK = 70_617_365;
const REGIME_CHANGED = clockAbi.getEvent("RegimeChanged")!.topicHash;

export interface RegimeTransition {
  wrapper: string;
  from: number;
  to: number;
  /** MarketClock's `at`: the block time of the attestation that flipped the regime, unix seconds. */
  at: number;
  block: number;
  logIndex: number;
  tx: string;
}

/** One JSON-RPC call to ONE endpoint. The head guard needs to know which endpoint answered. */
export type EndpointRpc = (url: string, method: string, params: unknown[]) => Promise<unknown>;

const defaultRpc: EndpointRpc = (url, method, params) => rpcAny([url], method, params, method === "eth_getLogs" ? 20_000 : 8_000);

export interface ClosureIndexOptions {
  /** Where {lastScannedBlock, transitions} is persisted. */
  path: string;
  clock: string;
  rpcs: string[];
  startBlock?: number;
  rpc?: EndpointRpc;
  /** Blocks the cursor trails the best head by. */
  confirmations?: number;
  /** Chunks in flight at once during a batch. */
  concurrency?: number;
  /** Chunks per batch (one persist per batch). */
  maxChunksPerStep?: number;
  now?: () => number;
  log?: Log;
}

export interface ClosureIndexStatus {
  startBlock: number;
  /** Every block up to and including this one has been scanned; startBlock - 1 before the first chunk. */
  lastScannedBlock: number;
  /** The best head seen at the last step, or null before the first. */
  headBlock: number | null;
  caughtUp: boolean;
  blocksRemaining: number | null;
  progressPct: number | null;
  transitions: number;
  lastError: string | null;
  lastStepAtMs: number | null;
}

export type ClosureStartStatus =
  /** The last RegimeChanged into CLOSED before the commit, from an open regime: the closure's start. */
  | "known"
  /** The index has not scanned up to the commit block yet: the start exists, it is not read yet. */
  | "pending-index"
  /** The index covers the commit, and there is no RegimeChanged into CLOSED for the wrapper before it. */
  | "no-closed-transition"
  /** The latest transition before the commit left CLOSED, so the index says the market was not shut then. */
  | "not-closed-at-commit"
  /** The CLOSED run began at MarketClock's first attestation (from UNKNOWN): the real cut predates the record. */
  | "first-attestation";

export interface ClosureStart {
  status: ClosureStartStatus;
  transition: RegimeTransition | null;
}

/**
 * Pure: the closure start for a row committed at (committedAtS, committedBlock), given ONE wrapper's
 * transitions sorted by (block, logIndex) and the last block the log is complete up to.
 *
 * Binary search on `at`, which is sound because block time never decreases with block number. It has to
 * be cheap: the free 402 preview of the curve runs this once per settled row, and a linear scan of every
 * transition per row would let anyone buy CPU with an unpaid request as the record grows.
 */
export function closureStartIn(
  wrapperSorted: readonly RegimeTransition[], lastScannedBlock: number, committedAtS: number, committedBlock: number,
): ClosureStart {
  if (lastScannedBlock < committedBlock) return { status: "pending-index", transition: null };
  // lo = the number of transitions strictly before committedAtS.
  let lo = 0, hi = wrapperSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (wrapperSorted[mid].at < committedAtS) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return { status: "no-closed-transition", transition: null };
  const latest = wrapperSorted[lo - 1];
  if (latest.to !== Regime.CLOSED) {
    for (let i = lo - 2; i >= 0; i--) {
      if (wrapperSorted[i].to === Regime.CLOSED) return { status: "not-closed-at-commit", transition: wrapperSorted[i] };
    }
    return { status: "no-closed-transition", transition: null };
  }
  if (latest.from === Regime.UNKNOWN) return { status: "first-attestation", transition: latest };
  return { status: "known", transition: latest };
}

/** The same rule over a mixed log (every wrapper), for callers that hold one. */
export function closureStartOf(
  sorted: readonly RegimeTransition[], lastScannedBlock: number,
  wrapper: string, committedAtS: number, committedBlock: number,
): ClosureStart {
  const w = wrapper.toLowerCase();
  return closureStartIn(sorted.filter((t) => t.wrapper.toLowerCase() === w), lastScannedBlock, committedAtS, committedBlock);
}

interface Persisted {
  schema: typeof REGIME_INDEX_SCHEMA;
  clock: string;
  startBlock: number;
  lastScannedBlock: number;
  transitions: RegimeTransition[];
}

type LogEntry = { blockNumber: string; logIndex: string; transactionHash: string; topics: string[]; data: string };

export function decodeRegimeChanged(l: LogEntry): RegimeTransition {
  const d = clockAbi.decodeEventLog("RegimeChanged", l.data, l.topics);
  // Positional, never by name: an ethers Result is an Array, so `d.at` is Array.prototype.at -- the event's
  // own `at` field is shadowed, and reading it by name silently yields NaN for every closure start.
  return {
    wrapper: getAddress(String(d[0])),
    from: Number(d[1]),
    to: Number(d[2]),
    at: Number(d[3]),
    block: Number(BigInt(l.blockNumber)),
    logIndex: Number(BigInt(l.logIndex)),
    tx: String(l.transactionHash).toLowerCase(),
  };
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const byPosition = (a: RegimeTransition, b: RegimeTransition) => a.block - b.block || a.logIndex - b.logIndex;

export class ClosureIndex {
  readonly path: string;
  readonly clock: string;
  readonly rpcs: string[];
  readonly startBlock: number;
  readonly confirmations: number;
  readonly concurrency: number;
  readonly maxChunksPerStep: number;
  private readonly rpc: EndpointRpc;
  private readonly now: () => number;
  private readonly log: Log;
  private lastScannedBlock: number;
  private transitions: RegimeTransition[] = [];
  /** Lower-cased wrapper -> its transitions, in log order: what a lookup searches. */
  private byWrapper = new Map<string, RegimeTransition[]>();
  private headBlock: number | null = null;
  private lastError: string | null = null;
  private lastStepAtMs: number | null = null;

  constructor(o: ClosureIndexOptions) {
    this.path = o.path;
    this.clock = getAddress(o.clock);
    this.rpcs = o.rpcs;
    this.startBlock = o.startBlock ?? MARKETCLOCK_FIRST_BLOCK;
    this.rpc = o.rpc ?? defaultRpc;
    this.confirmations = o.confirmations ?? 5;
    this.concurrency = Math.max(1, o.concurrency ?? 4);
    this.maxChunksPerStep = Math.max(1, o.maxChunksPerStep ?? 40);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? silentLog;
    this.lastScannedBlock = this.startBlock - 1;
  }

  /**
   * Resume from disk. A file for a different MarketClock or start block, or one that does not parse, is
   * discarded and the scan starts over: the index is derived data, and the chain can always rebuild it.
   */
  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const p = JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
      const ok = p.schema === REGIME_INDEX_SCHEMA && typeof p.clock === "string" && p.clock.toLowerCase() === this.clock.toLowerCase() &&
        p.startBlock === this.startBlock && Number.isInteger(p.lastScannedBlock) && p.lastScannedBlock >= this.startBlock - 1 &&
        Array.isArray(p.transitions) && p.transitions.every((t) => Number.isInteger(t.block) && t.block <= p.lastScannedBlock);
      if (!ok) { this.log("regime-index-reset", { reason: "persisted index is for a different clock or start block, or malformed" }); return; }
      this.lastScannedBlock = p.lastScannedBlock;
      this.transitions = p.transitions.slice().sort(byPosition);
      this.regroup();
    } catch (e) {
      this.log("regime-index-reset", { reason: `unreadable: ${describe(e)}` });
    }
  }

  private regroup(): void {
    this.byWrapper = new Map();
    for (const t of this.transitions) {
      const k = t.wrapper.toLowerCase();
      const g = this.byWrapper.get(k);
      if (g) g.push(t); else this.byWrapper.set(k, [t]);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const p: Persisted = {
      schema: REGIME_INDEX_SCHEMA, clock: this.clock, startBlock: this.startBlock,
      lastScannedBlock: this.lastScannedBlock, transitions: this.transitions,
    };
    persistReplace(this.path, JSON.stringify(p));
  }

  status(): ClosureIndexStatus {
    const target = this.headBlock === null ? null : this.headBlock - this.confirmations;
    const remaining = target === null ? null : Math.max(0, target - this.lastScannedBlock);
    const span = target === null ? null : Math.max(1, target - (this.startBlock - 1));
    return {
      startBlock: this.startBlock,
      lastScannedBlock: this.lastScannedBlock,
      headBlock: this.headBlock,
      caughtUp: remaining === 0,
      blocksRemaining: remaining,
      progressPct: remaining === null || span === null ? null : Math.floor(((span - remaining) / span) * 1000) / 10,
      transitions: this.transitions.length,
      lastError: this.lastError,
      lastStepAtMs: this.lastStepAtMs,
    };
  }

  closureStart(wrapper: string, committedAtS: number, committedBlock: number): ClosureStart {
    return closureStartIn(this.byWrapper.get(wrapper.toLowerCase()) ?? [], this.lastScannedBlock, committedAtS, committedBlock);
  }

  /** Each endpoint's head, -1 when it did not answer. */
  private async heads(): Promise<number[]> {
    return Promise.all(this.rpcs.map((url) =>
      this.rpc(url, "eth_blockNumber", []).then((h) => Number(BigInt(String(h))), () => -1)));
  }

  /**
   * One chunk, asked only of endpoints whose head has reached its end, starting from a different endpoint
   * per chunk so a batch spreads across them. Throws with every endpoint's reason when none could serve it.
   */
  private async chunk(from: number, to: number, heads: number[], k: number): Promise<RegimeTransition[]> {
    const reasons: string[] = [];
    for (let j = 0; j < this.rpcs.length; j++) {
      const i = (k + j) % this.rpcs.length;
      const url = this.rpcs[i];
      // Endpoints are named by endpointLabel, never by URL: this string is lastError, served by /healthz.
      if (heads[i] < to) { reasons.push(`${endpointLabel(url, i)} head ${heads[i]} < ${to}`); continue; }
      try {
        const logs = await this.rpc(url, "eth_getLogs", [{
          address: this.clock, topics: [REGIME_CHANGED],
          fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        }]);
        if (!Array.isArray(logs)) throw new Error("eth_getLogs returned a non-array");
        return (logs as LogEntry[]).map(decodeRegimeChanged);
      } catch (e) {
        reasons.push(`${endpointLabel(url, i)}: ${describe(e)}`);
      }
    }
    throw new Error(`no RPC could serve RegimeChanged logs for ${from}..${to}: ${reasons.join(" | ")}`);
  }

  /**
   * One batch: up to maxChunksPerStep chunks toward (best head - confirmations), `concurrency` at a time.
   * Advances over the contiguous prefix that succeeded and persists it; a failed chunk is reported in
   * lastError and re-asked on the next step.
   */
  async step(): Promise<{ caughtUp: boolean; scannedTo: number; added: number; error: string | null }> {
    this.lastStepAtMs = this.now();
    const heads = await this.heads();
    const best = Math.max(...heads);
    if (best < 0) {
      this.lastError = "no RPC returned a head";
      return { caughtUp: false, scannedTo: this.lastScannedBlock, added: 0, error: this.lastError };
    }
    this.headBlock = Math.max(this.headBlock ?? 0, best);
    const target = best - this.confirmations;
    if (this.lastScannedBlock >= target) {
      this.lastError = null;
      return { caughtUp: true, scannedTo: this.lastScannedBlock, added: 0, error: null };
    }

    const chunks: Array<[number, number]> = [];
    for (let b = this.lastScannedBlock + 1; b <= target && chunks.length < this.maxChunksPerStep; b += LOG_RANGE) {
      chunks.push([b, Math.min(b + LOG_RANGE - 1, target)]);
    }
    const results: Array<RegimeTransition[] | Error | undefined> = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      for (let k = next++; k < chunks.length; k = next++) {
        try { results[k] = await this.chunk(chunks[k][0], chunks[k][1], heads, k); } catch (e) { results[k] = e instanceof Error ? e : new Error(String(e)); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));

    const seen = new Set(this.transitions.map((t) => `${t.block}:${t.logIndex}`));
    const before = this.lastScannedBlock;
    let added = 0;
    let error: string | null = null;
    for (let k = 0; k < chunks.length; k++) {
      const r = results[k];
      if (!r || r instanceof Error) { error = r ? describe(r) : "chunk not attempted"; break; }
      for (const t of r) {
        const key = `${t.block}:${t.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.transitions.push(t);
        added++;
      }
      this.lastScannedBlock = chunks[k][1];
    }
    if (added) { this.transitions.sort(byPosition); this.regroup(); }
    if (this.lastScannedBlock !== before) this.persist();
    this.lastError = error;
    return { caughtUp: error === null && this.lastScannedBlock >= target, scannedTo: this.lastScannedBlock, added, error };
  }

  /**
   * The background loop: batches back to back while behind (a short gap between them keeps it polite to
   * the public RPCs), one step per idleMs once caught up, and exponential backoff on failure. Nothing
   * awaits it; requests only ever read status() and closureStart().
   */
  async run(o: { signal?: AbortSignal; idleMs?: number; busyGapMs?: number; maxBackoffMs?: number } = {}): Promise<void> {
    const idleMs = o.idleMs ?? 30_000;
    const busyGapMs = o.busyGapMs ?? 250;
    const maxBackoffMs = o.maxBackoffMs ?? 300_000;
    let backoff = 0;
    let reportedCaughtUp = false;
    while (!o.signal?.aborted) {
      let wait: number;
      try {
        const r = await this.step();
        if (r.error) {
          backoff = Math.min(maxBackoffMs, backoff ? backoff * 2 : 5_000);
          this.log("regime-index-error", { error: r.error, scannedTo: r.scannedTo, retryInMs: backoff });
          wait = backoff;
        } else {
          backoff = 0;
          if (r.caughtUp && !reportedCaughtUp) { reportedCaughtUp = true; this.log("regime-index-caught-up", { lastScannedBlock: r.scannedTo, transitions: this.transitions.length }); }
          wait = r.caughtUp ? idleMs : busyGapMs;
        }
      } catch (e) {
        backoff = Math.min(maxBackoffMs, backoff ? backoff * 2 : 5_000);
        this.lastError = describe(e);
        this.log("regime-index-error", { error: this.lastError, retryInMs: backoff });
        wait = backoff;
      }
      await sleep(wait, o.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", done); resolve(); }, ms);
    const done = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", done, { once: true });
  });
}
