/**
 * mark/2's evidence: reading numbers out of committed bytes, and fetching them without ever blocking a commit.
 *
 * The fixtures are real bytes fetched on 24 Sep 2026 for two rows already on chain: #9 (wTCENTx, overnight
 * 23 -> 24 Sep; Binance HK0700USDT closed minutes and Yahoo hourly charts) and #12 (wTCENTx, the 24 Sep
 * lunch recess; Binance only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  binanceKlinesUrl, yahooChartUrl, cutMinuteMs, commitMinuteMs, decToE18, klineClose, parseYahooChart,
  deriveSignal, evidenceBytes,
} from "./signal.ts";
import type { SignalContext } from "./signal.ts";
import { gatherSignal, sha256Hex } from "./signalFetch.ts";
import type { SignalFetchConfig } from "./signalFetch.ts";
import { MARK_METHODS, MARK2 } from "../mark.ts";

const MIN = MARK_METHODS[MARK2].minSignalClosureS!;
interface Fixture { wrapper: string; ctx: SignalContext; lastPrintE18: string; reopenPrintE18: string; exchanges: Array<{ key: string; url: string; body: string }> }
const load = (f: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
export const OVERNIGHT = load("mark2-overnight-wTCENTx-20260924.json");
export const RECESS = load("mark2-recess-wTCENTx-20260924.json");
const body = (fx: Fixture, key: string) => fx.exchanges.find((e) => e.key === key)!.body;

test("decimals convert exactly, with no floating point after the source's own text", () => {
  assert.equal(decToE18("438.80000"), 438_800_000_000_000_000_000n);
  assert.equal(decToE18("55.90999984741211"), 55_909_999_847_412_110_000n);
  assert.equal(decToE18("7.8427"), 7_842_700_000_000_000_000n);
  assert.equal(decToE18("1.5e-7"), 150_000_000_000n);
  assert.equal(decToE18("12"), 12n * 10n ** 18n);
  for (const bad of ["", "abc", "1.2.3", "NaN", "Infinity", "0x10", "1e999"]) assert.equal(decToE18(bad), null, bad);
});

test("the minute rules: the kline that closed at the cut, and the last one closed 5 s before the commit", () => {
  assert.equal(new Date(cutMinuteMs(Date.parse("2026-09-23T07:55:09Z"))).toISOString(), "2026-09-23T07:54:00.000Z");
  assert.equal(new Date(commitMinuteMs(Date.parse("2026-09-24T01:20:11Z"))).toISOString(), "2026-09-24T01:19:00.000Z");
  // Within 5 s of a minute boundary the just-closed minute may not be final yet: take the one before.
  assert.equal(new Date(commitMinuteMs(Date.parse("2026-09-24T01:20:03Z"))).toISOString(), "2026-09-24T01:18:00.000Z");
  assert.equal(binanceKlinesUrl("HK0700USDT", 1790150040000),
    "https://fapi.binance.com/fapi/v1/klines?symbol=HK0700USDT&interval=1m&startTime=1790150040000&limit=1");
  assert.equal(yahooChartUrl("HKD=X"), "https://query1.finance.yahoo.com/v8/finance/chart/HKD%3DX?interval=1h&range=5d");
});

test("a kline is read only when it is exactly the minute asked for", () => {
  const b = body(OVERNIGHT, "perp:cut");
  assert.deepEqual(klineClose(b, 1790150040000), { closeE18: 440_910_000_000_000_000_000n });
  assert.deepEqual(klineClose(b, 1790150100000), { error: "wrong-minute" });
  assert.deepEqual(klineClose("[]", 1790150040000), { error: "rows=0" });
  assert.deepEqual(klineClose("{\"code\":0,\"msg\":\"Service unavailable from a restricted location\"}", 1), { error: "not-an-array" });
  assert.deepEqual(klineClose("not json", 1), { error: "unparseable" });
});

test("the real overnight bytes derive both legs, and the numbers are the ones on the page", () => {
  const s = deriveSignal(OVERNIGHT.ctx, evidenceBytes(OVERNIGHT.exchanges), MIN);
  assert.deepEqual(s.missing, []);
  assert.equal(s.proxy, "wTCENTx");
  assert.equal(s.closureS, 63_291);
  assert.deepEqual(s.perp, {
    symbol: "HK0700USDT", cutMinuteMs: 1790150040000, commitMinuteMs: 1790212740000,
    cutE18: "440910000000000000000", commitE18: "440640000000000000000",
  });
  // TCEHY's 23 Sep close (the 20:00Z bar), x USD/HKD, over 0700.HK's 23 Sep close of HK$441.
  assert.equal(s.adr!.sessionEndS, Date.parse("2026-09-23T20:00:00Z") / 1000);
  assert.equal(s.adr!.adrCloseE18, "55909999847412110000");
  // Yahoo's HKEX period runs to 16:10 HKT: it includes the closing auction, whose price is the official close.
  assert.equal(s.adr!.primarySessionEndS, Date.parse("2026-09-23T08:10:00Z") / 1000);
  assert.equal(s.adr!.primaryCloseE18, "441000000000000000000");
  assert.equal(s.adr!.sharesPerAdr, 1);
});

test("a Yahoo series missing the closure's session is absent, never silently a day old", () => {
  // Yahoo dropped TCEHY's whole 22 Sep daily bar. Simulate the hourly equivalent: remove 23 Sep's bars.
  const chart = JSON.parse(body(OVERNIGHT, "yahoo:adr"));
  const r = chart.chart.result[0];
  const keep = r.timestamp.map((t: number) => t < Date.parse("2026-09-23T13:30:00Z") / 1000 || t > Date.parse("2026-09-23T20:00:00Z") / 1000);
  r.timestamp = r.timestamp.filter((_: number, i: number) => keep[i]);
  for (const k of Object.keys(r.indicators.quote[0])) r.indicators.quote[0][k] = r.indicators.quote[0][k].filter((_: unknown, i: number) => keep[i]);
  const ev = evidenceBytes(OVERNIGHT.exchanges.map((e) => e.key === "yahoo:adr" ? { ...e, body: JSON.stringify(chart) } : e));
  const s = deriveSignal(OVERNIGHT.ctx, ev, MIN);
  assert.equal(s.adr, null);
  assert.deepEqual(s.missing, ["yahoo:adr:no-bar"]);
  assert.ok(s.perp, "the perp leg stands on its own");

  // Bars that stop early in the session are stale, not a close.
  const early = JSON.parse(body(OVERNIGHT, "yahoo:adr"));
  const e = early.chart.result[0];
  const cutoff = Date.parse("2026-09-23T15:00:00Z") / 1000;
  const k2 = e.timestamp.map((t: number) => !(t > cutoff && t <= Date.parse("2026-09-23T20:00:00Z") / 1000));
  e.timestamp = e.timestamp.filter((_: number, i: number) => k2[i]);
  for (const k of Object.keys(e.indicators.quote[0])) e.indicators.quote[0][k] = e.indicators.quote[0][k].filter((_: unknown, i: number) => k2[i]);
  const s2 = deriveSignal(OVERNIGHT.ctx, evidenceBytes(OVERNIGHT.exchanges.map((x) => x.key === "yahoo:adr" ? { ...x, body: JSON.stringify(early) } : x)), MIN);
  assert.deepEqual(s2.missing, ["yahoo:adr:stale"]);
});

test("bytes claiming the wrong url or the wrong symbol are not read", () => {
  const swapped = OVERNIGHT.exchanges.map((e) => e.key === "perp:cut" ? { ...e, url: binanceKlinesUrl("HK1810USDT", 1790150040000) } : e);
  assert.deepEqual(deriveSignal(OVERNIGHT.ctx, evidenceBytes(swapped), MIN).missing, ["perp:cut:wrong-url"]);
  // Another ticker's chart under this ticker's url.
  const other = OVERNIGHT.exchanges.map((e) => e.key === "yahoo:adr" ? { ...e, body: body(OVERNIGHT, "yahoo:primary") } : e);
  assert.deepEqual(deriveSignal(OVERNIGHT.ctx, evidenceBytes(other), MIN).missing, ["yahoo:adr:wrong-symbol"]);
});

test("the recess derives the perp leg only: no US session can be inside 65 minutes", () => {
  const s = deriveSignal(RECESS.ctx, evidenceBytes(RECESS.exchanges), MIN);
  assert.equal(s.closureS, 3_891);
  assert.equal(s.adr, null);
  assert.deepEqual(s.missing, [], "the ADR leg is not looked for, so it is not a gap");
  assert.equal(s.perp!.cutE18, "434200000000000000000");
  assert.equal(s.perp!.commitE18, "435330000000000000000");
});

test("an asset without a proxy has no signal at all", () => {
  const s = deriveSignal({ ...OVERNIGHT.ctx, symbol: "wNVDAx" }, evidenceBytes(OVERNIGHT.exchanges), MIN);
  assert.deepEqual(s, { closureS: 63_291, proxy: null, perp: null, adr: null, missing: ["no-proxy"] });
  assert.equal(parseYahooChart("{}"), null);
});

// --- fetching: exact bytes, the relay's promises checked, never a throw ----------------------------

const RELAY = "https://relay.test";
const exact = (s: string) => new TextEncoder().encode(s);

/** A fake network: Binance direct answers 451 (as it does to a US host); the relay and Yahoo serve the fixture. */
function fakeNet(fx: Fixture, over: { relay?: (url: URL) => Response | null; yahoo?: (url: URL) => Response | null } = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.origin === RELAY) {
      const custom = over.relay?.(url);
      if (custom) return custom;
      const upstream = binanceKlinesUrl(url.searchParams.get("symbol")!, Number(url.searchParams.get("startTime")));
      const ex = fx.exchanges.find((e) => e.url === upstream);
      if (!ex) return new Response(JSON.stringify({ error: "upstream", upstreamStatus: 400 }), { status: 502 });
      const b = exact(ex.body);
      return new Response(b, { status: 200, headers: { "x-curb-upstream-url": upstream, "x-curb-upstream-sha256": sha256Hex(b) } });
    }
    if (url.hostname === "fapi.binance.com") return new Response("{\"code\":0,\"msg\":\"restricted location\"}", { status: 451 });
    if (url.hostname.endsWith("finance.yahoo.com")) {
      const custom = over.yahoo?.(url);
      if (custom) return custom;
      const canonical = url.href.replace("query2.", "query1.");
      const ex = fx.exchanges.find((e) => e.url === canonical);
      return ex ? new Response(exact(ex.body), { status: 200 }) : new Response("Too Many Requests", { status: 429 });
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  return { f, calls };
}

