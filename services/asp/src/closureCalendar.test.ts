import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCalendar, buildTimeline, closureWindows, effectiveCapAt, effectivePeriodAt, previewOf,
  TimelineCache, CALENDAR_SCHEMA, CALENDAR_METHOD,
} from "./closureCalendar.ts";
import type { CalendarInput } from "./closureCalendar.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { ExchangeSchedule } from "./regime.ts";
import type { PeriodLimits } from "./reopen.ts";

/**
 * Real issuer bodies from the attestor's committed round at block 70619137 (14 Sep 2026). The XHKG
 * holiday list is the one the issuer published after its 18 Sep correction (DECISIONS D-4): 1 Oct and
 * 19 Oct, no September closures.
 */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const XHKG: ExchangeSchedule = fixture("xhkg.exchange.json");
const XNAS: ExchangeSchedule = fixture("xnas.exchange.json");
const TCENT: PeriodLimits = fixture("tcentx.asset.json").trading.limitsPerPeriod;
const NVDA: PeriodLimits = fixture("nvdax.asset.json").trading.limitsPerPeriod;

const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function calendar(limits: PeriodLimits, sched: ExchangeSchedule, nowIso: string, horizonDays = 7, extra: Partial<CalendarInput["venue"]> = {}) {
  const nowMs = at(nowIso);
  return buildCalendar({
    symbol: "wTEST", wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E",
    venue: {
      mic: sched.mic, limits, sched, atMs: nowMs, reportedPeriod: null, halted: false,
      assetUrl: "https://issuer/asset", assetBodyHash: "0x01", exchangeUrl: "https://issuer/exchange", exchangeBodyHash: "0x02",
      ...extra,
    },
    timeline: buildTimeline(limits, sched, "k", nowMs),
    nowMs, horizonDays,
  });
}

test("the fixtures are what the tests claim: wTCENTx caps only the market period, at $100,000", () => {
  assert.equal(TCENT.market.maxOrderFiatValue, 10_000_000);
  assert.equal(TCENT.extended.maxOrderFiatValue, 0);
  assert.equal(XHKG.schedule.timezone, "Asia/Hong_Kong");
});

test("mid-morning HKT: open, and the next closure is the 11:55 cut that reopens at 13:00, not 12:00", () => {
  const c = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00");
  assert.equal(c.schema, CALENDAR_SCHEMA);
  assert.equal(c.method, CALENDAR_METHOD);
  assert.equal(c.marketOpen, true);
  assert.equal(c.nowPeriod, "market");
  assert.equal(c.nowCapFiat, 100_000, "10,000,000 issuer cents = $100,000");
  assert.equal(c.timezone, "Asia/Hong_Kong");
  assert.deepEqual(c.nextClosure, {
    startMs: at("2026-09-22T11:55:00+08:00"), endMs: at("2026-09-22T13:00:00+08:00"), durationS: 3900,
    startIso: "2026-09-22T03:55:00.000Z", endIso: "2026-09-22T05:00:00.000Z", kind: "recess",
  });
  // The afternoon cut: 15:55 -> 16:00 extended (zero cap) -> 16:10 shut -> 09:00 extended -> 09:30.
  assert.equal(c.windows[1].startIso, "2026-09-22T07:55:00.000Z");
  assert.equal(c.windows[1].endIso, "2026-09-23T01:30:00.000Z", "Wed 09:30 HKT, three boundaries later");
  assert.equal(c.windows[1].kind, "overnight");
});

test("inside the 11:55-12:00 early cut the schedule still says Regular, but capacity is already off", () => {
  const c = calendar(TCENT, XHKG, "2026-09-22T11:57:00+08:00");
  assert.equal(c.marketOpen, false);
  assert.equal(c.nowPeriod, "closed");
  assert.equal(c.nowCapFiat, 0);
  assert.equal(c.windows[0].startIso, "2026-09-22T03:55:00.000Z", "the closure in progress is reported first");
  assert.equal(c.windows[0].endIso, "2026-09-22T05:00:00.000Z");
  assert.equal(c.nextClosure!.startIso, "2026-09-22T07:55:00.000Z", "nextClosure is the one AFTER the current window");
});

