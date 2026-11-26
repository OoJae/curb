import { test } from "node:test";
import assert from "node:assert/strict";
import { carryLastGood, rememberGood, nearChange, transportFailure } from "./carry.ts";
import type { GoodFetch } from "./carry.ts";
import { buildRound } from "./round.ts";
import type { CohortEntry, RoundInputs } from "./round.ts";
import { verifyBundleOffline } from "./verify/offline.ts";
import { hashBytes } from "./tree.ts";
import type { Exchange, FetchLogEntry } from "./sources/xstocks.ts";
import { Regime } from "./regime.ts";
import type { ExchangeSchedule } from "./regime.ts";
import type { PriorObservation } from "./derive.ts";

const API = "https://api.xstocks.fi/api/v2/public";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const XHKG = {
  mic: "XHKG", timezone: "Asia/Hong_Kong", isOpen: true, currentSession: null, nextChangeAt: null,
  schedule: {
    timezone: "Asia/Hong_Kong",
    sessions: [
      { kind: "Extended", days: WEEK, open: "09:00", close: "09:30" },
      { kind: "Regular", days: WEEK, open: "09:30", close: "12:00" },
      { kind: "Regular", days: WEEK, open: "13:00", close: "16:00" },
      { kind: "Extended", days: WEEK, open: "16:00", close: "16:10" },
    ],
    holidays: [],
  },
};
const XHKG_BODY = enc(XHKG);
const SCHEDULES = new Map<string, ExchangeSchedule>([["XHKG", XHKG as unknown as ExchangeSchedule]]);

function assetBody(symbol: string, period: string, nextChangeAt: string | null = "2026-10-06T04:00:00.000Z") {
  return enc({
    symbol,
    trading: {
      currency: "USD", tradingHoursMode: "Regular", isTradingHalted: false, currentPeriod: period,
      openNow: period === "market", nextChangeAt,
      exchange: { mic: "XHKG", abbreviation: "HKEX", name: "HKEX", timezone: "Asia/Hong_Kong" },
      limitsPerPeriod: {
        market: { minOrderFiatValue: 1000, maxOrderFiatValue: 10_000_000 },
        extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
        overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
        closed: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
      },
    },
  });
}

