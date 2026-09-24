import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { loadConfig, tick, DEFAULT_CLOCK, DEFAULT_SCORECARD } from "./main.ts";
import type { AppState } from "./app.ts";
import type { Asset } from "./cohort.ts";
import { decodeMic } from "./cohort.ts";
import { TimelineCache } from "./closureCalendar.ts";
import { VenueStore } from "./venue.ts";
import { XStocksClient } from "./sources/xstocks.ts";
import { Payments } from "./pay/server.ts";
import { silentLog } from "./log.ts";

test("an empty environment is a valid config with payments off, not an error", () => {
  const { cfg, errors, paymentIssues } = loadConfig({});
  assert.deepEqual(errors, []);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.dataDir, "/data");
  assert.equal(cfg.chainId, 196);
  assert.equal(cfg.network, "eip155:196");
  assert.equal(cfg.clock, DEFAULT_CLOCK);
  assert.equal(cfg.scorecard, DEFAULT_SCORECARD);
  assert.deepEqual(cfg.rpcs, ["https://rpc.xlayer.tech", "https://xlayer.drpc.org"]);
  assert.equal(cfg.publicUrl, "https://api.curb.markets");
  assert.equal(cfg.payTo, null);
  assert.equal(cfg.okx, null);
  assert.equal(cfg.syncSettle, true);
  assert.equal(cfg.regimeIndexFromBlock, 70_617_365, "MarketClock's first attestation");
  assert.equal(cfg.regimeIndexConcurrency, 4);
  assert.equal(cfg.okxSettleTimeoutMs, 30_000, "a settle outlasting this is an unknown outcome, settled by the chain");
  assert.deepEqual(paymentIssues, ["PAY_TO is unset", "OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE unset"]);
});

test("the settle deadline is bounded: long enough for a sync settle to mine, short enough not to hold a buyer for minutes", () => {
  assert.equal(loadConfig({ OKX_SETTLE_TIMEOUT_MS: "45000" }).cfg.okxSettleTimeoutMs, 45_000);
  for (const bad of ["4999", "120001", "soon"]) {
    assert.ok(loadConfig({ OKX_SETTLE_TIMEOUT_MS: bad }).errors.some((e) => e.startsWith("OKX_SETTLE_TIMEOUT_MS must be in [5000,120000]")), bad);
  }
});

test("the RegimeChanged index settings are bounded; an unset SCORECARD is allowed and simply means no record routes", () => {
  const bad = loadConfig({ REGIME_INDEX_CONCURRENCY: "9", REGIME_INDEX_FROM_BLOCK: "-1" });
  assert.equal(bad.errors.length, 2);
  assert.ok(bad.errors.some((e) => e.startsWith("REGIME_INDEX_CONCURRENCY must be in [1,8]")));
  assert.ok(bad.errors.some((e) => e.startsWith("REGIME_INDEX_FROM_BLOCK")));
  const ok = loadConfig({ REGIME_INDEX_CONCURRENCY: "2", REGIME_INDEX_FROM_BLOCK: "71000000", SCORECARD: "" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.cfg.regimeIndexConcurrency, 2);
  assert.equal(ok.cfg.regimeIndexFromBlock, 71_000_000);
  assert.equal(ok.cfg.scorecard, "0x0000000000000000000000000000000000000000");
});

test("bad values are collected rather than thrown; a bad PAY_TO only turns payments off", () => {
  const { cfg, errors, paymentIssues } = loadConfig({ PORT: "99999", PAY_TO: "0xnot-an-address", OKX_SYNC_SETTLE: "maybe", CLOCK: "nope" });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.startsWith("PORT")));
  assert.ok(errors.some((e) => e.startsWith("OKX_SYNC_SETTLE")));
  assert.ok(errors.some((e) => e.startsWith("CLOCK")));
  assert.ok(paymentIssues.some((e) => e.startsWith("PAY_TO is not an address")));
  assert.equal(cfg.payTo, null);
});