test("during the lunch recess the reopen is 13:00", () => {
  const c = calendar(TCENT, XHKG, "2026-09-22T12:30:00+08:00");
  assert.equal(c.marketOpen, false);
  assert.equal(c.nowPeriod, "closed");
  assert.equal(c.windows[0].endIso, "2026-09-22T05:00:00.000Z");
  // And the reopen agrees with the keeper's own rule, from the cut.
  assert.equal(nextCapReturnMs(TCENT, XHKG, at("2026-09-22T11:55:00+08:00")), at("2026-09-22T13:00:00+08:00"));
});

test("the zero-cap extended session reads `extended` until its own early cut at 16:05", () => {
  const a = calendar(TCENT, XHKG, "2026-09-22T16:02:00+08:00");
  assert.equal(a.nowPeriod, "extended");
  assert.equal(a.marketOpen, false, "extended carries no capacity for a Hong Kong name");
  assert.equal(a.windows[0].startIso, "2026-09-22T07:55:00.000Z");
  const b = calendar(TCENT, XHKG, "2026-09-22T16:06:00+08:00");
  assert.equal(b.nowPeriod, "closed", "D-4: extended -> closed at 16:05 HKT, five minutes before 16:10");
});

test("the horizon bounds when a window STARTS; one day from 10:00 holds just the two Tuesday cuts", () => {
  const c = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00", 1);
  assert.deepEqual(c.windows.map((w) => w.kind), ["recess", "overnight"]);
  const week = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00", 7);
  // Tue..Fri two a day, then Monday 28 Sep's two (the weekend one is Friday's afternoon cut).
  assert.equal(week.windows.length, 10);
  assert.ok(week.windows.every((w, i) => i === 0 || w.startMs! > week.windows[i - 1].startMs!));
});

test("a Friday afternoon cut is a weekend closure that reopens Monday 09:30", () => {
  const c = calendar(TCENT, XHKG, "2026-09-25T15:00:00+08:00", 1);
  assert.equal(c.nextClosure!.startIso, "2026-09-25T07:55:00.000Z");
  assert.equal(c.nextClosure!.endIso, "2026-09-28T01:30:00.000Z");
  assert.equal(c.nextClosure!.kind, "weekend");
});

test("a published holiday is skipped and labelled: 30 Sep's cut reopens 2 Oct", () => {
  const c = calendar(TCENT, XHKG, "2026-09-30T15:00:00+08:00", 1);
  assert.equal(c.nextClosure!.endIso, "2026-10-02T01:30:00.000Z");
  assert.equal(c.nextClosure!.kind, "holiday");
});

test("a US name with overnight and extended caps shows five-minute handovers, and a weekend", () => {
  const tue = calendar(NVDA, XNAS, "2026-09-22T10:00:00-04:00", 1);
  assert.deepEqual(tue.nextClosure, {
    startMs: at("2026-09-22T15:55:00-04:00"), endMs: at("2026-09-22T16:00:00-04:00"), durationS: 300,
    startIso: "2026-09-22T19:55:00.000Z", endIso: "2026-09-22T20:00:00.000Z", kind: "handover",
  });
  assert.equal(tue.nowCapFiat, 1_000_000);
  const fri = calendar(NVDA, XNAS, "2026-09-25T19:00:00-04:00", 1);
  assert.equal(fri.nextClosure!.startIso, "2026-09-25T23:55:00.000Z", "Fri 19:55 ET: extended ends, no Friday overnight");
  assert.equal(fri.nextClosure!.endIso, "2026-09-28T00:00:00.000Z", "Sun 20:00 ET");
  assert.equal(fri.nextClosure!.kind, "weekend");
});

test("marketOpen and the windows never disagree: sampled every 5 minutes across a week, both venues", () => {
  for (const [limits, sched, start] of [
    [TCENT, XHKG, at("2026-09-21T00:00:00+08:00")],
    [NVDA, XNAS, at("2026-09-21T00:00:00-04:00")],
  ] as const) {
    const tl = buildTimeline(limits, sched, "k", start);
    for (let t = start; t < start + 7 * 86_400_000; t += 300_000) {
      const shut = effectiveCapAt(limits, sched, t) === 0;
      const inside = tl.windows.some((w) => w.startMs! <= t && (w.endMs === null || t < w.endMs));
      assert.equal(inside, shut, `${sched.mic} at ${iso(t)}: effective cap ${shut ? "zero" : "open"} but windows say ${inside}`);
    }
  }
});

