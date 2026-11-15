/**
 * Transaction outcomes (deploy 2, W5): the one send path, and what each outcome does to the books.
 *
 * Two defects in how HEAD used the Sender (PM section 9), both fixed here at the call site because
 * `tx/sender.ts` must stay byte-identical with the attestor's:
 *
 * 1. `broadcastAndWait` returns the receipt whatever its status. HEAD never read `receipt.status`, so a
 *    settle that reverted on chain (row 151: `PriceDeviates`, status 0, 28 Oct 01:35:06Z) was recorded as
 *    settled, never retried, and the row could never be graded. Here status 1 is the only success.
 * 2. After STUCK_MS a new `prepare` re-uses a stuck row's nonce, and if the OLDER transaction then mines,
 *    `broadcastAndWait` returns the older receipt (`sender.ts:447-455`). For the attestor both are rounds; for
 *    the keeper they can be a settle of one row and a commit of another, and HEAD would record the commit as
 *    on chain, later be refused `UnknownClosure` and lose the row. Here that receipt is `superseded`, and it
 *    counts for the caller only when the older transaction was an earlier attempt of the SAME frozen plan.
 *
 * Contract windows, read from `src/Scorecard.sol` and confirmed on chain at 0x3b40...Ef1f (15 Nov):
 * - `commit` has no time window of its own; it reverts `BadMark`, `MarketStillOpen`, `NoPriceSource`,
 *   `ClosureExists(id)` and `NotKeeper`. The keeper's window is COMMIT_FLOOR_S <= toReopenS <= COMMIT_LEAD_S.
 * - `settle` reverts `TooEarly(id, readyAt)` below readyAt = settleAfter + SETTLE_DELAY (300) and
 *   `TooLate(id, deadline)` above deadline = readyAt + SETTLE_WINDOW (21,600); both ends are inclusive. It is
 *   permissionless: any funded key may settle, so `isKeeper` is never a reason to hold a settle (CO m6).
 */
import { Interface } from "ethers";
import { RevertedInSimulation, PendingUnresolved } from "./tx/sender.ts";
import type { Sender, Prepared, Receipt, RpcFn } from "./tx/sender.ts";

// ---------------------------------------------------------------------------------------------
// Scorecard's custom errors: what the Sender decodes a refused simulation with
// ---------------------------------------------------------------------------------------------

/** Every custom error `commit` and `settle` can raise (src/Scorecard.sol:49-71), for the Sender's errorInterface. */
export const SCORECARD_ERRORS = [
  "error NotKeeper()", "error BadMark()", "error MarketStillOpen(address wrapper)", "error MarketStillShut(address wrapper)",
  "error ClosureExists(bytes32 id)", "error UnknownClosure(bytes32 id)", "error AlreadySettled(bytes32 id)",
  "error TooEarly(bytes32 id, uint64 readyAt)", "error TooLate(bytes32 id, uint64 deadline)", "error NoPriceSource(address wrapper)",
  "error PriceDeviates(int24 spotTick, int24 twapTick)", "error PriceUnreadable(address pool)",
] as const;

export const scorecardErrors = new Interface([...SCORECARD_ERRORS]);

/**
 * Selectors of the errors this module acts on, so a reason that reached us undecoded (an errorInterface
 * without them) is still classified. Pinned by a test against `cast sig` (15 Nov).
 */
const SELECTOR = {
  ClosureExists: "0x234ecc22",
  AlreadySettled: "0xb196a44a",
  TooLate: "0x065f328e",
  UnknownClosure: "0xf4ba97e7",
  NoPriceSource: "0xdceb16d7",
} as const;

const isError = (reason: string, name: keyof typeof SELECTOR) =>
  new RegExp(`^${name}\\b`).test(reason) || reason.toLowerCase().startsWith(SELECTOR[name]);

// ---------------------------------------------------------------------------------------------
// sendOnce: the only send path
// ---------------------------------------------------------------------------------------------

export type SendOutcome =
  | { kind: "mined"; hash: string; block: number }                        // status 1, our tx or our own 12 s fee bump
  | { kind: "reverted"; hash: string; block: number }                     // status 0, our tx
  | { kind: "superseded"; hash: string; block: number; status: number; replacedId: string }  // the older tx at our nonce mined
  | { kind: "refused"; reason: string }                                   // RevertedInSimulation (decoded through errorInterface)
  | { kind: "pending"; message: string }                                  // PendingUnresolved
  | { kind: "error"; message: string };                                   // timeout, no RPC accepted, RPC failure

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Prepare (simulate, sign) and broadcast one transaction, and say what happened to it. Never throws.
 *
 * `main.ts` must not call `broadcastAndWait` anywhere else (a wiring test pins it).
 */
