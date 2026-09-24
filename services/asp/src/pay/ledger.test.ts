/**
 * The payment ledger and its chain reads, offline: an in-memory USD₮0 answers authorizationState, receipts
 * and AuthorizationUsed logs the way X Layer does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, toBeHex, zeroPadValue } from "ethers";
import type { PaymentRequirements } from "@okxweb3/x402-core/types";
import { decodePaymentResponseHeader } from "@okxweb3/x402-core/http";
import { AUTHORIZATION_USED, TRANSFER, authorizationKey, authorizationOf, rpcAuthorizationChain } from "./authorization.ts";
import type { AuthorizationChain, SettlementExpectation } from "./authorization.ts";
import { AuthorizationLedger, askChain, PENDING_SCHEMA } from "./ledger.ts";
import type { PendingSettlement } from "./ledger.ts";
import { USDT0 } from "./routes.ts";
import { receiptIdOf } from "./receipt.ts";
import { sha256Hex } from "../hash.ts";

const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const BUYER = getAddress("0x2222222222222222222222222222222222222222");
const NONCE = "0x" + "44".repeat(32);
const TX = "0x" + "ab".repeat(32);
const T0 = Date.parse("2026-09-24T02:00:00Z");
const VALID_BEFORE = T0 / 1000 + 300;
const requirements: PaymentRequirements = {
  scheme: "exact", network: "eip155:196", asset: USDT0.address, amount: "10000",
  payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD₮0", version: "1" },
};
const BODY = Buffer.from('{"schema":"curb.asp.calendar/1","windows":[]}');

function pending(over: Partial<PendingSettlement> = {}): PendingSettlement {
  return {
    schema: PENDING_SCHEMA, key: authorizationKey({ payer: BUYER, nonce: NONCE }), payer: BUYER, nonce: NONCE, validBefore: VALID_BEFORE,
    route: "GET /v1/closure-calendar", query: { symbol: "wTCENTx", horizonDays: 7 }, requirements, payloadDigest: "0x" + "cd".repeat(32),
    body: BODY.toString("base64"), contentType: "application/json; charset=utf-8", startedMs: T0, transaction: null, refused: null,
    ...over,
  };
}

/** An in-memory chain: head advances by hand, and an authorization is used at a block by a transaction. */
function fakeChain(o: { headBlock?: number; headTs?: number } = {}) {
  const c = {
    head: o.headBlock ?? 71_500_000,
    ts: o.headTs ?? T0 / 1000 + 5,
    uses: [] as Array<{ tx: string; block: number; payer: string; nonce: string; to: string; value: bigint }>,
    calls: [] as string[],
  };
  const chain: AuthorizationChain = {
    async state(payer, nonce) {
      c.calls.push("state");
      return { used: c.uses.some((u) => u.payer === payer && u.nonce === nonce && u.block <= c.head), block: c.head, timestamp: c.ts };
    },
    async txPays(tx, e: SettlementExpectation) {
      c.calls.push("txPays");
      const u = c.uses.find((x) => x.tx === tx && x.block <= c.head);
      return !!u && u.payer === e.payer && u.nonce === e.nonce && u.to === PAY_TO && u.value >= e.minAmount;
    },
    async findUse(payer, nonce, from, to) {
      c.calls.push(`findUse:${from}-${to}`);
      return c.uses.find((u) => u.payer === payer && u.nonce === nonce && u.block >= from && u.block <= to)?.tx ?? null;
    },
  };
  return { c, chain };
}

const ledgerIn = (dir = mkdtempSync(join(tmpdir(), "curb-asp-ledger-"))) => {
  const logged: Array<[string, Record<string, unknown>]> = [];
  const l = new AuthorizationLedger({ dir: join(dir, "ledger"), receiptsDir: join(dir, "receipts"), now: () => T0, log: (e, f = {}) => { logged.push([e, f]); }, minAskGapMs: 0 });
  return { l, dir, logged };
};

test("authorizationOf accepts exactly an EIP-3009 authorization, and refuses anything the ledger could not key", () => {
  const good = { accepted: { extra: { name: "USD₮0", version: "1" } }, payload: { signature: "0x", authorization: { from: BUYER.toLowerCase(), to: PAY_TO, value: "10000", validAfter: "0", validBefore: String(VALID_BEFORE), nonce: NONCE.toUpperCase().replace("0X", "0x") } } };
  assert.deepEqual(authorizationOf(good), { payer: BUYER, nonce: NONCE, validBefore: VALID_BEFORE, value: "10000" });
  const bad: unknown[] = [
    null, 5, "x", {}, { payload: {} },
    { ...good, accepted: { extra: { assetTransferMethod: "permit2" } } },
    { payload: { authorization: { ...good.payload.authorization, from: "0x123" } } },
    { payload: { authorization: { ...good.payload.authorization, nonce: "0x01" } } },
    { payload: { authorization: { ...good.payload.authorization, validBefore: "soon" } } },
    { payload: { authorization: { ...good.payload.authorization, validBefore: "99999999999999999999" } } },
    { payload: { authorization: { ...good.payload.authorization, value: -1 } } },
  ];
  for (const b of bad) assert.equal(authorizationOf(b), null, JSON.stringify(b));
  assert.equal(authorizationKey({ payer: BUYER, nonce: NONCE }), `${BUYER.toLowerCase()}-${NONCE}`);
});

