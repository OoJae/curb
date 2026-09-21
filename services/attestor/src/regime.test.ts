import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, applicableCap, inPublishedSession, Regime } from "./regime.ts";
import type { TradingObject, ExchangeSchedule } from "./regime.ts";

// HKEX's real published schedule. Note the hole between 12:00 and 13:00 -- there is no
// session covering the lunch recess, which is the event the whole demo is staged on.
const XHKG: ExchangeSchedule = {
  mic: "XHKG", timezone: "Asia/Hong_Kong", isOpen: false, currentSession: null,
  nextChangeAt: null,
  schedule: {
    timezone: "Asia/Hong_Kong",
    sessions: [
      { kind: "Extended", days: ["Monday","Tuesday","Wednesday","Thursday","Friday"], open: "09:00", close: "09:30" },
      { kind: "Regular",  days: ["Monday","Tuesday","Wednesday","Thursday","Friday"], open: "09:30", close: "12:00" },
      { kind: "Regular",  days: ["Monday","Tuesday","Wednesday","Thursday","Friday"], open: "13:00", close: "16:00" },
      { kind: "Extended", days: ["Monday","Tuesday","Wednesday","Thursday","Friday"], open: "16:00", close: "16:10" },
    ],
    holidays: [
      { startsAt: "2026-09-25T04:00:00.000Z", endsAt: "2026-09-25T16:00:00.000Z", kind: "Closed" },
      { startsAt: "2026-09-30T16:00:00.000Z", endsAt: "2026-10-01T16:00:00.000Z", kind: "Closed" },
      { startsAt: "2026-10-18T16:00:00.000Z", endsAt: "2026-10-19T16:00:00.000Z", kind: "Closed" },
    ],
  },
};

const hk = (period: TradingObject["currentPeriod"], capMarket = 100_000_000): TradingObject => ({
  currency: "USD", tradingHoursMode: "Regular", isTradingHalted: false,
  currentPeriod: period, openNow: period === "market", nextChangeAt: null,
  exchange: { mic: "XHKG", abbreviation: "HKEX", name: "HKEX", timezone: "Asia/Hong_Kong" },
  limitsPerPeriod: {
    market:    { minOrderFiatValue: 1000, maxOrderFiatValue: capMarket },
    extended:  { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
    overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
    closed:    { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
  },
});

test("closed period caps primary at zero", () => {
  assert.equal(applicableCap(hk("closed")), 0);
  const r = resolve(hk("closed"), null, new Date("2026-09-12T08:00:00Z"));
  assert.equal(r.regime, Regime.CLOSED);
  assert.equal(r.primaryCapRaw, 0);
});

test("a missing period fails closed rather than reading as unlimited", () => {
  assert.equal(applicableCap(hk(null)), 0);
  assert.equal(resolve(hk(null), null).regime, Regime.UNKNOWN);
});

test("HKEX lunch recess is a gap in the published schedule, not a flag", () => {
  // Tue 6 Oct 2026 -- finale day. 03:00Z = 11:00 HKT, mid-morning session.
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T03:00:00Z")), true);
  // 04:30Z = 12:30 HKT -- inside the recess, and inside the finale window.
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T04:30:00Z")), false);
  // 05:30Z = 13:30 HKT -- reopened.
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T05:30:00Z")), true);
});

test("6 October is not a published holiday, so the finale lands on a trading day", () => {
  const inHoliday = XHKG.schedule.holidays.some(
    (h) => new Date("2026-10-06T04:00:00Z") >= new Date(h.startsAt)
        && new Date("2026-10-06T04:00:00Z") < new Date(h.endsAt),
  );
  assert.equal(inHoliday, false);
});

test("zero-cap EXTENDED is CLOSED: HKEX 09:15 HKT pre-open, issuer says extended with cap 0", () => {
  // Regression from the first-round adversarial verification: this used to write EXTENDED with
  // cap 0, so a consumer checking `regime != CLOSED` would think issuance was open.
  const r = resolve(hk("extended"), XHKG, new Date("2026-10-06T01:15:00Z"));
  assert.equal(r.regime, Regime.CLOSED);
  assert.equal(r.primaryCapRaw, 0);
  // Disagreement compares labels: the issuer label (extended) agrees with the venue (Extended
  // session), so zero capacity alone must not raise a disagreement every morning.
  assert.equal(r.disagreement, false);
});

test("zero-cap OVERNIGHT is CLOSED too", () => {
  const t: TradingObject = { ...hk("overnight"), limitsPerPeriod: { overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 } } };
  assert.equal(resolve(t, null, new Date("2026-10-06T01:15:00Z")).regime, Regime.CLOSED);
});

test("a non-zero cap keeps the label regime", () => {
  const t: TradingObject = { ...hk("extended"), limitsPerPeriod: { extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 100_000_000 } } };
  const r = resolve(t, null, new Date("2026-10-06T01:15:00Z"));
  assert.equal(r.regime, Regime.EXTENDED);
  assert.equal(r.primaryCapRaw, 100_000_000);
});

test("the economic definition overrides the label: market with a zero cap is closed", () => {
  const t = hk("market", 0); // issuer still says 'market' but has capped primary at zero
  const r = resolve(t, null, new Date("2026-10-06T03:00:00Z"));
  assert.equal(r.regime, Regime.CLOSED, "no primary capacity means no arbitrage, so it is closed");
});

