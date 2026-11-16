/**
 * W5: transaction outcomes, through the keeper's REAL Sender against a mock RPC and a fake clock (the harness
 * of tx/dataSuffix.test.ts and nov/pointer-map/sender-probe*.mjs). Receipts are shaped as the RPC returns
 * them; row 151's settle is `{status: "0x0", blockNumber: "0x46efbbe", gasUsed: "0x1cd97"}` (block
 * 74,382,270, 118,167 gas).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Wallet, Transaction, Interface } from "ethers";
import { Sender, STUCK_MS } from "./tx/sender.ts";
import type { RpcFn } from "./tx/sender.ts";
import {
  sendOnce, maxNonceRpc, commitAttempt, classifySettleRefusal, settleWindow, canSettle, settleStep, settleOutcome,
  settleLateAlarm, scorecardErrors, SCORECARD_ERRORS, SETTLE_WINDOW_S, SETTLE_DELAY_S, SETTLE_MIN_BALANCE_WEI,
} from "./outcome.ts";
import type { CommitPlan, Committed, SendOutcome } from "./outcome.ts";

const SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
const ROOT = "0x" + "11".repeat(32);
const ID = "0x" + "22".repeat(32);
const COMMIT_DATA = "0x8ed83271" + "ab".repeat(32);
const SETTLE_DATA = "0x" + "c3cc18b3" + "22".repeat(32);
type RawReceipt = { status: string; blockNumber: string; gasUsed: string } | null;

/** The keeper's real Sender over a mock chain. `receipt(hash, now)` decides what the chain reports. */
function harness(over: { pending?: number; latest?: number; receipt?: (hash: string, now: number) => RawReceipt; revertData?: () => string | null; errorInterface?: Interface } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "curb-outcome-"));
  const clock = { t: 1_000_000 };
  const chain = { pending: over.pending ?? 7, latest: over.latest ?? 7 };
  const sent: string[] = [];
  const rpc: RpcFn = async (_url, method, params) => {
    switch (method) {
      case "eth_call": {
        const d = over.revertData?.() ?? null;
        if (d) throw Object.assign(new Error("execution reverted"), { data: d });
        return "0x";
      }
      case "eth_estimateGas": return "0x" + (118_167).toString(16);
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": return "0x" + (params[1] === "latest" ? chain.latest : chain.pending).toString(16);
      case "eth_sendRawTransaction": sent.push(Transaction.from(params[0] as string).hash!); return sent.at(-1);
      case "eth_getTransactionReceipt": return (over.receipt ?? (() => ({ status: "0x1", blockNumber: "0x100", gasUsed: "0x5000" })))(params[0] as string, clock.t);
      case "eth_getTransactionByHash": return { hash: params[0] };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const dbPath = join(dir, "outbox.sqlite");
  const sender = new Sender({
    wallet: new Wallet("0x" + "4c".repeat(32)), rpcs: ["https://a"], chainId: 196, dbPath, rpc,
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, errorInterface: over.errorInterface ?? scorecardErrors,
  });
  const rows = () => {
    const db = new DatabaseSync(dbPath);
    try { return db.prepare("select id, nonce, state, kind, hash from outbox order by created_ms, id").all() as Array<{ id: string; nonce: number; state: string; kind: string; hash: string }>; }
    finally { db.close(); }
  };
  const count = () => {
    const db = new DatabaseSync(dbPath);
    try { return (db.prepare("select count(*) as n from outbox").get() as { n: number }).n; } finally { db.close(); }
  };
  return { sender, clock, chain, sent, rows, count, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const meta = (id: string, kind = "settle") => ({ id, kind, targetMs: 0 });

// ---------------------------------------------------------------------------------------------
// Scorecard's errors
// ---------------------------------------------------------------------------------------------

test("Scorecard error selectors are pinned (cast sig, confirmed 15 Nov)", () => {
  const want: Record<string, string> = {
    NotKeeper: "0xf512b278", BadMark: "0x95d6c0d1", MarketStillOpen: "0x008e3edd", MarketStillShut: "0x41ec796c",
    ClosureExists: "0x234ecc22", UnknownClosure: "0xf4ba97e7", AlreadySettled: "0xb196a44a", TooEarly: "0xf9ac2af1",
    TooLate: "0x065f328e", NoPriceSource: "0xdceb16d7", PriceDeviates: "0x82d02434", PriceUnreadable: "0x7fdeb21f",
  };
  assert.equal(SCORECARD_ERRORS.length, 12);
  for (const [name, sel] of Object.entries(want)) assert.equal(scorecardErrors.getError(name)!.selector, sel, name);
  assert.equal(SETTLE_DELAY_S, 300, "Scorecard.SETTLE_DELAY (read on chain 15 Nov: 300)");
  assert.equal(SETTLE_WINDOW_S, 21_600, "Scorecard.SETTLE_WINDOW (read on chain 15 Nov: 21600)");
});

// ---------------------------------------------------------------------------------------------
// sendOnce through the real Sender
// ---------------------------------------------------------------------------------------------

test("status 0 is reverted, never success (row 151)", async () => {
  const h = harness({ receipt: () => ({ status: "0x0", blockNumber: "0x46efbbe", gasUsed: "0x1cd97" }) });
  const o = await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`));
  assert.equal(o.kind, "reverted");
  assert.deepEqual(o, { kind: "reverted", hash: h.sent[0], block: 74_382_270 });
  assert.equal(h.rows()[0].state, "reverted");
  h.cleanup();
});

test("status 1 on our hash is mined", async () => {
  const h = harness({ receipt: () => ({ status: "0x1", blockNumber: "0x46efbbe", gasUsed: "0x1cd97" }) });
  const o = await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`));
  assert.deepEqual(o, { kind: "mined", hash: h.sent[0], block: 74_382_270 });
  assert.equal(h.rows()[0].state, "mined");
  h.cleanup();
});

test("our own 12 s fee bump that mines is mined", async () => {
  let first: string | null = null;
  const h = harness({
    receipt: (hash) => {
      first ??= hash;   // the first hash ever asked about is the original transaction
      return hash !== first ? { status: "0x1", blockNumber: "0x200", gasUsed: "0x5000" } : null;
    },
  });
  const o = await sendOnce(h.sender, SCORECARD, COMMIT_DATA, meta(`commit:${ROOT}:1`, "commit"));
  assert.equal(o.kind, "mined");
  assert.ok(o.kind === "mined" && o.hash !== h.sent[0], "the bump has its own hash and is still ours");
  assert.ok(h.clock.t - 1_000_000 >= 12_000, "the bump happens at 12 s");
  assert.equal(h.rows()[0].state, "mined");
  h.cleanup();
});

test("an older replaced transaction that mines is superseded", async () => {
  // sender-probe2: a settle at nonce 8 is not mined in 30 s; two minutes later a commit is prepared at the same
  // nonce, replacing it; the OLD settle is what mines.
  let minedHash: string | null = null;
  const h = harness({ pending: 8, latest: 7, receipt: (hash) => (hash === minedHash ? { status: "0x1", blockNumber: "0x200", gasUsed: "0x1126b" } : null) });
  const first = await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`));
  assert.equal(first.kind, "error", "not mined within 30 s");
  h.clock.t += STUCK_MS;
  // The stuck row's current hash: its 12 s fee bump if one was accepted, else the original.
  const oldHash = h.rows().find((r) => r.id === `settle:${ROOT}:1`)!.hash;
  minedHash = oldHash;
  const o = await sendOnce(h.sender, SCORECARD, COMMIT_DATA, meta("commit:0xother:1", "commit"));
  assert.deepEqual(o, { kind: "superseded", hash: oldHash, block: 0x200, status: 1, replacedId: `settle:${ROOT}:1` });
  const byId = Object.fromEntries(h.rows().map((r) => [r.id, r]));
  assert.equal(byId["commit:0xother:1"].state, "superseded");
  assert.equal(byId[`settle:${ROOT}:1`].state, "mined");
  assert.equal(byId["commit:0xother:1"].nonce, byId[`settle:${ROOT}:1`].nonce);
  h.cleanup();
});

test("a refused simulation is refused with the decoded reason and no outbox row", async () => {
  const data = scorecardErrors.encodeErrorResult("PriceDeviates", [-237294, -237347]);
  const h = harness({ revertData: () => data });
  const o = await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`));
  assert.deepEqual(o, { kind: "refused", reason: "PriceDeviates(-237294,-237347)" });
  assert.equal(h.count(), 0, "select count(*) from outbox");
  assert.equal(h.sent.length, 0);
  h.cleanup();
});

