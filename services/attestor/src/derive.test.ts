import { test } from "node:test";
import assert from "node:assert/strict";
import { derive, deriveDetailed, toAttestBatchArgs, LAST_KNOWN_GOOD_MS, PRIOR_MAX_AGE_MS } from "./derive.ts";
import type { AssetInput, PriorObservation } from "./derive.ts";
import { Regime } from "./regime.ts";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const XHKG = enc({
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
});

const XNAS = enc({
  mic: "XNAS", timezone: "America/New_York", isOpen: true, currentSession: null, nextChangeAt: null,
  schedule: {
    timezone: "America/New_York",
    sessions: [
      { kind: "Extended", days: WEEK, open: "04:00", close: "09:30" },
      { kind: "Regular", days: WEEK, open: "09:30", close: "16:00" },
      { kind: "Extended", days: WEEK, open: "16:00", close: "20:00" },
      { kind: "Overnight", days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], open: "20:00", close: "04:00" },
    ],
    holidays: [],
  },
});

const W_TCENT = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const W_NVDA = "0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5";

/** Shaped like the live GET /assets/{symbol}?network=XLayer response. */
function assetBody(period: string, mic: string, nextChangeAt: string | null, caps: Record<string, number>) {
  return enc({
    symbol: mic === "XHKG" ? "TCENTx" : "NVDAx",
    trading: {
      currency: "USD",
      tradingHoursMode: mic === "XHKG" ? "Regular" : "TwentyFourFive",
      isTradingHalted: false,
      currentPeriod: period,
      openNow: period !== "closed",
      nextChangeAt,
      exchange: { mic, abbreviation: mic, name: mic, timezone: mic === "XHKG" ? "Asia/Hong_Kong" : "America/New_York" },
      limitsPerPeriod: Object.fromEntries(
        Object.entries(caps).map(([k, v]) => [k, { minOrderFiatValue: 1000, maxOrderFiatValue: v }]),
      ),
    },
  });
}

const HK_CAPS = { market: 10_000_000, extended: 0, overnight: 0, closed: 0 };
const US_CAPS = { market: 100_000_000, extended: 100_000_000, overnight: 20_000_000, closed: 0 };
const ms = (s: string) => new Date(s).getTime();

/** derive/3 only writes an open regime when the previous tick saw it open too. */
function priorOpen(at: number, ...wrappers: string[]): PriorObservation {
  return { evaluatedAtMs: at, claims: Object.fromEntries(wrappers.map((w) => [w.toLowerCase(), { regime: Regime.MARKET, capUsd: "100000" }])) };
}
function priorShut(at: number, ...wrappers: string[]): PriorObservation {
  return { evaluatedAtMs: at, claims: Object.fromEntries(wrappers.map((w) => [w.toLowerCase(), { regime: Regime.CLOSED, capUsd: "0" }])) };
}

function tcent(period: string, fetchedAt: string, nextChangeAt: string | null): AssetInput {
  return { wrapper: W_TCENT, symbol: "TCENTx", mic: "XHKG", body: assetBody(period, "XHKG", nextChangeAt, HK_CAPS), fetchedAtMs: ms(fetchedAt) };
}

test("mid-morning session: Tencent is MARKET with its real cap and the API's next boundary", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-10-06T03:00:00Z"),
    assets: [tcent("market", "2026-10-06T02:59:58Z", "2026-10-06T04:00:00.000Z")],
    schedules: { XHKG },
    prior: priorOpen(ms("2026-10-06T02:59:55Z"), W_TCENT),
  });
  assert.equal(c.regime, Regime.MARKET);
  // The issuer's maxOrderFiatValue is in fiat CENTS (issuer API spec): 10,000,000 cents = $100,000.
  assert.equal(c.capUsd, 100_000n);
  assert.equal(c.nextAt, ms("2026-10-06T04:00:00Z") / 1000);
  assert.deepEqual(c.degraded, []);
});

test("the recess: a body still saying 'market' at 12:00:30 HKT is forced CLOSED by the calendar", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-10-06T04:00:30Z"),
    assets: [tcent("market", "2026-10-06T04:00:29Z", "2026-10-06T04:00:00.000Z")],
    schedules: { XHKG },
  });
  assert.equal(c.regime, Regime.CLOSED);
  assert.equal(c.capUsd, 0n);
  assert.equal(c.disagreement, true);
  // The API's nextChangeAt is stale; the next boundary must come from the published schedule.
  assert.equal(c.nextAt, ms("2026-10-06T05:00:00Z") / 1000);
});

