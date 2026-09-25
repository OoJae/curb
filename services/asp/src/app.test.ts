/**
 * The priced flow end to end, offline: a real node:http server, the REAL x402-core resource server and
 * exact-scheme builder, a stub OKX Broker, stubbed issuer bytes (the attestor's committed fixtures) and a
 * fixed cohort. Nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type { PaymentPayload, PaymentRequired, SettleResponse, SupportedResponse, VerifyResponse } from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import { createApp } from "./app.ts";
import type { AppState } from "./app.ts";
import { calendarHandler } from "./calendarRoute.ts";
import { TimelineCache, CALENDAR_SCHEMA, PREVIEW_SCHEMA } from "./closureCalendar.ts";
import type { Asset } from "./cohort.ts";
import { VenueStore } from "./venue.ts";
import { XStocksClient } from "./sources/xstocks.ts";
import { Payments } from "./pay/server.ts";
import type { PricedHandler } from "./pay/server.ts";
import { PRICED_ROUTES, USDT0 } from "./pay/routes.ts";
import { receiptIdOf } from "./pay/receipt.ts";
import { CORS_HEADERS, CSP_DATA, CSP_HTML } from "./http/respond.ts";
import { hashJson } from "./hash.ts";
import { silentLog } from "./log.ts";
import { recordHandler, curveHandler } from "./scorecardRoutes.ts";
import type { ScorecardSnapshot, ScorecardStatus } from "./index/scorecard.ts";
import { RECORD_SCHEMA, RECORD_PREVIEW_SCHEMA } from "./accuracyRecord.ts";
import { CURVE_SCHEMA, CURVE_PREVIEW_SCHEMA } from "./discountCurve.ts";
import { row, settlement, snapshot as snapshotOf, transition, closureView } from "./fixtures/scorecard.ts";
import { Regime } from "./regime.ts";

const T0 = new Date("2026-09-22T10:00:00+08:00").getTime();   // Tuesday, HKEX morning session
const PUBLIC = "https://api.curb.markets";
const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const BUYER = getAddress("0x2222222222222222222222222222222222222222");
const TX = "0x" + "ab".repeat(32);
const SIGNATURE = "0x" + "5e".repeat(65);
const NETWORK = "eip155:196" as const;

const COHORT: Asset[] = [
  {
    wrapper: getAddress("0x41333df9e7639188bbfca5522dc4844398af9f9e"), symbol: "wTCENTx", rawSymbol: "TCENTx",
    raw: getAddress("0xfa15e42c18cf57aeef4b1bac1cee7754af7cfe42"), micOnChain: "XHKG",
    pool: getAddress("0xc89d8b547cea7cdeaa7474e7a90b6bad01fe992f"), equityIsToken0: true, equityDecimals: 18, stableDecimals: 6,
  },
  {
    wrapper: getAddress("0xff637d2d435d6745df3faf61272b1216e7e8b727"), symbol: "wSHEINx", rawSymbol: "SHEINx",
    raw: getAddress("0x4d0ba049c430a7a80a61e7ebdf50b6daac6c3bd6"), micOnChain: "XHKG",
    pool: null, equityIsToken0: null, equityDecimals: null, stableDecimals: null,
  },
];

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ISSUER = "https://issuer.test/api/v2/public";
const BODIES: Record<string, string> = {
  [`${ISSUER}/assets/TCENTx?network=XLayer`]: fixture("tcentx.asset.json"),
  [`${ISSUER}/assets/SHEINx?network=XLayer`]: fixture("sheinx.asset.json"),
  [`${ISSUER}/exchanges/XHKG`]: fixture("xhkg.exchange.json"),
};
const issuerFetch = (async (input: string | URL | Request) => {
  const body = BODIES[String(input)];
  return body ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 });
}) as typeof fetch;

/** The OKX Broker, stubbed at the FacilitatorClient boundary the SDK calls through. */
class StubBroker implements FacilitatorClient {
  readonly events: string[];
  verifyResult: VerifyResponse = { isValid: true, payer: BUYER };
  settleResult: SettleResponse = { success: true, status: "success", transaction: TX, network: NETWORK, payer: BUYER };
  settleError: Error | null = null;
  onVerify: (() => void) | null = null;
  constructor(events: string[]) { this.events = events; }
  async getSupported(): Promise<SupportedResponse> {
    this.events.push("supported");
    // The kinds the live Broker lists for eip155:196, per the orchestrator's check against it.
    return {
      kinds: [
        { x402Version: 2, scheme: "exact", network: NETWORK },
        { x402Version: 2, scheme: "exact", network: NETWORK, extra: { assetTransferMethod: "permit2" } },
        { x402Version: 2, scheme: "aggr_deferred", network: NETWORK },
        { x402Version: 2, scheme: "upto", network: NETWORK },
      ],
      extensions: [], signers: {},
    };
  }
  async verify(): Promise<VerifyResponse> { this.events.push("verify"); this.onVerify?.(); return this.verifyResult; }
  async settle(): Promise<SettleResponse> {
    this.events.push("settle");
    if (this.settleError) throw this.settleError;
    return this.settleResult;
  }
}

/**
 * The Scorecard as the tick would hold it: three settled wTCENTx rows shaped like the live 22-23 Sep ones
 * (ties: mark = last print = closing VWAP) and one committed row not yet settled, read at T0; and
 * MarketClock's RegimeChanged log for the three closures, fully indexed.
 */
