/**
 * The Binance klines relay, offline: a fake fetch stands in for Binance, and the one integration test runs
 * the real createApp on a real node:http server. Nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type { SupportedResponse } from "@okxweb3/x402-core/types";

import { createBinanceRelay, binanceKlinesUrl, BINANCE_KLINE_SYMBOLS, BINANCE_KLINES_PATH } from "./relay.ts";
import type { RelayResponse } from "./relay.ts";
import { createApp } from "./app.ts";
import { VenueStore } from "./venue.ts";
import { Payments } from "./pay/server.ts";
import type { PricedHandler } from "./pay/server.ts";
import { silentLog } from "./log.ts";

const T = 1_790_236_440_000;   // a closed minute: 2026-09-24T07:14:00Z
const NOW = T + 10 * 60_000;
const URL1 = `https://fapi.binance.com/fapi/v1/klines?symbol=HK0700USDT&interval=1m&startTime=${T}&limit=1`;
/** Odd spacing, a tab, `.0` on integers, a trailing newline: a parse-and-reserialise would change every one. */
const RAW = `[ [${T},"438.80000", "438.80000",\t"438.80000","438.80000","1.26",${T + 59_999}.0,"552.8880000",2.0,"1.26","552.8880000","0"]\n]`;
const RAW2 = `[[${T},"1","1","1","1","0",${T + 59_999},"0",0,"0","0","0"],[${T + 60_000},"2","2","2","2","0",${T + 119_999},"0",0,"0","0","0"]]`;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const q = (s: string) => new URLSearchParams(s);
const bytesOf = (r: RelayResponse) => Buffer.from(r.body as Uint8Array);
const jsonOf = (r: RelayResponse) => JSON.parse(typeof r.body === "string" ? r.body : Buffer.from(r.body).toString("utf8"));

