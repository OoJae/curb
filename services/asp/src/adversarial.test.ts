/**
 * Adversarial review of services/asp. Each test PROVES a defence holds. The review's findings were first
 * pinned here as "DEFECT:" tests asserting the broken behaviour; each is now "FIXED:" and asserts the
 * behaviour that replaced it, so a regression fails loudly. Offline: real node:http server, the real
 * x402-core resource server, a stub Broker, and an in-memory USD₮0 for the chain's side of a payment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getAddress, toBeHex, zeroPadValue } from "ethers";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type { PaymentPayload, PaymentRequired, SettleResponse, SupportedResponse, VerifyResponse } from "@okxweb3/x402-core/types";

import { createApp } from "./app.ts";
import type { AppState } from "./app.ts";
import { calendarHandler } from "./calendarRoute.ts";
import { TimelineCache, buildTimeline, buildCalendar } from "./closureCalendar.ts";
import type { Asset } from "./cohort.ts";
import { VenueStore } from "./venue.ts";
import { XStocksClient } from "./sources/xstocks.ts";
import { pinLatest } from "./sources/chain.ts";
import { Payments, makeChainConfirm } from "./pay/server.ts";
import type { PricedHandler } from "./pay/server.ts";
import type { BrokerDeadlines } from "./pay/broker.ts";
import { USDT0 } from "./pay/routes.ts";
import { AUTHORIZATION_USED, TRANSFER, authorizationKey, settlementScope } from "./pay/authorization.ts";
import type { AuthorizationChain, SettlementExpectation } from "./pay/authorization.ts";
import { AuthorizationLedger, PENDING_SCHEMA } from "./pay/ledger.ts";
import { payloadDigestOf, receiptIdOf } from "./pay/receipt.ts";
import { silentLog } from "./log.ts";
import type { Log } from "./log.ts";
import { recordHandler, curveHandler } from "./scorecardRoutes.ts";
import type { ScorecardSnapshot, ScorecardStatus } from "./index/scorecard.ts";
import { ClosureIndex } from "./index/closures.ts";
import type { ClosureIndexStatus } from "./index/closures.ts";
import { tick } from "./main.ts";
import { row, settlement, snapshot as snapshotOf, closureView } from "./fixtures/scorecard.ts";

const T0 = new Date("2026-09-22T10:00:00+08:00").getTime();
const PUBLIC = "https://api.curb.markets";
const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const BUYER = getAddress("0x2222222222222222222222222222222222222222");
const TX = "0x" + "ab".repeat(32);
const NETWORK = "eip155:196" as const;
const NONCE = "0x" + "44".repeat(32);

const COHORT: Asset[] = [{
  wrapper: getAddress("0x41333df9e7639188bbfca5522dc4844398af9f9e"), symbol: "wTCENTx", rawSymbol: "TCENTx",
  raw: getAddress("0xfa15e42c18cf57aeef4b1bac1cee7754af7cfe42"), micOnChain: "XHKG",
  pool: getAddress("0xc89d8b547cea7cdeaa7474e7a90b6bad01fe992f"), equityIsToken0: true, equityDecimals: 18, stableDecimals: 6,
}];
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ISSUER = "https://issuer.test/api/v2/public";
const BODIES: Record<string, string> = {
  [`${ISSUER}/assets/TCENTx?network=XLayer`]: fixture("tcentx.asset.json"),
  [`${ISSUER}/exchanges/XHKG`]: fixture("xhkg.exchange.json"),
};
const issuerFetch = (async (input: string | URL | Request) => {
  const body = BODIES[String(input)];
  return body ? new Response(body, { status: 200 }) : new Response("no", { status: 404 });
}) as typeof fetch;

const SUPPORTED: SupportedResponse = {
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {},
};

class StubBroker implements FacilitatorClient {
  events: string[] = [];
  verifyGate: Promise<void> | null = null;
  settleGate: Promise<void> | null = null;
  supportedGate: Promise<void> | null = null;
  settleResult: SettleResponse = { success: true, status: "success", transaction: TX, network: NETWORK, payer: BUYER };
  async getSupported(): Promise<SupportedResponse> { this.events.push("supported"); if (this.supportedGate) await this.supportedGate; return SUPPORTED; }
  async verify(): Promise<VerifyResponse> { this.events.push("verify"); if (this.verifyGate) await this.verifyGate; return { isValid: true, payer: BUYER }; }
  async settle(): Promise<SettleResponse> {
    this.events.push("settle");
    if (this.settleGate) await this.settleGate;
    return this.settleResult;
  }
}

/**
 * USD₮0 as the chain would answer for it: an authorization is used by a transaction at a block, and that
 * transaction pays PAY_TO whatever `value` says.
 */
