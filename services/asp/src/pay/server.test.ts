import { test } from "node:test";
import assert from "node:assert/strict";
import { toBeHex, zeroPadValue } from "ethers";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type { SupportedResponse } from "@okxweb3/x402-core/types";
import { makeChainConfirm, Payments } from "./server.ts";
import { USDT0 } from "./routes.ts";
import { AUTHORIZATION_USED, TRANSFER, settlementScope } from "./authorization.ts";
import { BrokerError, withDeadlines } from "./broker.ts";
import { silentLog } from "../log.ts";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const NONCE = "0x" + "44".repeat(32);
const PRICE = 100_000n;   // $0.10
const used = (address: string, payer = BUYER, nonce = NONCE) =>
  ({ address, topics: [AUTHORIZATION_USED, zeroPadValue(payer, 32), nonce], data: "0x" });
const transfer = (address: string, to: string, amount = PRICE, from = BUYER) =>
  ({ address, topics: [TRANSFER, zeroPadValue(from, 32), zeroPadValue(to, 32)], data: toBeHex(amount, 32) });
const SUPPORTED: SupportedResponse = { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }], extensions: [], signers: {} };

test("the settlement-timeout hook confirms only THIS payment: its authorization used, and at least the price from its payer to PAY_TO", async () => {
  const hook = (receipt: unknown) => makeChainConfirm(async () => receipt, USDT0.address, PAY_TO);
  const inScope = (receipt: unknown) =>
    settlementScope.run({ payer: BUYER, nonce: NONCE, minAmount: PRICE }, () => hook(receipt)("0xabc", "eip155:196"));
  const ok = { status: "0x1", logs: [used(USDT0.address.toLowerCase()), transfer(USDT0.address, PAY_TO)] };
  assert.deepEqual(await inScope(ok), { confirmed: true });
  assert.deepEqual(await inScope({ ...ok, status: "0x0" }), { confirmed: false }, "reverted");
  assert.deepEqual(await inScope(null), { confirmed: false }, "not mined");
  const cases: Array<[string, unknown[]]> = [
    ["paid someone else", [used(USDT0.address), transfer(USDT0.address, "0x3333333333333333333333333333333333333333")]],
    ["some other token", [used("0x4444444444444444444444444444444444444444"), transfer("0x4444444444444444444444444444444444444444", PAY_TO)]],
    ["one atomic unit from a stranger", [transfer(USDT0.address, PAY_TO, 1n, "0x9999999999999999999999999999999999999999")]],
    ["the price, from a stranger", [used(USDT0.address), transfer(USDT0.address, PAY_TO, PRICE, "0x9999999999999999999999999999999999999999")]],
    ["less than the price", [used(USDT0.address), transfer(USDT0.address, PAY_TO, PRICE - 1n)]],
    ["another authorization of the same payer", [used(USDT0.address, BUYER, "0x" + "55".repeat(32)), transfer(USDT0.address, PAY_TO)]],
    ["a transfer with no authorization used", [transfer(USDT0.address, PAY_TO)]],
  ];
  for (const [why, logs] of cases) assert.deepEqual(await inScope({ status: "0x1", logs }), { confirmed: false }, why);
  assert.deepEqual(await hook(ok)("0xabc", "eip155:196"), { confirmed: false }, "outside a settlement there is nothing to confirm");
  const throwing = makeChainConfirm(async () => { throw new Error("rpc down"); }, USDT0.address, PAY_TO);
  assert.deepEqual(await settlementScope.run({ payer: BUYER, nonce: NONCE, minAmount: PRICE }, () => throwing("0xabc", "eip155:196")), { confirmed: false });
});

test("every Broker call has a deadline; a settle that errors or stalls is an unknown outcome, not a refusal", async () => {
  const never = new Promise<never>(() => {});
  const inner: FacilitatorClient = {
    getSupported: () => never,
    verify: () => never,
    settle: async () => { throw new Error("OKX settle failed: 504"); },
  };
  const bounded = withDeadlines(inner, { supportedMs: 20, verifyMs: 30, settleMs: 40, statusMs: 10 });
  await assert.rejects(bounded.getSupported(), (e: unknown) => e instanceof BrokerError && e.call === "supported" && e.timedOut);
  const payload = {} as never;
  await assert.rejects(bounded.verify(payload, payload), (e: unknown) => e instanceof BrokerError && e.call === "verify" && e.timedOut && /30 ms/.test(e.message));
  await assert.rejects(bounded.settle(payload, payload), (e: unknown) => e instanceof BrokerError && e.call === "settle" && !e.timedOut && /504/.test(e.message));
  assert.equal(bounded.getSettleStatus, undefined, "no status poll is invented for a Broker without one");

  const withStatus = withDeadlines({ ...inner, getSettleStatus: () => never }, { supportedMs: 20, verifyMs: 20, settleMs: 20, statusMs: 15 });
  await assert.rejects(withStatus.getSettleStatus!("0xabc"), (e: unknown) => e instanceof BrokerError && e.call === "status" && e.timedOut);

  // Answers pass through untouched, including a Broker's own "not valid".
  const fine = withDeadlines({ ...inner, verify: async () => ({ isValid: false, invalidReason: "nope" }) }, { supportedMs: 20, verifyMs: 50, settleMs: 20, statusMs: 20 });
  assert.deepEqual(await fine.verify(payload, payload), { isValid: false, invalidReason: "nope" });
});