export async function sendOnce(
  s: Pick<Sender, "prepare" | "broadcastAndWait">, to: string, data: string,
  meta: { id: string; kind: string; targetMs: number },
): Promise<SendOutcome> {
  let p: Prepared;
  try { p = await s.prepare(to, data, meta); }
  catch (e) {
    if (e instanceof RevertedInSimulation) return { kind: "refused", reason: e.reason };
    if (e instanceof PendingUnresolved) return { kind: "pending", message: e.message };
    return { kind: "error", message: msg(e) };
  }
  let r: Receipt;
  try { r = await s.broadcastAndWait(p); } catch (e) { return { kind: "error", message: msg(e) }; }
  // PM 9.2: when the stuck transaction this one replaced is the one that mined, the Sender hands back ITS receipt.
  if (p.replaces && r.hash.toLowerCase() === p.replaces.hash.toLowerCase()) {
    return { kind: "superseded", hash: r.hash, block: r.blockNumber, status: r.status, replacedId: p.replaces.id };
  }
  // Anything else is ours: the original hash or our own fee bump (a different hash at our nonce, same calldata).
  return r.status === 1 ? { kind: "mined", hash: r.hash, block: r.blockNumber }
                        : { kind: "reverted", hash: r.hash, block: r.blockNumber };
}

// ---------------------------------------------------------------------------------------------
// maxNonceRpc: the nonce race at the call site (KM 6.4)
// ---------------------------------------------------------------------------------------------

/**
 * Wrap the Sender's `rpc` so `eth_getTransactionCount` asks every endpoint at once and answers with the
 * HIGHEST count among those that answered by the time the slowest finished OR `graceMs` after the first
 * answer, whichever is sooner. `nextNonce` takes the first endpoint that answers, and twice a lagging one
 * returned an old count ("nonce too low" on 2 and 4 Nov). For an account nonce higher is always fresher, for
 * both `pending` and `latest`. A hanging endpoint costs at most `graceMs` once another has answered (CO B1).
 * Every other method passes straight through.
 */