const LUNCH_CUT = Date.parse("2026-09-22T03:55:05Z") / 1000;
const SCORE_ROWS = [
  row({ settlement: settlement({ curbErrorBps: 0, lastPrintErrorBps: 0, closingVwapErrorBps: 0 }) }),
  row({
    committedAt: Date.parse("2026-09-23T01:20:18Z") / 1000, committedBlock: 71_355_000, settleAfter: Date.parse("2026-09-23T01:30:00Z") / 1000,
    markE18: "57538211366309229177", lastPrintE18: "57538211366309229177", closingVwapE18: "57538211366309229177",
    settlement: settlement({ reopenPrintE18: "57233586614833596700", curbErrorBps: 53, lastPrintErrorBps: 53, closingVwapErrorBps: 53 }),
  }),
  row({
    committedAt: Date.parse("2026-09-23T04:50:22Z") / 1000, committedBlock: 71_365_000, settleAfter: Date.parse("2026-09-23T05:00:00Z") / 1000,
    settlement: settlement({ curbErrorBps: 5, lastPrintErrorBps: 5, closingVwapErrorBps: 5 }),
  }),
  row({ committedAt: Date.parse("2026-09-24T01:20:21Z") / 1000, committedBlock: 71_442_000, settleAfter: Date.parse("2026-09-24T01:30:00Z") / 1000, settlement: null }),
].map((r) => ({ ...r, wrapper: COHORT[0].wrapper }));
const SCORE_LOG = [
  transition({ at: LUNCH_CUT, block: 71_278_700, wrapper: COHORT[0].wrapper }),
  transition({ at: LUNCH_CUT + 3_900, block: 71_282_600, from: Regime.CLOSED, to: Regime.MARKET, wrapper: COHORT[0].wrapper }),
  transition({ at: Date.parse("2026-09-22T07:55:04Z") / 1000, block: 71_293_100, wrapper: COHORT[0].wrapper }),
  transition({ at: Date.parse("2026-09-23T01:30:04Z") / 1000, block: 71_355_600, from: Regime.CLOSED, to: Regime.MARKET, wrapper: COHORT[0].wrapper }),
  transition({ at: Date.parse("2026-09-23T03:55:04Z") / 1000, block: 71_364_300, wrapper: COHORT[0].wrapper }),
];

/** ScorecardIndex.status(), with its 5-minute stale and 30-minute outage lines, over a fixed snapshot. */
function scorecardAt(snap: ScorecardSnapshot | null) {
  return {
    snapshot: snap,
    status(nowMs: number): ScorecardStatus {
      const s = this.snapshot;
      const ageMs = s ? nowMs - s.readAtMs : null;
      return { snapshot: s, ageMs, stale: ageMs !== null && ageMs > 300_000, outage: ageMs === null || ageMs > 1_800_000, lastError: s ? null : "no RPC returned a head" };
    },
  };
}

async function harness(opts: { configured?: boolean; scorecardRoutes?: boolean } = {}) {
  const configured = opts.configured ?? true;
  let nowMs = T0;
  const now = () => nowMs;
  const advance = (ms: number) => { nowMs += ms; };
  const dataDir = mkdtempSync(join(tmpdir(), "curb-asp-test-"));
  const state: AppState = { bootMs: T0, ticks: 1, lastTickOkMs: T0, cohort: COHORT, cohortAsOfMs: T0, cohortError: null };
  const venues = new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 });
  await venues.refresh(COHORT, new XStocksClient(ISSUER, issuerFetch, now), now);

  const events: string[] = [];
  const calendar = calendarHandler({ cohort: () => state.cohort, venues, timelines: new TimelineCache() });
  // Record when the flow builds the paid answer, to check it happens between verify and settle.
  const scorecard = scorecardAt(snapshotOf(SCORE_ROWS, { readAtMs: T0 }));
  const closures = closureView(SCORE_LOG, 71_450_000);
  const traced = (h: PricedHandler): PricedHandler => ({ ...h, build: (q, n) => { events.push("build"); return h.build(q, n); } });
  const handlers = new Map<string, PricedHandler>([["GET /v1/closure-calendar", traced(calendar)]]);
  // Production registers these whenever SCORECARD is set (main.ts); `scorecardRoutes: false` is the unset case.
  if (opts.scorecardRoutes ?? true) {
    const deps = { cohort: () => state.cohort, scorecard, closures, chainId: 196 };
    handlers.set("GET /v1/accuracy-record", traced(recordHandler(deps)));
    handlers.set("GET /v1/discount-curve", traced(curveHandler(deps)));
  }
  const broker = new StubBroker(events);
  const payments = new Payments({
    network: NETWORK, payTo: configured ? PAY_TO : null, okx: null, facilitator: configured ? broker : undefined,
    syncSettle: true, publicUrl: PUBLIC, handlers, now, log: silentLog, initRetryMs: 0,
  });
  await payments.ensureReady();

  const server = createServer(createApp({
    state, venues, payments, handlers, dataDir, publicUrl: PUBLIC, tickMs: 30_000,
    contracts: { chainId: 196, clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b", scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f" },
    now, log: silentLog, scorecard, closures,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  const receipts = () => (existsSync(join(dataDir, "receipts")) ? readdirSync(join(dataDir, "receipts")) : []);
  return { base, now, advance, dataDir, broker, events, payments, state, close, receipts, scorecard };
}

const API = { accept: "application/json", "user-agent": "curb-test-agent/1.0" };

async function challenge(base: string, query = "symbol=wTCENTx", path = "/v1/closure-calendar"): Promise<PaymentRequired> {
  const r = await fetch(`${base}${path}?${query}`, { headers: API });
  assert.equal(r.status, 402);
  await r.arrayBuffer();
  return decodePaymentRequiredHeader(r.headers.get("payment-required")!);
}

/**
 * One signed payment. Each nonce is a different payment; the same nonce twice is the same payment. Like a
 * real client, it is valid for maxTimeoutSeconds from when it is signed (`signedAtMs`, default T0).
 */
function signedPayment(pr: PaymentRequired, nonce = "0x" + "33".repeat(32), signedAtMs = T0): string {
  const accepted = pr.accepts[0];
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: {
      signature: SIGNATURE,
      authorization: { from: BUYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(signedAtMs / 1000) + accepted.maxTimeoutSeconds), nonce },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

test("unpaid: 402 with the real SDK's challenge in PAYMENT-REQUIRED and a truthful preview in the body", async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: API });
    assert.equal(r.status, 402);
    assert.match(r.headers.get("access-control-expose-headers") ?? "", /PAYMENT-REQUIRED/);
    const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
    assert.equal(pr.x402Version, 2);
    assert.equal(pr.error, "Payment required");
    assert.equal(pr.resource.url, `${PUBLIC}/v1/closure-calendar`, "a fixed resource URL, never the request's");
    assert.equal(pr.accepts.length, 1);
    const a = pr.accepts[0];
    assert.equal(a.scheme, "exact");
    assert.equal(a.network, "eip155:196");
    assert.equal(a.payTo, PAY_TO);
    assert.equal(a.amount, "10000", "$0.01 in USD₮0's 6-decimal atomic units");
    assert.equal(a.asset.toLowerCase(), USDT0.address.toLowerCase());
    assert.equal(a.maxTimeoutSeconds, 300);
    assert.equal(typeof a.extra.name, "string", "the EIP-712 domain a client needs to sign EIP-3009");
    assert.equal(a.extra.version, "1");

    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ["marketOpen", "mic", "nextClosure", "nowPeriod", "schema", "symbol"]);
    assert.equal(body.schema, PREVIEW_SCHEMA);
    assert.equal(body.symbol, "wTCENTx");
    assert.equal(body.mic, "XHKG");
    assert.equal(body.marketOpen, true);
    assert.equal(body.nowPeriod, "market");
    assert.equal(body.nextClosure.startIso, "2026-09-22T03:55:00.000Z");
    assert.equal(body.nextClosure.endIso, "2026-09-22T05:00:00.000Z");
    assert.deepEqual(h.events, ["supported"], "no verify, no settle for an unpaid call");
    assert.deepEqual(h.receipts(), []);
  } finally { await h.close(); }
});

