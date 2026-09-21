import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { boundaries, nextBoundaryAfter } from "./calendar.ts";
import type { ExchangeSchedule } from "./regime.ts";

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Both schedules exactly as published by GET /api/v2/public/exchanges/{MIC} on 13-14 Sep 2026.
const XHKG: ExchangeSchedule = {
  mic: "XHKG", timezone: "Asia/Hong_Kong", isOpen: false, currentSession: null, nextChangeAt: null,
  schedule: {
    timezone: "Asia/Hong_Kong",
    sessions: [
      { kind: "Extended", days: WEEK, open: "09:00", close: "09:30" },
      { kind: "Regular", days: WEEK, open: "09:30", close: "12:00" },
      { kind: "Regular", days: WEEK, open: "13:00", close: "16:00" },
      { kind: "Extended", days: WEEK, open: "16:00", close: "16:10" },
    ],
    holidays: [
      { startsAt: "2026-09-25T04:00:00.000Z", endsAt: "2026-09-25T16:00:00.000Z", kind: "Closed" },
      { startsAt: "2026-09-27T16:00:00.000Z", endsAt: "2026-09-28T16:00:00.000Z", kind: "Closed" },
      { startsAt: "2026-09-30T16:00:00.000Z", endsAt: "2026-10-01T16:00:00.000Z", kind: "Closed" },
      { startsAt: "2026-10-18T16:00:00.000Z", endsAt: "2026-10-19T16:00:00.000Z", kind: "Closed" },
    ],
  },
};

const XNAS: ExchangeSchedule = {
  mic: "XNAS", timezone: "America/New_York", isOpen: false, currentSession: null, nextChangeAt: null,
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

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => new Date(s).getTime();

test("finale day, 6 Oct 2026: HKEX boundaries in UTC, including the 12:00 recess", () => {
  const got = boundaries(XHKG, ms("2026-10-06T00:00:00Z"), ms("2026-10-06T09:00:00Z"))
    .map((b) => `${iso(b.t).slice(11, 16)} ${b.kind} ${b.from}->${b.to}`);
  assert.deepEqual(got, [
    "01:00 venue-open null->Extended",
    "01:30 session-change Extended->Regular",
    "04:00 venue-close Regular->null",
    "05:00 venue-open null->Regular",
    "08:00 session-change Regular->Extended",
    "08:10 venue-close Extended->null",
  ]);
});

test("the demo's close is found exactly: next boundary after 11:59:30 HKT is 12:00:00 HKT", () => {
  const b = nextBoundaryAfter(XHKG, ms("2026-10-06T03:59:30Z"));
  assert.ok(b);
  assert.equal(iso(b.t), "2026-10-06T04:00:00.000Z");
  assert.equal(b.kind, "venue-close");
});

test("25 Sep half-day holiday: morning trades, closes at 12:00 HKT, no afternoon reopen", () => {
  const got = boundaries(XHKG, ms("2026-09-25T00:00:00Z"), ms("2026-09-25T09:00:00Z"))
    .map((b) => `${iso(b.t).slice(11, 16)} ${b.kind}`);
  assert.deepEqual(got, ["01:00 venue-open", "01:30 session-change", "04:00 venue-close"]);
});

test("28 Sep full-day holiday produces no HKEX boundaries at all", () => {
  assert.deepEqual(boundaries(XHKG, ms("2026-09-27T23:00:00Z"), ms("2026-09-28T12:00:00Z")), []);
});

test("US week: overnight runs Sunday to Thursday, and Friday 20:00 ET is a real close", () => {
  // Fri 18 Sep 16:00 ET -> Mon 21 Sep 04:30 ET, in UTC.
  const got = boundaries(XNAS, ms("2026-09-18T20:00:00Z"), ms("2026-09-21T08:30:00Z"))
    .map((b) => `${iso(b.t).slice(0, 16)} ${b.kind} ${b.from}->${b.to}`);
  assert.deepEqual(got, [
    "2026-09-19T00:00 venue-close Extended->null",      // Fri 20:00 ET: no Friday overnight
    "2026-09-21T00:00 venue-open null->Overnight",      // Sun 20:00 ET
    "2026-09-21T08:00 session-change Overnight->Extended", // Mon 04:00 ET
  ]);
});

test("a weeknight 20:00 ET is a session change, never a close", () => {
  // Before the cross-midnight fix this looked like the venue shutting every night.
  const got = boundaries(XNAS, ms("2026-09-15T23:30:00Z"), ms("2026-09-16T00:30:00Z"));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "session-change");
  assert.equal(got[0].from, "Extended");
  assert.equal(got[0].to, "Overnight");
});

// A fingerprint of one full week of boundaries for both venues. The package test script runs this
// file under several TZ values; every run must produce this exact hash, which proves the calendar
// does not depend on the host's timezone.
test("golden week: identical boundaries on every host timezone", () => {
  const week = [
    ...boundaries(XHKG, ms("2026-09-20T00:00:00Z"), ms("2026-09-27T00:00:00Z")),
    ...boundaries(XNAS, ms("2026-09-20T00:00:00Z"), ms("2026-09-27T00:00:00Z")),
  ];
  const hash = createHash("sha256").update(JSON.stringify(week)).digest("hex");
  assert.equal(week.length, GOLDEN_COUNT, `boundary count changed; hash is now ${hash}`);
  assert.equal(hash, GOLDEN_SHA256);
});

// Verified identical under UTC, Asia/Hong_Kong, America/Los_Angeles, Pacific/Kiritimati and
// Africa/Lagos. Hand count: HKEX 4 normal days x 6 + 3 on the 25 Sep half-day = 27; XNAS Sunday's
// overnight open 1 + Mon-Thu 4 each (16) + Friday 4 = 21; total 48.
const GOLDEN_COUNT = 48;
const GOLDEN_SHA256 = "88df435bb08def9fe339ee1188fa686cff9519e808fe030d7f7f9d217638f7d5";