test("the pre-built close: evaluated exactly at 12:00:00 HKT with a pre-close body", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-10-06T04:00:00Z"),
    assets: [tcent("market", "2026-10-06T03:59:59Z", "2026-10-06T04:00:00.000Z")],
    schedules: { XHKG },
  });
  assert.equal(c.regime, Regime.CLOSED, "the close depends only on the schedule, so it can be built in advance");
  assert.equal(c.capUsd, 0n);
});

test("a stale body is never trusted: CLOSED, cap 0, flagged, next boundary from the schedule", () => {
  const evaluatedAt = ms("2026-10-06T03:00:00Z");
  const [c] = derive({
    evaluatedAtMs: evaluatedAt,
    assets: [{ ...tcent("market", "2026-10-06T03:00:00Z", "2026-10-06T04:00:00.000Z"), fetchedAtMs: evaluatedAt - LAST_KNOWN_GOOD_MS - 1 }],
    schedules: { XHKG },
  });
  assert.equal(c.regime, Regime.CLOSED);
  assert.equal(c.capUsd, 0n);
  assert.deepEqual(c.degraded, ["source-unavailable"]);
  assert.equal(c.nextAt, ms("2026-10-06T04:00:00Z") / 1000);
});

test("a missing body produces CLOSED, never UNKNOWN and never a skipped write", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-10-06T03:00:00Z"),
    assets: [{ wrapper: W_TCENT, symbol: "TCENTx", mic: "XHKG", body: null, fetchedAtMs: null }],
    schedules: { XHKG },
  });
  assert.equal(c.regime, Regime.CLOSED);
  assert.notEqual(c.regime, Regime.UNKNOWN);
});

test("US Sunday 20:00 ET: NVIDIA resolves OVERNIGHT with a $200,000 cap and no false close", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-09-14T00:00:30Z"),
    assets: [{ wrapper: W_NVDA, symbol: "NVDAx", mic: "XNAS", body: assetBody("overnight", "XNAS", "2026-09-14T08:00:00.000Z", US_CAPS), fetchedAtMs: ms("2026-09-14T00:00:29Z") }],
    schedules: { XNAS },
  });
  assert.equal(c.regime, Regime.OVERNIGHT);
  assert.equal(c.capUsd, 200_000n, "20,000,000 cents overnight cap = $200,000");
  assert.equal(c.disagreement, false);
});

// ---------------------------------------------------------------------------------------------
// Method versioning. Every round commits the method id that produced it, and a verifier must be able
// to re-derive old rounds exactly after the rules change.
// ---------------------------------------------------------------------------------------------

test("derive/1 is preserved exactly: raw issuer value, the unit the first live rounds wrote", () => {
  const input = {
    evaluatedAtMs: ms("2026-09-14T00:00:30Z"),
    assets: [{ wrapper: W_NVDA, symbol: "NVDAx", mic: "XNAS", body: assetBody("overnight", "XNAS", "2026-09-14T08:00:00.000Z", US_CAPS), fetchedAtMs: ms("2026-09-14T00:00:29Z") }],
    schedules: { XNAS },
  };
  assert.equal(derive(input, "curb.marketclock.derive/1")[0].capUsd, 20_000_000n);
  assert.equal(derive(input, "curb.marketclock.derive/2")[0].capUsd, 200_000n);
  assert.equal(derive(input)[0].capUsd, 200_000n, "the default is the current method");
});

test("derive/1 kept its old zero-cap rule: extended with cap 0 stayed EXTENDED", () => {
  const input = {
    evaluatedAtMs: ms("2026-10-06T01:15:00Z"),
    assets: [tcent("extended", "2026-10-06T01:14:59Z", "2026-10-06T01:30:00.000Z")],
    schedules: { XHKG },
  };
  assert.equal(derive(input, "curb.marketclock.derive/1")[0].regime, Regime.EXTENDED);
  assert.equal(derive(input, "curb.marketclock.derive/2")[0].regime, Regime.CLOSED);
});