const cfg = (f: typeof fetch, over: Partial<SignalFetchConfig> = {}): SignalFetchConfig =>
  ({ enabled: true, relayBase: RELAY, binanceDirect: true, perFetchMs: 2_000, fetchImpl: f, ...over });

test("through the relay: the upstream url and sha256 are checked, and the committed url is Binance's", async () => {
  const { f, calls } = fakeNet(OVERNIGHT);
  const g = await gatherSignal(OVERNIGHT.ctx, MIN, cfg(f));
  assert.deepEqual(g.exchanges.map((e) => e.key), ["perp:commit", "perp:cut", "yahoo:adr", "yahoo:fx", "yahoo:primary"]);
  const cut = g.exchanges.find((e) => e.key === "perp:cut")!;
  assert.equal(cut.url, binanceKlinesUrl("HK0700USDT", 1790150040000));
  assert.ok(cut.via.startsWith(`${RELAY}/v1/relay/binance/klines?`));
  assert.equal(cut.sha256, "7b3de63c048e38d3edc65a5e967f5dc01d523cc193077fc5e92147fc9c4db96d", "the hash anyone gets from fapi.binance.com");
  assert.equal(cut.reproducible, true);
  assert.equal(g.exchanges.find((e) => e.key === "yahoo:adr")!.reproducible, false);
  assert.deepEqual(g.input, deriveSignal(OVERNIGHT.ctx, evidenceBytes(OVERNIGHT.exchanges), MIN));
  assert.ok(!calls.some((c) => c.includes("fapi.binance.com")), "no direct fetch when the relay answers");
});