test("PendingUnresolved is pending", async () => {
  const h = harness({ pending: 8, latest: 7, receipt: () => null });
  assert.equal((await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`))).kind, "error");
  const o = await sendOnce(h.sender, SCORECARD, COMMIT_DATA, meta(`commit:${ROOT}:1`, "commit"));
  assert.equal(o.kind, "pending");
  assert.match((o as { message: string }).message, /still pending/);
  h.cleanup();
});

test("sendOnce never throws: an id already prepared is an error outcome", async () => {
  const h = harness();
  await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`));
  const o = await sendOnce(h.sender, SCORECARD, SETTLE_DATA, meta(`settle:${ROOT}:1`));
  assert.equal(o.kind, "error");
  assert.match((o as { message: string }).message, /already prepared/);
  h.cleanup();
});

// ---------------------------------------------------------------------------------------------
// commitAttempt
// ---------------------------------------------------------------------------------------------

const planOf = (attempts = 0): CommitPlan => ({ root: ROOT, id: ID, settleAfterS: 1_794_546_000, markE18: "123", bandBps: 40, data: COMMIT_DATA, attempts });
const closureOf = (plan = planOf()) => ({ symbol: "wTCENTx", cutBlock: 75_773_120, plan, committed: undefined as Committed | undefined });

/** A commitAttempt dependency set that records the order of saves and sends. */
function deps(outcome: SendOutcome | ((id: string) => SendOutcome), over: { saveThrows?: number[]; lastChance?: boolean } = {}) {
  const order: string[] = [];
  let saves = 0;
  return {
    order,
    d: {
      save: () => { saves++; order.push(`save${saves}`); if (over.saveThrows?.includes(saves)) throw new Error("ENOSPC: no space left on device"); },
      send: async (id: string) => { order.push(`send:${id}`); return typeof outcome === "function" ? outcome(id) : outcome; },
      nowMs: 1_794_545_400_000,
      lastChance: over.lastChance ?? false,
    },
  };
}