test("derive/2 closes a positive cap that floors to $0, keeping cap 0 <=> CLOSED", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-10-06T03:00:00Z"),
    assets: [{ wrapper: W_TCENT, symbol: "TCENTx", mic: "XHKG", body: assetBody("market", "XHKG", null, { market: 99, extended: 0, overnight: 0, closed: 0 }), fetchedAtMs: ms("2026-10-06T02:59:59Z") }],
    schedules: { XHKG },
  });
  assert.equal(c.regime, Regime.CLOSED);
  assert.equal(c.capUsd, 0n);
  assert.ok(c.degraded.includes("cap-below-one-dollar"));
});

test("an unknown method id is refused rather than silently falling back", () => {
  assert.throws(() => derive({ evaluatedAtMs: 0, assets: [], schedules: {} }, "curb.marketclock.derive/9"), /unknown derivation method/);
});

test("a missing schedule is flagged but the asset body still resolves", () => {
  const [c] = derive({
    evaluatedAtMs: ms("2026-10-06T03:00:00Z"),
    assets: [tcent("market", "2026-10-06T02:59:58Z", "2026-10-06T04:00:00.000Z")],
    schedules: {},
    prior: priorOpen(ms("2026-10-06T02:59:55Z"), W_TCENT),
  });
  assert.equal(c.regime, Regime.MARKET);
  assert.deepEqual(c.degraded, ["schedule-unavailable"]);
});

test("deterministic: identical inputs in any order give byte-identical claims", () => {
  const a = tcent("market", "2026-10-06T02:59:58Z", "2026-10-06T04:00:00.000Z");
  const b: AssetInput = { wrapper: W_NVDA, symbol: "NVDAx", mic: "XNAS", body: assetBody("overnight", "XNAS", null, US_CAPS), fetchedAtMs: ms("2026-10-06T02:59:58Z") };
  const input1 = { evaluatedAtMs: ms("2026-10-06T03:00:00Z"), assets: [a, b], schedules: { XHKG, XNAS } };
  const input2 = { evaluatedAtMs: ms("2026-10-06T03:00:00Z"), assets: [b, a], schedules: { XNAS, XHKG } };
  const s = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  assert.equal(s(derive(input1)), s(derive(input2)));
});

test("attestBatch arguments carry the contract's exact positional types", () => {
  const claims = derive({
    evaluatedAtMs: ms("2026-10-06T04:00:30Z"),
    assets: [tcent("market", "2026-10-06T04:00:29Z", null)],
    schedules: { XHKG },
  });
  const root = "0x" + "ab".repeat(32);
  const [wrappers, regimes, caps, nextAt, halted, inputRoot] = toAttestBatchArgs(claims, root);
  assert.deepEqual(wrappers, [W_TCENT]);
  assert.deepEqual(regimes, [Regime.CLOSED]);
  assert.deepEqual(caps, [0n]);
  assert.equal(typeof nextAt[0], "bigint");
  assert.deepEqual(halted, [false]);
  assert.equal(inputRoot, root);
});

// ---------------------------------------------------------------------------------------------
// derive/3: the two rules added after six days of live evidence (DECISIONS D-9).
// ---------------------------------------------------------------------------------------------

const nvda = (period: string, fetchedAt: string, caps = US_CAPS): AssetInput =>
  ({ wrapper: W_NVDA, symbol: "NVDAx", mic: "XNAS", body: assetBody(period, "XNAS", null, caps), fetchedAtMs: ms(fetchedAt) });
const W_AAPL = "0x943BF64D4d7C4Cb9Af7B1d0eD0c1Cc4cCa2fDe8f";
const aapl = (period: string, fetchedAt: string, caps = US_CAPS): AssetInput =>
  ({ wrapper: W_AAPL, symbol: "AAPLx", mic: "XNAS", body: assetBody(period, "XNAS", null, caps), fetchedAtMs: ms(fetchedAt) });
const AT = ms("2026-09-17T13:25:05Z"); // the real incident: one CDN edge served the pair inconsistently

