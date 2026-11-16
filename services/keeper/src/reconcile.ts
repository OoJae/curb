/**
 * Reconciling the keeper's books against Scorecard every tick (deploy 2, W5.5; tick step 5, before both passes).
 *
 * The keeper is the only settler, so a row it wrongly believes settled is a row nobody grades (row 151: the
 * settle reverted, the keeper recorded success, the six-hour window passed). Each tick it reads, at the pinned
 * block and with its own 5 s deadline, `settlements(id)` for every row it still owes and every row it settled
 * in the last 24 hours, and `commitments(id)` for every open closure it believes is on chain:
 *
 * - a pending row the chain shows settled is settled without a send (`settledOnChain`);
 * - a recent row the chain shows NOT settled goes back to pending while its window is open (`reopened`), or
 *   is expired once it has closed (`lostAfterWindow`);
 * - an open closure recorded on chain whose commitment is empty is un-committed so its frozen plan is retried
 *   while the commit window allows (`commitMissing`); the retry's simulation answers `ClosureExists` if it did
 *   mine after all.
 * - an open closure whose plan was sent (attempts > 0) but is not recorded as committed is read too (review F2): an
 *   attempt that timed out and mined, or a crash between a mined commit and its save, leaves `committed` unset, and
 *   below COMMIT_FLOOR_S no further simulation would ever answer `ClosureExists`. A non-zero commitment cannot come
 *   from a stale read, so one read adopts it (`planOnChain`), before the per-asset loop can close or abandon the
 *   closure. A zero read (`planNotOnChain`) is what lets that loop abandon such a closure.
 *
 * A read can be older than what it is compared with (CO m1): an id whose receipt block is known is skipped
 * until the read is at least 10 blocks past it, and a disagreement acts only when two consecutive reconciled
 * ticks show it. A read that failed changes nothing and resets nothing. There is no closure-count arithmetic
 * (CO m2): `closureCount` is shown on /healthz beside the keeper's own counts, and judged by a person.
 *
 * Deferred to deploy 3 (CO M3): adopting unsettled on-chain rows the keeper does not hold.
 */
import { multicallAt } from "./sources/chain.ts";
import type { Call, CallResult, MulticallSnapshot, PinnedBlock } from "./sources/chain.ts";
import { scorecardAbi } from "./sources/scorecard.ts";
import { settleWindow, SETTLE_SEND_MARGIN_S } from "./outcome.ts";

/** A row this keeper settled, kept 24 h and re-checked on chain (`State.recent`). */
export interface SettledRef {
  id: string;
  root: string;
  symbol: string;
  settleAfterS: number;
  /** The settle transaction; "" when the chain settled it (someone else, or a receipt we never saw). */
  tx: string;
  /** Receipt block, when known. */
  block?: number;
  atMs: number;
  /** Optional, so a row the chain says is not settled can be put back in `pending` and keep its attempt numbering. */
  wrapper?: string;
  cutBlock?: number;
  attempts?: number;
  by?: "keeper" | "chain";
}

/** A row whose settle window closed unsettled (`State.expired`, last 50). */
export interface ExpiredRef {
  id: string;
  root: string;
  symbol: string;
  settleAfterS: number;
  reason: "window-closed" | "unknown-closure";
  atMs: number;
}

export interface CommittedLike { id: string; root: string; settleAfterS: number; onChain: boolean; txHash?: string; block?: number }
export interface RowLike {
  wrapper: string;
  symbol: string;
  cutBlock: number;
  committed?: CommittedLike;
  plan?: { id: string; attempts: number };
  settled?: unknown;
  settleAttempts?: number;
}
export interface StateLike<R extends RowLike = RowLike> {
  open: Record<string, R>;
  pending: R[];
  recent?: SettledRef[];
  expired?: ExpiredRef[];
}

export interface ChainBook { atBlock: number; settled: Map<string, boolean | null>; committedAt: Map<string, bigint | null> }
export interface Corrections {
  settledOnChain: string[];        // pending ids the chain shows settled: settle without sending
  reopened: string[];              // recent ids the chain shows NOT settled inside their window: back to pending
  lostAfterWindow: string[];       // recent ids not settled and past the window: expire
  commitMissing: string[];         // open ids recorded on chain whose commitments(id).committedAt == 0
  planOnChain: string[];           // plan ids of open closures sent but not recorded, whose commitment exists: adopt
  planNotOnChain: string[];        // plan ids of open closures sent but not recorded, read as absent at this block
}