test("commitAttempt: attempts++, then save, then send; a mined commit is recorded with its block", async () => {
  const c = closureOf();
  const { order, d } = deps({ kind: "mined", hash: "0xaa", block: 75_776_400 });
  const r = await commitAttempt(c, d);
  assert.deepEqual(order, ["save1", `send:commit:${ROOT}:1`, "save2"]);
  assert.equal(c.plan.attempts, 1);
  assert.equal(r.result, "committed");
  assert.equal(r.event, "committed");
  assert.equal(r.alarm, undefined);
  assert.deepEqual(c.committed, { id: ID, root: ROOT, settleAfterS: 1_794_546_000, markE18: "123", bandBps: 40, onChain: true, txHash: "0xaa", atMs: d.nowMs, block: 75_776_400 });
});

test("commitAttempt never sends when the attempt cannot be saved", async () => {
  const c = closureOf(planOf(2));
  const { order, d } = deps({ kind: "mined", hash: "0xaa", block: 1 }, { saveThrows: [1] });
  const r = await commitAttempt(c, d);
  assert.deepEqual(order, ["save1"], "send not called");
  assert.equal(c.plan.attempts, 2, "unchanged");
  assert.equal(r.result, "persist-failed");
  assert.equal(c.committed, undefined);
  assert.equal(r.alarm?.[0], 1);
});