test("cohort coherence: a peer reporting the primary shut closes an asset whose object is still open", () => {
  // 17 Sep 2026: host A's edge served AAPLx closed and NVDAx extended 475ms apart, and wNVDAx was written
  // EXTENDED / $1,000,000 for ~20s after its cap had really gone to zero.
  const input = {
    evaluatedAtMs: AT,
    assets: [nvda("extended", "2026-09-17T13:25:04Z"), aapl("closed", "2026-09-17T13:25:04Z")],
    schedules: { XNAS },
    prior: priorOpen(AT - 5_000, W_NVDA, W_AAPL),
  };
  const v2 = derive(input, "curb.marketclock.derive/2");
  assert.equal(v2.find((c) => c.symbol === "NVDAx")!.regime, Regime.EXTENDED, "derive/2 wrote the stale object through");
  assert.equal(v2.find((c) => c.symbol === "NVDAx")!.capUsd, 1_000_000n);

  const v3 = derive(input);
  const n = v3.find((c) => c.symbol === "NVDAx")!;
  assert.equal(n.regime, Regime.CLOSED);
  assert.equal(n.capUsd, 0n);
  assert.ok(n.degraded.includes("venue-cohort-shut"));
  assert.match(n.reason, /COHORT-INCOHERENT XNAS/);
  assert.equal(v3.find((c) => c.symbol === "AAPLx")!.regime, Regime.CLOSED);
});

test("cohort coherence never fires on a peer that is shut for its own reasons (halt, or no body)", () => {
  const halted = { ...aapl("market", "2026-09-17T13:25:04Z"), body: enc({ symbol: "AAPLx", trading: { currency: "USD", tradingHoursMode: "TwentyFourFive", isTradingHalted: true, currentPeriod: "market", openNow: true, nextChangeAt: null, exchange: { mic: "XNAS", abbreviation: "XNAS", name: "XNAS", timezone: "America/New_York" }, limitsPerPeriod: { market: { minOrderFiatValue: 1000, maxOrderFiatValue: 100_000_000 } } } }) };
  const withHalt = derive({
    evaluatedAtMs: AT, assets: [nvda("market", "2026-09-17T13:25:04Z"), halted], schedules: { XNAS },
    prior: priorOpen(AT - 5_000, W_NVDA, W_AAPL),
  });
  assert.equal(withHalt.find((c) => c.symbol === "AAPLx")!.regime, Regime.CLOSED, "the halted asset is shut");
  assert.equal(withHalt.find((c) => c.symbol === "NVDAx")!.regime, Regime.MARKET, "its peer is untouched");

  const withBlind = derive({
    evaluatedAtMs: AT,
    assets: [nvda("market", "2026-09-17T13:25:04Z"), { ...aapl("market", "2026-09-17T13:25:04Z"), body: null, fetchedAtMs: null }],
    schedules: { XNAS }, prior: priorOpen(AT - 5_000, W_NVDA, W_AAPL),
  });
  assert.equal(withBlind.find((c) => c.symbol === "NVDAx")!.regime, Regime.MARKET, "an unreadable peer proves nothing");
});

test("cohort coherence is per venue AND hours mode: a Hong Kong close does not shut a US name", () => {
  const out = derive({
    evaluatedAtMs: ms("2026-10-06T04:00:30Z"),
    assets: [tcent("closed", "2026-10-06T04:00:29Z", null), nvda("market", "2026-10-06T04:00:29Z")],
    schedules: { XHKG, XNAS }, prior: priorOpen(ms("2026-10-06T04:00:25Z"), W_TCENT, W_NVDA),
  });
  assert.equal(out.find((c) => c.symbol === "TCENTx")!.regime, Regime.CLOSED);
  assert.equal(out.find((c) => c.symbol === "NVDAx")!.regime, Regime.MARKET);
});

test("confirm before open: a reopen waits one tick, then goes through", () => {
  const reopen = {
    evaluatedAtMs: ms("2026-10-06T05:00:02Z"),
    assets: [tcent("market", "2026-10-06T05:00:01Z", "2026-10-06T08:00:00.000Z")],
    schedules: { XHKG },
  };
  const held = deriveDetailed({ ...reopen, prior: priorShut(ms("2026-10-06T04:59:57Z"), W_TCENT) });
  assert.equal(held.claims[0].regime, Regime.CLOSED, "one stale cached body cannot reopen an asset");
  assert.equal(held.claims[0].capUsd, 0n);
  assert.ok(held.claims[0].degraded.includes("awaiting-reopen-confirmation"));
  // The observation carried forward is the RAW one, so the hold lasts exactly one tick.
  assert.equal(held.observed.claims[W_TCENT.toLowerCase()].regime, Regime.MARKET);

  const confirmed = derive({ ...reopen, evaluatedAtMs: ms("2026-10-06T05:00:07Z"), prior: held.observed });
  assert.equal(confirmed[0].regime, Regime.MARKET);
  assert.equal(confirmed[0].capUsd, 100_000n);
  assert.deepEqual(confirmed[0].degraded, []);
});