test("a relay that alters the bytes is refused, and the leg falls back to a direct fetch", async () => {
  const { f } = fakeNet(OVERNIGHT, {
    relay: (url) => {
      if (url.searchParams.get("startTime") !== "1790150040000") return null;
      const upstream = binanceKlinesUrl("HK0700USDT", 1790150040000);
      const real = exact(body(OVERNIGHT, "perp:cut"));
      const lie = exact(body(OVERNIGHT, "perp:cut").replace("440.91000", "450.91000"));
      return new Response(lie, { status: 200, headers: { "x-curb-upstream-url": upstream, "x-curb-upstream-sha256": sha256Hex(real) } });
    },
  });
  const g = await gatherSignal(OVERNIGHT.ctx, MIN, cfg(f));
  const cut = g.attempts.filter((a) => a.key === "perp:cut");
  assert.equal(cut.length, 2, "relay, then direct");
  assert.match(cut[0].error!, /sha256 header does not match/);
  assert.match(cut[1].error!, /http 451/);
  assert.equal(g.input.perp, null);
  assert.deepEqual(g.input.missing, ["perp:cut:absent"]);
  assert.ok(g.input.adr, "the ADR leg is unaffected");
});

test("everything failing gives an absent signal and a full log, never a throw", async () => {
  const f = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const g = await gatherSignal(OVERNIGHT.ctx, MIN, cfg(f));
  assert.deepEqual(g.exchanges, []);
  assert.equal(g.input.perp, null);
  assert.equal(g.input.adr, null);
  assert.equal(g.attempts.length, 2 * 2 + 3 * 2, "two routes per kline, two hosts per chart");
  assert.ok(g.attempts.every((a) => !a.ok && a.error));
});