test("every window's end is exactly the keeper's reopen rule applied to its cut, including past the list's end", () => {
  // closureWindows answers reopens from its own boundary list and falls back to nextCapReturnMs near the
  // end of the span; both paths must give the keeper's instant, or a calendar would contradict a row.
  // The 11:56:30 start makes the first boundary land inside the early cut of the list's first cut.
  for (const [limits, sched, from] of [
    [TCENT, XHKG, at("2026-09-21T00:00:00Z")],
    [TCENT, XHKG, at("2026-09-22T11:56:30+08:00")],
    [NVDA, XNAS, at("2026-09-21T00:00:00Z")],
    [NVDA, XNAS, at("2026-11-20T00:00:00Z")],   // spans the published Thanksgiving closures
  ] as const) {
    const ws = closureWindows(limits, sched, from, from + 14 * 86_400_000);
    assert.ok(ws.length > 10);
    for (const w of ws) assert.equal(w.endMs, nextCapReturnMs(limits, sched, w.startMs!), `${sched.mic} cut ${w.startIso}`);
  }
});

test("an asset whose every period caps at zero has no windows and says why, rather than guessing", () => {
  const dead = { market: { maxOrderFiatValue: 0 }, extended: { maxOrderFiatValue: 0 }, closed: { maxOrderFiatValue: 0 } };
  const c = calendar(dead, XHKG, "2026-09-22T10:00:00+08:00");
  assert.equal(c.marketOpen, false);
  assert.equal(c.windows.length, 0);
  assert.equal(c.nextClosure, null);
  assert.ok(c.warnings.some((w) => w.includes("non-zero cap")));
});

test("a halted asset is not open, whatever the schedule says, and the halt is disclosed", () => {
  const c = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00", 7, { halted: true });
  assert.equal(c.marketOpen, false);
  assert.ok(c.warnings.some((w) => w.includes("halted")));
});

test("the issuer's own period is cross-checked against the schedule at fetch time", () => {
  const agree = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00", 7, { reportedPeriod: "market" });
  assert.ok(!agree.warnings.some((w) => w.includes("reported period")));
  const disagree = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00", 7, { reportedPeriod: "closed" });
  assert.ok(disagree.warnings.some((w) => w.includes("reported period")));
});

test("a horizon past the issuer's last published holiday is disclosed", () => {
  const c = calendar(TCENT, XHKG, "2026-10-15T10:00:00+08:00", 14);
  assert.ok(c.warnings.some((w) => w.includes("holiday list")));
  const near = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00", 7);
  assert.ok(!near.warnings.some((w) => w.includes("holiday list")));
});

test("the preview carries only symbol, mic, marketOpen, nowPeriod and nextClosure", () => {
  const c = calendar(TCENT, XHKG, "2026-09-22T10:00:00+08:00");
  const p = previewOf(c);
  assert.deepEqual(Object.keys(p).sort(), ["marketOpen", "mic", "nextClosure", "nowPeriod", "schema", "symbol"]);
  assert.deepEqual(p.nextClosure, c.nextClosure);
});

test("the timeline cache reuses a build for the same inputs and rebuilds when they change or it ages out", () => {
  const cache = new TimelineCache();
  const v = { limits: TCENT, sched: XHKG, inputsKey: "a" };
  const t0 = at("2026-09-22T10:00:00+08:00");
  const first = cache.get("w", v, t0);
  assert.equal(cache.get("w", v, t0 + 3_600_000), first);
  assert.notEqual(cache.get("w", { ...v, inputsKey: "b" }, t0 + 3_600_000), first);
  const b = cache.get("w", { ...v, inputsKey: "b" }, t0 + 3_600_000);
  assert.notEqual(cache.get("w", { ...v, inputsKey: "b" }, t0 + 3 * 86_400_000), b);
});

test("effectivePeriodAt is host-timezone independent at the edges it cares about", () => {
  assert.equal(effectivePeriodAt(XHKG, at("2026-09-22T11:54:59+08:00")), "market");
  assert.equal(effectivePeriodAt(XHKG, at("2026-09-22T11:55:00+08:00")), "closed");
  assert.equal(effectivePeriodAt(XHKG, at("2026-09-22T13:00:00+08:00")), "market");
  assert.equal(effectivePeriodAt(XHKG, at("2026-09-27T10:00:00+08:00")), "closed", "Sunday");
});