test("confirm before open never delays a CLOSE, and never holds an asset that was already open", () => {
  const closing = derive({
    evaluatedAtMs: ms("2026-10-06T03:55:02Z"),
    assets: [tcent("closed", "2026-10-06T03:55:01Z", null)],
    schedules: { XHKG }, prior: priorOpen(ms("2026-10-06T03:54:57Z"), W_TCENT),
  });
  assert.equal(closing[0].regime, Regime.CLOSED, "closing is immediate");
  assert.deepEqual(closing[0].degraded, []);
});

test("with no usable prior the round still opens, but says so: open-unconfirmed", () => {
  const input = {
    evaluatedAtMs: ms("2026-10-06T03:00:00Z"),
    assets: [tcent("market", "2026-10-06T02:59:58Z", "2026-10-06T04:00:00.000Z")],
    schedules: { XHKG },
  };
  assert.ok(derive({ ...input, prior: null })[0].degraded.includes("open-unconfirmed"), "fresh boot");
  const stale = priorOpen(ms("2026-10-06T03:00:00Z") - PRIOR_MAX_AGE_MS - 1, W_TCENT);
  assert.ok(derive({ ...input, prior: stale })[0].degraded.includes("open-unconfirmed"), "prior too old to confirm");
  const other = priorOpen(ms("2026-10-06T02:59:55Z"), W_NVDA);
  assert.ok(derive({ ...input, prior: other })[0].degraded.includes("open-unconfirmed"), "no entry for this wrapper");
  assert.equal(derive({ ...input, prior: null })[0].regime, Regime.MARKET);
});

test("derive/1 and derive/2 ignore the prior entirely, so old rounds re-derive unchanged", () => {
  const input = {
    evaluatedAtMs: ms("2026-10-06T05:00:02Z"),
    assets: [tcent("market", "2026-10-06T05:00:01Z", "2026-10-06T08:00:00.000Z")],
    schedules: { XHKG },
  };
  for (const m of ["curb.marketclock.derive/1", "curb.marketclock.derive/2"]) {
    const withShutPrior = derive({ ...input, prior: priorShut(ms("2026-10-06T04:59:57Z"), W_TCENT) }, m);
    const withoutPrior = derive({ ...input, prior: null }, m);
    assert.equal(withShutPrior[0].regime, Regime.MARKET, m);
    assert.deepEqual(withShutPrior[0].degraded, withoutPrior[0].degraded, m);
    assert.equal(withShutPrior[0].capUsd, withoutPrior[0].capUsd, m);
  }
});

// ---------------------------------------------------------------------------------------------
// derive/3 hardening, from the pre-deploy review: a cohort witness must be speaking for the VENUE,
// and must still be speaking for NOW.
// ---------------------------------------------------------------------------------------------

/** A body whose own label is still open but whose cap for that period is zero: a per-asset suspension. */
function suspended(wrapper: string, symbol: string, fetchedAt: string): AssetInput {
  return { wrapper, symbol, mic: "XHKG", body: enc({
    symbol,
    trading: {
      currency: "USD", tradingHoursMode: "Regular", isTradingHalted: false, currentPeriod: "market",
      openNow: true, nextChangeAt: "2026-10-06T04:00:00.000Z",
      exchange: { mic: "XHKG", abbreviation: "HKEX", name: "HKEX", timezone: "Asia/Hong_Kong" },
      limitsPerPeriod: { market: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 }, extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 }, overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 }, closed: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 } },
    },
  }), fetchedAtMs: ms(fetchedAt) };
}