test("every listed price is exactly what the SDK's exact scheme charges", async () => {
  for (const r of PRICED_ROUTES) {
    const parsed = await new ExactEvmScheme().parsePrice(`$${r.priceUsd}`, NETWORK);
    assert.equal(parsed.amount, r.atomic, r.key);
    assert.equal(parsed.asset.toLowerCase(), USDT0.address.toLowerCase());
  }
  assert.deepEqual(PRICED_ROUTES.map((r) => [r.key, r.priceUsd]), [
    ["GET /v1/closure-calendar", "0.01"], ["GET /v1/accuracy-record", "0.05"], ["GET /v1/discount-curve", "0.10"],
  ]);
});

test("paid: verify, then build, then settle; 200 with the receipt header, and a durable receipt for those exact bytes", async () => {
  const h = await harness();
  try {
    const pr = await challenge(h.base);
    const header = signedPayment(pr);
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wtcentx&horizonDays=3`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"], "the answer is built BEFORE money moves");

    const body = JSON.parse(bytes.toString("utf8"));
    assert.equal(body.schema, CALENDAR_SCHEMA);
    assert.equal(body.symbol, "wTCENTx", "resolved case-insensitively to the canonical symbol");
    assert.equal(body.horizonDays, 3);
    assert.equal(body.method, "curb.reopen/1");
    assert.equal(body.nowCapFiat, 100_000);
    assert.equal(body.windows[0].endIso, "2026-09-22T05:00:00.000Z");
    assert.equal(body.venueEvidence.assetUrl, `${ISSUER}/assets/TCENTx?network=XLayer`);
    assert.match(body.venueEvidence.assetBodyHash, /^0x[0-9a-f]{64}$/);

    const settle = decodePaymentResponseHeader(r.headers.get("payment-response")!);
    assert.equal(settle.transaction, TX);

    const id = r.headers.get("x-curb-receipt")!;
    assert.match(id, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(h.receipts(), [`${id}.json`]);
    const text = readFileSync(join(h.dataDir, "receipts", `${id}.json`), "utf8");
    const receipt = JSON.parse(text);
    const digest = "0x" + createHash("sha256").update(bytes).digest("hex");
    assert.equal(receipt.schema, "curb.asp.receipt/1");
    assert.equal(receipt.receiptId, id);
    assert.equal(receipt.responseDigest, digest, "sha256 of the exact bytes delivered");
    assert.equal(receiptIdOf(TX, digest), id, "id = keccak256(transaction ++ responseDigest)");
    assert.equal(receipt.route, "GET /v1/closure-calendar");
    assert.deepEqual(receipt.query, { symbol: "wTCENTx", horizonDays: 3 });
    assert.equal(receipt.network, "eip155:196");
    assert.equal(receipt.scheme, "exact");
    assert.equal(receipt.amount, "10000");
    assert.equal(receipt.payTo, PAY_TO);
    assert.equal(receipt.payer, BUYER);
    assert.equal(receipt.transaction, TX);
    assert.equal(receipt.settleStatus, "success");
    assert.equal(receipt.requirementsDigest, hashJson(pr.accepts[0]));
    assert.match(receipt.payloadDigest, /^0x[0-9a-f]{64}$/);
    assert.ok(!text.includes(SIGNATURE.slice(2)), "the payment signature is never stored");

    const served = await fetch(`${h.base}/receipts/${id}.json`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get("cache-control")!, /immutable/);
    assert.equal(await served.text(), text);
  } finally { await h.close(); }
});

test("POST is the same priced resource as GET: OKX's bare `curl -i -X POST` self-check gets the 402", async () => {
  const h = await harness();
  try {
    const post = (path: string, body?: string, contentType = "application/json") =>
      fetch(`${h.base}${path}`, { method: "POST", headers: { ...API, ...(body === undefined ? {} : { "content-type": contentType }) }, body });

    // No parameters at all: every priced path answers with its challenge, never 400 or 405.
    for (const route of PRICED_ROUTES) {
      const r = await post(route.path);
      assert.equal(r.status, 402, route.path);
      assert.equal(decodePaymentRequiredHeader(r.headers.get("payment-required")!).accepts[0].amount, route.atomic, route.path);
      assert.match(r.headers.get("access-control-allow-methods") ?? "", /POST/);
      await r.arrayBuffer();
    }

    // Parameters from a JSON body, a form body, or the query string all bill the same query.
    const get = await (await fetch(`${h.base}/v1/closure-calendar?symbol=wSHEINx&horizonDays=3`, { headers: API })).json();
    for (const [path, body, type] of [
      ["/v1/closure-calendar", JSON.stringify({ symbol: "wSHEINx", horizonDays: 3 }), "application/json"],
      ["/v1/closure-calendar", "symbol=wSHEINx&horizonDays=3", "application/x-www-form-urlencoded"],
      ["/v1/closure-calendar?symbol=wSHEINx", JSON.stringify({ symbol: "wSHEINx", horizonDays: "3", ignored: null }), "application/json"],
      ["/v1/closure-calendar?symbol=wSHEINx&horizonDays=3", "", "application/json"],
    ] as const) {
      const r = await post(path, body, type);
      assert.equal(r.status, 402, `${path} ${body}`);
      assert.deepEqual(await r.json(), get, `${path} ${body}`);
    }

    // Refused for free, before any challenge.
    for (const [path, body, error] of [
      ["/v1/closure-calendar?symbol=wTCENTx", JSON.stringify({ symbol: "wSHEINx" }), "conflicting-parameter"],
      ["/v1/closure-calendar", "{not json", "bad-body"],
      ["/v1/closure-calendar", JSON.stringify(["wTCENTx"]), "bad-body"],
      ["/v1/closure-calendar", JSON.stringify({ symbol: { nested: "wTCENTx" } }), "bad-body"],
      ["/v1/closure-calendar", JSON.stringify({ symbol: "wNOPEx" }), "unknown-symbol"],
    ] as const) {
      const r = await post(path, body);
      assert.equal(r.status, 400, body);
      assert.equal(r.headers.get("payment-required"), null, body);
      assert.equal((await r.json()).error, error, body);
    }
    assert.deepEqual(h.events, ["supported"], "nothing verified or settled");
  } finally { await h.close(); }
});

test("paid by POST: the same verify, build, settle and receipt as GET, billed for the body's parameters", async () => {
  const h = await harness();
  try {
    const pr = await challenge(h.base);
    const r = await fetch(`${h.base}/v1/closure-calendar`, {
      method: "POST",
      headers: { ...API, "content-type": "application/json", "PAYMENT-SIGNATURE": signedPayment(pr) },
      body: JSON.stringify({ symbol: "wTCENTx", horizonDays: 3 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schema, CALENDAR_SCHEMA);
    assert.equal(body.horizonDays, 3);
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"]);
    const receipt = JSON.parse(readFileSync(join(h.dataDir, "receipts", `${r.headers.get("x-curb-receipt")}.json`), "utf8"));
    assert.equal(receipt.route, "GET /v1/closure-calendar", "one priced resource, whichever verb carried it");
    assert.deepEqual(receipt.query, { symbol: "wTCENTx", horizonDays: 3 });
  } finally { await h.close(); }
});

test("verified, but the answer cannot be built: 503 and the payment is NEVER settled", async () => {
  const h = await harness();
  try {
    const header = signedPayment(await challenge(h.base));
    // The issuer goes dark while the Broker is verifying: by build time the last good bytes are 31 minutes old.
    h.broker.onVerify = () => h.advance(31 * 60_000);
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "issuer-unavailable", lastGoodAsOfMs: T0 });
    assert.ok(h.events.includes("verify"));
    assert.ok(!h.events.includes("settle"), "settle was never called");
    assert.equal(r.headers.get("x-curb-receipt"), null);
    assert.deepEqual(h.receipts(), []);
  } finally { await h.close(); }
});

test("settlement fails: the SDK's failure response, and no content", async () => {
  const h = await harness();
  try {
    const header = signedPayment(await challenge(h.base));
    h.broker.settleResult = { success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK };
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 402);
    assert.ok(r.headers.get("payment-response"), "the SDK's settlement header is passed through");
    assert.equal(r.headers.get("x-curb-receipt"), null);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { error: "settlement-failed", reason: "insufficient_funds", message: "insufficient_funds", transaction: null });
    assert.ok(!text.includes("windows") && !text.includes(CALENDAR_SCHEMA), "no paid content leaks");
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"]);

    // The same, refused payment presented again is never settled again: a 402 that says so, and no Broker call.
    const again = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(again.status, 402);
    const againBody = await again.json();
    assert.equal(againBody.error, "settlement-failed");
    assert.equal(againBody.reason, "insufficient_funds");
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"]);

    // A Broker that errors mid-settle (a 500, a gateway 504) may already have submitted the transfer: that is
    // an unknown outcome, never a refusal. With no chain to ask, the buyer is told so and to retry with the
    // SAME header -- and no content leaks.
    h.broker.settleResult = { success: true, status: "success", transaction: TX, network: NETWORK };
    h.broker.settleError = new Error("OKX settle failed: 500");
    const header2 = signedPayment(await challenge(h.base), "0x" + "34".repeat(32));
    const r2 = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header2 } });
    assert.equal(r2.status, 503);
    assert.equal(r2.headers.get("retry-after"), "15");
    const text2 = await r2.text();
    assert.equal(JSON.parse(text2).error, "settlement-unconfirmed");
    assert.ok(!text2.includes("windows") && !text2.includes(CALENDAR_SCHEMA));
    assert.deepEqual(h.receipts(), []);
    const health = await (await fetch(`${h.base}/healthz`)).json();
    assert.equal(health.payments.unconfirmed, 2, "both are watched until validBefore");
  } finally { await h.close(); }
});

test("one payment buys one answer: the same header again is 409 with its receipt, and never reaches the Broker", async () => {
  const h = await harness();
  try {
    const header = signedPayment(await challenge(h.base));
    const first = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const id = first.headers.get("x-curb-receipt")!;
    for (const q of ["symbol=wTCENTx", "symbol=wTCENTx&horizonDays=14"]) {
      const r = await fetch(`${h.base}/v1/closure-calendar?${q}`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
      assert.equal(r.status, 409, q);
      const body = await r.json();
      assert.equal(body.error, "payment-already-used");
      assert.equal(body.receiptId, id, "its own buyer is pointed at the receipt");
      assert.equal(body.receipt, `/receipts/${id}.json`);
    }
    // The same (payer, nonce) inside a different payload -- rebuilt from the chain, say -- learns nothing.
    const forged = JSON.parse(Buffer.from(header, "base64").toString());
    forged.payload.signature = "0x" + "77".repeat(65);
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(forged)).toString("base64") } });
    assert.equal(r.status, 409);
    assert.deepEqual(Object.keys(await r.json()).sort(), ["detail", "error"]);
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"], "one verify, one settle");
    assert.equal(h.receipts().length, 1);
  } finally { await h.close(); }
});

test("a payment that is not an EIP-3009 authorization is refused before the Broker is asked anything", async () => {
  const h = await harness();
  try {
    const pr = await challenge(h.base);
    const permit2 = JSON.parse(Buffer.from(signedPayment(pr), "base64").toString());
    permit2.accepted.extra.assetTransferMethod = "permit2";
    const noAuth = { x402Version: 2, accepted: pr.accepts[0], payload: { signature: SIGNATURE } };
    for (const payload of [permit2, noAuth, { hello: "world" }]) {
      const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "unsupported-payment");
    }
    assert.deepEqual(h.events, ["supported"]);
  } finally { await h.close(); }
});

test("an invalid payment is re-challenged, and never built or settled", async () => {
  const h = await harness();
  try {
    const header = signedPayment(await challenge(h.base));
    h.broker.verifyResult = { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 402);
    assert.equal(decodePaymentRequiredHeader(r.headers.get("payment-required")!).error, "invalid_exact_evm_payload_signature");
    const text = await r.text();
    assert.ok(!text.includes("windows"));
    assert.deepEqual(h.events, ["supported", "verify"]);
  } finally { await h.close(); }
});

test("a payment for different terms (tampered amount) never reaches the Broker", async () => {
  const h = await harness();
  try {
    const pr = await challenge(h.base);
    pr.accepts[0] = { ...pr.accepts[0], amount: "1" };
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": signedPayment(pr) } });
    assert.equal(r.status, 402);
    await r.arrayBuffer();
    assert.deepEqual(h.events, ["supported"]);
  } finally { await h.close(); }
});

test("free refusals come before any challenge: bad input, unknown symbol, issuer outage", async () => {
  const h = await harness();
  try {
    const get = (q: string) => fetch(`${h.base}${q}`, { headers: API });
    let r = await get("/v1/closure-calendar?symbol=wNOPEx");
    assert.equal(r.status, 400);
    assert.equal(r.headers.get("payment-required"), null);
    assert.deepEqual(await r.json(), { error: "unknown-symbol", symbol: "wNOPEx", valid: ["wTCENTx", "wSHEINx"] });

    // No symbol is the default asset, not a refusal: OKX's marketplace probes with no parameters.
    for (const q of ["", "?symbol=", "?symbol=wTCENTx&horizonDays="]) {
      r = await get(`/v1/closure-calendar${q}`);
      assert.equal(r.status, 402, q);
      assert.equal((await r.json()).symbol, "wTCENTx", q);
    }

    for (const bad of ["0", "15", "abc", "7.5", "-1"]) {
      r = await get(`/v1/closure-calendar?symbol=wTCENTx&horizonDays=${bad}`);
      assert.equal(r.status, 400, bad);
      assert.equal((await r.json()).error, "bad-horizon");
    }
    r = await get("/v1/closure-calendar?symbol=wTCENTx&symbol=wSHEINx");
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "repeated-parameter");

    h.advance(31 * 60_000);
    r = await get("/v1/closure-calendar?symbol=wTCENTx");
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("payment-required"), null);
    assert.deepEqual(await r.json(), { error: "issuer-unavailable", lastGoodAsOfMs: T0 });
    assert.deepEqual(h.events, ["supported"]);
  } finally { await h.close(); }
});

test("stale-but-usable issuer bytes are served, with their age disclosed", async () => {
  const h = await harness();
  try {
    h.advance(12 * 60_000);   // past refresh + one tick, inside the 30-minute outage line
    const header = signedPayment(await challenge(h.base), undefined, h.now());
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.warnings.some((w: string) => w.includes("720s old")), JSON.stringify(body.warnings));
  } finally { await h.close(); }
});

test("a browser gets a static paywall page that echoes nothing from the request", async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx&x=%3Cscript%3Ealert(1)%3C/script%3E`, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0" },
    });
    assert.equal(r.status, 402);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    const html = await r.text();
    assert.ok(!html.includes("<script"), "nothing from the query string is reflected");
    assert.ok(html.includes("$0.01"));
  } finally { await h.close(); }
});