function fakeUsdt0() {
  const c = { head: 71_500_000, ts: Math.floor(T0 / 1000) + 5, uses: [] as Array<{ tx: string; block: number; payer: string; nonce: string; value: bigint }> };
  const chain: AuthorizationChain = {
    async state(payer, nonce) { return { used: c.uses.some((u) => u.payer === payer && u.nonce === nonce), block: c.head, timestamp: c.ts }; },
    async txPays(tx, e: SettlementExpectation) { const u = c.uses.find((x) => x.tx === tx); return !!u && u.payer === e.payer && u.nonce === e.nonce && u.value >= e.minAmount; },
    async findUse(payer, nonce, from, to) { return c.uses.find((u) => u.payer === payer && u.nonce === nonce && u.block >= from && u.block <= to)?.tx ?? null; },
  };
  const use = (tx: string, nonce = NONCE, value = 10_000n) => c.uses.push({ tx, block: c.head - 2, payer: BUYER, nonce, value });
  return { c, chain, use };
}

function scorecardAt(snap: ScorecardSnapshot) {
  return { status(nowMs: number): ScorecardStatus { const ageMs = nowMs - snap.readAtMs; return { snapshot: snap, ageMs, stale: false, outage: ageMs > 1_800_000, lastError: null }; } };
}

interface HarnessOptions {
  chain?: AuthorizationChain | null;
  dataDir?: string;
  deadlines?: Partial<BrokerDeadlines>;
  inlineReconcileMs?: number;
  log?: Log;
  /** Wires the settlement-timeout hook (makeChainConfirm) to this receipt source. */
  confirmRpc?: (method: string, params: unknown[]) => Promise<unknown>;
  closures?: { status(): ClosureIndexStatus };
}