test("a complete payment config checksums PAY_TO and carries the credentials", () => {
  const { cfg, errors, paymentIssues } = loadConfig({
    PAY_TO: "0x1111111111111111111111111111111111111111", OKX_API_KEY: "k", OKX_SECRET_KEY: "s", OKX_PASSPHRASE: "p",
    PUBLIC_URL: "https://api.curb.markets/", OKX_SYNC_SETTLE: "false",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(paymentIssues, []);
  assert.equal(cfg.payTo, getAddress("0x1111111111111111111111111111111111111111"));
  assert.deepEqual(cfg.okx, { apiKey: "k", secretKey: "s", passphrase: "p" });
  assert.equal(cfg.publicUrl, "https://api.curb.markets", "trailing slash trimmed");
  assert.equal(cfg.syncSettle, false);
});

test("MarketClock's bytes4 venue decodes to a MIC, and junk decodes to nothing", () => {
  assert.equal(decodeMic("0x58484b47"), "XHKG");
  assert.equal(decodeMic("0x584e4153"), "XNAS");
  assert.equal(decodeMic("0x00000000"), "");
  assert.equal(decodeMic("0xffffffff"), "");
});

test("a tick loads the cohort and issuer bytes, readies payments, and survives a dead RPC", async () => {
  const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
  const bodies: Record<string, string> = {
    "https://issuer.test/assets/TCENTx?network=XLayer": fixture("tcentx.asset.json"),
    "https://issuer.test/exchanges/XHKG": fixture("xhkg.exchange.json"),
  };
  const fetchStub = (async (u: string | URL | Request) => new Response(bodies[String(u)] ?? "", { status: bodies[String(u)] ? 200 : 404 })) as typeof fetch;
  const asset: Asset = {
    wrapper: getAddress("0x41333df9e7639188bbfca5522dc4844398af9f9e"), symbol: "wTCENTx", rawSymbol: "TCENTx",
    raw: getAddress("0xfa15e42c18cf57aeef4b1bac1cee7754af7cfe42"), micOnChain: "XHKG", pool: null,
    equityIsToken0: null, equityDecimals: null, stableDecimals: null,
  };
  const now = () => new Date("2026-09-22T10:00:00+08:00").getTime();
  const state: AppState = { bootMs: now(), ticks: 0, lastTickOkMs: 0, cohort: [], cohortAsOfMs: 0, cohortError: null };
  const venues = new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 });
  let supported = 0;
  const payments = new Payments({
    network: "eip155:196", payTo: getAddress("0x1111111111111111111111111111111111111111"), okx: null, syncSettle: true,
    publicUrl: "https://x.test", handlers: new Map(), now, log: silentLog, initRetryMs: 0,
    facilitator: {
      async getSupported() { supported++; return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }], extensions: [], signers: {} }; },
      async verify() { throw new Error("unused"); }, async settle() { throw new Error("unused"); },
    },
  });
  const fresh: string[] = [];
  let rpcUp = true;
  const deps = {
    state, venues, timelines: new TimelineCache(), payments, now, log: silentLog, cohortRefreshMs: 600_000,
    client: new XStocksClient("https://issuer.test", fetchStub, now),
    readCohort: async () => { if (!rpcUp) throw new Error("no RPC returned a head"); return [asset]; },
    onFreshVenue: (_a: Asset, v: { assetBodyHash: string }) => fresh.push(v.assetBodyHash),
  };
  await tick(deps);
  assert.equal(state.cohort.length, 1);
  assert.equal(venues.status(asset.wrapper, now()).venue?.mic, "XHKG");
  // The tick fires /supported and does not wait for it; ensureReady() hands back that same attempt.
  assert.equal(await payments.ensureReady(), true);
  assert.equal(payments.ready, true);
  assert.equal(supported, 1, "one attempt: the tick's");
  assert.equal(fresh.length, 1, "the issuer bytes were handed over to be kept as evidence");

  rpcUp = false;
  state.cohortAsOfMs = 0;   // force a cohort refresh
  await tick(deps);
  assert.equal(state.cohort.length, 1, "a failed refresh keeps the last good cohort");
  assert.match(state.cohortError!, /no RPC/);
});

test("every tick refreshes the Scorecard snapshot, and a failed refresh costs a log line, not the tick", async () => {
  const now = () => new Date("2026-09-22T10:00:00+08:00").getTime();
  const state: AppState = { bootMs: now(), ticks: 0, lastTickOkMs: 0, cohort: [], cohortAsOfMs: 0, cohortError: null };
  const logged: string[] = [];
  let refreshes = 0;
  let fail = false;
  let supported = 0;
  const payments = new Payments({
    network: "eip155:196", payTo: getAddress("0x1111111111111111111111111111111111111111"), okx: null, syncSettle: true,
    publicUrl: "https://x.test", handlers: new Map(), now, log: silentLog, initRetryMs: 0,
    facilitator: {
      async getSupported() { supported++; return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }], extensions: [], signers: {} }; },
      async verify() { throw new Error("unused"); }, async settle() { throw new Error("unused"); },
    },
  });
  const deps = {
    state, venues: new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 }), timelines: new TimelineCache(),
    payments, now, log: (e: string) => { logged.push(e); }, cohortRefreshMs: 600_000,
    client: new XStocksClient("https://issuer.test", (async () => new Response("", { status: 404 })) as typeof fetch, now),
    readCohort: async () => [] as Asset[],
    scorecard: { async refresh() { refreshes++; if (fail) throw new Error("multicall failed on every RPC"); } },
  };
  await tick(deps);
  assert.equal(refreshes, 1);
  fail = true;
  await tick(deps);
  assert.equal(refreshes, 2);
  assert.ok(logged.includes("scorecard-error"));
  assert.equal(await payments.ensureReady(), true, "the steps after it still ran");
  assert.equal(supported, 1);
});
