import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCapReturnMs, capAt, periodAt } from "./reopen.ts";
import type { ExchangeSchedule } from "./regime.ts";

/** HKEX as the issuer publishes it: no session covers 12:00-13:00. */
const HKEX: ExchangeSchedule = {
  mic: "XHKG", timezone: "Asia/Hong_Kong", isOpen: false, currentSession: null, nextChangeAt: null,
  schedule: {
    timezone: "Asia/Hong_Kong",
    sessions: [
      { kind: "Extended", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:00", close: "09:30" },
      { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:30", close: "12:00" },
      { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "13:00", close: "16:00" },
      { kind: "Extended", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "16:00", close: "16:10" },
    ],
    holidays: [{ startsAt: "2026-10-01T00:00:00+08:00", endsAt: "2026-10-02T00:00:00+08:00", kind: "PublicHoliday" }],
  },
};

/** A Hong Kong name: primary capacity exists only in the Regular session. */
const HK_LIMITS = {
  market: { maxOrderFiatValue: 2_000_000 },
  extended: { maxOrderFiatValue: 0 },
  overnight: { maxOrderFiatValue: 0 },
  closed: { maxOrderFiatValue: 0 },
};

const hkt = (iso: string) => new Date(iso).getTime();

test("the extended session is not capacity, so 09:00 is not a reopen", () => {
  assert.equal(periodAt(HKEX, hkt("2026-09-22T09:10:00+08:00")), "extended");
  assert.equal(capAt(HK_LIMITS, HKEX, hkt("2026-09-22T09:10:00+08:00")), 0);
  assert.equal(capAt(HK_LIMITS, HKEX, hkt("2026-09-22T09:40:00+08:00")), 2_000_000);
});

test("the lunch cut reopens at 13:00, not at the 12:00 boundary", () => {
  // Capacity is cut at 11:55; the next boundary is 12:00, which is NOT the reopen.
  const r = nextCapReturnMs(HK_LIMITS, HKEX, hkt("2026-09-22T11:55:00+08:00"));
  assert.equal(new Date(r!).toISOString(), "2026-09-22T05:00:00.000Z"); // 13:00 HKT
});

test("the afternoon cut reopens the next morning at 09:30, spanning three boundaries", () => {
  const r = nextCapReturnMs(HK_LIMITS, HKEX, hkt("2026-09-22T15:55:00+08:00"));
  assert.equal(new Date(r!).toISOString(), "2026-09-23T01:30:00.000Z"); // Wed 09:30 HKT
});

test("a Friday close predicts Monday, skipping the weekend", () => {
  const r = nextCapReturnMs(HK_LIMITS, HKEX, hkt("2026-09-25T15:55:00+08:00"));
  assert.equal(new Date(r!).toISOString(), "2026-09-28T01:30:00.000Z"); // Mon 09:30 HKT
});

test("a holiday is skipped: 30 Sep's close reopens 2 Oct, not 1 Oct", () => {
  const r = nextCapReturnMs(HK_LIMITS, HKEX, hkt("2026-09-30T15:55:00+08:00"));
  assert.equal(new Date(r!).toISOString(), "2026-10-02T01:30:00.000Z");
});

test("an asset whose every period caps at zero has no reopen, rather than a guessed one", () => {
  const dead = { market: { maxOrderFiatValue: 0 }, extended: { maxOrderFiatValue: 0 }, closed: { maxOrderFiatValue: 0 } };
  assert.equal(nextCapReturnMs(dead, HKEX, hkt("2026-09-22T11:55:00+08:00")), null);
});

test("missing limits fail closed rather than reading as unlimited", () => {
  assert.equal(capAt(undefined, HKEX, hkt("2026-09-22T10:00:00+08:00")), 0);
  assert.equal(nextCapReturnMs(undefined, HKEX, hkt("2026-09-22T11:55:00+08:00")), null);
});

test("a US name with an overnight cap reopens at the overnight session", () => {
  const XNAS: ExchangeSchedule = {
    mic: "XNAS", timezone: "America/New_York", isOpen: false, currentSession: null, nextChangeAt: null,
    schedule: {
      timezone: "America/New_York",
      sessions: [
        { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:30", close: "16:00" },
        { kind: "Overnight", days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], open: "20:00", close: "04:00" },
      ],
      holidays: [],
    },
  };
  const us = { market: { maxOrderFiatValue: 20_000_000 }, overnight: { maxOrderFiatValue: 20_000_000 }, extended: { maxOrderFiatValue: 0 }, closed: { maxOrderFiatValue: 0 } };
  // 16:00 ET Tuesday: shut until the overnight session opens at 20:00 the same day.
  const r = nextCapReturnMs(us, XNAS, hkt("2026-09-22T16:00:00-04:00"));
  assert.equal(new Date(r!).toISOString(), "2026-09-23T00:00:00.000Z");
});

// --- the closure id, pinned against the deployed contract's own arithmetic -------------------
import { closureId } from "./main.ts";

test("closureId matches keccak256(abi.encode(wrapper, settleAfter, inputRoot)) in Solidity", () => {
  // Cross-check computed with `cast keccak $(cast abi-encode ...)`, i.e. by the compiler's own
  // encoder rather than by a second copy of this code. A drift here would make every settle target
  // a row that does not exist.
  assert.equal(
    closureId(
      "0x41333Df9E7639188BBfca5522dC4844398Af9f9E",
      1758513600,
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    ),
    "0x9375650bbb050ec828985933f044f36da83d04dec6d73342dfa8f208882c86d5",
  );
});
