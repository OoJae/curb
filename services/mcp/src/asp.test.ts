import { test } from "node:test";
import assert from "node:assert/strict";
import { readCorporateActions, readPaidServices, CURB_REVENUE, USDT0 } from "./asp.ts";
import type { JsonFetch } from "./asp.ts";
import { requireAsset } from "./assets.ts";

function jsonFetch(routes: Record<string, { status: number; body: unknown } | Error>, seen: string[] = []): JsonFetch {
  return async (url) => {
    seen.push(url);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: "not-found" }) };
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
}

const version = (n: number) => ({ eventId: `e${n}`, version: 1, caType: "CashDividend", effectiveTimeUtc: `2026-0${n}-01T00:00:00.000Z`, status: "Initial" });

test("corporate actions: the issuer ticker is sent, never the caller's spelling, and versions are cut to limit", async () => {
  const seen: string[] = [];
  const url = "https://api.curb.markets/v1/corporate-actions?symbol=AAPLx";
  const f = jsonFetch({ [url]: { status: 200, body: { schema: "curb.asp.corporate-actions/1", symbol: "AAPLx", asOfMs: 1_790_299_074_329, events: 5, stale: false, source: "https://api.xstocks.fi/x", versions: [5, 4, 3, 2, 1].map(version) } } }, seen);
  const r = await readCorporateActions(f, requireAsset("0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f"), 2, () => 0);
  assert.deepEqual(seen, [url]);
  assert.equal(r.versionsTotal, 5);
  assert.equal(r.versionsShown, 2);
  assert.deepEqual((r.feed.versions as { eventId: string }[]).map((v) => v.eventId), ["e5", "e4"]);
  assert.equal(r.asOf, "2026-09-25T01:17:54.329Z");
  assert.equal(r.source.upstream, "https://api.xstocks.fi/x");
  assert.match(r.summary, /^wAAPLx \(AAPLx\): 5 corporate-action events, 5 versions kept by curb-asp; newest: CashDividend effective 2026-05-01/);
});

test("corporate actions: an asp failure is an error, not an empty history", async () => {
  const f = jsonFetch({ "https://api.curb.markets/v1/corporate-actions?symbol=TCENTx": { status: 503, body: { error: "corporate-actions-not-configured" } } });
  await assert.rejects(readCorporateActions(f, requireAsset("TCENTx")), /feed unavailable: http 503/);
  await assert.rejects(readCorporateActions(jsonFetch({ "https://api.curb.markets/v1/corporate-actions?symbol=TCENTx": new Error("socket hang up") }), requireAsset("TCENTx")), /socket hang up/);
});

test("paid services: terms read live from /.well-known/x402, with the onchainos commands for each route", async () => {
  const live = {
    routes: [
      { path: "/v1/closure-calendar", summary: "cal", query: "q1", price: "$0.01", available: true, accepts: [{ scheme: "exact", network: "eip155:196", asset: USDT0, amount: "10000", payTo: CURB_REVENUE, maxTimeoutSeconds: 300 }] },
      { path: "/v1/accuracy-record", price: "$0.07", available: false, accepts: [{ amount: "70000" }] },
      { path: "/v1/discount-curve", price: "$0.10", available: true, accepts: [{ amount: "100000" }] },
    ],
  };
  const r = await readPaidServices(jsonFetch({ "https://api.curb.markets/.well-known/x402": { status: 200, body: live } }), () => Date.parse("2026-09-25T01:00:00Z"));
  assert.equal(r.termsSource.read, "live");
  assert.deepEqual(r.services.map((s) => s.price), ["$0.01", "$0.07", "$0.10"], "a live price change shows up here");
  assert.equal(r.services[1].terms.amountAtomic, "70000");
  assert.equal(r.services[1].available, false);
  assert.deepEqual(r.services[0].pay, [
    'onchainos payment quote "https://api.curb.markets/v1/closure-calendar?symbol=wTCENTx&horizonDays=7"',
    "onchainos payment pay --payment-id <paymentId printed by quote>",
  ]);
  assert.match(r.howToPay.join(" "), /re-run it with `--yes`/);
  assert.match(r.verifyReceipt.join(" "), /keccak256\(transaction ‖ responseDigest\)/);
  assert.match(r.verifyCurbData, /npx -y github:OoJae\/curb tx <hash>/);
});

test("paid services: with the asp unreachable, the listed terms are used and labelled as the fallback", async () => {
  const r = await readPaidServices(jsonFetch({ "https://api.curb.markets/.well-known/x402": new Error("ECONNREFUSED") }));
  assert.equal(r.termsSource.read, "fallback");
  assert.match(String(r.termsSource.from), /24 Sep 2026/);
  assert.deepEqual(r.services.map((s) => [s.price, s.terms.amountAtomic, s.terms.payTo]), [
    ["$0.01", "10000", CURB_REVENUE], ["$0.05", "50000", CURB_REVENUE], ["$0.10", "100000", CURB_REVENUE],
  ]);
  assert.ok(r.services.every((s) => s.available === null));
});
