/**
 * W5.5: the keeper's books against Scorecard. Row 151 (wTCENTx, 28 Oct) is the case this exists for: its settle
 * reverted (`PriceDeviates`, status 0, block 74,382,270 at 01:35:06Z), the keeper recorded success, and the row
 * could never be graded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scorecardAbi } from "./sources/scorecard.ts";
import type { MulticallSnapshot, PinnedBlock } from "./sources/chain.ts";
import {
  reconcile, reconcileCalls, bookFrom, readChainBook, withDeadline, applyCorrections, recordSettled, recordExpired,
  rowFromRecent, pruneRecent, closureCountCall, decodeClosureCount, RECENT_KEEP_MS, EXPIRED_KEEP,
} from "./reconcile.ts";
import type { ChainBook, RowLike, SettledRef, StateLike } from "./reconcile.ts";
import { settleOutcome } from "./outcome.ts";

const SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const ROW151 = "0xfc88b5dbe6d0ab024e18027980626b2c97165f387c85159bbd111bf5c6122ecf";
const ROOT151 = "0x" + "51".repeat(32);
const SETTLE_AFTER_151 = 1_793_151_000;          // 28 Oct 2026 01:30:00Z
const ID2 = "0x" + "a2".repeat(32);
const DELAY = 300;

type Row = RowLike & { committed?: RowLike["committed"] & { txHash: string; atMs: number } };

const book = (atBlock: number, settled: Record<string, boolean | null> = {}, committedAt: Record<string, bigint | null> = {}): ChainBook => ({
  atBlock,
  settled: new Map(Object.entries(settled).map(([k, v]) => [k.toLowerCase(), v])),
  committedAt: new Map(Object.entries(committedAt).map(([k, v]) => [k.toLowerCase(), v])),
});
const pendingRow = (id = ROW151, over: Partial<Row> = {}): Row => ({
  wrapper: W, symbol: "wTCENTx", cutBlock: 74_370_000, settleAttempts: 0,
  committed: { id, root: ROOT151, settleAfterS: SETTLE_AFTER_151, onChain: true, txHash: "0xc0", atMs: 0 },
  ...over,
});
const recentRef = (over: Partial<SettledRef> = {}): SettledRef => ({
  id: ROW151, root: ROOT151, symbol: "wTCENTx", settleAfterS: SETTLE_AFTER_151, tx: "0x287805da", atMs: 0,
  wrapper: W, cutBlock: 74_370_000, attempts: 1, by: "keeper", ...over,
});
const emptyState = (): StateLike<Row> => ({ open: {}, pending: [], recent: [], expired: [] });
const none = { settledOnChain: [], reopened: [], lostAfterWindow: [], commitMissing: [], planOnChain: [], planNotOnChain: [] };

test("row 151 replay: a reverted settle stays owed and the next tick settles it", () => {
  const state = emptyState();
  const row = pendingRow();
  state.pending.push(row);
  const streak = new Map<string, number>();
  // 01:35:06Z: the settle reverted on chain. HEAD recorded it settled; now it stays owed.
  const v1 = settleOutcome({ kind: "reverted", hash: "0x287805daf1ad38c0cfc6a89d53f75857475c53dd825b86db7e7c065f55ca9af5", block: 74_382_270 }, row as never, 1);
  assert.equal(v1.books, "keep");
  assert.equal(state.pending.length, 1);
  // 01:35:36Z: the chain says not settled. Nothing to correct: the row is already owed.
  assert.deepEqual(reconcile(state, book(74_382_300, { [ROW151]: false }), 1_793_151_336, DELAY, streak), none);
  // The next attempt mines: settled, into recent, out of pending.
  const v2 = settleOutcome({ kind: "mined", hash: "0x99", block: 74_382_301 }, row as never, 2);
  assert.equal(v2.books, "settled");
  if (v2.books !== "settled") return;
  state.pending = state.pending.filter((c) => c !== row);
  recordSettled(state, row as Row & { committed: NonNullable<Row["committed"]> }, { tx: v2.tx, block: v2.block, atMs: 1_793_151_337_000, by: "keeper" });
  assert.equal(state.pending.length, 0);
  assert.deepEqual(state.recent!.map((r) => [r.id, r.tx, r.block]), [[ROW151, "0x99", 74_382_301]]);
  // A later read that agrees changes nothing.
  assert.deepEqual(reconcile(state, book(74_382_400, { [ROW151]: true }), 1_793_151_400, DELAY, streak), none);
});

test("the chain's settlement settles a pending row without a send", () => {
  const state = emptyState();
  state.pending.push(pendingRow());
  const c = reconcile(state, book(74_382_300, { [ROW151]: true }), 1_793_151_336, DELAY, new Map());
  assert.deepEqual(c.settledOnChain, [ROW151]);
  // Applied: settled by the chain, into recent, file deleted, no alarm.
  const removed: unknown[] = [];
  const alarms: unknown[] = [];
  const logs: string[] = [];
  const rep = applyCorrections(state, c, {
    nowMs: 1_793_151_336_000, canRetryCommit: () => false, revive: (r) => rowFromRecent(r) as Row,
    remove: (r) => removed.push(r), raise: (...a) => alarms.push(a), log: (e) => logs.push(e),
  });
  assert.equal(rep.settled, 1);
  assert.equal(state.pending.length, 0);
  assert.deepEqual(state.recent!.map((r) => [r.id, r.tx, r.by]), [[ROW151, "", "chain"]]);
  assert.deepEqual(removed, [{ wrapper: W, cutBlock: 74_370_000 }]);
  assert.deepEqual(alarms, []);
  assert.deepEqual(logs, ["settled-by-other"]);
});

test("a recent row the chain does not show settled returns to pending inside its window, on the second read", () => {
  const state = emptyState();
  state.recent!.push(recentRef());
  const streak = new Map<string, number>();
  const inWindow = SETTLE_AFTER_151 + DELAY + 600;
  assert.deepEqual(reconcile(state, book(100, { [ROW151]: false }), inWindow, DELAY, streak).reopened, [], "first tick");
  assert.deepEqual(reconcile(state, book(101, { [ROW151]: false }), inWindow + 30, DELAY, streak).reopened, [ROW151], "second consecutive tick");
  // Applied: back to pending with its attempt numbering, sev-1 books-disagree.
  const alarms: Array<[number, string, string]> = [];
  applyCorrections(state, { ...none, reopened: [ROW151] }, {
    nowMs: 1, canRetryCommit: () => false, revive: (r) => rowFromRecent(r) as Row,
    remove: () => {}, raise: (s, k, m) => alarms.push([s, k, m]), log: () => {},
  });
  assert.equal(state.recent!.length, 0);
  assert.equal(state.pending.length, 1);
  assert.deepEqual([state.pending[0].committed!.id, state.pending[0].settleAttempts, state.pending[0].wrapper], [ROW151, 1, W]);
  assert.deepEqual(alarms.map((a) => a.slice(0, 2)), [[1, `keeper:books-disagree:${ROW151}`]]);

  // Past the window (deadline - 60 s), the same disagreement expires the row instead.
  const late = emptyState();
  late.recent!.push(recentRef());
  const deadline = SETTLE_AFTER_151 + DELAY + 21_600;
  const s2 = new Map<string, number>();
  reconcile(late, book(100, { [ROW151]: false }), deadline - 59, DELAY, s2);
  const c = reconcile(late, book(101, { [ROW151]: false }), deadline - 59, DELAY, s2);
  assert.deepEqual([c.reopened, c.lostAfterWindow], [[], [ROW151]]);
  applyCorrections(late, c, { nowMs: 5, canRetryCommit: () => false, revive: (r) => rowFromRecent(r) as Row, remove: () => {}, raise: () => {}, log: () => {} });
  assert.equal(late.recent!.length, 0);
  assert.deepEqual(late.expired!.map((e) => [e.id, e.reason]), [[ROW151, "window-closed"]]);
});

test("an agreeing read between two disagreeing ones resets the streak", () => {
  const state = emptyState();
  state.recent!.push(recentRef());
  const streak = new Map<string, number>();
  const now = SETTLE_AFTER_151 + DELAY + 600;
  reconcile(state, book(100, { [ROW151]: false }), now, DELAY, streak);
  reconcile(state, book(101, { [ROW151]: true }), now, DELAY, streak);
  assert.deepEqual(reconcile(state, book(102, { [ROW151]: false }), now, DELAY, streak).reopened, []);
  assert.deepEqual(reconcile(state, book(103, { [ROW151]: false }), now, DELAY, streak).reopened, [ROW151]);
});

test("a read before the receipt block + 10 is ignored", () => {
  const state = emptyState();
  state.recent!.push(recentRef({ block: 1000 }));
  const streak = new Map<string, number>();
  const now = SETTLE_AFTER_151 + DELAY + 600;
  assert.deepEqual(reconcile(state, book(1005, { [ROW151]: false }), now, DELAY, streak), none);
  assert.equal(streak.size, 0, "streak not advanced");
  assert.deepEqual(reconcile(state, book(1010, { [ROW151]: false }), now, DELAY, streak), none);
  assert.equal(streak.get(`settle:${ROW151}`), 1, "counted");
  assert.deepEqual(reconcile(state, book(1011, { [ROW151]: false }), now, DELAY, streak).reopened, [ROW151]);
  // The same guard on a pending row's commit block.
  const p = emptyState();
  p.pending.push(pendingRow(ROW151, { committed: { ...pendingRow().committed!, block: 2000 } }));
  assert.deepEqual(reconcile(p, book(2009, { [ROW151]: true }), now, DELAY, new Map()).settledOnChain, []);
  assert.deepEqual(reconcile(p, book(2010, { [ROW151]: true }), now, DELAY, new Map()).settledOnChain, [ROW151]);
});

test("a committed open row with no commitment is un-committed when the window allows, on the second read", () => {
  const mk = () => {
    const state = emptyState();
    state.open[W] = { wrapper: W, symbol: "wTCENTx", cutBlock: 76_000_000, plan: { id: ID2, attempts: 1 }, committed: { id: ID2, root: ROOT151, settleAfterS: 1, onChain: true, txHash: "0xc", atMs: 0, block: 500 } };
    return state;
  };
  const state = mk();
  const streak = new Map<string, number>();
  assert.deepEqual(reconcile(state, book(600, {}, { [ID2]: 0n }), 1, DELAY, streak).commitMissing, [], "first read");
  const c = reconcile(state, book(601, {}, { [ID2]: 0n }), 1, DELAY, streak);
  assert.deepEqual(c.commitMissing, [ID2], "second consecutive read");
  const alarms: Array<[number, string, string]> = [];
  const logs: string[] = [];
  const rep = applyCorrections(state, c, { nowMs: 1, canRetryCommit: () => true, revive: (r) => rowFromRecent(r) as Row, remove: () => {}, raise: (s, k, m) => alarms.push([s, k, m]), log: (e) => logs.push(e) });
  assert.equal(rep.uncommitted, 1);
  assert.equal(state.open[W].committed, undefined, "the frozen plan will be retried");
  assert.deepEqual(state.open[W].plan, { id: ID2, attempts: 1 }, "the plan is kept");
  assert.deepEqual(alarms.map((a) => a.slice(0, 2)), [[1, `keeper:books-disagree:${ID2}`]]);
  // Too late to retry: committed is kept and the loss is logged.
  const late = mk();
  const rep2 = applyCorrections(late, { ...none, commitMissing: [ID2] }, { nowMs: 1, canRetryCommit: () => false, revive: (r) => rowFromRecent(r) as Row, remove: () => {}, raise: () => {}, log: (e) => logs.push(e) });
  assert.equal(rep2.commitLost, 1);
  assert.ok(late.open[W].committed);
  assert.equal(logs.at(-1), "commit-lost");
  // A non-zero commitment agrees and resets.
  const ok = mk();
  const s3 = new Map<string, number>();
  reconcile(ok, book(600, {}, { [ID2]: 0n }), 1, DELAY, s3);
  reconcile(ok, book(601, {}, { [ID2]: 1_793_150_409n }), 1, DELAY, s3);
  assert.deepEqual(reconcile(ok, book(602, {}, { [ID2]: 0n }), 1, DELAY, s3).commitMissing, []);
});

test("a failed read changes nothing", () => {
  const state = emptyState();
  state.recent!.push(recentRef());
  state.pending.push(pendingRow(ID2));
  state.open[W] = { wrapper: W, symbol: "wTCENTx", cutBlock: 1, committed: { id: "0x" + "c3".repeat(32), root: ROOT151, settleAfterS: 1, onChain: true, txHash: "", atMs: 0 } };
  const streak = new Map<string, number>([[`settle:${ROW151}`, 1], [`commit:${"0x" + "c3".repeat(32)}`, 1]]);
  const now = SETTLE_AFTER_151 + DELAY + 600;
  const c = reconcile(state, book(100, { [ROW151]: null, [ID2]: null }, { ["0x" + "c3".repeat(32)]: null }), now, DELAY, streak);
  assert.deepEqual(c, none);
  assert.equal(streak.get(`settle:${ROW151}`), 1, "existing streak unchanged");
  assert.equal(streak.get(`commit:${"0x" + "c3".repeat(32)}`), 1);
  // An id not read this tick at all is the same as a failed read.
  assert.deepEqual(reconcile(state, book(101), now, DELAY, streak), none);
  assert.equal(streak.get(`settle:${ROW151}`), 1);
});

test("streaks of rows no longer tracked are forgotten", () => {
  const streak = new Map<string, number>([[`settle:${ROW151}`, 1], ["commit:0xgone", 1]]);
  reconcile(emptyState(), book(1), 1, DELAY, streak);
  assert.equal(streak.size, 0);
});

test("reconcileCalls: every pending row and on-chain open closure, recent rows rotating under the cap", () => {
  const state = emptyState();
  state.open[W] = { wrapper: W, symbol: "wTCENTx", cutBlock: 1, committed: { id: ID2, root: ROOT151, settleAfterS: 1, onChain: true, txHash: "", atMs: 0 } };
  state.open["0x0000000000000000000000000000000000000001"] = { wrapper: "0x0000000000000000000000000000000000000001", symbol: "x", cutBlock: 1 };
  state.pending.push(pendingRow(ROW151));
  state.pending.push(pendingRow("0x" + "d4".repeat(32), { committed: { ...pendingRow().committed!, id: "0x" + "d4".repeat(32), onChain: false } }));
  for (let i = 0; i < 5; i++) state.recent!.push(recentRef({ id: "0x" + String(i).repeat(64) }));
  state.recent!.push(recentRef({ id: ROW151 }));            // also pending: read once
  const cursor = { recent: 0 };
  const a = reconcileCalls(state, SCORECARD, cursor, 4).map((c) => c.label);
  assert.deepEqual(a, [`commitment:${ID2}`, `settlement:${ROW151}`, ...[0, 1, 2, 3].map((i) => `settlement:0x${String(i).repeat(64)}`)]);
  const b = reconcileCalls(state, SCORECARD, cursor, 4).map((c) => c.label);
  assert.deepEqual(b, [`commitment:${ID2}`, `settlement:${ROW151}`, `settlement:0x${"4".repeat(64)}`, `settlement:0x${"0".repeat(64)}`, `settlement:0x${"1".repeat(64)}`]);
  // The calldata is the real ABI encoding.
  const call = reconcileCalls(state, SCORECARD, { recent: 0 }, 0).find((c) => c.label === `commitment:${ID2}`)!;
  assert.equal(call.target, SCORECARD);
  assert.equal(scorecardAbi.decodeFunctionData("commitments", call.callData)[0], ID2);
});

const snap = (results: MulticallSnapshot["results"], number = 77): MulticallSnapshot => ({ block: { number, hash: "0xb", timestamp: 1, rpc: "https://a" }, results });
const settlementData = (settled: boolean) => scorecardAbi.encodeFunctionResult("settlements", [1, 2, 3, 4, 5, 6, 7, 1, settled]);
const commitmentData = (committedAt: bigint) => scorecardAbi.encodeFunctionResult("commitments", [W, committedAt, 9, 10, 11, 12, ROOT151, ROOT151, 13, 14, 15]);

test("bookFrom decodes real return data; anything unusable is unknown", () => {
  const b = bookFrom(snap([
    { label: `settlement:${ROW151}`, target: SCORECARD, callData: "0x", success: true, returnData: settlementData(true) },
    { label: `settlement:${ID2}`, target: SCORECARD, callData: "0x", success: true, returnData: settlementData(false) },
    { label: "settlement:0xfail", target: SCORECARD, callData: "0x", success: false, returnData: "0x" },
    { label: "settlement:0xempty", target: SCORECARD, callData: "0x", success: true, returnData: "0x" },
    { label: "settlement:0xjunk", target: SCORECARD, callData: "0x", success: true, returnData: "0x1234" },
    { label: `commitment:${ID2}`, target: SCORECARD, callData: "0x", success: true, returnData: commitmentData(1_793_150_409n) },
    { label: "commitment:0xzero", target: SCORECARD, callData: "0x", success: true, returnData: commitmentData(0n) },
    { label: "commitment:0xfail", target: SCORECARD, callData: "0x", success: false, returnData: "0x" },
  ]));
  assert.equal(b.atBlock, 77);
  assert.deepEqual(Object.fromEntries(b.settled), { [ROW151]: true, [ID2]: false, "0xfail": null, "0xempty": null, "0xjunk": null });
  assert.deepEqual(Object.fromEntries(b.committedAt), { [ID2]: 1_793_150_409n, "0xzero": 0n, "0xfail": null });
});

test("readChainBook keeps its deadline, and a late failure is never unhandled", async () => {
  const block: PinnedBlock = { number: 5, hash: "0xb", timestamp: 1, rpc: "https://a" };
  const calls = [{ label: `settlement:${ROW151}`, target: SCORECARD, callData: "0x" }];
  const t0 = performance.now();
  await assert.rejects(readChainBook(block, calls, [], 150, () => new Promise(() => { /* hangs */ })), /deadline/);
  assert.ok(performance.now() - t0 < 600);
  await assert.rejects(readChainBook(block, calls, [], 1_000, async () => { throw new Error("multicall failed on every RPC"); }), /every RPC/);
  const late = new Promise<MulticallSnapshot>((_, rej) => setTimeout(() => rej(new Error("late")), 50));
  await assert.rejects(withDeadline(late, 10), /deadline/);
  await new Promise((r) => setTimeout(r, 80));     // the late rejection must not surface as unhandled
  const ok = await readChainBook(block, calls, [], 1_000, async (b, c) => snap(c.map((x) => ({ ...x, success: true, returnData: settlementData(true) })), b.number));
  assert.equal(ok.settled.get(ROW151), true);
  const empty = await readChainBook(block, [], [], 1_000, () => { throw new Error("must not be called"); });
  assert.equal(empty.settled.size, 0);
});