test("ensureReady is single-flight, never rejects, and gives up on a silent Broker at the /supported deadline", async () => {
  let calls = 0;
  let answer: ((s: SupportedResponse) => void) | null = null;
  const broker: FacilitatorClient = {
    getSupported: () => { calls++; return new Promise<SupportedResponse>((r) => { answer = r; }); },
    verify: async () => { throw new Error("unused"); }, settle: async () => { throw new Error("unused"); },
  };
  const base = { network: "eip155:196" as const, payTo: PAY_TO, okx: null, syncSettle: true, publicUrl: "https://x.test", handlers: new Map(), now: () => 0, log: silentLog, initRetryMs: 0 };
  const p = new Payments({ ...base, facilitator: broker, brokerDeadlines: { supportedMs: 1_000 } });
  const a = p.ensureReady();
  const b = p.ensureReady();
  assert.equal(a, b, "a second caller gets the attempt already out");
  answer!(SUPPORTED);
  assert.equal(await a, true);
  assert.equal(calls, 1);

  const silent = new Payments({ ...base, facilitator: { ...broker, getSupported: () => new Promise<never>(() => {}) }, brokerDeadlines: { supportedMs: 30 } });
  const warn = console.warn;
  console.warn = () => {};   // the SDK logs each failed /supported
  try {
    assert.equal(await silent.ensureReady(), false);
  } finally { console.warn = warn; }
  assert.match(silent.lastInitError!, /supported gave no answer within 30 ms/);
});

test("payments are not configured without PAY_TO or credentials, and then never contact a Broker", async () => {
  const base = { network: "eip155:196" as const, syncSettle: true, publicUrl: "https://x.test", handlers: new Map(), now: () => 0, log: silentLog };
  const noPayTo = new Payments({ ...base, payTo: null, okx: { apiKey: "k", secretKey: "s", passphrase: "p" } });
  assert.equal(noPayTo.configured, false);
  assert.deepEqual(noPayTo.missing, ["PAY_TO"]);
  assert.equal(await noPayTo.ensureReady(), false);
  const noCreds = new Payments({ ...base, payTo: PAY_TO, okx: null });
  assert.equal(noCreds.configured, false);
  assert.deepEqual(noCreds.missing, ["OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE"]);
  const both = new Payments({ ...base, payTo: PAY_TO, okx: { apiKey: "k", secretKey: "s", passphrase: "p" } });
  assert.equal(both.configured, true, "production path: an OKXFacilitatorClient is built from the credentials");
  assert.equal(both.ready, false, "and nothing is ready until the Broker's /supported has been read");
});

test("a Broker that is down leaves payments unready, records why, and is retried no faster than the backoff", async () => {
  let t = 0;
  let calls = 0;
  const broker = {
    async getSupported() { calls++; throw new Error("OKX getSupported failed: 503"); },
    async verify() { throw new Error("unused"); },
    async settle() { throw new Error("unused"); },
  };
  const p = new Payments({
    network: "eip155:196", payTo: PAY_TO, okx: null, facilitator: broker, syncSettle: true, publicUrl: "https://x.test",
    handlers: new Map(), now: () => t, log: silentLog, initRetryMs: 60_000,
  });
  const warn = console.warn;
  console.warn = () => {};   // the SDK logs each failed /supported; the assertion below is the record
  try {
    assert.equal(await p.ensureReady(), false);
    assert.match(p.lastInitError!, /503/);
    t = 30_000;
    await p.ensureReady();
    assert.equal(calls, 1, "not retried inside the backoff");
    t = 61_000;
    await p.ensureReady();
    assert.equal(calls, 2);
  } finally { console.warn = warn; }
});