test("a per-asset suspension (open label, zero cap) is NOT venue evidence: healthy peers stay open", () => {
  const W_SHEIN = "0xff637d2d5A0Ab1E4b3e5cC0B9Ff0bE9dD1E4b727";
  const at = ms("2026-10-06T03:00:00Z");
  const out = derive({
    evaluatedAtMs: at,
    assets: [suspended(W_SHEIN, "SHEINx", "2026-10-06T02:59:58Z"), tcent("market", "2026-10-06T02:59:58Z", "2026-10-06T04:00:00.000Z")],
    schedules: { XHKG },
    prior: priorOpen(at - 5_000, W_SHEIN, W_TCENT),
  });
  assert.equal(out.find((c) => c.symbol === "SHEINx")!.regime, Regime.CLOSED, "the suspended name is shut");
  const healthy = out.find((c) => c.symbol === "TCENTx")!;
  assert.equal(healthy.regime, Regime.MARKET, "its peers keep trading");
  assert.equal(healthy.capUsd, 100_000n);
  assert.deepEqual(healthy.degraded, []);
});

test("at a reopen, a cached body that has outlived its own nextChangeAt cannot close the cohort", () => {
  // 13:00 HKT reopen. One edge still serves `closed` with nextChangeAt = the reopen that has just passed.
  const at = ms("2026-10-06T05:00:20Z");
  const W_SHEIN = "0xff637d2d5A0Ab1E4b3e5cC0B9Ff0bE9dD1E4b727";
  const staleClosed: AssetInput = { wrapper: W_SHEIN, symbol: "SHEINx", mic: "XHKG",
    body: assetBody("closed", "XHKG", "2026-10-06T05:00:00.000Z", HK_CAPS), fetchedAtMs: at - 2_000 };
  const out = derive({
    evaluatedAtMs: at,
    assets: [staleClosed, tcent("market", "2026-10-06T05:00:18Z", "2026-10-06T08:00:00.000Z")],
    schedules: { XHKG },
    prior: priorOpen(at - 5_000, W_SHEIN, W_TCENT),
  });
  assert.equal(out.find((c) => c.symbol === "TCENTx")!.regime, Regime.MARKET, "the fresh object is not overruled by a stale one");
  assert.equal(out.find((c) => c.symbol === "SHEINx")!.regime, Regime.CLOSED, "the stale object still reports itself shut");
});

test("cohort coherence stands down for two minutes after a published session starts", () => {
  const at = ms("2026-10-06T05:00:30Z"); // 30s after the 13:00 HKT reopen
  const W_SHEIN = "0xff637d2d5A0Ab1E4b3e5cC0B9Ff0bE9dD1E4b727";
  // This witness has no nextChangeAt at all, so only the quiet window can protect the cohort.
  const staleNoNext: AssetInput = { wrapper: W_SHEIN, symbol: "SHEINx", mic: "XHKG",
    body: assetBody("closed", "XHKG", null, HK_CAPS), fetchedAtMs: at - 2_000 };
  const out = derive({
    evaluatedAtMs: at,
    assets: [staleNoNext, tcent("market", "2026-10-06T05:00:28Z", "2026-10-06T08:00:00.000Z")],
    schedules: { XHKG },
    prior: priorOpen(at - 5_000, W_SHEIN, W_TCENT),
  });
  assert.equal(out.find((c) => c.symbol === "TCENTx")!.regime, Regime.MARKET);

  // Well clear of any session start, the same shape DOES close the cohort: the rule still works.
  const later = ms("2026-10-06T06:00:00Z");
  const out2 = derive({
    evaluatedAtMs: later,
    assets: [{ ...staleNoNext, fetchedAtMs: later - 2_000 }, tcent("market", "2026-10-06T05:59:58Z", "2026-10-06T08:00:00.000Z")],
    schedules: { XHKG },
    prior: priorOpen(later - 5_000, W_SHEIN, W_TCENT),
  });
  assert.equal(out2.find((c) => c.symbol === "TCENTx")!.regime, Regime.CLOSED);
  assert.ok(out2.find((c) => c.symbol === "TCENTx")!.degraded.includes("venue-cohort-shut"));
});

test("a forced close restates the next boundary from the venue schedule, not the open period's value", () => {
  const at = ms("2026-10-06T05:00:02Z");
  const held = derive({
    evaluatedAtMs: at,
    assets: [tcent("market", "2026-10-06T05:00:01Z", "2026-10-06T08:00:00.000Z")],
    schedules: { XHKG },
    prior: priorShut(at - 5_000, W_TCENT),
  });
  assert.equal(held[0].regime, Regime.CLOSED);
  assert.equal(held[0].nextAt, ms("2026-10-06T08:00:00Z") / 1000, "next published boundary: the 16:00 HKT close");
});