test("the books: recent keeps 24 hours and one entry per id; expired keeps the last 50", () => {
  const state: StateLike<Row> = emptyState();
  const row = pendingRow() as Row & { committed: NonNullable<Row["committed"]> };
  recordSettled(state, row, { tx: "0x1", atMs: 1_000, by: "keeper" });
  recordSettled(state, row, { tx: "0x2", atMs: 2_000, by: "keeper" });
  assert.deepEqual(state.recent!.map((r) => r.tx), ["0x2"]);
  pruneRecent(state, 2_000 + RECENT_KEEP_MS - 1);
  assert.equal(state.recent!.length, 1);
  pruneRecent(state, 2_000 + RECENT_KEEP_MS);
  assert.equal(state.recent!.length, 0);
  for (let i = 0; i < EXPIRED_KEEP + 5; i++) recordExpired(state, { symbol: "s", committed: { id: `0x${i}`, root: "0x", settleAfterS: i } }, "window-closed", i);
  assert.equal(state.expired!.length, EXPIRED_KEEP);
  assert.equal(state.expired![0].id, "0x5");
});

test("closureCount is read for /healthz only", () => {
  const call = closureCountCall(SCORECARD);
  assert.equal(call.label, "closureCount");
  const ret = scorecardAbi.encodeFunctionResult("closureCount", [233]);
  assert.equal(decodeClosureCount({ ...call, success: true, returnData: ret }), 233);
  assert.equal(decodeClosureCount({ ...call, success: false, returnData: "0x" }), null);
  assert.equal(decodeClosureCount(undefined), null);
});