test("the chain reads: authorizationState pinned to the block whose time it reports, and a newest-first log search", async () => {
  const calls: Array<[string, unknown[]]> = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push([method, params]);
    if (method === "eth_getBlockByNumber") return { number: "0x" + (71_500_000).toString(16), timestamp: "0x" + (VALID_BEFORE - 10).toString(16) };
    if (method === "eth_call") return "0x" + "0".repeat(63) + "1";
    if (method === "eth_getLogs") {
      const f = (params[0] as { fromBlock: string; toBlock: string; topics: string[] });
      assert.deepEqual(f.topics, [AUTHORIZATION_USED, zeroPadValue(BUYER, 32), NONCE]);
      // The authorization was used at block 71,499,850.
      return Number(f.fromBlock) <= 71_499_850 && 71_499_850 <= Number(f.toBlock) ? [{ transactionHash: TX.toUpperCase().replace("0X", "0x") }] : [];
    }
    if (method === "eth_getTransactionReceipt") {
      return { status: "0x1", logs: [
        { address: USDT0.address, topics: [AUTHORIZATION_USED, zeroPadValue(BUYER, 32), NONCE], data: "0x" },
        { address: USDT0.address, topics: [TRANSFER, zeroPadValue(BUYER, 32), zeroPadValue(PAY_TO, 32)], data: toBeHex(10_000n, 32) },
      ] };
    }
    throw new Error(method);
  };
  const chain = rpcAuthorizationChain(rpc, USDT0.address, PAY_TO);
  assert.deepEqual(await chain.state(BUYER, NONCE), { used: true, block: 71_500_000, timestamp: VALID_BEFORE - 10 });
  assert.equal((calls[1][1] as unknown[])[1], "0x" + (71_500_000).toString(16), "eth_call at the block just read, not at 'latest'");
  calls.length = 0;
  assert.equal(await chain.findUse(BUYER, NONCE, 71_499_700, 71_500_000), TX);
  assert.deepEqual(calls.map(([, p]) => (p[0] as { fromBlock: string; toBlock: string })).map((f) => [Number(f.fromBlock), Number(f.toBlock)]),
    [[71_499_901, 71_500_000], [71_499_801, 71_499_900]], "100 blocks per call, newest first, stopping at the hit");
  assert.equal(await chain.txPays(TX, { payer: BUYER, nonce: NONCE, minAmount: 10_000n }), true);
  assert.equal(await chain.txPays(TX, { payer: BUYER, nonce: NONCE, minAmount: 10_001n }), false);
});

test("askChain: the Broker's transaction first, then a search of the blocks since the settle call; unused is final only past validBefore", async () => {
  const { c, chain } = fakeChain();
  assert.deepEqual(await askChain(chain, pending()), { kind: "unused", final: false });
  c.ts = VALID_BEFORE + 59;
  assert.deepEqual(await askChain(chain, pending()), { kind: "unused", final: false }, "a minute of margin past validBefore");
  c.ts = VALID_BEFORE + 60;
  assert.deepEqual(await askChain(chain, pending()), { kind: "unused", final: true });

  c.ts = T0 / 1000 + 20;
  c.uses.push({ tx: TX, block: c.head - 3, payer: BUYER, nonce: NONCE, to: PAY_TO, value: 10_000n });
  c.calls.length = 0;
  assert.deepEqual(await askChain(chain, pending({ transaction: TX })), { kind: "paid", transaction: TX });
  assert.deepEqual(c.calls, ["state", "txPays"], "the Broker named it: no log search");
  c.calls.length = 0;
  assert.deepEqual(await askChain(chain, pending()), { kind: "paid", transaction: TX });
  // 20 s since the settle call, plus the 120 s margin, half as much again: 210 blocks.
  assert.deepEqual(c.calls, ["state", `findUse:${c.head - 209}-${c.head}`, "txPays"]);

  // Used, but by a transaction that does not pay this sale (or that the log index has not caught up with).
  c.uses[0].value = 1n;
  assert.deepEqual(await askChain(chain, pending()), { kind: "unmatched", final: false });
  c.ts = VALID_BEFORE + 600;
  assert.deepEqual(await askChain(chain, pending()), { kind: "unmatched", final: true });
});