test("missing credentials: every priced route is 503 payments-not-configured, the free routes still serve", async () => {
  const h = await harness({ configured: false });
  try {
    for (const r of PRICED_ROUTES) {
      const res = await fetch(`${h.base}${r.path}?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": "e30=" } });
      assert.equal(res.status, 503, r.path);
      assert.deepEqual(await res.json(), { error: "payments-not-configured" });
      assert.equal(res.headers.get("payment-required"), null);
    }
    for (const path of ["/", "/healthz", "/v1/assets", "/.well-known/x402"]) {
      const res = await fetch(`${h.base}${path}`);
      assert.equal(res.status, 200, path);
      await res.arrayBuffer();
    }
    const health = await (await fetch(`${h.base}/healthz`)).json();
    assert.equal(health.payments.configured, false);
    assert.deepEqual(health.payments.missing, ["OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE", "PAY_TO"]);
    const wk = await (await fetch(`${h.base}/.well-known/x402`)).json();
    assert.ok(wk.routes.every((r: { available: boolean }) => r.available === false));
    assert.deepEqual(h.events, [], "no Broker call at all");
  } finally { await h.close(); }
});

test("the free routes: assets, discovery, health and home", async () => {
  const h = await harness();
  try {
    const assets = await (await fetch(`${h.base}/v1/assets`)).json();
    assert.deepEqual(assets.assets, [
      { symbol: "wTCENTx", wrapper: COHORT[0].wrapper, pool: COHORT[0].pool, mic: "XHKG", hasPriceSource: true, venueAsOfMs: T0 },
      { symbol: "wSHEINx", wrapper: COHORT[1].wrapper, pool: null, mic: "XHKG", hasPriceSource: false, venueAsOfMs: T0 },
    ]);

    const wk = await (await fetch(`${h.base}/.well-known/x402`)).json();
    assert.equal(wk.x402Version, 2);
    assert.deepEqual(wk.resources, PRICED_ROUTES.map((r) => `${PUBLIC}${r.path}`));
    assert.deepEqual(wk.routes.map((r: { price: string; accepts: { amount: string; payTo: string }[] }) => [r.price, r.accepts[0].amount, r.accepts[0].payTo]), [
      ["$0.01", "10000", PAY_TO], ["$0.05", "50000", PAY_TO], ["$0.10", "100000", PAY_TO],
    ]);
    assert.deepEqual(wk.routes.map((r: { available: boolean }) => r.available), [true, true, true]);

    const health = await fetch(`${h.base}/healthz`);
    assert.equal(health.status, 200);
    const hj = await health.json();
    assert.equal(hj.ok, true);
    assert.equal(hj.payments.configured, true);
    assert.equal(hj.payments.ready, true);
    assert.equal(hj.cohort.size, 2);
    assert.equal(hj.venues[0].outage, false);
    assert.deepEqual(hj.scorecard, { asOfBlock: 71_450_876, readAtMs: T0, ageS: 0, rows: 4, settled: 3, stale: false, outage: false, lastError: null });
    assert.equal(hj.regimeIndex.lastScannedBlock, 71_450_000);
    assert.equal(hj.regimeIndex.caughtUp, true);

    const home = await fetch(`${h.base}/`);
    assert.match(home.headers.get("content-type")!, /text\/html/);
    const html = await home.text();
    for (const r of PRICED_ROUTES) assert.ok(html.includes(r.path) && html.includes(`$${r.priceUsd}`), r.path);
    assert.ok(!html.includes("coming soon"), "every priced route has a handler");

    const missing = await fetch(`${h.base}/receipts/0x${"00".repeat(32)}.json`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    // POST is for the priced routes only; everything else is GET.
    for (const path of ["/", "/healthz", "/v1/assets", "/.well-known/x402"]) {
      const post = await fetch(`${h.base}${path}`, { method: "POST" });
      assert.equal(post.status, 405, path);
      assert.equal(post.headers.get("allow"), "GET, OPTIONS", path);
      await post.arrayBuffer();
    }
    const put = await fetch(`${h.base}/v1/closure-calendar`, { method: "PUT" });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get("allow"), "GET, POST, OPTIONS");
    await put.arrayBuffer();
  } finally { await h.close(); }
});

test("every response carries HSTS, nosniff, no-referrer and a CSP fitted to its type (200, 204, 400, 402, 404, 405, 500); CORS is unchanged", async () => {
  const h = await harness();
  try {
    const check = (r: Response, what: string) => {
      assert.equal(r.headers.get("strict-transport-security"), "max-age=31536000", what);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", what);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", what);
      const html = /^text\/html/.test(r.headers.get("content-type") ?? "");
      assert.equal(r.headers.get("content-security-policy"), html ? CSP_HTML : CSP_DATA, what);
      for (const [k, v] of Object.entries(CORS_HEADERS)) assert.equal(r.headers.get(k), v, `${what}: ${k}`);
    };
    const browser = { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0" };
    const cases: Array<[string, RequestInit, number, boolean]> = [
      ["/healthz", {}, 200, false],
      ["/", {}, 200, true],
      ["/.well-known/x402", {}, 200, false],
      ["/v1/closure-calendar", { method: "OPTIONS" }, 204, false],
      ["/v1/closure-calendar?symbol=wNOPEx", { headers: API }, 400, false],
      ["/v1/closure-calendar?symbol=wTCENTx", { headers: API }, 402, false],
      ["/v1/closure-calendar?symbol=wTCENTx", { headers: browser }, 402, true],
      ["/nope", {}, 404, false],
      ["/healthz", { method: "DELETE" }, 405, false],
    ];
    for (const [path, init, status, html] of cases) {
      const r = await fetch(`${h.base}${path}`, init);
      assert.equal(r.status, status, path);
      check(r, `${init.method ?? "GET"} ${path} ${status}`);
      const text = await r.text();
      // The HTML policy allows inline style and nothing else: neither page may need more.
      if (html) assert.ok(!/<(script|img|link|iframe|form|object|embed)\b/i.test(text) && /<style>/.test(text), `${path}: only inline style`);
    }

    const paid = await fetch(`${h.base}/v1/closure-calendar?symbol=wTCENTx`, { headers: { ...API, "PAYMENT-SIGNATURE": signedPayment(await challenge(h.base)) } });
    assert.equal(paid.status, 200);
    check(paid, "paid 200");
    assert.ok(paid.headers.get("x-curb-receipt"), "the SDK's and our own headers still go out beside them");
    await paid.arrayBuffer();
    const receipt = await fetch(`${h.base}/receipts/${paid.headers.get("x-curb-receipt")}.json`);
    assert.equal(receipt.status, 200);
    check(receipt, "receipt 200");
    await receipt.arrayBuffer();

    h.state.cohort = undefined as unknown as Asset[];   // any unexpected throw inside a route
    const broken = await fetch(`${h.base}/v1/assets`);
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), { error: "internal" });
    check(broken, "500");
  } finally { await h.close(); }
});

test("/healthz never carries a credential, even when real ones are configured", async () => {
  const events: string[] = [];
  const secrets = { apiKey: "key-DO-NOT-LEAK-1", secretKey: "secret-DO-NOT-LEAK-2", passphrase: "pass-DO-NOT-LEAK-3" };
  const payments = new Payments({
    network: NETWORK, payTo: PAY_TO, okx: secrets, facilitator: new StubBroker(events),
    syncSettle: true, publicUrl: PUBLIC, handlers: new Map(), now: () => T0, log: silentLog, initRetryMs: 0,
  });
  await payments.ensureReady();
  const state: AppState = { bootMs: T0, ticks: 1, lastTickOkMs: T0, cohort: COHORT, cohortAsOfMs: T0, cohortError: null };
  const server = createServer(createApp({
    state, venues: new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 }), payments,
    handlers: new Map(), dataDir: mkdtempSync(join(tmpdir(), "curb-asp-test-")), publicUrl: PUBLIC, tickMs: 30_000,
    contracts: { chainId: 196, clock: COHORT[0].wrapper, scorecard: COHORT[0].wrapper }, now: () => T0, log: silentLog,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/healthz", "/", "/.well-known/x402", "/v1/assets"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      for (const v of Object.values(secrets)) assert.ok(!text.includes(v), `${path} leaks a credential`);
    }
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

// ---------------------------------------------------------------------------------------------
// the Scorecard routes, through the same real SDK and stub Broker
// ---------------------------------------------------------------------------------------------

test("accuracy record: the 402 carries only the skill triple and row count; paid, it is verified, built, settled and receipted", async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/v1/accuracy-record`, { headers: API });
    assert.equal(r.status, 402, "no parameters is a valid request: every graded asset, 50 rows");
    const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
    assert.equal(pr.resource.url, `${PUBLIC}/v1/accuracy-record`);
    assert.equal(pr.accepts[0].amount, "50000", "$0.05");
    assert.equal(pr.accepts[0].scheme, "exact");
    assert.deepEqual(await r.json(), { schema: RECORD_PREVIEW_SCHEMA, skill: { settled: 3, beatLastPrint: 0, beatClosingVwap: 0 }, rowCount: 4 });

    const paid = await fetch(`${h.base}/v1/accuracy-record?symbol=TCENTx&limit=2`, { headers: { ...API, "PAYMENT-SIGNATURE": signedPayment(pr) } });
    assert.equal(paid.status, 200);
    const bytes = Buffer.from(await paid.arrayBuffer());
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"], "built before any money moves");
    const body = JSON.parse(bytes.toString("utf8"));
    assert.equal(body.schema, RECORD_SCHEMA);
    assert.equal(body.chainId, 196);
    assert.equal(body.asOfBlock, 71_450_876);
    assert.match(body.asOfBlockHash, /^0x[0-9a-f]{64}$/);
    assert.equal(body.symbol, "wTCENTx", "the issuer symbol resolves to the wrapper's");
    assert.equal(body.totalRows, 4);
    assert.equal(body.rows.length, 2);
    assert.equal(body.rows[0].settled, false, "newest first: the row still owed a settle");
    assert.deepEqual([body.rows[1].tie, body.rows[1].beatLastPrint, body.rows[1].beatClosingVwap], [true, false, false]);
    assert.equal(body.rows[1].evidenceStatus, "archived");
    assert.deepEqual(body.perSymbol.wTCENTx, {
      wrapper: COHORT[0].wrapper, committed: 4, settled: 3, beatLast: 0, beatVwap: 0, ties: 3, tiesClosingVwap: 3,
      medianCurbErrorBps: 5, medianLastPrintErrorBps: 5,
    });
    assert.match(body.note, /A tie is not a win\. 3 of the 3 settled rows for wTCENTx tie the last print exactly\./);

    const id = paid.headers.get("x-curb-receipt")!;
    const receipt = JSON.parse(readFileSync(join(h.dataDir, "receipts", `${id}.json`), "utf8"));
    assert.equal(receipt.route, "GET /v1/accuracy-record");
    assert.deepEqual(receipt.query, { limit: 2, symbol: "wTCENTx" }, "what was billed, after validation and defaults");
    assert.equal(receipt.amount, "50000");
    assert.equal(receipt.responseDigest, "0x" + createHash("sha256").update(bytes).digest("hex"));
  } finally { await h.close(); }
});

test("discount curve: the 402 carries n, nUsable and bucket counts; paid, fit is null and every observation is returned", async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/v1/discount-curve?symbol=wTCENTx`, { headers: API });
    assert.equal(r.status, 402);
    const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
    assert.equal(pr.accepts[0].amount, "100000", "$0.10");
    assert.deepEqual(await r.json(), {
      schema: CURVE_PREVIEW_SCHEMA, n: 3, nUsable: 3,
      buckets: [
        { label: "30m-2h", n: 2, status: "insufficient" },
        { label: "2h-8h", n: 0, status: "insufficient" },
        { label: "8h-24h", n: 1, status: "insufficient" },
        { label: "24h-72h", n: 0, status: "insufficient" },
        { label: ">72h", n: 0, status: "insufficient" },
      ],
    });

    const paid = await fetch(`${h.base}/v1/discount-curve?minMinutes=60`, { headers: { ...API, "PAYMENT-SIGNATURE": signedPayment(pr) } });
    assert.equal(paid.status, 200);
    const body = await paid.json();
    assert.deepEqual(h.events, ["supported", "verify", "build", "settle"]);
    assert.equal(body.schema, CURVE_SCHEMA);
    assert.equal(body.method, "curb.discount/1");
    assert.equal(body.fit, null);
    assert.equal(body.minMinutes, 60);
    assert.equal(body.index.status, "current");
    assert.equal(body.recordStartedAt, "2026-09-21T15:17:00.000Z");
    assert.equal(body.pendingSettlement, 1);
    assert.deepEqual(body.observations.map((o: { durationS: number; bucket: string; discountBps: number }) => [o.durationS, o.bucket, o.discountBps]), [
      [3_895, "30m-2h", 0.9],     // 22 Sep lunch: 11:55:05 -> 13:00:00 HKT
      [63_296, "8h-24h", 52.94],  // 22-23 Sep overnight: 15:55:04 -> 09:30:00 HKT
      [3_896, "30m-2h", 0.9],     // 23 Sep lunch
    ]);
    assert.match(body.disclosure, /a backfilled mark is not a mark/);
    const receipt = JSON.parse(readFileSync(join(h.dataDir, "receipts", `${paid.headers.get("x-curb-receipt")}.json`), "utf8"));
    assert.deepEqual(receipt.query, { minMinutes: 60 });
    assert.equal(receipt.amount, "100000");
  } finally { await h.close(); }
});

test("the Scorecard routes refuse bad input for free, before any challenge", async () => {
  const h = await harness();
  try {
    const refusal = async (path: string, status: number) => {
      const r = await fetch(`${h.base}${path}`, { headers: API });
      assert.equal(r.status, status, path);
      assert.equal(r.headers.get("payment-required"), null, `${path}: no challenge`);
      return r.json();
    };
    for (const bad of ["0", "201", "abc", "1.5", "-3"]) {
      assert.deepEqual(await refusal(`/v1/accuracy-record?limit=${bad}`, 400), { error: "bad-limit", limit: bad, min: 1, max: 200 });
    }
    for (const bad of ["29", "10081", "x"]) {
      assert.equal((await refusal(`/v1/discount-curve?minMinutes=${bad}`, 400)).error, "bad-min-minutes");
    }
    for (const path of ["/v1/accuracy-record", "/v1/discount-curve"]) {
      assert.deepEqual(await refusal(`${path}?symbol=wNOPEx`, 400), { error: "unknown-symbol", symbol: "wNOPEx", valid: ["wTCENTx", "wSHEINx"] });
      const none = await refusal(`${path}?symbol=wSHEINx`, 400);
      assert.equal(none.error, "no-graded-record", "no price source: an empty record by construction is not sold");
      assert.deepEqual(none.graded, ["wTCENTx"]);
      assert.equal((await refusal(`${path}?symbol=wTCENTx&symbol=wSHEINx`, 400)).error, "repeated-parameter");
    }
    assert.deepEqual(h.events, ["supported"], "nothing reached the Broker");
  } finally { await h.close(); }
});

test("no readable record is a free 503; a record that goes dark while the Broker verifies is never settled", async () => {
  const h = await harness();
  try {
    const header = signedPayment(await challenge(h.base, "", "/v1/accuracy-record"));
    h.broker.onVerify = () => h.advance(31 * 60_000);   // past the 30-minute outage line by build time
    const r = await fetch(`${h.base}/v1/accuracy-record`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "record-unavailable", lastGoodAsOfBlock: 71_450_876, lastGoodReadAtMs: T0 });
    assert.ok(h.events.includes("verify"));
    assert.ok(!h.events.includes("settle"), "settle was never called");
    assert.deepEqual(h.receipts(), []);

    h.scorecard.snapshot = null;   // never read at all, e.g. every RPC down since boot
    for (const path of ["/v1/accuracy-record", "/v1/discount-curve"]) {
      const res = await fetch(`${h.base}${path}`, { headers: API });
      assert.equal(res.status, 503, path);
      assert.equal(res.headers.get("payment-required"), null);
      assert.deepEqual(await res.json(), { error: "record-unavailable", lastGoodAsOfBlock: null, lastGoodReadAtMs: null });
    }
    const health = await (await fetch(`${h.base}/healthz`)).json();
    assert.equal(health.scorecard.outage, true);
    assert.equal(health.scorecard.lastError, "no RPC returned a head");
  } finally { await h.close(); }
});

test("a stale record is served with its age disclosed", async () => {
  const h = await harness();
  try {
    h.advance(6 * 60_000);   // past the 5-minute stale line, inside the 30-minute outage line
    const header = signedPayment(await challenge(h.base, "", "/v1/discount-curve"), undefined, h.now());
    const r = await fetch(`${h.base}/v1/discount-curve`, { headers: { ...API, "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.warnings.some((w: string) => /snapshot is 360s old \(block 71450876\)/.test(w)), JSON.stringify(body.warnings));
  } finally { await h.close(); }
});

test("with no Scorecard configured, its routes stay listed and answer 503 not-yet-available before any challenge", async () => {
  const h = await harness({ scorecardRoutes: false });
  try {
    for (const path of ["/v1/accuracy-record", "/v1/discount-curve"]) {
      const r = await fetch(`${h.base}${path}`, { headers: API });
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("payment-required"), null, "no challenge for an answer that does not exist");
      assert.deepEqual(await r.json(), { error: "not-yet-available", route: path });
    }
    const wk = await (await fetch(`${h.base}/.well-known/x402`)).json();
    assert.deepEqual(wk.routes.map((r: { available: boolean }) => r.available), [true, false, false]);
    assert.deepEqual(h.events, ["supported"]);
  } finally { await h.close(); }
});