async function harness(o: HarnessOptions = {}) {
  const now = () => T0;
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "curb-asp-adv-"));
  const log = o.log ?? silentLog;
  const state: AppState = { bootMs: T0, ticks: 1, lastTickOkMs: T0, cohort: COHORT, cohortAsOfMs: T0, cohortError: null };
  const venues = new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 });
  await venues.refresh(COHORT, new XStocksClient(ISSUER, issuerFetch, now), now);
  const scorecard = scorecardAt(snapshotOf([row({ wrapper: COHORT[0].wrapper, settlement: settlement() })], { readAtMs: T0 }));
  const view = closureView([], 71_450_000);
  const deps = { cohort: () => state.cohort, scorecard, closures: view, chainId: 196 };
  const handlers = new Map<string, PricedHandler>([
    ["GET /v1/closure-calendar", calendarHandler({ cohort: () => state.cohort, venues, timelines: new TimelineCache() })],
    ["GET /v1/accuracy-record", recordHandler(deps)],
    ["GET /v1/discount-curve", curveHandler(deps)],
  ]);
  const broker = new StubBroker();
  const payments = new Payments({
    network: NETWORK, payTo: PAY_TO, okx: null, facilitator: broker, syncSettle: true, publicUrl: PUBLIC, handlers, now, log, initRetryMs: 0,
    // Short, so a silent Broker costs a test a fraction of a second instead of the production 10-30 s.
    brokerDeadlines: { supportedMs: 300, verifyMs: 300, settleMs: 2_000, statusMs: 100, ...o.deadlines },
    confirmSettlementTx: o.confirmRpc ? makeChainConfirm(o.confirmRpc, USDT0.address, PAY_TO) : undefined,
  });
  await payments.ensureReady();
  // As main.ts does: the ledger is built, and whatever a previous process left pending is loaded.
  const ledger = new AuthorizationLedger({ dir: join(dataDir, "ledger"), receiptsDir: join(dataDir, "receipts"), now, log, minAskGapMs: 0 });
  ledger.load();
  const server = createServer(createApp({
    state, venues, payments, handlers, dataDir, publicUrl: PUBLIC, tickMs: 30_000,
    contracts: { chainId: 196, clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b", scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f" },
    now, log, scorecard, closures: o.closures ?? view, ledger, authChain: o.chain ?? null, inlineReconcileMs: o.inlineReconcileMs ?? 200,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  const receipts = () => (existsSync(join(dataDir, "receipts")) ? readdirSync(join(dataDir, "receipts")) : []);
  return { base, port, broker, close, receipts, ledger, dataDir };
}

const API = { accept: "application/json", "user-agent": "curb-adv/1.0" };

async function challengeFor(base: string, path: string, query: string): Promise<PaymentRequired> {
  const r = await fetch(`${base}${path}?${query}`, { headers: API });
  assert.equal(r.status, 402);
  await r.arrayBuffer();
  return decodePaymentRequiredHeader(r.headers.get("payment-required")!);
}

function pay(pr: PaymentRequired, nonce = NONCE): string {
  const accepted = pr.accepts[0];
  const payload: PaymentPayload = {
    x402Version: 2, resource: pr.resource, accepted,
    payload: {
      signature: "0x" + "5e".repeat(65),
      authorization: { from: BUYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(T0 / 1000) + 300), nonce },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

/** Raw request, so the request line is sent exactly as written (fetch normalises paths). */
function raw(port: number, requestLine: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let buf = "";
    s.on("data", (d) => { buf += d.toString("latin1"); });
    s.on("end", () => {
      const [head, ...rest] = buf.split("\r\n\r\n");
      const lines = head.split("\r\n");
      const hs: Record<string, string> = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(":"); hs[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      resolve({ status: Number(lines[0].split(" ")[1]), body: rest.join("\r\n\r\n"), headers: hs });
    });
    s.on("error", reject);
    const hdr = Object.entries({ host: "x", connection: "close", accept: "application/json", "user-agent": "curb-adv", ...headers }).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    s.write(`${requestLine}\r\n${hdr}\r\n\r\n`);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await sleep(5);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------------------------
// defences that hold
// ---------------------------------------------------------------------------------------------

test("HOLDS: path, case, encoding and method tricks never reach paid content or the Broker", async () => {
  const h = await harness();
  try {
    const cases: Array<[string, number[]]> = [
      ["GET /v1/closure-calendar/?symbol=wTCENTx HTTP/1.1", [402]],
      ["GET /v1/closure-calendar//?symbol=wTCENTx HTTP/1.1", [402]],
      ["GET /V1/CLOSURE-CALENDAR?symbol=wTCENTx HTTP/1.1", [404]],
      ["GET /v1/closure%2Dcalendar?symbol=wTCENTx HTTP/1.1", [404]],
      ["GET /v1//closure-calendar?symbol=wTCENTx HTTP/1.1", [404]],
      ["GET /v1/./closure-calendar?symbol=wTCENTx HTTP/1.1", [402]],
      ["GET /x/../v1/closure-calendar?symbol=wTCENTx HTTP/1.1", [402]],
      // Absolute form: the adapter never reads the authority, and maps a non-origin-form target to "/".
      ["GET http://evil.test/v1/closure-calendar?symbol=wTCENTx HTTP/1.1", [200]],
      ["HEAD /v1/closure-calendar?symbol=wTCENTx HTTP/1.1", [405]],
      ["POST /v1/closure-calendar?symbol=wTCENTx HTTP/1.1", [405]],
      ["get /v1/closure-calendar?symbol=wTCENTx HTTP/1.1", [400]],
    ];
    for (const [line, ok] of cases) {
      const r = await raw(h.port, line, { "payment-signature": "garbage" });
      assert.ok(ok.includes(r.status), `${line} -> ${r.status}`);
      assert.ok(!r.body.includes("curb.asp.calendar/1\""), `${line} leaked the paid schema`);
      assert.ok(!r.body.includes("\"windows\""), `${line} leaked windows`);
    }
    assert.ok(!h.broker.events.includes("verify") && !h.broker.events.includes("settle"));
  } finally { await h.close(); }
});

test("HOLDS: a payment signed for the $0.01 route is refused by the $0.10 route before the Broker is asked", async () => {
  const h = await harness();
  try {
    const pr = await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx");
    const r = await fetch(`${h.base}/v1/discount-curve`, { headers: { ...API, "payment-signature": pay(pr) } });
    assert.equal(r.status, 402);
    const body = await r.text();
    assert.ok(!body.includes("observations"));
    assert.deepEqual(h.broker.events, ["supported"]);
  } finally { await h.close(); }
});

test("HOLDS: bodies are capped, receipts cannot be traversed, a bad payment header is just an unpaid call", async () => {
  const h = await harness();
  try {
    const big = await new Promise<number>((resolve) => {
      const rq = httpRequest(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { method: "GET", headers: { ...API, "content-length": "70000" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      rq.on("error", () => resolve(-1));
      rq.end("x".repeat(70_000));
    });
    assert.equal(big, 413);
    for (const p of ["/receipts/..%2f..%2fetc%2fpasswd.json", "/receipts/0x" + "a".repeat(63) + ".json", "/receipts/../issuer/x.json", "/issuer/0x" + "g".repeat(64) + ".json"]) {
      const r = await raw(h.port, `GET ${p} HTTP/1.1`);
      assert.equal(r.status, 404, p);
    }
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": "%%%not-base64%%%" } });
    assert.equal(r.status, 402);
    assert.deepEqual(Object.keys(await r.json()).sort(), ["marketOpen", "mic", "nextClosure", "nowPeriod", "schema", "symbol"]);
    for (const q of ["horizonDays=1e9", "horizonDays=-1", "horizonDays=NaN", "horizonDays=0x7", "horizonDays=%00"]) {
      const bad = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx&${q}`, { headers: API });
      assert.equal(bad.status, 400, q);
    }
    for (const q of ["limit=0", "limit=201", "limit=-5", "limit=1.5", "limit=Infinity"]) {
      assert.equal((await fetch(`${h.base}/v1/accuracy-record?${q}`, { headers: API })).status, 400, q);
    }
    for (const q of ["minMinutes=29", "minMinutes=10081", "minMinutes=NaN"]) {
      assert.equal((await fetch(`${h.base}/v1/discount-curve?${q}`, { headers: API })).status, 400, q);
    }
    assert.deepEqual(h.broker.events, ["supported"]);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------------------------
// the review's findings, fixed
// ---------------------------------------------------------------------------------------------

const sha256 = (b: Uint8Array) => "0x" + createHash("sha256").update(b).digest("hex");
const PREVIEW_KEYS = ["marketOpen", "mic", "nextClosure", "nowPeriod", "schema", "symbol"];

test("FIXED: a buyer who disconnects while verify is in flight is never settled, and the same payment still works afterwards", async () => {
  const h = await harness();
  try {
    const header = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    let release!: () => void;
    h.broker.verifyGate = new Promise<void>((r) => { release = r; });
    const req = httpRequest(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    req.on("error", () => {});
    req.end();
    // Wait until the Broker is verifying, then the buyer gives up (a client timeout, a dropped mobile link).
    await until(() => h.broker.events.includes("verify"), "verify");
    req.destroy();
    await sleep(50);
    release();
    await until(() => h.ledger.inFlightCount === 0, "the request to finish");
    assert.ok(!h.broker.events.includes("settle"), "nobody is waiting for the answer, so nobody is charged for it");
    assert.deepEqual(h.receipts(), []);
    assert.equal(h.ledger.lookup(authorizationKey({ payer: BUYER, nonce: NONCE })).state, "free", "the authorization was never used");

    // The buyer comes back with the same, still-valid authorization: an ordinary paid call.
    h.broker.verifyGate = null;
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    assert.equal(h.broker.events.filter((e) => e === "settle").length, 1);
  } finally { await h.close(); }
});

test("FIXED: a buyer whose socket dies while settle is in flight is charged once, and the same header then returns those exact bytes", async () => {
  const h = await harness({ deadlines: { settleMs: 5_000 } });
  try {
    const header = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    let release!: () => void;
    h.broker.settleGate = new Promise<void>((r) => { release = r; });
    const req = httpRequest(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    req.on("error", () => {});
    req.end();
    await until(() => h.broker.events.includes("settle"), "settle");
    req.destroy();
    await sleep(50);
    release();
    await until(() => h.receipts().length === 1, "the receipt");

    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(JSON.parse(bytes.toString("utf8")).schema, "curb.asp.calendar/1");
    const id = r.headers.get("x-curb-receipt")!;
    assert.deepEqual(h.receipts(), [`${id}.json`]);
    assert.equal(id, receiptIdOf(TX, sha256(bytes)), "the bytes the receipt was written for");
    assert.equal(decodePaymentResponseHeader(r.headers.get("payment-response")!).transaction, TX);
    assert.equal(h.broker.events.filter((e) => e === "settle").length, 1, "redelivered, never settled again");
  } finally { await h.close(); }
});

test("FIXED: two concurrent requests carrying ONE payment: the second is refused before verify; one settle, one answer, even across a restart", async () => {
  const h = await harness({ deadlines: { settleMs: 5_000 } });
  try {
    const sig = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    let release!: () => void;
    h.broker.settleGate = new Promise<void>((r) => { release = r; });
    const a = fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": sig } });
    await until(() => h.broker.events.includes("settle"), "the first request to reach settle");
    const b = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx&horizonDays=14`, { headers: { ...API, "payment-signature": sig } });
    assert.equal(b.status, 409);
    assert.equal((await b.json()).error, "payment-in-use");
    assert.equal(b.headers.get("retry-after"), "5");
    release();
    const ra = await a;
    assert.equal(ra.status, 200);
    const id = ra.headers.get("x-curb-receipt");
    await ra.arrayBuffer();

    // After it, the payment is used -- whatever the Broker would say about a duplicate settle.
    const c = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": sig } });
    assert.equal(c.status, 409);
    const cb = await c.json();
    assert.equal(cb.error, "payment-already-used");
    assert.equal(cb.receiptId, id);
    assert.deepEqual(h.broker.events.filter((e) => e === "verify" || e === "settle"), ["verify", "settle"]);
    assert.equal(h.receipts().length, 1);

    // The ledger is on the volume: a new process refuses it too, without asking its Broker anything.
    const h2 = await harness({ dataDir: h.dataDir });
    try {
      const d = await fetch(`${h2.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": sig } });
      assert.equal(d.status, 409);
      await d.arrayBuffer();
      assert.deepEqual(h2.broker.events, ["supported"]);
    } finally { await h2.close(); }
  } finally { await h.close(); }
});

test("FIXED: a Broker that never answers /supported cannot stall the tick, and the attempt is abandoned at its deadline", async () => {
  const broker = new StubBroker();
  broker.supportedGate = new Promise<void>(() => {});   // the Broker accepts the connection and never answers
  const now = () => T0;
  const payments = new Payments({
    network: NETWORK, payTo: PAY_TO, okx: null, facilitator: broker, syncSettle: true, publicUrl: PUBLIC, handlers: new Map(), now, log: silentLog,
    // Long enough that a tick which awaited /supported would visibly wait for it.
    initRetryMs: 0, brokerDeadlines: { supportedMs: 1_500 },
  });
  const state: AppState = { bootMs: T0, ticks: 0, lastTickOkMs: 0, cohort: [], cohortAsOfMs: 0, cohortError: null };
  const venues = new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 });
  let scorecardRefreshes = 0;
  const started = Date.now();
  await tick({
    state, venues, timelines: new TimelineCache(), payments, client: new XStocksClient(ISSUER, issuerFetch, now),
    readCohort: async () => COHORT, cohortRefreshMs: 600_000, scorecard: { refresh: async () => { scorecardRefreshes++; } }, now, log: silentLog,
  });
  assert.ok(Date.now() - started < 700, "the tick finished without waiting on the Broker; main() can count it and /healthz go ok");
  assert.equal(scorecardRefreshes, 1);
  assert.equal(state.cohort.length, 1);
  assert.ok(venues.status(COHORT[0].wrapper, T0).venue, "the steps after it ran");
  const warn = console.warn;
  console.warn = () => {};   // the SDK logs each failed /supported
  try {
    assert.equal(await payments.ensureReady(), false, "the tick's own attempt, given up at its deadline");
  } finally { console.warn = warn; }
  assert.match(payments.lastInitError!, /supported gave no answer within 1500 ms/);
  assert.deepEqual(broker.events, ["supported"], "one attempt at a time");
});

test("FIXED: a Broker that never answers verify is a 503 at the verify deadline, before anything is built or settled", async () => {
  const h = await harness();   // verify deadline 300 ms
  try {
    const header = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    h.broker.verifyGate = new Promise<void>(() => {});
    const started = Date.now();
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header }, signal: AbortSignal.timeout(5_000) });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(r.headers.get("retry-after"), "10");
    assert.deepEqual(await r.json(), { error: "broker-unavailable", stage: "verify", timedOut: true, detail: "the payment was not charged; retry" });
    assert.ok(!h.broker.events.includes("settle"));
    assert.deepEqual(h.receipts(), []);
    assert.equal(h.ledger.lookup(authorizationKey({ payer: BUYER, nonce: NONCE })).state, "free", "the payment can be presented again");
  } finally { await h.close(); }
});

test("FIXED: a Broker error AFTER the transfer was submitted is settled by the chain: the buyer gets the answer and a receipt", async () => {
  const usdt0 = fakeUsdt0();
  const h = await harness({ chain: usdt0.chain });
  try {
    const header = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    const MINED = "0x" + "cd".repeat(32);
    // OKXFacilitatorClient.settle throws exactly this on any non-2xx -- here after the transfer went out.
    h.broker.settle = async () => { h.broker.events.push("settle"); usdt0.use(MINED); throw new Error("OKX settle failed: 504"); };
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(JSON.parse(bytes.toString("utf8")).schema, "curb.asp.calendar/1");
    const id = r.headers.get("x-curb-receipt")!;
    assert.equal(id, receiptIdOf(MINED, sha256(bytes)));
    assert.equal(decodePaymentResponseHeader(r.headers.get("payment-response")!).transaction, MINED);
    const receipt = JSON.parse(readFileSync(join(h.dataDir, "receipts", `${id}.json`), "utf8"));
    assert.deepEqual([receipt.transaction, receipt.payer, receipt.settleStatus, receipt.amount], [MINED, BUYER, "success", "10000"]);
    assert.equal(h.ledger.pendingCount, 0);
  } finally { await h.close(); }
});

test("FIXED: a Broker that never answers settle is an unknown outcome at the deadline, and the chain settles it", async () => {
  const usdt0 = fakeUsdt0();
  const h = await harness({ chain: usdt0.chain, deadlines: { settleMs: 300 } });
  try {
    const header = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    const MINED = "0x" + "c0".repeat(32);
    h.broker.settle = () => { h.broker.events.push("settle"); usdt0.use(MINED); return new Promise<never>(() => {}); };
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header }, signal: AbortSignal.timeout(5_000) });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(r.headers.get("x-curb-receipt"), receiptIdOf(MINED, sha256(bytes)));
  } finally { await h.close(); }
});

test("FIXED: a Broker error with nothing on chain yet is a 503 settlement-unconfirmed; once it mines, the SAME header returns the answer built for it", async () => {
  const usdt0 = fakeUsdt0();
  const h = await harness({ chain: usdt0.chain });
  try {
    const header = pay(await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx"));
    h.broker.settle = async () => { h.broker.events.push("settle"); throw new Error("OKX settle failed: 504"); };
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "15");
    const body = await r.json();
    assert.equal(body.error, "settlement-unconfirmed");
    assert.equal(body.validBefore, Math.floor(T0 / 1000) + 300);
    assert.match(body.detail, /SAME PAYMENT-SIGNATURE/);
    assert.deepEqual(h.receipts(), []);

    // Asked again before it mines: still unconfirmed, and the Broker is never asked to settle it again.
    const again = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    assert.equal(again.status, 503);
    await again.arrayBuffer();

    const MINED = "0x" + "c1".repeat(32);
    usdt0.use(MINED);
    // Even with another query: what comes back is the answer that was built and paid for, not a new one.
    const paid = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx&horizonDays=14`, { headers: { ...API, "payment-signature": header } });
    assert.equal(paid.status, 200);
    const bytes = Buffer.from(await paid.arrayBuffer());
    assert.equal(JSON.parse(bytes.toString("utf8")).horizonDays, 7);
    assert.equal(paid.headers.get("x-curb-receipt"), receiptIdOf(MINED, sha256(bytes)));
    assert.deepEqual(h.broker.events.filter((e) => e === "verify" || e === "settle"), ["verify", "settle"]);
  } finally { await h.close(); }
});

test("FIXED: a crash between settle and receipt no longer loses a payment: the next process reconciles it, and the same header returns the answer", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "curb-asp-adv-crash-"));
  const h0 = await harness({ dataDir });
  const pr = await challengeFor(h0.base, "/v1/closure-calendar", "symbol=wTCENTx");
  await h0.close();
  const header = pay(pr);
  const built = Buffer.from(JSON.stringify({ schema: "curb.asp.calendar/1", symbol: "wTCENTx", note: "built before the crash" }));
  // What flow.ts writes, fsynced, before it calls settle. Then the process is killed mid-settle.
  new AuthorizationLedger({ dir: join(dataDir, "ledger"), receiptsDir: join(dataDir, "receipts"), now: () => T0 }).begin({
    schema: PENDING_SCHEMA, key: authorizationKey({ payer: BUYER, nonce: NONCE }), payer: BUYER, nonce: NONCE,
    validBefore: Math.floor(T0 / 1000) + 300, route: "GET /v1/closure-calendar", query: { symbol: "wTCENTx", horizonDays: 7 },
    requirements: pr.accepts[0], payloadDigest: payloadDigestOf(decodePaymentSignatureHeader(header)),
    body: built.toString("base64"), contentType: "application/json; charset=utf-8", startedMs: T0, transaction: null, refused: null,
  });
  const usdt0 = fakeUsdt0();
  const MINED = "0x" + "c2".repeat(32);
  usdt0.use(MINED);   // the settle it had asked for went through

  const h = await harness({ dataDir, chain: usdt0.chain });
  try {
    assert.equal(h.ledger.pendingCount, 1, "loaded at boot");
    await h.ledger.reconcileAll(usdt0.chain);   // the reconciler's loop body
    assert.equal(h.ledger.pendingCount, 0);
    const id = receiptIdOf(MINED, sha256(built));
    assert.deepEqual(h.receipts(), [`${id}.json`]);
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": header } });
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), built);
    assert.equal(r.headers.get("x-curb-receipt"), id);
    assert.deepEqual(h.broker.events, ["supported"], "nothing verified or settled again");
  } finally { await h.close(); }
});

test("FIXED: the settlement-timeout hook confirms ONLY this payment: a stranger's 1-unit transfer to PAY_TO confirms nothing", async () => {
  const stranger = getAddress("0x9999999999999999999999999999999999999999");
  const strangerTransfer = { address: USDT0.address, topics: [TRANSFER, zeroPadValue(stranger, 32), zeroPadValue(PAY_TO, 32)], data: toBeHex(1n, 32) };
  const ours = (nonce: string, amount: bigint) => [
    { address: USDT0.address, topics: [AUTHORIZATION_USED, zeroPadValue(BUYER, 32), nonce], data: "0x" },
    { address: USDT0.address, topics: [TRANSFER, zeroPadValue(BUYER, 32), zeroPadValue(PAY_TO, 32)], data: toBeHex(amount, 32) },
  ];
  const hook = (logs: unknown[]) => makeChainConfirm(async (method) => {
    assert.equal(method, "eth_getTransactionReceipt");
    return { status: "0x1", logs };
  }, USDT0.address, PAY_TO);
  const expected = { payer: BUYER, nonce: NONCE, minAmount: 100_000n };
  const inScope = (logs: unknown[]) => settlementScope.run(expected, () => hook(logs)("0x" + "cd".repeat(32), NETWORK));
  assert.deepEqual(await inScope([strangerTransfer]), { confirmed: false });
  assert.deepEqual(await hook([strangerTransfer])("0x" + "cd".repeat(32), NETWORK), { confirmed: false }, "outside a settlement, nothing is confirmed");
  assert.deepEqual(await inScope(ours("0x" + "55".repeat(32), 100_000n)), { confirmed: false }, "another authorization");
  assert.deepEqual(await inScope(ours(NONCE, 99_999n)), { confirmed: false }, "short of the price");
  assert.deepEqual(await inScope(ours(NONCE, 100_000n)), { confirmed: true });

  // End to end: the SDK calls the hook from inside processSettlement, and the flow's scope reaches it.
  const NAMED = "0x" + "ee".repeat(32);
  let receiptOfNamed: unknown = { status: "0x1", logs: [strangerTransfer] };
  const h = await harness({ confirmRpc: async () => receiptOfNamed });
  try {
    const pr = await challengeFor(h.base, "/v1/closure-calendar", "symbol=wTCENTx");
    h.broker.settleResult = { success: false, status: "timeout", transaction: NAMED, network: NETWORK, payer: BUYER };
    const r1 = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": pay(pr, "0x" + "61".repeat(32)) } });
    assert.equal(r1.status, 503, "the named transaction is not this payment: unconfirmed, and no content");
    assert.equal((await r1.json()).error, "settlement-unconfirmed");
    assert.deepEqual(h.receipts(), []);
    receiptOfNamed = { status: "0x1", logs: ours("0x" + "62".repeat(32), 10_000n) };
    const r2 = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": pay(pr, "0x" + "62".repeat(32)) } });
    assert.equal(r2.status, 200);
    await r2.arrayBuffer();
    assert.equal(decodePaymentResponseHeader(r2.headers.get("payment-response")!).transaction, NAMED);
  } finally { await h.close(); }
});

test("FIXED: a closure whose cut lies in the last 300 s of the horizon is listed even from a timeline at the end of its cache life", () => {
  const venue = JSON.parse(fixture("tcentx.asset.json"));
  const sched = JSON.parse(fixture("xhkg.exchange.json"));
  const limits = venue.trading.limitsPerPeriod;
  // A cut at 11:55 HKT on Thu 8 Oct 2026. The request is made so that the 14-day horizon ends 60 s after it.
  const cut = Date.parse("2026-10-08T11:55:00+08:00");
  const nowMs = cut + 60_000 - 14 * 86_400_000;
  const anchor = nowMs - 2 * 86_400_000 + 100_000;
  const aged = buildTimeline(limits, sched, "k", anchor);   // what the cache still hands out: 100 s of life left
  const fresh = buildTimeline(limits, sched, "k", nowMs);
  const v = { mic: "XHKG", limits, sched, atMs: nowMs, reportedPeriod: null, halted: false, assetUrl: "a", assetBodyHash: "0x", exchangeUrl: "e", exchangeBodyHash: "0x" };
  const calendarFrom = (timeline: typeof aged) => buildCalendar({ symbol: "wTCENTx", wrapper: COHORT[0].wrapper, venue: v, timeline, nowMs, horizonDays: 14 });
  assert.equal(calendarFrom(fresh).windows.some((w) => w.startMs === cut), true);
  assert.equal(calendarFrom(aged).windows.some((w) => w.startMs === cut), true, "the aged timeline lists the 11:55 cut too");
  assert.deepEqual(calendarFrom(aged).windows, calendarFrom(fresh).windows);

  // The cache hands a timeline out exactly while it lists every cut a 14-day horizon can reach, and no longer.
  const cache = new TimelineCache();
  const inputs = { limits, sched, inputsKey: "k" };
  const t = cache.get("w", inputs, anchor);
  assert.equal(cache.get("w", inputs, anchor + 2 * 86_400_000), t, "reused through the end of its life");
  assert.notEqual(cache.get("w", inputs, anchor + 2 * 86_400_000 + 1), t, "rebuilt the moment it could miss a cut");
  // And a timeline that could miss one is refused loudly, never used.
  assert.throws(() => calendarFrom({ ...aged, toMs: aged.toMs - 400_000 }), /does not cover the requested horizon/);
});

test("FIXED: an RPC URL carrying an API key never reaches an error string or the public /healthz", async () => {
  const keyed = "https://xlayer-mainnet.example-rpc.test/v2/SECRET_KEY_abc123";
  const ix = new ClosureIndex({
    path: join(mkdtempSync(join(tmpdir(), "curb-adv-ix-")), "ix.json"), clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b", rpcs: [keyed],
    rpc: async (_url, method) => { if (method === "eth_blockNumber") return "0x" + (71_000_000).toString(16); throw new Error("429 over rate limit"); },
  });
  await ix.step();
  const err = ix.status().lastError ?? "";
  assert.match(err, /rpc\[0\] https:\/\/xlayer-mainnet\.example-rpc\.test: 429 over rate limit/);
  assert.doesNotMatch(err, /SECRET_KEY_abc123/);

  // pinLatest's reasons become the Scorecard snapshot's lastError, also on /healthz: named the same way.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  try {
    await assert.rejects(pinLatest([keyed, "https://rpc.two.test/?apikey=SECRET_TWO"], 1), (e: Error) => {
      assert.doesNotMatch(e.message, /SECRET/);
      assert.match(e.message, /attempt 1 rpc\[0\] https:\/\/xlayer-mainnet\.example-rpc\.test: TypeError: fetch failed \| attempt 1 rpc\[1\] https:\/\/rpc\.two\.test/);
      return true;
    });
  } finally { globalThis.fetch = realFetch; }

  // End to end: /healthz serves the index's status verbatim.
  const h = await harness({ closures: ix });
  try {
    const text = await (await fetch(`${h.base}/healthz`)).text();
    assert.match(text, /rpc\[0\] https:\/\/xlayer-mainnet\.example-rpc\.test/);
    assert.doesNotMatch(text, /SECRET_KEY_abc123/);
  } finally { await h.close(); }
});

test("FIXED: junk PAYMENT-SIGNATURE headers print no stack traces, cost one structured line a minute, and are each still a 402 with the preview", async () => {
  const events: string[] = [];
  const h = await harness({ log: (e) => { events.push(e); } });
  const orig = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const junk = ["A".repeat(8000), "garbage", "%%%not-base64%%%", Buffer.from("{not json").toString("base64")];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "payment-signature": junk[i % junk.length] } });
      assert.equal(r.status, 402);
      assert.ok(r.headers.get("payment-required"), "a real challenge");
      assert.deepEqual(Object.keys(await r.json()).sort(), PREVIEW_KEYS);
    }
  } finally { console.warn = orig; await h.close(); }
  assert.equal(warned, 0, "the SDK never saw a header it could not decode");
  assert.equal(events.filter((e) => e === "payment-header-undecodable").length, 1);
  assert.ok(!h.broker.events.includes("verify"));
});