test("commitAttempt: a failed save after the outcome keeps the books and reports it", async () => {
  const c = closureOf();
  const { d } = deps({ kind: "mined", hash: "0xaa", block: 9 }, { saveThrows: [2] });
  const r = await commitAttempt(c, d);
  assert.equal(r.result, "committed");
  assert.equal(c.committed?.txHash, "0xaa");
  assert.match(r.saveError ?? "", /ENOSPC/);
});

test("commitAttempt: superseded by an earlier attempt of the same plan is committed", async () => {
  const c = closureOf(planOf(1));
  const { order, d } = deps({ kind: "superseded", hash: "0xold", block: 77, status: 1, replacedId: `commit:${ROOT}:1` });
  const r = await commitAttempt(c, d);
  assert.deepEqual(order, ["save1", `send:commit:${ROOT}:2`, "save2"]);
  assert.equal(r.result, "committed");
  assert.equal(r.fields.viaReplaced, true);
  assert.equal(c.committed?.txHash, "0xold");
  assert.equal(c.committed?.block, 77);
  assert.equal(c.committed?.onChain, true);
});

test("commitAttempt: superseded by anything else is not ours", async () => {
  for (const o of [
    { kind: "superseded", hash: "0xs", block: 5, status: 1, replacedId: `settle:${ROOT}:1` },
    { kind: "superseded", hash: "0xs", block: 5, status: 1, replacedId: "commit:0x99:1" },
    { kind: "superseded", hash: "0xs", block: 5, status: 0, replacedId: `commit:${ROOT}:1` },
  ] as SendOutcome[]) {
    const c = closureOf(planOf(1));
    const r = await commitAttempt(c, deps(o).d);
    assert.equal(r.result, "superseded");
    assert.equal(c.committed, undefined);
    assert.deepEqual(r.alarm?.slice(0, 2), [2, "keeper:commit-superseded:wTCENTx"]);
  }
});

test("commitAttempt: reverted is sev-1 and records nothing", async () => {
  const c = closureOf();
  const r = await commitAttempt(c, deps({ kind: "reverted", hash: "0xr", block: 3 }).d);
  assert.equal(r.result, "reverted");
  assert.equal(r.event, "commit-reverted");
  assert.equal(c.committed, undefined);
  assert.deepEqual(r.alarm?.slice(0, 2), [1, "keeper:commit-reverted:wTCENTx:75773120"]);
});

test("commitAttempt: ClosureExists proves an earlier attempt mined (decoded or raw), and is booked as our commit", async () => {
  for (const reason of [`ClosureExists(${ID})`, scorecardErrors.encodeErrorResult("ClosureExists", [ID])]) {
    const c = closureOf(planOf(3));
    const r = await commitAttempt(c, deps({ kind: "refused", reason }).d);
    // Review F5: the id comes from our own bundle root, so the row on chain is ours: logged `committed`, counted.
    assert.equal(r.result, "committed");
    assert.equal(r.event, "committed");
    assert.equal(r.fields.via, "ClosureExists");
    assert.equal(c.committed?.onChain, true);
    assert.equal(c.committed?.txHash, "", "no outbox lookup given: hash unknown");
    assert.equal(c.committed?.block, undefined);
    assert.equal(r.alarm, undefined);
  }
  // With the outbox lookup: the earlier attempt's hash and block.
  const c = closureOf(planOf(1));
  const asked: string[] = [];
  const d = { ...deps({ kind: "refused", reason: `ClosureExists(${ID})` }).d, minedEarlier: (p: string) => { asked.push(p); return { hash: "0xearly", block: 75_776_000 }; } };
  const r = await commitAttempt(c, d);
  assert.deepEqual(asked, [`commit:${ROOT}:`]);
  assert.deepEqual([c.committed?.txHash, c.committed?.block, r.fields.tx, r.fields.block], ["0xearly", 75_776_000, "0xearly", 75_776_000]);
  // A lookup that throws never breaks the booking.
  const c2 = closureOf(planOf(1));
  await commitAttempt(c2, { ...deps({ kind: "refused", reason: `ClosureExists(${ID})` }).d, minedEarlier: () => { throw new Error("SQLITE_BUSY"); } });
  assert.deepEqual([c2.committed?.onChain, c2.committed?.txHash], [true, ""]);
});