export const RECENT_KEEP_MS = 24 * 3_600_000;
export const EXPIRED_KEEP = 50;
/** Recent rows read per tick, rotating; every pending row and every on-chain open closure is read every tick. */
export const RECONCILE_RECENT_CAP = 24;
export const RECONCILE_DEADLINE_MS = 5_000;
/** A read must be this many blocks past a known receipt block before it can disagree with it (CO m1). */
export const RECONCILE_CONFIRM_BLOCKS = 10;
/** Consecutive reconciled ticks that must show the same disagreement before it acts. */
export const RECONCILE_STREAK = 2;

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------

const lc = (s: string) => s.toLowerCase();

/** `closureCount()`, appended to the tick multicall under label `closureCount` (for /healthz only). */
export function closureCountCall(scorecard: string): Call {
  return { label: "closureCount", target: scorecard, callData: scorecardAbi.encodeFunctionData("closureCount") };
}

export function decodeClosureCount(r: CallResult | undefined): number | null {
  if (!r?.success || !r.returnData || r.returnData === "0x") return null;
  try { return Number(scorecardAbi.decodeFunctionResult("closureCount", r.returnData)[0]); } catch { return null; }
}

/**
 * The reconciliation reads for this tick: `commitment:<id>` for every open closure recorded on chain,
 * `settlement:<id>` for every pending on-chain row, and for up to `cap` recent rows, rotating through them
 * with `cursor` so a long list is still read in full every few ticks. One call per id.
 */
export function reconcileCalls(state: StateLike, scorecard: string, cursor: { recent: number }, cap = RECONCILE_RECENT_CAP): Call[] {
  const calls = new Map<string, Call>();
  const settlement = (id: string) => {
    const label = `settlement:${lc(id)}`;
    if (!calls.has(label)) calls.set(label, { label, target: scorecard, callData: scorecardAbi.encodeFunctionData("settlements", [id]) });
  };
  for (const c of Object.values(state.open)) {
    const id = c.committed?.onChain ? c.committed.id : (!c.committed && c.plan && c.plan.attempts > 0 ? c.plan.id : null);
    if (id === null) continue;
    const label = `commitment:${lc(id)}`;
    if (!calls.has(label)) calls.set(label, { label, target: scorecard, callData: scorecardAbi.encodeFunctionData("commitments", [id]) });
  }
  for (const c of state.pending) if (c.committed?.onChain && !c.settled) settlement(c.committed.id);
  const recent = state.recent ?? [];
  if (recent.length > 0 && cap > 0) {
    const n = Math.min(cap, recent.length);
    const start = ((cursor.recent % recent.length) + recent.length) % recent.length;
    for (let k = 0; k < n; k++) settlement(recent[(start + k) % recent.length].id);
    cursor.recent = (start + n) % recent.length;
  }
  return [...calls.values()];
}

/** Decode a reconciliation snapshot. Anything that did not succeed or does not decode is `null`: unknown. */
export function bookFrom(snap: MulticallSnapshot): ChainBook {
  const book: ChainBook = { atBlock: snap.block.number, settled: new Map(), committedAt: new Map() };
  const usable = (r: CallResult) => r.success && !!r.returnData && r.returnData !== "0x";
  for (const r of snap.results) {
    if (r.label.startsWith("settlement:")) {
      const id = r.label.slice("settlement:".length);
      let v: boolean | null = null;
      if (usable(r)) { try { v = Boolean(scorecardAbi.decodeFunctionResult("settlements", r.returnData).settled); } catch { v = null; } }
      book.settled.set(id, v);
    } else if (r.label.startsWith("commitment:")) {
      const id = r.label.slice("commitment:".length);
      let v: bigint | null = null;
      if (usable(r)) { try { v = BigInt(scorecardAbi.decodeFunctionResult("commitments", r.returnData).committedAt); } catch { v = null; } }
      book.committedAt.set(id, v);
    }
  }
  return book;
}

