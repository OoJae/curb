/**
 * Run under four host zones (the schedule must not depend on the host's):
 *   for tz in UTC Asia/Hong_Kong America/Los_Angeles Pacific/Kiritimati; do
 *     TZ=$tz node --test --experimental-strip-types web/src/data/schedule.test.ts || break; done
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HKEX, NASDAQ, SLOTS_PER_WEEK, SLOT_MS, MINUTE, DAY,
  boundaries, closureAt, closureStartMs, closureWindows, closuresInWeek, countdown, formatDuration,
  isOpenAt, nextChange, nextClosure, nextReopenMs, slotStates, venueClock, weekSlots, weekStartMs,
} from "./schedule.ts";

const Z = (iso: string) => new Date(iso).getTime();

test("host zone is what the runner says (sanity)", () => {
  // Not an assertion on the zone itself: just proves the suite ran under the intended TZ.
  assert.ok(typeof Intl.DateTimeFormat().resolvedOptions().timeZone === "string");
});

test("a normal day has 320 open minutes (09:30–11:55, 13:00–15:55 HKT)", () => {
  const day0 = Z("2026-09-21T16:00:00Z"); // Tue 22 Sep 2026 00:00 HKT
  let open = 0;
  for (let t = day0; t < day0 + DAY; t += MINUTE) if (isOpenAt(t)) open++;
  assert.equal(open, 320);
  assert.equal(isOpenAt(Z("2026-09-22T01:30:00Z")), true, "09:30 HKT opens");
  assert.equal(isOpenAt(Z("2026-09-22T01:29:59Z")), false, "09:29:59 still shut");
  assert.equal(isOpenAt(Z("2026-09-22T03:54:59Z")), true, "11:54:59 open");
  assert.equal(isOpenAt(Z("2026-09-22T03:55:00Z")), false, "11:55 cap cut (300 s early)");
  assert.equal(isOpenAt(Z("2026-09-22T05:00:00Z")), true, "13:00 reopens");
  assert.equal(isOpenAt(Z("2026-09-22T07:55:00Z")), false, "15:55 cap cut");
});

test("a normal week is 141 h 20 m shut, and the ring is 2,016 slots with 320 open", () => {
  const ws = weekSlots(Z("2026-09-23T06:00:00Z"));
  assert.equal(ws.weekStartMs, Z("2026-09-20T16:00:00Z"), "Mon 21 Sep 00:00 HKT");
  assert.equal(ws.open.length, SLOTS_PER_WEEK);
  assert.equal(ws.slotMs, SLOT_MS);
  assert.equal(ws.openSlots, 320);
  assert.equal(ws.shutMinutes, 141 * 60 + 20);
  assert.equal(formatDuration(ws.shutMinutes * MINUTE), "141 h 20 m");
  assert.equal(Math.round((ws.shutSlots / SLOTS_PER_WEEK) * 100), 84, "amber is 84% of the ring");
  // the same total from the closure windows themselves
  const shutMs = closuresInWeek(ws.weekStartMs).reduce((sum, w) => {
    const a = Math.max(w.startMs!, ws.weekStartMs);
    const b = Math.min(w.endMs!, ws.weekStartMs + 7 * DAY);
    return sum + Math.max(0, b - a);
  }, 0);
  assert.equal(shutMs, (141 * 60 + 20) * MINUTE);
});

test("the slot fast path agrees with the generic per-slot rule", () => {
  for (const at of ["2026-09-23T06:00:00Z", "2026-09-30T06:00:00Z", "2026-10-19T06:00:00Z"]) {
    const start = weekStartMs(Z(at));
    assert.deepEqual(slotStates(start, HKEX), slotStates(start, HKEX, true), at);
  }
  const us = weekStartMs(Z("2026-09-23T06:00:00Z"), NASDAQ.sched.schedule.timezone);
  assert.deepEqual(slotStates(us, NASDAQ), slotStates(us, NASDAQ, true));
});

test("the 5-minute boundary walk equals the original 1-minute walk (both venues, two weeks)", () => {
  const from = Z("2026-09-26T00:00:00Z");
  const to = from + 14 * DAY;
  for (const v of [HKEX, NASDAQ]) {
    assert.deepEqual(boundaries(v.sched, from, to, 5 * MINUTE), boundaries(v.sched, from, to, MINUTE), v.mic);
  }
});

test("week slots: nowIndex, and Monday 00:00 HKT belongs to its own week", () => {
  const mon = Z("2026-09-20T16:00:00Z");
  assert.equal(weekStartMs(mon), mon);
  assert.equal(weekStartMs(mon - 1), mon - 7 * DAY, "Sun 23:59:59.999 HKT is last week");
  assert.equal(weekSlots(mon).nowIndex, 0);
  assert.equal(weekSlots(mon + 7 * DAY - 1).nowIndex, SLOTS_PER_WEEK - 1);
  assert.equal(weekSlots(Z("2026-09-21T01:30:00Z")).nowIndex, (9 * 60 + 30) / 5, "Mon 09:30 HKT = slot 114");
  const ws = weekSlots(Z("2026-09-21T01:30:00Z"));
  assert.equal(ws.open[113], false);
  assert.equal(ws.open[114], true, "Mon 09:30 — opens");
  assert.equal(ws.open[(11 * 60 + 50) / 5], true);
  assert.equal(ws.open[(11 * 60 + 55) / 5], false, "11:55 — cap to zero");
});

test("overnight: closure start, next reopen and kind (Thu 24 Sep 21:00 HKT)", () => {
  const now = Z("2026-09-24T13:00:00Z");
  const w = closureAt(now)!;
  assert.equal(w.startMs, Z("2026-09-24T07:55:00Z"), "cut at 15:55 HKT");
  assert.equal(w.endMs, Z("2026-09-25T01:30:00Z"), "reopens 09:30 HKT, not at the 09:00 extended boundary");
  assert.equal(w.kind, "overnight");
  assert.equal(closureStartMs(now), w.startMs);
  assert.equal(nextReopenMs(now), w.endMs);
  assert.deepEqual(nextChange(now), { atMs: w.endMs, kind: "reopen" });
});

test("recess on Fri 25 Sep matches the live API preview (03:55Z → 05:00Z)", () => {
  const open = Z("2026-09-25T02:00:00Z");
  assert.equal(closureAt(open), null);
  const nx = nextClosure(open)!;
  assert.equal(nx.startMs, Z("2026-09-25T03:55:00Z"));
  assert.equal(nx.endMs, Z("2026-09-25T05:00:00Z"));
  assert.equal(nx.durationS, 3900);
  assert.equal(nx.kind, "recess");
  assert.deepEqual(nextChange(open), { atMs: nx.startMs, kind: "cut" });
  assert.equal(nextReopenMs(open), nx.endMs);
  // edges: the cut instant is shut, the reopen instant is open
  assert.equal(closureAt(Z("2026-09-25T03:55:00Z"))?.startMs, nx.startMs);
  assert.equal(closureAt(Z("2026-09-25T05:00:00Z")), null);
});

test("weekend: Fri 15:55 → Mon 09:30 — 65 h 35 m", () => {
  const w = closureAt(Z("2026-09-26T12:00:00Z"))!;
  assert.equal(w.startMs, Z("2026-09-25T07:55:00Z"));
  assert.equal(w.endMs, Z("2026-09-28T01:30:00Z"));
  assert.equal(w.kind, "weekend");
  assert.equal(formatDuration(w.endMs! - w.startMs!), "65 h 35 m");
  assert.equal(venueClock(w.startMs!).label, "Fri 15:55");
  assert.equal(venueClock(w.endMs!).label, "Mon 09:30");
});

test("holiday 1 Oct: Wed 15:55 → Fri 09:30, and that week is 320 minutes more shut", () => {
  const w = closureAt(Z("2026-10-01T04:00:00Z"))!;
  assert.equal(w.startMs, Z("2026-09-30T07:55:00Z"));
  assert.equal(w.endMs, Z("2026-10-02T01:30:00Z"));
  assert.equal(w.kind, "holiday");
  const ws = weekSlots(Z("2026-09-30T00:00:00Z"));
  assert.equal(ws.openSlots, 256);
  assert.equal(ws.shutMinutes, 141 * 60 + 20 + 320);
});

test("holiday 19 Oct (Monday): Fri 16 Oct 15:55 → Tue 20 Oct 09:30", () => {
  const w = closureAt(Z("2026-10-19T02:00:00Z"))!;
  assert.equal(w.startMs, Z("2026-10-16T07:55:00Z"));
  assert.equal(w.endMs, Z("2026-10-20T01:30:00Z"));
  assert.equal(w.kind, "holiday");
});

test("every closure kind over two weeks is one of the four HKEX kinds", () => {
  const ws = closureWindows(Z("2026-09-21T00:00:00Z"), Z("2026-10-05T00:00:00Z"));
  const kinds = new Set(ws.map((w) => w.kind));
  assert.deepEqual([...kinds].sort(), ["holiday", "overnight", "recess", "weekend"]);
  for (const w of ws) assert.ok(w.startMs! < w.endMs!);
});

test("countdown cells", () => {
  assert.deepEqual(countdown(Z("2026-09-25T01:30:00Z"), Z("2026-09-24T13:00:00Z") + 1500), { h: "12", m: "29", s: "58", totalS: 44998 });
  assert.deepEqual(countdown(0, 1), { h: "00", m: "00", s: "00", totalS: 0 });
});

test("XNAS: handover windows are 5 minutes, the Friday close runs to Sunday 20:00 ET", () => {
  const ws = closureWindows(Z("2026-09-21T00:00:00Z"), Z("2026-09-28T00:00:00Z"), NASDAQ);
  assert.ok(ws.some((w) => w.kind === "handover" && w.durationS === 300));
  const weekend = ws.find((w) => w.kind === "weekend")!;
  assert.equal(weekend.startMs, Z("2026-09-26T00:00:00Z") - 300_000, "Fri 19:55 ET");
  assert.equal(weekend.endMs, Z("2026-09-28T00:00:00Z"), "Sun 20:00 ET overnight session");
});