test("commitAttempt: any other refusal and any error are sev-1 commit-failed", async () => {
  for (const o of [{ kind: "refused", reason: "MarketStillOpen(0x41333Df9E7639188BBfca5522dC4844398Af9f9E)" }, { kind: "error", message: "round commit:x:1 not mined within 30000ms (nonce 9)" }] as SendOutcome[]) {
    const c = closureOf();
    const r = await commitAttempt(c, deps(o).d);
    assert.equal(r.result, "failed");
    assert.equal(r.event, "commit-failed");
    assert.equal(c.committed, undefined);
    assert.deepEqual(r.alarm?.slice(0, 2), [1, "keeper:commit-failed:wTCENTx:75773120"]);
  }
});

test("commitAttempt: pending is sev-2 unless last chance", async () => {
  const pending: SendOutcome = { kind: "pending", message: "transaction 0x.. at nonce 9 is still pending; not sending another on top of it" };
  const a = await commitAttempt(closureOf(), deps(pending, { lastChance: false }).d);
  assert.equal(a.result, "pending");
  assert.deepEqual(a.alarm?.slice(0, 2), [2, "keeper:commit-pending:wTCENTx"]);
  const b = await commitAttempt(closureOf(), deps(pending, { lastChance: true }).d);
  assert.deepEqual(b.alarm?.slice(0, 2), [1, "keeper:commit-failed:wTCENTx:75773120"]);
});

test("commitAttempt never sends for a closure already committed", async () => {
  const c = closureOf();
  c.committed = { id: ID, root: ROOT, settleAfterS: 1, markE18: "1", bandBps: 1, onChain: true, txHash: "0x1", atMs: 1 };
  const { order, d } = deps({ kind: "mined", hash: "0xaa", block: 1 });
  const r = await commitAttempt(c, d);
  assert.deepEqual(order, []);
  assert.equal(r.result, "skipped");
});

test("a reloaded plan continues its attempt numbering", async () => {
  const reloaded = JSON.parse(JSON.stringify({ plan: planOf(2) })) as { plan: CommitPlan };
  const c = closureOf(reloaded.plan);
  const { order, d } = deps({ kind: "error", message: "timeout" });
  await commitAttempt(c, d);
  assert.equal(order[1], `send:commit:${ROOT}:3`);
});

test("commitAttempt end to end: an earlier attempt of the same plan that mines after replacement is committed", async () => {
  let minedHash: string | null = null;
  const h = harness({ pending: 8, latest: 7, receipt: (hash) => (hash === minedHash ? { status: "0x1", blockNumber: "0x300", gasUsed: "0x1126b" } : null) });
  const c = closureOf();
  const send = (id: string) => sendOnce(h.sender, SCORECARD, c.plan.data, { id, kind: "commit", targetMs: 0 });
  const first = await commitAttempt(c, { save: () => {}, send, nowMs: 1, lastChance: false });
  assert.equal(first.result, "failed", "attempt 1 times out");
  h.clock.t += STUCK_MS;
  const stuckHash = h.rows().find((r) => r.id === `commit:${ROOT}:1`)!.hash;
  minedHash = stuckHash;
  const second = await commitAttempt(c, { save: () => {}, send, nowMs: 2, lastChance: false });
  assert.equal(second.result, "committed");
  assert.equal(second.fields.replacedId, `commit:${ROOT}:1`);
  assert.equal(c.committed?.txHash, stuckHash);
  assert.equal(c.committed?.block, 0x300);
  h.cleanup();
});