const COHORT: CohortEntry[] = [
  { wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", raw: "0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42", symbol: "TCENTx", mic: "XHKG" },
  { wrapper: "0x076CF393E701839FC7a5832D2c68AaFA235682AE", raw: "0xfb4f81f511b40b80996062032260A539E60aDFc0", symbol: "XIAOx", mic: "XHKG" },
];
const urlOf = (symbol: string) => `${API}/assets/${symbol}?network=XLayer`;
const SCHED_URL = `${API}/exchanges/XHKG`;

function good(url: string, body: Uint8Array, respEndMs: number): Exchange {
  return { url, status: 200, ok: true, body, bodyHash: hashBytes(body), bytes: body.byteLength, reqStartMs: respEndMs - 120, respEndMs, headers: {}, error: null };
}
function failed(url: string, respEndMs: number, status = 0, error = "AbortError: This operation was aborted"): Exchange {
  return { url, status, ok: false, body: null, bodyHash: null, bytes: 0, reqStartMs: respEndMs - 3000, respEndMs, headers: {}, error: status ? `http ${status}` : error };
}

/** A fake client log: every exchange gets the next sequence number, as XStocksClient.get does. */
class Log {
  seq = 0;
  entries: FetchLogEntry[] = [];
  add(ex: Exchange): Exchange {
    this.entries.push({ seq: ++this.seq, url: ex.url, status: ex.status, ok: ex.ok, bodyHash: ex.bodyHash, reqStartMs: ex.reqStartMs, respEndMs: ex.respEndMs, error: ex.error });
    return ex;
  }
  take(): FetchLogEntry[] { return this.entries.splice(0, this.entries.length); }
}

function roundInputs(t: number, assetEx: Exchange[], schedEx: Exchange, fetchLog: FetchLogEntry[], prior: PriorObservation | null): RoundInputs {
  return {
    chainId: 196, clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b", kind: "heartbeat", targetMs: t, evaluatedAtMs: t,
    codeDigest: "sha256:test", cohort: COHORT,
    assetExchanges: new Map(COHORT.map((c, i) => [c.symbol, assetEx[i]])),
    scheduleExchanges: new Map([["XHKG", schedEx]]),
    fetchLog, prior,
    chain: {
      block: { number: 76_900_000, hash: "0x" + "11".repeat(32), timestamp: Math.floor(t / 1000), rpc: "https://rpc.xlayer.tech" },
      results: [{ label: "gcm:0xfa15", target: COHORT[0].raw, callData: "0x2b63c300", success: true, returnData: "0x" }],
    },
  };
}

/**
 * Two ticks as main.ts runs them: tick 1 fetches everything, tick 2 fails XIAOx as `fail` says.
 * 10:30 HKT on Tue 6 Oct 2026, 90 minutes from the next boundary, unless `at` says otherwise.
 */
function twoTicks(o: { at?: string; gapMs?: number; fail?: (url: string, endMs: number) => Exchange[]; carry?: boolean; xiaoBody1?: Uint8Array } = {}) {
  const t1 = new Date(o.at ?? "2026-10-06T02:30:00Z").getTime();
  const log = new Log();
  const lastGood = new Map<string, GoodFetch>();

  const sched1 = log.add(good(SCHED_URL, XHKG_BODY, t1 - 700));
  const ex1 = [log.add(good(urlOf("TCENTx"), assetBody("TCENTx", "market"), t1 - 500)), log.add(good(urlOf("XIAOx"), o.xiaoBody1 ?? assetBody("XIAOx", "market"), t1 - 480))];
  const tickLog1 = log.take();
  const c1 = carryLastGood({ cohort: COHORT, assetEx: ex1, tickLog: tickLog1, lastGood, schedules: SCHEDULES, evaluatedAtMs: t1 });
  rememberGood(lastGood, COHORT, ex1, tickLog1);
  const r1 = buildRound(roundInputs(t1, c1.assetEx, sched1, c1.fetchLog, null));

  // The failing tick: two 3 s attempts, then the chain reads, so it evaluates about 37 s after tick 1's fetch.
  const t2 = t1 + (o.gapMs ?? 37_000);
  const sched2 = log.add(good(SCHED_URL, XHKG_BODY, t2 - 6900));
  const tencent2 = log.add(good(urlOf("TCENTx"), assetBody("TCENTx", "market"), t2 - 6800));
  const attempts = (o.fail ?? ((url, end) => [failed(url, end - 3400), failed(url, end)]))(urlOf("XIAOx"), t2 - 600).map((e) => log.add(e));
  const ex2 = [tencent2, attempts[attempts.length - 1]];
  const tickLog2 = log.take();
  const c2 = o.carry === false
    ? { assetEx: ex2, fetchLog: tickLog2, carried: [] }
    : carryLastGood({ cohort: COHORT, assetEx: ex2, tickLog: tickLog2, lastGood, schedules: SCHEDULES, evaluatedAtMs: t2 });
  rememberGood(lastGood, COHORT, ex2, tickLog2);
  const r2 = buildRound(roundInputs(t2, c2.assetEx, sched2, c2.fetchLog, r1.observed));
  return { t1, t2, r1, r2, c2, lastGood, ex1, tickLog2 };
}

const claimOf = (r: ReturnType<typeof buildRound>, symbol: string) => r.claims.find((c) => c.symbol === symbol)!;

test("without the carry, one timed-out fetch writes that asset shut (the false closure of D-18)", () => {
  const { r2 } = twoTicks({ carry: false });
  assert.equal(claimOf(r2, "TCENTx").regime, Regime.MARKET);
  assert.equal(claimOf(r2, "XIAOx").regime, Regime.CLOSED);
  assert.equal(claimOf(r2, "XIAOx").capUsd, 0n);
  assert.deepEqual(claimOf(r2, "XIAOx").degraded, ["source-unavailable"]);
});

test("with it, the asset keeps the state of its last good answer, 37 s old, and nothing is flagged", () => {
  const { r2, c2, t1, t2 } = twoTicks();
  assert.deepEqual(c2.carried, [{ symbol: "XIAOx", ageMs: t2 - (t1 - 480), error: "AbortError: This operation was aborted" }]);
  assert.equal(claimOf(r2, "XIAOx").regime, Regime.MARKET);
  assert.equal(claimOf(r2, "XIAOx").capUsd, 100_000n);
  assert.deepEqual(claimOf(r2, "XIAOx").degraded, []);
});

test("the round re-derives offline, under derive/3, from the published bundle alone", () => {
  const { r2, t1 } = twoTicks();
  const published = JSON.parse(JSON.stringify(r2.bundle));
  const v = verifyBundleOffline(published);
  assert.deepEqual(v.failures, []);
  assert.equal(v.root, r2.root);
  // The evidence says what happened: the reused fetch's own entry, older and first, then this tick's failed attempts.
  const fetchLog = Object.values(published.json as Record<string, string>).map((s) => JSON.parse(s)).find((j) => Array.isArray(j) && j[0]?.url) as FetchLogEntry[];
  const xiao = fetchLog.filter((e) => e.url === urlOf("XIAOx"));
  assert.deepEqual(xiao.map((e) => [e.ok, e.status]), [[true, 200], [false, 0], [false, 0]]);
  assert.equal(xiao[0].respEndMs, t1 - 480);
  assert.equal(xiao[0].seq, 3, "the entry keeps the sequence number of the tick that fetched it");
  assert.deepEqual(fetchLog.map((e) => e.seq), [...fetchLog.map((e) => e.seq)].sort((a, b) => a - b));
  const params = Object.values(published.json as Record<string, string>).map((s) => JSON.parse(s)).find((j) => j?.method);
  assert.equal(params.method, "curb.marketclock.derive/3");
  assert.equal(params.lastKnownGoodMs, 60_000);
});

test("an answer older than the 60 s window is not reused: the asset closes, as before", () => {
  const { r2, c2 } = twoTicks({ gapMs: 61_000 });
  assert.deepEqual(c2.carried, []);
  assert.equal(claimOf(r2, "XIAOx").regime, Regime.CLOSED);
  assert.deepEqual(claimOf(r2, "XIAOx").degraded, ["source-unavailable"]);
  assert.deepEqual(verifyBundleOffline(JSON.parse(JSON.stringify(r2.bundle))).failures, []);
});

test("exactly at the window's edge it is still reused, and derive() agrees it is fresh", () => {
  // tick 1's XIAOx fetch ended 480 ms before t1, so a gap of 59,520 ms puts it exactly 60,000 ms back.
  const { r2, c2 } = twoTicks({ gapMs: 59_520 });
  assert.equal(c2.carried[0]?.ageMs, 60_000);
  assert.equal(claimOf(r2, "XIAOx").regime, Regime.MARKET);
  assert.deepEqual(verifyBundleOffline(JSON.parse(JSON.stringify(r2.bundle))).failures, []);
});

test("nothing is reused near a scheduled change: 6 minutes before the 12:00 HKT boundary the asset closes", () => {
  // 11:53:23 HKT at tick 1, 11:54:00 at the failing tick: inside the 7-minute guard, before the issuer's 11:55 cut.
  const { r2, c2 } = twoTicks({ at: "2026-10-06T03:53:23Z" });
  assert.deepEqual(c2.carried, []);
  assert.equal(claimOf(r2, "XIAOx").regime, Regime.CLOSED);
  assert.deepEqual(claimOf(r2, "XIAOx").degraded, ["source-unavailable"]);
});

test("nor just after one: 2 minutes after the 09:30 HKT open a failed fetch still closes", () => {
  const { c2 } = twoTicks({ at: "2026-10-06T01:31:30Z" });
  assert.deepEqual(c2.carried, []);
});

test("the body's own announced change guards it too, even where the schedule shows nothing near", () => {
  const now = new Date("2026-10-06T02:30:00Z").getTime();
  const body = (next: string | null) => assetBody("XIAOx", "market", next);
  assert.equal(nearChange(body("2026-10-06T04:00:00.000Z"), SCHEDULES.get("XHKG"), now), false);
  assert.equal(nearChange(body("2026-10-06T02:36:00.000Z"), SCHEDULES.get("XHKG"), now), true, "6 minutes away");
  assert.equal(nearChange(body("2026-10-06T02:29:00.000Z"), SCHEDULES.get("XHKG"), now), true, "already past: the body has outlived its statement");
  assert.equal(nearChange(body("2026-10-06T02:37:01.000Z"), SCHEDULES.get("XHKG"), now), false, "just outside 7 minutes");
  // No schedule: the body's own statement decides, and with neither there is nothing to say a change is NOT near.
  assert.equal(nearChange(body("2026-10-06T04:00:00.000Z"), undefined, now), false);
  assert.equal(nearChange(body(null), undefined, now), true);
  assert.equal(nearChange(body(null), SCHEDULES.get("XHKG"), now), false);
  assert.equal(nearChange(new TextEncoder().encode("not json"), SCHEDULES.get("XHKG"), now), true);
});

test("only a transport failure is 'no news': a rate limit and a 5xx are reused, a 404 is not", () => {
  for (const status of [429, 500, 503]) {
    const { c2, r2 } = twoTicks({ fail: (url, end) => [failed(url, end - 400, status), failed(url, end, status)] });
    assert.equal(c2.carried.length, 1, String(status));
    assert.equal(claimOf(r2, "XIAOx").regime, Regime.MARKET, String(status));
    assert.deepEqual(verifyBundleOffline(JSON.parse(JSON.stringify(r2.bundle))).failures, [], String(status));
  }
  const gone = twoTicks({ fail: (url, end) => [failed(url, end, 404)] });
  assert.deepEqual(gone.c2.carried, []);
  assert.equal(claimOf(gone.r2, "XIAOx").regime, Regime.CLOSED);
  assert.equal(gone.lastGood.has("XIAOx"), false, "a 404 is an answer: the earlier good one is forgotten");
  assert.equal(transportFailure(failed("u", 1, 404)), false);
  assert.equal(transportFailure(failed("u", 1, 0)), true);
});

test("a body the shape check withheld is an answer too: it is not replaced, and it ends the carry", () => {
  // 200 with an unusable body: main.ts keeps ok and withholds the body (neutralizeIfInvalid).
  const withheld = (url: string, end: number): Exchange[] => [{ ...good(url, enc({ nonsense: true }), end), body: null }];
  const { c2, r2, lastGood } = twoTicks({ fail: withheld });
  assert.deepEqual(c2.carried, []);
  assert.equal(claimOf(r2, "XIAOx").regime, Regime.CLOSED);
  assert.equal(lastGood.has("XIAOx"), false);
  assert.deepEqual(verifyBundleOffline(JSON.parse(JSON.stringify(r2.bundle))).failures, []);
});

test("a first tick with nothing remembered closes as before, and a reused closed answer stays closed", () => {
  const t = new Date("2026-10-06T02:30:00Z").getTime();
  const ex = [good(urlOf("TCENTx"), assetBody("TCENTx", "market"), t - 500), failed(urlOf("XIAOx"), t - 400)];
  const boot = carryLastGood({ cohort: COHORT, assetEx: ex, tickLog: [], lastGood: new Map(), schedules: SCHEDULES, evaluatedAtMs: t });
  assert.deepEqual(boot.carried, []);
  assert.equal(boot.assetEx[1].ok, false);

  // Sunday: the last good answer says closed until Monday 09:30 HKT. Reusing it writes CLOSED, which is what a
  // missing body writes too, so the chain state does not depend on the carry.
  const sunday = twoTicks({ at: "2026-10-04T10:00:00Z", xiaoBody1: assetBody("XIAOx", "closed", "2026-10-05T01:30:00.000Z") });
  assert.equal(sunday.c2.carried.length, 1);
  assert.equal(claimOf(sunday.r2, "XIAOx").regime, Regime.CLOSED);
  assert.equal(claimOf(sunday.r2, "XIAOx").capUsd, 0n);
});

test("the reused answer is the newest good one, an asset that left the cohort is dropped, and inputs are not mutated", () => {
  const { lastGood, ex1 } = twoTicks();
  assert.equal(lastGood.get("XIAOx")!.ex, ex1[1], "still tick 1's: tick 2 failed in transport");
  assert.equal(lastGood.get("TCENTx")!.ex.respEndMs > ex1[0].respEndMs, true, "TCENTx moved on to tick 2's fetch");
  rememberGood(lastGood, [COHORT[0]], [lastGood.get("TCENTx")!.ex], [lastGood.get("TCENTx")!.entry]);
  assert.deepEqual([...lastGood.keys()], ["TCENTx"]);

  const t = new Date("2026-10-06T02:30:00Z").getTime();
  const assetEx = [failed(urlOf("TCENTx"), t), failed(urlOf("XIAOx"), t)];
  const frozen = [...assetEx];
  carryLastGood({ cohort: COHORT, assetEx, tickLog: [], lastGood, schedules: SCHEDULES, evaluatedAtMs: t });
  assert.deepEqual(assetEx, frozen);
});