export function maxNonceRpc(raw: RpcFn, rpcs: string[], graceMs = 1_500): RpcFn {
  return async (url, method, params) => {
    if (method !== "eth_getTransactionCount") return raw(url, method, params);
    const targets = rpcs.length > 0 ? rpcs : [url];
    const ns: bigint[] = [];
    const errs: unknown[] = [];
    await new Promise<void>((done) => {
      let left = targets.length;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = () => { if (--left === 0) { if (timer) clearTimeout(timer); done(); } };
      for (const u of targets) {
        let call: Promise<unknown>;
        try { call = Promise.resolve(raw(u, method, params)); } catch (e) { call = Promise.reject(e); }
        call.then(
          (v) => {
            try {
              ns.push(BigInt(v as string));
              if (!timer) timer = setTimeout(done, graceMs);
            } catch (e) { errs.push(e); }       // an unparseable answer is an error, never an unhandled rejection
            settle();
          },
          (e) => { errs.push(e); settle(); },
        );
      }
    });
    if (ns.length === 0) throw errs[0] instanceof Error ? errs[0] : new Error(`eth_getTransactionCount failed: ${String(errs[0])}`);
    return "0x" + ns.reduce((a, b) => (a > b ? a : b)).toString(16);
  };
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

/** The frozen commit (main.ts `CommitPlan`): built once, persisted before the first signature, reused byte for byte. */
export interface CommitPlan {
  root: string;
  id: string;
  settleAfterS: number;
  markE18: string;
  bandBps: number;
  /** The bare `commit` encoding; the Sender adds attribution per send. */
  data: string;
  /** Attempts made so far, persisted BEFORE each send, so a restart never re-uses an outbox id. */
  attempts: number;
}

/** A closure's commit record (main.ts `Committed`). `block` is new in deploy 2 and optional. */
export interface Committed {
  id: string;
  root: string;
  settleAfterS: number;
  markE18: string;
  bandBps: number;
  /** True once the row is on chain (or proved to be, by the contract refusing a duplicate). */
  onChain: boolean;
  txHash: string;
  atMs: number;
  /** Receipt block of the commit, when known (not after a `ClosureExists` proof). */
  block?: number;
}

export type AlarmSpec = [1 | 2, string, string];

export interface CommitAttemptResult {
  /** committed | already-onchain | superseded | reverted | pending | failed | persist-failed | skipped */
  result: string;
  /** The log event the caller writes: committed, commit-already-onchain, commit-superseded, commit-reverted, commit-failed, state-persist-failed. */
  event: string;
  fields: Record<string, unknown>;
  /** The caller raises it with `alarms.raise` (never awaited). */
  alarm?: AlarmSpec;
  outcome?: SendOutcome;
  /** The books changed but the save after the outcome failed; the caller logs it, the end-of-tick save retries. */
  saveError?: string;
}

/**
 * One commit attempt for one closure. The W6 property, in this order: `plan.attempts++`; `d.save()` (if it
 * throws: undo, `persist-failed`, NO send); send under id `commit:<root>:<attempts>`; apply the outcome; save
 * again if the books changed. At most one attempt per closure per tick is the caller's rule; the next
 * attempt's simulation settles every ambiguity (`ClosureExists` means an earlier attempt mined).
 */
export async function commitAttempt(
  c: { symbol: string; cutBlock: number; plan: CommitPlan; committed?: Committed },
  d: { save(): void; send(id: string): Promise<SendOutcome>; nowMs: number; lastChance: boolean },
): Promise<CommitAttemptResult> {
  const plan = c.plan;
  const base = { symbol: c.symbol, id: plan.id, root: plan.root };
  if (c.committed) {
    // Never a second send for a closure already recorded; the caller should not have asked.
    return { result: "skipped", event: "commit-skipped", fields: { ...base, reason: "already committed" } };
  }

  plan.attempts++;
  try { d.save(); }
  catch (e) {
    plan.attempts--;
    const error = msg(e);
    return {
      result: "persist-failed", event: "state-persist-failed",
      fields: { where: "commit-attempt", ...base, attempt: plan.attempts + 1, error },
      alarm: [1, "keeper:state-persist-failed", `cannot persist the commit attempt for ${c.symbol} (nothing was sent): ${error}`],
    };
  }

  const attempt = plan.attempts;
  const o = await d.send(`commit:${plan.root}:${attempt}`);
  const record = (txHash: string, block?: number) => {
    c.committed = {
      id: plan.id, root: plan.root, settleAfterS: plan.settleAfterS, markE18: plan.markE18, bandBps: plan.bandBps,
      onChain: true, txHash, atMs: d.nowMs, ...(block !== undefined ? { block } : {}),
    };
  };
  const committedFields = (tx: string, block: number | null, extra: Record<string, unknown> = {}) => ({
    ...base, settleAfter: new Date(plan.settleAfterS * 1000).toISOString(), mark: plan.markE18, band: plan.bandBps,
    tx, block, attempt, ...extra,
  });
  const failedAlarm = (why: string): AlarmSpec =>
    [1, `keeper:commit-failed:${c.symbol}:${c.cutBlock}`, `commit for ${c.symbol} failed: ${why}`];

  let out: CommitAttemptResult;
  switch (o.kind) {
    case "mined":
      record(o.hash, o.block);
      out = { result: "committed", event: "committed", fields: committedFields(o.hash, o.block), outcome: o };
      break;
    case "superseded":
      if (o.status === 1 && o.replacedId.startsWith(`commit:${plan.root}:`)) {
        // An earlier attempt of the SAME frozen plan mined: same calldata, same id. It is our row.
        record(o.hash, o.block);
        out = { result: "committed", event: "committed", fields: committedFields(o.hash, o.block, { viaReplaced: true, replacedId: o.replacedId }), outcome: o };
      } else {
        out = {
          result: "superseded", event: "commit-superseded",
          fields: { ...base, attempt, replacedId: o.replacedId, status: o.status, hash: o.hash, block: o.block }, outcome: o,
          alarm: [2, `keeper:commit-superseded:${c.symbol}`, `commit for ${c.symbol} did not mine: an older transaction at its nonce (${o.replacedId}, status ${o.status}) mined instead; retrying`],
        };
      }
      break;
    case "reverted":
      out = {
        result: "reverted", event: "commit-reverted", fields: { ...base, attempt, hash: o.hash, block: o.block }, outcome: o,
        alarm: [1, `keeper:commit-reverted:${c.symbol}:${c.cutBlock}`, `commit for ${c.symbol} reverted on chain (tx ${o.hash}, block ${o.block}); retrying while the window allows`],
      };
      break;
    case "refused":
      if (isError(o.reason, "ClosureExists")) {
        // The contract refusing a duplicate is proof an earlier attempt mined.
        record("");
        out = { result: "already-onchain", event: "commit-already-onchain", fields: { ...base, attempt }, outcome: o };
      } else {
        out = { result: "failed", event: "commit-failed", fields: { ...base, attempt, error: `refused: ${o.reason}` }, outcome: o, alarm: failedAlarm(`refused: ${o.reason}`) };
      }
      break;
    case "pending":
      out = {
        result: "pending", event: "commit-failed", fields: { ...base, attempt, error: o.message }, outcome: o,
        alarm: d.lastChance ? failedAlarm(o.message)
          : [2, `keeper:commit-pending:${c.symbol}`, `commit for ${c.symbol} waits on an unresolved transaction: ${o.message}`],
      };
      break;
    default:
      out = { result: "failed", event: "commit-failed", fields: { ...base, attempt, error: o.message }, outcome: o, alarm: failedAlarm(o.message) };
  }

  if (c.committed) {
    try { d.save(); } catch (e) { out.saveError = msg(e); }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// settles
// ---------------------------------------------------------------------------------------------

/** Scorecard.SETTLE_DELAY (src/Scorecard.sol:138); CFG.settleDelayS must equal it. */
export const SETTLE_DELAY_S = 300;
/** Scorecard.SETTLE_WINDOW (src/Scorecard.sol:141). */
export const SETTLE_WINDOW_S = 21_600;
/** Never send a settle in the last minute of its window: it could land after the deadline. */
export const SETTLE_SEND_MARGIN_S = 60;
/** Page when a settle is still owed this long after its window opened (5 of the 6 hours are left for a person). */
export const SETTLE_LATE_S = 3_600;
/** 0.0001 OKB: about 40 settles at 118,167 gas. */
export const SETTLE_MIN_BALANCE_WEI = 100_000_000_000_000n;

export function settleWindow(settleAfterS: number, settleDelayS: number) {
  const readyAt = settleAfterS + settleDelayS;
  return { readyAt, deadline: readyAt + SETTLE_WINDOW_S };
}

export type SettleRefusal = "done" | "expired" | "lost" | "wait" | "fault";

/**
 * What a refused settle simulation means.
 * `AlreadySettled` done; `TooLate` expired; `UnknownClosure` lost; `NoPriceSource` fault; `TooEarly`,
 * `MarketStillShut`, `PriceDeviates`, `PriceUnreadable` and anything undecoded wait (retry next tick).
 * A refusal is only ever reported when every endpoint refused (the Sender tries the next RPC on any error),
 * so one lagging node cannot by itself make a live row look unknown.
 */
export function classifySettleRefusal(reason: string): SettleRefusal {
  const r = String(reason).trim();
  if (isError(r, "AlreadySettled")) return "done";
  if (isError(r, "TooLate")) return "expired";
  if (isError(r, "UnknownClosure")) return "lost";
  if (isError(r, "NoPriceSource")) return "fault";
  return "wait";
}

/** Settles need gas and a key, not `isKeeper` (settle is permissionless, CO m6). */
export function canSettle(mode: string, hasSender: boolean, balanceWei: bigint | null): boolean {
  return mode === "live" && hasSender && balanceWei !== null && balanceWei >= SETTLE_MIN_BALANCE_WEI;
}

export type SettleStep =
  | { action: "keep"; why: "shadow" | "too-early" | "cannot-send" }
  | { action: "drop-shadow" }
  | { action: "expire"; reason: "window-closed"; alarm: AlarmSpec }
  | { action: "send" };

/**
 * The decision for one pending row before any send, on chain time (`chainNowS` = the pinned block's
 * timestamp: the contract compares `block.timestamp`, not the VPS clock).
 */
export function settleStep(
  row: { symbol: string; committed: { id: string; onChain: boolean; settleAfterS: number } },
  chainNowS: number, settleDelayS: number, canSend: boolean,
): SettleStep {
  const { readyAt, deadline } = settleWindow(row.committed.settleAfterS, settleDelayS);
  if (!row.committed.onChain) return chainNowS > deadline ? { action: "drop-shadow" } : { action: "keep", why: "shadow" };
  if (chainNowS < readyAt) return { action: "keep", why: "too-early" };
  if (chainNowS > deadline - SETTLE_SEND_MARGIN_S) {
    return {
      action: "expire", reason: "window-closed",
      alarm: [1, `keeper:settle-expired:${row.committed.id}`, `row ${row.committed.id} (${row.symbol}) was never settled; its settle window closed at ${new Date(deadline * 1000).toISOString()}`],
    };
  }
  if (!canSend) return { action: "keep", why: "cannot-send" };
  return { action: "send" };
}

export type SettleVerdict =
  | { books: "settled"; by: "keeper" | "chain"; tx: string; block?: number; event: "settled" | "settled-by-other"; fields: Record<string, unknown> }
  | { books: "keep"; event: "settle-superseded" | "settle-reverted" | "settle-fault" | "settle-retry"; fields: Record<string, unknown>; alarm?: AlarmSpec }
  | { books: "expire"; reason: "window-closed" | "unknown-closure"; event: "settle-expired" | "commit-lost"; fields: Record<string, unknown>; alarm: AlarmSpec };

/** What a settle attempt's outcome does to the books (W5.4). `attempt` is the attempt number that was sent. */
export function settleOutcome(o: SendOutcome, row: { symbol: string; committed: { id: string; root: string } }, attempt: number): SettleVerdict {
  const { id, root } = row.committed;
  const base = { symbol: row.symbol, id, attempt };
  switch (o.kind) {
    case "mined":
      return { books: "settled", by: "keeper", tx: o.hash, block: o.block, event: "settled", fields: { ...base, tx: o.hash, block: o.block } };
    case "superseded":
      if (o.status === 1 && o.replacedId.startsWith(`settle:${root}:`)) {
        return { books: "settled", by: "keeper", tx: o.hash, block: o.block, event: "settled", fields: { ...base, tx: o.hash, block: o.block, viaReplaced: true, replacedId: o.replacedId } };
      }
      return {
        books: "keep", event: "settle-superseded", fields: { ...base, replacedId: o.replacedId, status: o.status, hash: o.hash, block: o.block },
        alarm: [2, `keeper:settle-superseded:${id}`, `settle of ${id} (${row.symbol}) did not mine: an older transaction at its nonce (${o.replacedId}, status ${o.status}) mined instead; retrying`],
      };
    case "reverted":
      return {
        books: "keep", event: "settle-reverted", fields: { ...base, hash: o.hash, block: o.block },
        alarm: [2, `keeper:settle-reverted:${id}`, `settle of ${id} (${row.symbol}) reverted on chain (tx ${o.hash}, block ${o.block}); retrying next tick`],
      };
    case "refused": {
      const k = classifySettleRefusal(o.reason);
      if (k === "done") return { books: "settled", by: "chain", tx: "", event: "settled-by-other", fields: { ...base, reason: o.reason } };
      if (k === "expired") {
        return {
          books: "expire", reason: "window-closed", event: "settle-expired", fields: { ...base, reason: o.reason },
          alarm: [1, `keeper:settle-expired:${id}`, `row ${id} (${row.symbol}) can no longer be settled: ${o.reason}`],
        };
      }
      if (k === "lost") {
        return {
          books: "expire", reason: "unknown-closure", event: "commit-lost", fields: { ...base, reason: o.reason },
          alarm: [1, `keeper:commit-lost:${id}`, `row ${id} (${row.symbol}) is unknown to Scorecard (${o.reason}): the keeper recorded a commit that is not on chain`],
        };
      }
      if (k === "fault") {
        return {
          books: "keep", event: "settle-fault", fields: { ...base, error: `refused: ${o.reason}` },
          alarm: [1, `keeper:settle-fault:${id}`, `settle of ${id} (${row.symbol}) refused: ${o.reason}`],
        };
      }
      return { books: "keep", event: "settle-retry", fields: { ...base, error: `refused: ${o.reason}` } };
    }
    case "pending":
    case "error":
      return { books: "keep", event: "settle-retry", fields: { ...base, error: o.message } };
  }
}

/** sev-1 when an on-chain row is still owed an hour after its settle window opened (replaces settle-stuck at +3 h). */
export function settleLateAlarm(
  row: { symbol: string; committed: { id: string; onChain: boolean; settleAfterS: number } },
  chainNowS: number, settleDelayS: number,
): AlarmSpec | null {
  if (!row.committed.onChain) return null;
  const { readyAt, deadline } = settleWindow(row.committed.settleAfterS, settleDelayS);
  if (chainNowS <= readyAt + SETTLE_LATE_S) return null;
  const mins = Math.floor((chainNowS - readyAt) / 60);
  return [1, `keeper:settle-late:${row.committed.id}`,
    `row ${row.committed.id} (${row.symbol}) still unsettled ${mins} min after its settle window opened; it closes at ${new Date(deadline * 1000).toISOString()}`];
}