// ---------------------------------------------------------------------------------------------
// maxNonceRpc
// ---------------------------------------------------------------------------------------------

const RPCS = ["https://a", "https://b"];

test("maxNonceRpc takes the highest count", async () => {
  const answers = (a: () => Promise<unknown>, b: () => Promise<unknown>): RpcFn => async (url) => (url === RPCS[0] ? a() : b());
  const ok = (v: string) => () => Promise.resolve(v);
  const bad = () => Promise.reject(new Error("timeout"));
  assert.equal(await maxNonceRpc(answers(ok("0x10"), ok("0x11")), RPCS)("https://a", "eth_getTransactionCount", ["0x1", "pending"]), "0x11");
  assert.equal(await maxNonceRpc(answers(ok("0x11"), ok("0x10")), RPCS)("https://a", "eth_getTransactionCount", ["0x1", "latest"]), "0x11");
  assert.equal(await maxNonceRpc(answers(bad, ok("0x10")), RPCS)("https://a", "eth_getTransactionCount", []), "0x10");
  assert.equal(await maxNonceRpc(answers(ok("0x10"), bad), RPCS)("https://a", "eth_getTransactionCount", []), "0x10");
  assert.equal(await maxNonceRpc(answers(ok("0x10"), ok("garbage")), RPCS)("https://a", "eth_getTransactionCount", []), "0x10", "an unparseable answer is an error");
  await assert.rejects(maxNonceRpc(answers(bad, bad), RPCS)("https://a", "eth_getTransactionCount", []), /timeout/);
});

test("maxNonceRpc does not wait for a hanging endpoint", async () => {
  const raw: RpcFn = (url) => (url === RPCS[0] ? Promise.resolve("0x10") : new Promise(() => { /* never answers */ }));
  const t0 = performance.now();
  assert.equal(await maxNonceRpc(raw, RPCS, 100)("https://a", "eth_getTransactionCount", []), "0x10");
  assert.ok(performance.now() - t0 < 300, `took ${Math.round(performance.now() - t0)} ms`);
});

test("maxNonceRpc passes every other method through to the asked endpoint only", async () => {
  const seen: string[] = [];
  const raw: RpcFn = async (url, method) => { seen.push(`${url} ${method}`); return "0x1"; };
  await maxNonceRpc(raw, RPCS)("https://b", "eth_call", []);
  assert.deepEqual(seen, ["https://b eth_call"]);
});