/** A stand-in for Binance: records every call, answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

test("passes the upstream bytes through byte for byte, with their sha256 and the canonical upstream URL", async () => {
  const up = fakeFetch(() => new Response(RAW, { status: 200, headers: { "content-type": "application/json" } }));
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => NOW });
  const r = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=1`));
  assert.equal(r.status, 200);
  assert.ok(bytesOf(r).equals(Buffer.from(RAW, "utf8")), "the exact upstream bytes");
  assert.equal(r.headers["x-curb-upstream-sha256"], sha(RAW));
  assert.match(r.headers["x-curb-upstream-sha256"], /^[0-9a-f]{64}$/, "plain lowercase hex, as sha256sum prints it");
  assert.equal(r.headers["x-curb-upstream-url"], URL1);
  assert.equal(binanceKlinesUrl("HK0700USDT", T, 1), URL1, "the keeper and a verifier build the same string");
  assert.equal(r.headers["x-curb-upstream-status"], "200");
  assert.equal(r.headers["x-curb-relay-cache"], "miss");
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.match(r.headers["access-control-expose-headers"], /x-curb-upstream-sha256/);

  assert.equal(up.calls.length, 1);
  assert.equal(up.calls[0].url, URL1, "the relay fetches exactly the URL it reports");
  const h = up.calls[0].init?.headers as Record<string, string>;
  assert.equal(h["user-agent"], "Mozilla/5.0 (compatible; curb-asp-relay/1.0)");
  assert.equal(h["accept-encoding"], "identity");
  assert.ok(up.calls[0].init?.signal instanceof AbortSignal);

  // interval=1m spelled out, and limit left to its default, are the same request and the same URL.
  const again = await relay.handle(q(`startTime=${T}&interval=1m&symbol=HK0700USDT`));
  assert.equal(again.headers["x-curb-upstream-url"], URL1);
});

test("the upstream base is configurable, and limit=2 asks for two minutes", async () => {
  const up = fakeFetch(() => new Response(RAW2));
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => NOW, upstreamBase: "http://binance.test" });
  const r = await relay.handle(q(`symbol=MEITUANUSDT&startTime=${T}&limit=2`));
  assert.equal(r.status, 200);
  assert.equal(up.calls[0].url, `http://binance.test/fapi/v1/klines?symbol=MEITUANUSDT&interval=1m&startTime=${T}&limit=2`);
  assert.equal(r.headers["x-curb-upstream-url"], up.calls[0].url);
  assert.equal(r.headers["x-curb-relay-cache"], "miss");
  assert.match(r.headers["cache-control"], /immutable/, "two closed rows, one per requested minute: final");
});

test("a second identical request is a cache hit: one upstream fetch, identical bytes and hash", async () => {
  const up = fakeFetch(() => new Response(RAW));
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => NOW });
  const a = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=1`));
  const b = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=1`));
  assert.equal(up.calls.length, 1);
  assert.equal(a.headers["x-curb-relay-cache"], "miss");
  assert.equal(b.headers["x-curb-relay-cache"], "hit");
  assert.ok(bytesOf(a).equals(bytesOf(b)));
  assert.equal(b.headers["x-curb-upstream-sha256"], sha(RAW));
  assert.equal(b.headers["x-curb-upstream-url"], URL1);
  assert.equal(b.headers["cache-control"], "public, max-age=31536000, immutable");
});

test("malformed or out-of-policy queries are 400s, and Binance is never asked", async () => {
  const up = fakeFetch(() => new Response(RAW));
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => NOW });
  const base = `symbol=HK0700USDT&startTime=${T}`;
  const cases: Array<[string, string]> = [
    [`symbol=BTCUSDT&startTime=${T}`, "symbol-not-allowed"],
    [`symbol=hk0700usdt&startTime=${T}`, "symbol-not-allowed"],
    [`startTime=${T}`, "symbol-not-allowed"],
    [`${base}&interval=5m`, "bad-interval"],
    [`${base}&interval=`, "bad-interval"],
    [`${base}&limit=3`, "bad-limit"],
    [`${base}&limit=0`, "bad-limit"],
    [`${base}&limit=01`, "bad-limit"],
    [`${base}&limit=`, "bad-limit"],
    [`symbol=HK0700USDT&startTime=${T + 1}`, "bad-startTime"],
    [`symbol=HK0700USDT&startTime=${T + 30_000}`, "bad-startTime"],
    ["symbol=HK0700USDT", "bad-startTime"],
    ["symbol=HK0700USDT&startTime=", "bad-startTime"],
    [`symbol=HK0700USDT&startTime=-${T}`, "bad-startTime"],
    [`symbol=HK0700USDT&startTime=%2B${T}`, "bad-startTime"],
    [`symbol=HK0700USDT&startTime=0${T}`, "bad-startTime"],
    ["symbol=HK0700USDT&startTime=1.79023644e12", "bad-startTime"],
    [`${base}&endTime=${T + 60_000}`, "unknown-parameter"],
    [`${base}&foo=1`, "unknown-parameter"],
    [`${base}&symbol=HK1810USDT`, "repeated-parameter"],
  ];
  for (const [query, error] of cases) {
    const r = await relay.handle(q(query));
    assert.equal(r.status, 400, query);
    assert.equal(jsonOf(r).error, error, query);
    assert.equal(r.headers["cache-control"], "no-store", query);
  }
  assert.deepEqual(jsonOf(await relay.handle(q(`symbol=BTCUSDT&startTime=${T}`))).allowed, [...BINANCE_KLINE_SYMBOLS]);
  assert.deepEqual(BINANCE_KLINE_SYMBOLS, ["HK0700USDT", "HK1810USDT", "MEITUANUSDT", "TENCENTUSDT"]);
  assert.equal(up.calls.length, 0);
});

test("a minute that has not closed is a 400 and is never fetched; the instant it closes, it is", async () => {
  let now = T + 59_999;
  const up = fakeFetch(() => new Response(RAW));
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => now });
  const open = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=1`));
  assert.equal(open.status, 400);
  assert.deepEqual(jsonOf(open), { error: "minute-not-closed", startTime: T, limit: 1, closesAtMs: T + 60_000, nowMs: T + 59_999 });

  now = T + 90_000;   // the first minute has closed, the second has not
  const second = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=2`));
  assert.equal(second.status, 400);
  assert.equal(jsonOf(second).error, "minute-not-closed");
  assert.equal(up.calls.length, 0);

  now = T + 60_000;
  const closed = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=1`));
  assert.equal(closed.status, 200);
  assert.equal(up.calls.length, 1);
  assert.equal(closed.headers["cache-control"], "no-store", "closed 1 ms ago: served, but not cached yet");
});

test("an upstream 451 is a 502 naming the status and why, and is never cached", async () => {
  const geo = '{"code":0,"msg":"Service unavailable from a restricted location according to \'b. Eligibility\' in https://www.binance.com/en/terms."}';
  const up = fakeFetch(() => new Response(geo, { status: 451 }));
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => NOW });
  const r = await relay.handle(q(`symbol=TENCENTUSDT&startTime=${T}`));
  assert.equal(r.status, 502);
  const body = jsonOf(r);
  assert.equal(body.error, "upstream");
  assert.equal(body.upstreamStatus, 451);
  assert.equal(body.reason, geo.slice(0, 200));
  assert.equal(body.upstreamUrl, binanceKlinesUrl("TENCENTUSDT", T, 1));
  assert.equal(r.headers["x-curb-upstream-status"], "451");
  assert.equal(r.headers["cache-control"], "no-store");
  await relay.handle(q(`symbol=TENCENTUSDT&startTime=${T}`));
  assert.equal(up.calls.length, 2, "an error is fetched again, not replayed");
});

test("a timeout or a network failure is a 502 with upstreamStatus 0, and the relay recovers after it", async () => {
  // Honours its signal, and never answers otherwise: the relay's deadline must end it.
  const hang = fakeFetch((_u, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  }));
  const slow = createBinanceRelay({ fetchImpl: hang.fetch, now: () => NOW, timeoutMs: 25 });
  const t = await slow.handle(q(`symbol=HK1810USDT&startTime=${T}`));
  assert.equal(t.status, 502);
  assert.equal(jsonOf(t).upstreamStatus, 0);
  assert.match(jsonOf(t).reason, /^TimeoutError: /);
  assert.equal(hang.calls[0].init?.signal?.aborted, true, "the upstream request is aborted, not left running");

  // Ignores its signal entirely: still bounded.
  const deaf = createBinanceRelay({ fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch, now: () => NOW, timeoutMs: 25 });
  assert.equal((await deaf.handle(q(`symbol=HK1810USDT&startTime=${T}`))).status, 502);

  let down = true;
  const flaky = fakeFetch(() => (down ? Promise.reject(new TypeError("fetch failed")) : new Response(RAW)));
  const relay = createBinanceRelay({ fetchImpl: flaky.fetch, now: () => NOW });
  const f = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`));
  assert.equal(f.status, 502);
  assert.deepEqual(jsonOf(f), { error: "upstream", upstreamStatus: 0, reason: "TypeError: fetch failed", upstreamUrl: URL1 });
  down = false;
  const ok = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["x-curb-relay-cache"], "miss");
  assert.equal(flaky.calls.length, 2);
});

test("an empty or short answer, or a row not yet settled, is passed through but not cached", async () => {
  let body = "[]";
  const up = fakeFetch(() => new Response(body));
  let now = NOW;
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => now });

  const empty = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`));
  assert.equal(empty.status, 200);
  assert.equal(Buffer.from(empty.body as Uint8Array).toString("utf8"), "[]");
  assert.equal(empty.headers["x-curb-upstream-sha256"], sha("[]"));
  assert.equal(empty.headers["cache-control"], "no-store");
  assert.equal((await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`))).headers["x-curb-relay-cache"], "miss");
  assert.equal(up.calls.length, 2);

  body = RAW;   // one row where two were asked for
  const short = await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=2`));
  assert.equal(short.headers["cache-control"], "no-store");
  await relay.handle(q(`symbol=HK0700USDT&startTime=${T}&limit=2`));
  assert.equal(up.calls.length, 4);

  // A different minute than the one asked for (Binance returns the next klines after a gap): not cached.
  const later = await relay.handle(q(`symbol=HK0700USDT&startTime=${T - 60_000}`));
  assert.equal(later.headers["cache-control"], "no-store");

  // Closed, but within the settle margin: served, not cached; once settled, cached.
  now = T + 60_000 + 3_000;
  assert.equal((await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`))).headers["cache-control"], "no-store");
  now = T + 60_000 + 6_000;
  assert.match((await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`))).headers["cache-control"], /immutable/);
  assert.equal((await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`))).headers["x-curb-relay-cache"], "hit");
});

test("the upstream budget: past maxPerMinute fetches in a rolling minute, a 503; cache hits stay free", async () => {
  let now = NOW;
  const up = fakeFetch((u) => {
    const start = Number(new URL(u).searchParams.get("startTime"));
    return new Response(`[[${start},"1","1","1","1","0",${start + 59_999},"0",0,"0","0","0"]]`);
  });
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => now, maxPerMinute: 2 });
  const at = (m: number) => q(`symbol=HK0700USDT&startTime=${T - m * 60_000}`);
  assert.equal((await relay.handle(at(0))).status, 200);
  assert.equal((await relay.handle(at(1))).status, 200);
  const busy = await relay.handle(at(2));
  assert.equal(busy.status, 503);
  assert.deepEqual(jsonOf(busy), { error: "relay-busy", maxPerMinute: 2 });
  assert.equal(busy.headers["retry-after"], "5");
  assert.equal(up.calls.length, 2, "a refused request is not fetched");

  const hit = await relay.handle(at(0));
  assert.equal(hit.status, 200);
  assert.equal(hit.headers["x-curb-relay-cache"], "hit", "a cache hit is served while the budget is spent");

  now += 60_000;
  assert.equal((await relay.handle(at(2))).status, 200, "the window rolls");
  assert.equal(up.calls.length, 3);
});

test("the cache is bounded: past maxCache, the oldest answer goes first", async () => {
  const up = fakeFetch((u) => {
    const start = Number(new URL(u).searchParams.get("startTime"));
    return new Response(`[[${start},"1","1","1","1","0",${start + 59_999},"0",0,"0","0","0"]]`);
  });
  const relay = createBinanceRelay({ fetchImpl: up.fetch, now: () => NOW, maxCache: 2 });
  for (const m of [0, 1, 2]) await relay.handle(q(`symbol=HK0700USDT&startTime=${T - m * 60_000}`));
  assert.equal((await relay.handle(q(`symbol=HK0700USDT&startTime=${T - 2 * 60_000}`))).headers["x-curb-relay-cache"], "hit");
  assert.equal((await relay.handle(q(`symbol=HK0700USDT&startTime=${T - 60_000}`))).headers["x-curb-relay-cache"], "hit");
  assert.equal((await relay.handle(q(`symbol=HK0700USDT&startTime=${T}`))).headers["x-curb-relay-cache"], "miss", "evicted");
  assert.equal(up.calls.length, 4);
});

test("the handler never throws: a fetch that throws synchronously, or any other failure, is a 502", async () => {
  const sync = createBinanceRelay({ fetchImpl: (() => { throw new Error("boom"); }) as typeof fetch, now: () => NOW });
  const a = await sync.handle(q(`symbol=HK0700USDT&startTime=${T}`));
  assert.equal(a.status, 502);
  assert.equal(jsonOf(a).reason, "Error: boom");

  const broken = createBinanceRelay({ fetchImpl: fakeFetch(() => new Response(RAW)).fetch, now: () => { throw new Error("clock"); } });
  const b = await broken.handle(q(`symbol=HK0700USDT&startTime=${T}`));
  assert.equal(b.status, 502);
  assert.equal(jsonOf(b).error, "relay-error");
});

test("createApp routes GET /v1/relay/binance/klines to the relay: free while payments are live, GET only", async () => {
  const now = () => NOW;
  const network = "eip155:196" as const;
  const broker: FacilitatorClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} } as SupportedResponse; },
    async verify() { throw new Error("no payment in this test"); },
    async settle() { throw new Error("no payment in this test"); },
  };
  const stub: PricedHandler = { accept: () => ({ ok: true, query: {} }), preview: () => ({}), build: () => ({ ok: true, body: {} }) };
  const handlers = new Map<string, PricedHandler>([["GET /v1/closure-calendar", stub]]);
  const payments = new Payments({
    network, payTo: getAddress("0x1111111111111111111111111111111111111111"), okx: null, facilitator: broker,
    syncSettle: true, publicUrl: "https://api.curb.markets", handlers, now, log: silentLog, initRetryMs: 0,
  });
  assert.equal(await payments.ensureReady(), true);
  const up = fakeFetch(() => new Response(RAW));
  const server = createServer(createApp({
    state: { bootMs: NOW, ticks: 1, lastTickOkMs: NOW, cohort: [], cohortAsOfMs: NOW, cohortError: null },
    venues: new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 }),
    payments, handlers, dataDir: mkdtempSync(join(tmpdir(), "curb-asp-relay-")), publicUrl: "https://api.curb.markets", tickMs: 30_000,
    contracts: { chainId: 196, clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b", scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f" },
    now, log: silentLog, relay: createBinanceRelay({ fetchImpl: up.fetch, now }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { accept: "application/json", "user-agent": "curb-test-agent/1.0" };
  try {
    const priced = await fetch(`${base}/v1/closure-calendar`, { headers });
    assert.equal(priced.status, 402, "payments are live: a priced route challenges");
    await priced.arrayBuffer();

    const r = await fetch(`${base}${BINANCE_KLINES_PATH}?symbol=HK0700USDT&startTime=${T}&limit=1`, { headers });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("payment-required"), null, "no challenge: the relay is free");
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.ok(bytes.equals(Buffer.from(RAW, "utf8")), "the exact upstream bytes, through the socket");
    assert.equal(r.headers.get("content-type"), "application/json");
    assert.equal(r.headers.get("content-length"), String(Buffer.byteLength(RAW)));
    assert.equal(r.headers.get("x-curb-upstream-sha256"), sha(bytes));
    assert.equal(r.headers.get("x-curb-upstream-url"), URL1);
    assert.equal(r.headers.get("x-curb-relay-cache"), "miss");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");

    const slash = await fetch(`${base}${BINANCE_KLINES_PATH}/?symbol=HK0700USDT&startTime=${T}`, { headers });
    assert.equal(slash.status, 200);
    assert.equal(slash.headers.get("x-curb-relay-cache"), "hit");
    await slash.arrayBuffer();

    const bad = await fetch(`${base}${BINANCE_KLINES_PATH}?symbol=BTCUSDT&startTime=${T}`, { headers });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "symbol-not-allowed");

    const post = await fetch(`${base}${BINANCE_KLINES_PATH}?symbol=HK0700USDT&startTime=${T}`, { method: "POST", headers });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, OPTIONS");
    await post.arrayBuffer();
    assert.equal(up.calls.length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