test("claim is the guard: a key in flight, unconfirmed or settled cannot be taken again", () => {
  const { l } = ledgerIn();
  const key = pending().key;
  assert.equal(l.claim(key), true);
  assert.equal(l.claim(key), false, "in flight");
  assert.deepEqual(l.lookup(key), { state: "in-flight" });
  l.begin(pending());
  l.release(key);
  assert.equal(l.lookup(key).state, "unconfirmed");
  assert.equal(l.claim(key), false, "unconfirmed");
  l.settle(pending(), { transaction: TX, status: "success", headers: {} }, true);
  assert.equal(l.lookup(key).state, "settled");
  assert.equal(l.claim(key), false, "settled");
});

test("a record left mid-settle by a crash is loaded at boot and reconciled from the chain: receipt written, bytes kept for the buyer", async () => {
  const first = ledgerIn();
  first.l.begin(pending());
  const onDisk = readFileSync(join(first.dir, "ledger", "pending", `${pending().key}.json`), "utf8");
  assert.ok(!onDisk.includes("signature"), "the ledger keeps the payload digest, never the signed payload");
  // The process dies here: settle was called, nothing else happened.

  const second = ledgerIn(first.dir);
  assert.equal(second.l.load(), 1);
  const { c, chain } = fakeChain();
  await second.l.reconcileAll(chain);
  assert.equal(second.l.pendingCount, 1, "not used yet: kept, nobody charged so far");

  c.uses.push({ tx: TX, block: c.head - 2, payer: BUYER, nonce: NONCE, to: PAY_TO, value: 10_000n });
  await second.l.reconcileAll(chain);
  assert.equal(second.l.pendingCount, 0);
  const seen = second.l.lookup(pending().key);
  assert.equal(seen.state, "settled");
  const s = seen.state === "settled" ? seen.settled : null!;
  const id = receiptIdOf(TX, sha256Hex(BODY));
  assert.equal(s.receiptId, id);
  assert.equal(s.transaction, TX);
  assert.ok(existsSync(join(first.dir, "receipts", `${id}.json`)));
  assert.equal(Buffer.from(s.redeliver!.body, "base64").toString(), BODY.toString(), "the exact bytes that were built");
  assert.equal(s.redeliver!.headers["x-curb-receipt"], id);
  assert.equal(decodePaymentResponseHeader(s.redeliver!.headers["payment-response"]).transaction, TX);
  assert.deepEqual(readdirSync(join(first.dir, "ledger", "pending")), []);
  assert.ok(second.logged.some(([e]) => e === "reconciled-paid"));
});

test("a pending file this version cannot reconcile is left on disk and logged, never loaded or chased", () => {
  const first = ledgerIn();
  first.l.begin(pending());
  const dir = join(first.dir, "ledger", "pending");
  const junkKey = `${BUYER.toLowerCase()}-0x${"55".repeat(32)}`;
  writeFileSync(join(dir, `${junkKey}.json`), JSON.stringify({ schema: PENDING_SCHEMA, key: junkKey }));
  writeFileSync(join(dir, "not-a-key.json"), "{}");
  const second = ledgerIn(first.dir);
  assert.equal(second.l.load(), 1, "only the well-formed record");
  assert.ok(second.logged.some(([e, f]) => e === "ledger-unreadable" && f.file === `${junkKey}.json`));
  assert.ok(existsSync(join(dir, `${junkKey}.json`)), "left for a human");
});

test("an authorization still unused once the chain's clock is past validBefore is dropped: it is dead, nobody was charged", async () => {
  const { l, logged } = ledgerIn();
  l.begin(pending());
  const { c, chain } = fakeChain();
  await l.reconcile(pending().key, chain);
  assert.equal(l.pendingCount, 1);
  c.ts = VALID_BEFORE + 61;
  await l.reconcile(pending().key, chain);
  assert.equal(l.pendingCount, 0);
  assert.equal(l.lookup(pending().key).state, "free");
  assert.ok(logged.some(([e]) => e === "reconciled-unpaid"));
});

test("the reconciler never touches a key a request holds, and asks at most once per gap however often it is prompted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-asp-ledger-"));
  const l = new AuthorizationLedger({ dir, receiptsDir: join(dir, "r"), now: () => T0, minAskGapMs: 60_000 });
  const { c, chain } = fakeChain();
  const key = pending().key;
  l.claim(key);
  l.begin(pending());
  await l.reconcile(key, chain);
  assert.deepEqual(c.calls, [], "in flight: the request's own chain check owns it");
  l.release(key);
  await Promise.all([l.reconcile(key, chain), l.reconcile(key, chain)]);
  await l.reconcile(key, chain);
  assert.deepEqual(c.calls, ["state"], "one chain read for three prompts");
});