/** Race `p` against a deadline. A late failure of `p` after the deadline is swallowed, never unhandled. */
export function withDeadline<T>(p: Promise<T>, ms: number, what = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded its ${ms} ms deadline`)), ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** One multicall at the pinned block, raced against `ms`. Throws on timeout or failure: the caller logs `reconcile-skipped`. */
export async function readChainBook(
  block: PinnedBlock, calls: Call[], rpcs: string[], ms = RECONCILE_DEADLINE_MS,
  mc: (b: PinnedBlock, c: Call[], r: string[]) => Promise<MulticallSnapshot> = multicallAt,
): Promise<ChainBook> {
  if (calls.length === 0) return { atBlock: block.number, settled: new Map(), committedAt: new Map() };
  return bookFrom(await withDeadline(mc(block, calls, rpcs), ms, "reconcile multicall"));
}

// ---------------------------------------------------------------------------------------------
// the decision (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Compare the books with the chain. `streak` lives in memory across ticks (keys `settle:<id>`, `commit:<id>`);
 * it is advanced only by a usable read that disagrees, reset by a usable read that agrees, and left alone by a
 * missing or failed read. `chainNowS` is the pinned block's timestamp.
 */
export function reconcile(state: StateLike, book: ChainBook, chainNowS: number, settleDelayS: number, streak: Map<string, number>): Corrections {
  const out: Corrections = { settledOnChain: [], reopened: [], lostAfterWindow: [], commitMissing: [], planOnChain: [], planNotOnChain: [] };
  const fresh = (block: number | undefined) => block === undefined || book.atBlock >= block + RECONCILE_CONFIRM_BLOCKS;
  const tracked = new Set<string>();

  for (const c of state.pending) {
    if (!c.committed?.onChain || c.settled) continue;
    const id = c.committed.id;
    tracked.add(`settle:${lc(id)}`);
    if (!fresh(c.committed.block)) continue;
    // A usable "settled" read is never stale-wrong (a settle cannot be undone), so one read suffices.
    if (book.settled.get(lc(id)) === true && !out.settledOnChain.includes(id)) out.settledOnChain.push(id);
  }

  for (const r of state.recent ?? []) {
    const key = `settle:${lc(r.id)}`;
    tracked.add(key);
    const s = book.settled.get(lc(r.id));
    if (s === undefined || s === null) continue;          // not read, or the read failed: nothing changes
    if (!fresh(r.block)) continue;                        // too close to its own receipt block: not counted
    if (s === true) { streak.delete(key); continue; }
    const n = (streak.get(key) ?? 0) + 1;
    streak.set(key, n);
    if (n < RECONCILE_STREAK) continue;
    streak.delete(key);
    const { deadline } = settleWindow(r.settleAfterS, settleDelayS);
    if (chainNowS <= deadline - SETTLE_SEND_MARGIN_S) out.reopened.push(r.id);
    else out.lostAfterWindow.push(r.id);
  }

  for (const c of Object.values(state.open)) {
    if (!c.committed && c.plan && c.plan.attempts > 0) {
      // Sent, not recorded: a non-zero commitment is never a stale read, so one read is enough either way.
      const at = book.committedAt.get(lc(c.plan.id));
      if (at === undefined || at === null) continue;
      (at !== 0n ? out.planOnChain : out.planNotOnChain).push(c.plan.id);
      continue;
    }
    if (!c.committed?.onChain) continue;
    const key = `commit:${lc(c.committed.id)}`;
    tracked.add(key);
    const at = book.committedAt.get(lc(c.committed.id));
    if (at === undefined || at === null) continue;
    if (!fresh(c.committed.block)) continue;
    if (at !== 0n) { streak.delete(key); continue; }
    const n = (streak.get(key) ?? 0) + 1;
    streak.set(key, n);
    if (n < RECONCILE_STREAK) continue;
    streak.delete(key);
    out.commitMissing.push(c.committed.id);
  }

  for (const k of [...streak.keys()]) if (!tracked.has(k)) streak.delete(k);   // bounded by what is tracked
  return out;
}

// ---------------------------------------------------------------------------------------------
// the books
// ---------------------------------------------------------------------------------------------

/** Drop `recent` entries older than 24 hours. */
export function pruneRecent(state: { recent?: SettledRef[] }, nowMs: number): void {
  if (!state.recent) return;
  state.recent = state.recent.filter((r) => nowMs - r.atMs < RECENT_KEEP_MS);
}

/** Add a settled row to `recent` (replacing any entry for the same id). The caller removes it from `pending`. */
export function recordSettled(
  state: { recent?: SettledRef[] }, row: RowLike & { committed: CommittedLike },
  how: { tx: string; block?: number; atMs: number; by: "keeper" | "chain" },
): SettledRef {
  const ref: SettledRef = {
    id: row.committed.id, root: row.committed.root, symbol: row.symbol, settleAfterS: row.committed.settleAfterS,
    tx: how.tx, ...(how.block !== undefined ? { block: how.block } : {}), atMs: how.atMs,
    wrapper: row.wrapper, cutBlock: row.cutBlock, attempts: row.settleAttempts ?? 0, by: how.by,
  };
  state.recent = [...(state.recent ?? []).filter((r) => lc(r.id) !== lc(ref.id)), ref];
  pruneRecent(state, how.atMs);
  return ref;
}

/** Add a row to `expired` (the last 50 are kept). The caller removes it from `pending` or `recent`. */
export function recordExpired(
  state: { expired?: ExpiredRef[] },
  row: { symbol: string; committed: { id: string; root: string; settleAfterS: number } },
  reason: ExpiredRef["reason"], atMs: number,
): ExpiredRef {
  const ref: ExpiredRef = { id: row.committed.id, root: row.committed.root, symbol: row.symbol, settleAfterS: row.committed.settleAfterS, reason, atMs };
  state.expired = [...(state.expired ?? []), ref].slice(-EXPIRED_KEEP);
  return ref;
}

/** The fields a recent entry carries for a row put back in `pending`; main.ts fills the rest of its Closure. */
export function rowFromRecent(ref: SettledRef): RowLike & { committed: CommittedLike & { txHash: string; atMs: number }; settleAttempts: number } {
  return {
    wrapper: ref.wrapper ?? "", symbol: ref.symbol, cutBlock: ref.cutBlock ?? 0, settleAttempts: ref.attempts ?? 0,
    committed: {
      id: ref.id, root: ref.root, settleAfterS: ref.settleAfterS, onChain: true, txHash: ref.tx, atMs: ref.atMs,
      ...(ref.block !== undefined ? { block: ref.block } : {}),
    },
  };
}

export interface ApplyReport { settled: number; reopened: number; expired: number; uncommitted: number; commitLost: number; adopted: number }

/**
 * Apply the corrections to the books. Effects go through `d`, so main.ts keeps its types and its file store:
 * - settledOnChain: settled (`by: "chain"`), to `recent`, swap file deleted; log `settled-by-other`.
 * - reopened: back to `pending` (through `d.revive`); sev-1 `keeper:books-disagree:<id>`.
 * - lostAfterWindow: to `expired`; sev-1 `keeper:books-disagree:<id>`.
 * - commitMissing: sev-1 `keeper:books-disagree:<id>`; `committed` deleted when `d.canRetryCommit` (a plan
 *   exists and toReopenS >= COMMIT_FLOOR_S), else log `commit-lost`.
 * - planOnChain: `d.adoptPlan(row)` records the commitment from the frozen plan (it is our row: the id comes from our
 *   own bundle root); sev-2 `keeper:commit-found:<symbol>`.
 * The alarm keys carry the id so two rows disagreeing in one tick both page (the queue coalesces by key).
 */
export function applyCorrections<R extends RowLike>(
  state: StateLike<R>, corr: Corrections,
  d: {
    nowMs: number;
    canRetryCommit(row: R): boolean;
    revive(ref: SettledRef): R;
    adoptPlan?(row: R): void;
    remove(row: { wrapper: string; cutBlock: number }): void;
    raise(sev: 1 | 2, key: string, message: string): void;
    log(event: string, fields?: Record<string, unknown>): void;
  },
): ApplyReport {
  const rep: ApplyReport = { settled: 0, reopened: 0, expired: 0, uncommitted: 0, commitLost: 0, adopted: 0 };
  const removeFile = (row: { wrapper?: string; cutBlock?: number; symbol: string }) => {
    if (!row.wrapper || row.cutBlock === undefined || row.cutBlock === 0) return;
    try { d.remove({ wrapper: row.wrapper, cutBlock: row.cutBlock }); }
    catch (e) { d.log("swap-file-remove-failed", { symbol: row.symbol, cutBlock: row.cutBlock, error: e instanceof Error ? e.message : String(e) }); }
  };

  for (const id of corr.settledOnChain) {
    const i = state.pending.findIndex((c) => c.committed && lc(c.committed.id) === lc(id));
    if (i < 0) continue;
    const row = state.pending[i] as R & { committed: CommittedLike };
    state.pending.splice(i, 1);
    recordSettled(state, row, { tx: "", atMs: d.nowMs, by: "chain" });
    removeFile(row);
    d.log("settled-by-other", { symbol: row.symbol, id: row.committed.id, via: "reconcile" });
    rep.settled++;
  }

  for (const id of corr.reopened) {
    const ref = (state.recent ?? []).find((r) => lc(r.id) === lc(id));
    if (!ref) continue;
    state.recent = (state.recent ?? []).filter((r) => r !== ref);
    state.pending.push(d.revive(ref));
    d.log("books-disagree", { kind: "settle", symbol: ref.symbol, id: ref.id, tx: ref.tx, action: "back-to-pending" });
    d.raise(1, `keeper:books-disagree:${ref.id}`,
      `row ${ref.id} (${ref.symbol}) was recorded settled (tx ${ref.tx || "none"}) but Scorecard shows it unsettled; it is back in pending and will be settled again`);
    rep.reopened++;
  }

  for (const id of corr.lostAfterWindow) {
    const ref = (state.recent ?? []).find((r) => lc(r.id) === lc(id));
    if (!ref) continue;
    state.recent = (state.recent ?? []).filter((r) => r !== ref);
    recordExpired(state, { symbol: ref.symbol, committed: ref }, "window-closed", d.nowMs);
    d.log("books-disagree", { kind: "settle", symbol: ref.symbol, id: ref.id, tx: ref.tx, action: "expired" });
    d.raise(1, `keeper:books-disagree:${ref.id}`,
      `row ${ref.id} (${ref.symbol}) was recorded settled (tx ${ref.tx || "none"}) but Scorecard shows it unsettled, and its settle window has closed`);
    rep.expired++;
  }

  for (const id of corr.commitMissing) {
    const row = Object.values(state.open).find((c) => c.committed && lc(c.committed.id) === lc(id));
    if (!row || !row.committed) continue;
    const retry = d.canRetryCommit(row);
    d.raise(1, `keeper:books-disagree:${row.committed.id}`,
      `${row.symbol} commit ${row.committed.id} is recorded on chain but Scorecard has no commitment for it; ${retry ? "retrying the frozen plan" : "too late to retry"}`);
    if (retry) {
      d.log("books-disagree", { kind: "commit", symbol: row.symbol, id: row.committed.id, tx: row.committed.txHash ?? "", action: "retry-plan" });
      delete row.committed;
      rep.uncommitted++;
    } else {
      d.log("commit-lost", { symbol: row.symbol, id: row.committed.id, tx: row.committed.txHash ?? "", cutBlock: row.cutBlock });
      rep.commitLost++;
    }
  }

  for (const id of corr.planOnChain) {
    const row = Object.values(state.open).find((c) => !c.committed && c.plan && lc(c.plan.id) === lc(id));
    if (!row || !d.adoptPlan) continue;
    d.adoptPlan(row);
    if (!row.committed) continue;
    d.raise(2, `keeper:commit-found:${row.symbol}`,
      `${row.symbol} commit ${id} is on chain although no attempt reported it mined (a timeout, or a restart before its save); recorded, it will be settled`);
    rep.adopted++;
  }

  pruneRecent(state, d.nowMs);
  return rep;
}