test("venue calendar wins when the asset disagrees, and the disagreement is surfaced", () => {
  // Asset claims open during the recess; the venue's own schedule says otherwise.
  const r = resolve(hk("market"), XHKG, new Date("2026-10-06T04:30:00Z"));
  assert.equal(r.regime, Regime.CLOSED);
  assert.equal(r.disagreement, true);
  assert.match(r.reason, /DISAGREEMENT/);
});

test("a halt closes the asset regardless of session", () => {
  const t = { ...hk("market"), isTradingHalted: true };
  assert.equal(resolve(t, XHKG, new Date("2026-10-06T03:00:00Z")).regime, Regime.CLOSED);
});

test("holiday closure is respected", () => {
  assert.equal(inPublishedSession(XHKG, new Date("2026-09-25T06:00:00Z")), false);
});

// ---------------------------------------------------------------------------------------------
// Regressions found by the W1 red team. Each of these returned the wrong answer on a UTC host
// before inPublishedSession stopped converting time zones twice. The package test script runs
// this whole file under several TZ values, so any host-timezone dependence fails CI.
// ---------------------------------------------------------------------------------------------

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// XNAS as published live: the overnight session crosses midnight and is listed by opening day.
const XNAS: ExchangeSchedule = {
  mic: "XNAS", timezone: "America/New_York", isOpen: false, currentSession: null,
  nextChangeAt: null,
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
};

test("HKEX extended close session at 16:05 HKT on a Friday is open", () => {
  assert.equal(inPublishedSession(XHKG, new Date("2026-09-18T08:05:00Z")), true);
});

test("HKEX regular session at 15:59 HKT on a Friday is open", () => {
  assert.equal(inPublishedSession(XHKG, new Date("2026-09-18T07:59:00Z")), true);
});

test("HKEX is shut on a Sunday afternoon", () => {
  // The double-conversion bug reported this as open on a UTC host.
  assert.equal(inPublishedSession(XHKG, new Date("2026-09-13T08:05:00Z")), false);
});

test("the 12:00 recess starts exactly on the minute and ends exactly on 13:00", () => {
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T03:59:59Z")), true);
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T04:00:00Z")), false);
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T04:59:59Z")), false);
  assert.equal(inPublishedSession(XHKG, new Date("2026-10-06T05:00:00Z")), true);
});

test("25 Sep half-day: the morning trades, the market shuts from 12:00 HKT", () => {
  assert.equal(inPublishedSession(XHKG, new Date("2026-09-25T03:59:00Z")), true);
  assert.equal(inPublishedSession(XHKG, new Date("2026-09-25T05:30:00Z")), false);
});

test("US overnight session crosses midnight: Sunday 20:00 ET is open", () => {
  assert.equal(inPublishedSession(XNAS, new Date("2026-09-14T00:00:30Z")), true);
});

test("US overnight session crosses midnight: Monday 03:59 ET is still Sunday's session", () => {
  assert.equal(inPublishedSession(XNAS, new Date("2026-09-14T07:59:00Z")), true);
});

test("US overnight session: Thursday 23:59 ET is open", () => {
  assert.equal(inPublishedSession(XNAS, new Date("2026-09-18T03:59:00Z")), true);
});

test("US overnight session does not run on Friday night", () => {
  // Friday 20:00 ET. Overnight is listed Sunday-Thursday only.
  assert.equal(inPublishedSession(XNAS, new Date("2026-09-19T00:00:30Z")), false);
});

test("US overnight body resolves OVERNIGHT with no false disagreement", () => {
  // Before the fix this forced wNVDAx and wAAPLx to CLOSED every weeknight at 20:00 ET.
  const body: TradingObject = {
    currency: "USD", tradingHoursMode: "TwentyFourFive", isTradingHalted: false,
    currentPeriod: "overnight", openNow: true, nextChangeAt: "2026-09-14T08:00:00.000Z",
    exchange: { mic: "XNAS", abbreviation: "NASDAQ", name: "Nasdaq", timezone: "America/New_York" },
    limitsPerPeriod: {
      market: { minOrderFiatValue: 1000, maxOrderFiatValue: 100_000_000 },
      extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 100_000_000 },
      overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 20_000_000 },
      closed: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
    },
  };
  const r = resolve(body, XNAS, new Date("2026-09-14T00:00:30Z"));
  assert.equal(r.regime, Regime.OVERNIGHT);
  assert.equal(r.disagreement, false);
  assert.equal(r.primaryCapRaw, 20_000_000);
});

test("a stale overnight body on Friday night is forced closed by the venue calendar", () => {
  const body: TradingObject = {
    currency: "USD", tradingHoursMode: "TwentyFourFive", isTradingHalted: false,
    currentPeriod: "overnight", openNow: true, nextChangeAt: null, exchange: null,
    limitsPerPeriod: { overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 20_000_000 } },
  };
  const r = resolve(body, XNAS, new Date("2026-09-19T00:00:30Z"));
  assert.equal(r.regime, Regime.CLOSED);
  assert.equal(r.primaryCapRaw, 0);
  assert.equal(r.disagreement, true);
});