test("review F2: a closure whose plan was sent but is not recorded is read, adopted when on chain, confirmed absent when not", () => {
  const mk = (attempts: number) => {
    const state = emptyState();
    state.open[W] = { wrapper: W, symbol: "wTCENTx", cutBlock: 76_000_000, plan: { id: ID2, attempts } };
    return state;
  };
  // Never sent: nothing to read.
  assert.deepEqual(reconcileCalls(mk(0), SCORECARD, { recent: 0 }), []);
  // Sent (the last attempt timed out): commitments(plan.id) is read.
  const state = mk(2);
  assert.deepEqual(reconcileCalls(state, SCORECARD, { recent: 0 }).map((c) => c.label), [`commitment:${ID2}`]);
  // One non-zero read adopts it (a stale node cannot show a commitment that does not exist); no streak, no block guard.
  const streak = new Map<string, number>();
  const found = reconcile(state, book(10, {}, { [ID2]: 1_793_150_409n }), 1, DELAY, streak);
  assert.deepEqual(found, { ...none, planOnChain: [ID2] });
  const adopted: unknown[] = [];
  const alarms: Array<[number, string, string]> = [];
  const rep = applyCorrections(state, found, {
    nowMs: 7, canRetryCommit: () => false, revive: (r) => rowFromRecent(r) as Row, remove: () => {},
    adoptPlan: (row) => { adopted.push(row); row.committed = { id: ID2, root: ROOT151, settleAfterS: 1, onChain: true, txHash: "", atMs: 7 }; },
    raise: (s, k, m) => alarms.push([s, k, m]), log: () => {},
  });
  assert.equal(rep.adopted, 1);
  assert.equal(adopted.length, 1);
  assert.ok(state.open[W].committed?.onChain);
  assert.deepEqual(alarms.map((a) => a.slice(0, 2)), [[2, "keeper:commit-found:wTCENTx"]]);
  // Recorded now: the usual committed read takes over.
  assert.deepEqual(reconcileCalls(state, SCORECARD, { recent: 0 }).map((c) => c.label), [`commitment:${ID2}`]);
  // A zero read is reported as absent at this block (what lets the per-asset loop abandon it); a failed read is nothing.
  assert.deepEqual(reconcile(mk(1), book(11, {}, { [ID2]: 0n }), 1, DELAY, streak), { ...none, planNotOnChain: [ID2] });
  assert.deepEqual(reconcile(mk(1), book(12, {}, { [ID2]: null }), 1, DELAY, streak), none);
  assert.equal(streak.size, 0);
});