test("a slow upstream is cut off by the per-request timeout", async () => {
  const f = ((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  const t0 = Date.now();
  const g = await gatherSignal(RECESS.ctx, MIN, cfg(f, { perFetchMs: 100 }));
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(g.input.perp, null);
  assert.ok(g.attempts.every((a) => /TimeoutError|abort/i.test(a.error ?? "")), JSON.stringify(g.attempts));
});

test("a recess fetches the perp only; SIGNAL=off and assets with no proxy fetch nothing", async () => {
  const net = fakeNet(RECESS);
  const g = await gatherSignal(RECESS.ctx, MIN, cfg(net.f));
  assert.ok(net.calls.every((c) => !c.includes("yahoo")), "no US session in a recess, so no ADR fetch");
  assert.deepEqual(g.exchanges.map((e) => e.key), ["perp:commit", "perp:cut"]);

  const off = fakeNet(OVERNIGHT);
  const g2 = await gatherSignal(OVERNIGHT.ctx, MIN, cfg(off.f, { enabled: false }));
  assert.deepEqual(off.calls, []);
  assert.equal(g2.attempts[0].error, "signal fetching disabled (SIGNAL=off)");
  assert.deepEqual(g2.input.missing, ["perp:cut:absent", "perp:commit:absent", "yahoo:adr:absent"]);

  const us = fakeNet(OVERNIGHT);
  const g3 = await gatherSignal({ ...OVERNIGHT.ctx, symbol: "wAAPLx" }, MIN, cfg(us.f));
  assert.deepEqual(us.calls, []);
  assert.equal(g3.input.proxy, null);
});