test("maxNonceRpc under the real Sender: a lagging endpoint's count never re-uses a nonce", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-nonce-"));
  const counts: Record<string, number> = { "https://a": 5, "https://b": 9 };   // a lags by four transactions
  const raw: RpcFn = async (url, method, params) => {
    switch (method) {
      case "eth_call": return "0x";
      case "eth_estimateGas": return "0x5208";
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": return "0x" + counts[url].toString(16);
      case "eth_sendRawTransaction": return Transaction.from(params[0] as string).hash;
      case "eth_getTransactionReceipt": return { status: "0x1", blockNumber: "0x1", gasUsed: "0x5208" };
      default: throw new Error(method);
    }
  };
  const mk = (rpc: RpcFn, name: string) => new Sender({ wallet: new Wallet("0x" + "4c".repeat(32)), rpcs: RPCS, chainId: 196, dbPath: join(dir, `${name}.sqlite`), rpc, now: () => 0, sleep: async () => {} });
  const naive = await mk(raw, "naive").prepare(SCORECARD, SETTLE_DATA, meta("s:1"));
  const wrapped = await mk(maxNonceRpc(raw, RPCS, 50), "wrapped").prepare(SCORECARD, SETTLE_DATA, meta("s:1"));
  assert.equal(naive.nonce, 5, "HEAD: the first endpoint's stale count");
  assert.equal(wrapped.nonce, 9);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// settle windows and outcomes
// ---------------------------------------------------------------------------------------------

test("classifySettleRefusal", () => {
  const h = "0x" + "ab".repeat(32);
  assert.equal(classifySettleRefusal(`AlreadySettled(${h})`), "done");
  assert.equal(classifySettleRefusal(`TooLate(${h},1)`), "expired");
  assert.equal(classifySettleRefusal(`UnknownClosure(${h})`), "lost");
  assert.equal(classifySettleRefusal("NoPriceSource(0x41333Df9E7639188BBfca5522dC4844398Af9f9E)"), "fault");
  for (const r of [`TooEarly(${h},1794546300)`, "MarketStillShut(0x41333Df9E7639188BBfca5522dC4844398Af9f9E)", "PriceDeviates(-237294,-237347)", "PriceUnreadable(0x41333Df9E7639188BBfca5522dC4844398Af9f9E)", "0xdeadbeef", "execution reverted", ""]) {
    assert.equal(classifySettleRefusal(r), "wait", r);
  }
  // Undecoded (an errorInterface without them): the selector still classifies.
  assert.equal(classifySettleRefusal(scorecardErrors.encodeErrorResult("AlreadySettled", [h])), "done");
  assert.equal(classifySettleRefusal(scorecardErrors.encodeErrorResult("TooLate", [h, 1])), "expired");
  assert.equal(classifySettleRefusal(scorecardErrors.encodeErrorResult("UnknownClosure", [h])), "lost");
  assert.equal(classifySettleRefusal(scorecardErrors.encodeErrorResult("TooEarly", [h, 1])), "wait");
});

test("settleWindow edges", () => {
  assert.deepEqual(settleWindow(1000, 300), { readyAt: 1300, deadline: 22_900 });
  const row = (onChain = true) => ({ symbol: "wTCENTx", committed: { id: ID, onChain, settleAfterS: 1000 } });
  assert.deepEqual(settleStep(row(), 1299, 300, true), { action: "keep", why: "too-early" });
  assert.deepEqual(settleStep(row(), 1300, 300, true), { action: "send" });
  assert.deepEqual(settleStep(row(), 22_840, 300, true), { action: "send" }, "deadline 22900 - 60");
  const late = settleStep(row(), 22_841, 300, true);
  assert.equal(late.action, "expire");
  assert.deepEqual((late as { alarm: unknown[] }).alarm.slice(0, 2), [1, `keeper:settle-expired:${ID}`]);
  assert.deepEqual(settleStep(row(), 1300, 300, false), { action: "keep", why: "cannot-send" });
  assert.equal(settleStep(row(), 22_841, 300, false).action, "expire", "a row past its window is expired even when it could not be sent");
  // Shadow marks: nothing on chain; kept until the window would have closed, then dropped without an alarm.
  assert.deepEqual(settleStep(row(false), 22_900, 300, true), { action: "keep", why: "shadow" });
  assert.deepEqual(settleStep(row(false), 22_901, 300, true), { action: "drop-shadow" });
});

test("canSettle needs gas, not isKeeper", () => {
  assert.equal(SETTLE_MIN_BALANCE_WEI, 10n ** 14n);
  assert.equal(canSettle("live", true, 10n ** 14n), true);
  assert.equal(canSettle("live", true, 10n ** 14n - 1n), false);
  assert.equal(canSettle("live", true, null), false);
  assert.equal(canSettle("shadow", true, 10n ** 18n), false);
  assert.equal(canSettle("live", false, 10n ** 18n), false);
});

test("settleOutcome: what each outcome does to the books", () => {
  const row = { symbol: "wTCENTx", committed: { id: ID, root: ROOT } };
  const v = (o: SendOutcome) => settleOutcome(o, row, 2);
  assert.deepEqual(v({ kind: "mined", hash: "0xm", block: 9 }), { books: "settled", by: "keeper", tx: "0xm", block: 9, event: "settled", fields: { symbol: "wTCENTx", id: ID, attempt: 2, tx: "0xm", block: 9 } });
  const viaOld = v({ kind: "superseded", hash: "0xold", block: 8, status: 1, replacedId: `settle:${ROOT}:1` });
  assert.equal(viaOld.books, "settled");
  assert.equal(viaOld.books === "settled" && viaOld.tx, "0xold");
  for (const o of [
    { kind: "superseded", hash: "0xc", block: 8, status: 1, replacedId: "commit:0x99:1" },
    { kind: "superseded", hash: "0xc", block: 8, status: 0, replacedId: `settle:${ROOT}:1` },
  ] as SendOutcome[]) {
    const x = v(o);
    assert.equal(x.books, "keep");
    assert.deepEqual(x.books === "keep" && x.alarm?.slice(0, 2), [2, `keeper:settle-superseded:${ID}`]);
  }
  const rev = v({ kind: "reverted", hash: "0x287805da", block: 74_382_270 });
  assert.equal(rev.books, "keep", "row 151: a reverted settle stays owed");
  assert.deepEqual(rev.books === "keep" && rev.alarm?.slice(0, 2), [2, `keeper:settle-reverted:${ID}`]);
  const other = v({ kind: "refused", reason: `AlreadySettled(${ID})` });
  assert.deepEqual([other.books, other.books === "settled" && other.by, other.event], ["settled", "chain", "settled-by-other"]);
  // Review F5: when our own earlier attempt mined (the outbox says so), AlreadySettled is our settle.
  const ours = settleOutcome({ kind: "refused", reason: `AlreadySettled(${ID})` }, row, 2, (p) => (p === `settle:${ROOT}:` ? { hash: "0xmine", block: 74_382_270 } : null));
  assert.deepEqual([ours.books, ours.books === "settled" && ours.by, ours.books === "settled" && ours.tx, ours.books === "settled" && ours.block, ours.event],
    ["settled", "keeper", "0xmine", 74_382_270, "settled"]);
  const exp = v({ kind: "refused", reason: `TooLate(${ID},22900)` });
  assert.deepEqual([exp.books, exp.books === "expire" && exp.reason, exp.books === "expire" && exp.alarm[1]], ["expire", "window-closed", `keeper:settle-expired:${ID}`]);
  // Review F1: UnknownClosure can be one stale endpoint's word: kept (retried), never expired by it, but paged.
  const lost = v({ kind: "refused", reason: `UnknownClosure(${ID})` });
  assert.deepEqual([lost.books, lost.event, lost.books === "keep" && lost.alarm?.[0], lost.books === "keep" && lost.alarm?.[1]],
    ["keep", "settle-unknown-closure", 1, `keeper:commit-lost:${ID}`]);
  const fault = v({ kind: "refused", reason: "NoPriceSource(0x41333Df9E7639188BBfca5522dC4844398Af9f9E)" });
  assert.deepEqual([fault.books, fault.books === "keep" && fault.alarm?.[0], fault.books === "keep" && fault.alarm?.[1]], ["keep", 1, `keeper:settle-fault:${ID}`]);
  for (const o of [{ kind: "refused", reason: "PriceDeviates(-237294,-237347)" }, { kind: "pending", message: "p" }, { kind: "error", message: "e" }] as SendOutcome[]) {
    const x = v(o);
    assert.deepEqual([x.books, x.event, x.books === "keep" && x.alarm], ["keep", "settle-retry", undefined]);
  }
});

test("settleLateAlarm fires an hour after the window opened, for on-chain rows only", () => {
  const row = (onChain = true) => ({ symbol: "wTCENTx", committed: { id: ID, onChain, settleAfterS: 1000 } });
  assert.equal(settleLateAlarm(row(), 1300 + 3600, 300), null);
  assert.deepEqual(settleLateAlarm(row(), 1300 + 3601, 300)?.slice(0, 2), [1, `keeper:settle-late:${ID}`]);
  assert.equal(settleLateAlarm(row(false), 1300 + 9999, 300), null);
});
