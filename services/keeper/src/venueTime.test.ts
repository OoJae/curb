import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ISSUER_EARLY_CUT_MS, RETRACTION_MARGIN_MS, applyRecut, checkCut, closureSchedule, closureVenue, expectedCapAt, foldHolidays,
  holidayKey, venueEvidenceFor,
} from "./venueTime.ts";
import type { CutCheck, HolidayEntry, HolidayLedger, RecutClosure, VenueRead } from "./venueTime.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { ExchangeSchedule } from "./regime.ts";
import type { VenueEvidence } from "./markRound.ts";
import { LeafKind, loadTree, subjectOf } from "./tree.ts";
import type { Leaf } from "./tree.ts";

// The archived bundles (fixtures/marks): the 2 Oct and 20 Oct XHKG holiday rows, the 9 Nov XNAS weekend row and
// the 13 Nov XHKG recess row (wXIAOx).
const HOLIDAY_2OCT = "0x3dafc1b6355ef8bfacc33bbc0563489b65530afc2474a8b78fd9d560c7ff18ed";
const HOLIDAY_20OCT = "0x4db753ad7eb06acf7ba22d0b4fe2ded09ab39eda8803b6cc6ba811b6e4a36ad5";
const US_9NOV = "0xa5e1ff04a41bb46293fa07b6d62a386a86a5cb0da3378f6d34c0a6d968652efd";
const HK_RECESS = "0x06a92e8238992e4d2ed25fac5b4a6ac243e6bbadc8dd99cced80fbe16ca71b75";

function bundleOf(root: string) {
  const b = JSON.parse(readFileSync(new URL(`./fixtures/marks/${root}.json`, import.meta.url), "utf8"));
  const leaves = [...loadTree(b.tree).entries()].map(([, v]: [number, Leaf]) => v);
  const leaf = (kind: number, subject?: string) => {
    const l = leaves.find(([k, s]) => Number(k) === kind && (subject === undefined || s === subject));
    return l ? JSON.parse(b.json[l[2]]) : null;
  };
  const claim = leaf(LeafKind.CLAIM);
  const venue = leaf(LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${claim.wrapper.toLowerCase()}`)) as VenueEvidence;
  const params = leaf(LeafKind.PARAMS, subjectOf("params"));
  return { claim, venue, params };
}

const T = (s: string) => Date.parse(s);
const S = (v: VenueEvidence, holidays?: ExchangeSchedule["schedule"]["holidays"]): ExchangeSchedule =>
  ({ mic: v.mic, schedule: { ...v.schedule, holidays: holidays ?? v.schedule.holidays } }) as ExchangeSchedule;
/** The venue a keeper holds, rebuilt from a committed venue leaf. */
const venueRead = (v: VenueEvidence, atMs: number, holidays?: ExchangeSchedule["schedule"]["holidays"]): VenueRead => ({
  mic: v.mic, assetUrl: v.assetUrl, assetBodyHash: v.assetBodyHash, exchangeUrl: v.exchangeUrl, exchangeBodyHash: v.exchangeBodyHash,
  limits: v.limitsPerPeriod, sched: { ...S(v, holidays), timezone: v.schedule.timezone, isOpen: false, currentSession: null, nextChangeAt: null }, atMs,
});
const walk = (v: VenueEvidence, sched: ExchangeSchedule["schedule"], fromMs: number) =>
  nextCapReturnMs(v.limitsPerPeriod, { mic: v.mic, schedule: sched } as ExchangeSchedule, fromMs);

const HK_1OCT = { startsAt: "2026-09-30T16:00:00.000Z", endsAt: "2026-10-01T16:00:00.000Z", kind: "Closed" };
const HK_19OCT = { startsAt: "2026-10-18T16:00:00.000Z", endsAt: "2026-10-19T16:00:00.000Z", kind: "Closed" };
const US_26NOV = { startsAt: "2026-11-26T01:00:00.000Z", endsAt: "2026-11-27T01:00:00.000Z", kind: "Closed" };
const US_27NOV = { startsAt: "2026-11-27T18:00:00.000Z", endsAt: "2026-11-28T01:00:00.000Z", kind: "Closed" };

test("a pruned holiday is kept, and the 2 Oct row re-derives from its cut", () => {
  const { venue: v, claim } = bundleOf(HOLIDAY_2OCT);
  assert.ok(!v.schedule.holidays.some((h) => holidayKey(h) === holidayKey(HK_1OCT)), "the committed list had already pruned 1 Oct");
  let ledger = foldHolidays(undefined, [...v.schedule.holidays, HK_1OCT], T("2026-09-30T04:50:26Z"));
  ledger = foldHolidays(ledger, v.schedule.holidays, T("2026-10-01T17:00:00Z"));
  const e = ledger.entries.find((x) => holidayKey(x) === holidayKey(HK_1OCT))!;
  assert.ok(e, "kept");
  assert.equal(e.lastSeenMs, T("2026-09-30T04:50:26Z"));
  const { schedule, kept } = closureSchedule(v.schedule, ledger);
  assert.deepEqual(kept.map(holidayKey), [holidayKey(HK_1OCT)]);
  assert.equal(v.cutAtMs, 1790754931673);
  assert.equal(walk(v, schedule, 1790754931673), 1790904600000);
  assert.equal(claim.settleAfterS * 1000, 1790904600000);
  assert.equal(walk(v, v.schedule, 1790754931673), T("2026-10-01T01:30:00Z"), "without the ledger the walk stops on 1 Oct");
});

test("the 20 Oct row likewise", () => {
  const { venue: v, claim } = bundleOf(HOLIDAY_20OCT);
  let ledger = foldHolidays(undefined, [...v.schedule.holidays, HK_19OCT], T("2026-10-16T04:50:00Z"));
  ledger = foldHolidays(ledger, v.schedule.holidays, T("2026-10-19T17:00:00Z"));
  assert.equal(v.cutAtMs, 1792137337142);
  assert.equal(walk(v, closureSchedule(v.schedule, ledger).schedule, 1792137337142), 1792459800000);
  assert.equal(claim.settleAfterS * 1000, 1792459800000);
});

test("a correction is dropped", () => {
  const h = { startsAt: "2026-09-27T16:00:00.000Z", endsAt: "2026-09-28T16:00:00.000Z", kind: "Closed" };
  let ledger = foldHolidays(undefined, [h], T("2026-09-18T06:00:00Z"));
  assert.equal(ledger.entries.length, 1);
  ledger = foldHolidays(ledger, [], T("2026-09-18T08:00:00Z"));
  assert.deepEqual(ledger.entries, []);
  assert.equal(ledger.initializedAtMs, T("2026-09-18T06:00:00Z"));
});

test("an entry pruned less than 24 h before its start is kept", () => {
  const start = T("2026-09-27T16:00:00Z");
  const h = { startsAt: "2026-09-27T16:00:00.000Z", endsAt: "2026-09-28T16:00:00.000Z", kind: "Closed" };
  const first = foldHolidays(undefined, [h], start - 3 * 86_400_000);
  assert.equal(foldHolidays(first, [], start - 23 * 3_600_000).entries.length, 1, "23 h before: kept");
  assert.equal(foldHolidays(first, [], start - RETRACTION_MARGIN_MS).entries.length, 1, "exactly 24 h before: kept");
  assert.equal(foldHolidays(first, [], start - RETRACTION_MARGIN_MS - 1).entries.length, 0, "just over 24 h before: withdrawn");
});

test("an addition is merged", () => {
  const a = { startsAt: "2027-01-01T16:00:00.000Z", endsAt: "2027-01-02T16:00:00.000Z", kind: "Closed" };
  const b: HolidayEntry = { startsAt: "2026-12-24T04:00:00.000Z", endsAt: "2026-12-24T16:00:00.000Z", kind: "Closed", note: "issuer extra field" };
  const first = foldHolidays(undefined, [a], 1_000);
  const second = foldHolidays(first, [a, b], 2_000);
  assert.equal(second.initializedAtMs, 1_000);
  assert.deepEqual(second.entries.map((e) => [e.startsAt, e.firstSeenMs, e.lastSeenMs]), [
    ["2026-12-24T04:00:00.000Z", 2_000, 2_000],
    ["2027-01-01T16:00:00.000Z", 1_000, 2_000],
  ]);
  assert.equal(second.entries[0].raw, b, "the issuer's object is kept as read");
});

test("closureSchedule returns the latest schedule itself when nothing is kept", () => {
  const { venue: v } = bundleOf(US_9NOV);
  const ledger = foldHolidays(undefined, v.schedule.holidays, 1);
  const r = closureSchedule(v.schedule, ledger);
  assert.equal(r.schedule, v.schedule);
  assert.deepEqual(r.kept, []);
  assert.equal(closureSchedule(v.schedule, undefined).schedule, v.schedule);
  const sched = venueRead(v, 1).sched;
  assert.equal(closureVenue(sched, ledger), sched);
});

test("Thanksgiving: the ledger keeps the 26 Nov entry", () => {
  const { venue: v } = bundleOf(US_9NOV);
  assert.ok(v.schedule.holidays.some((h) => holidayKey(h) === holidayKey(US_26NOV)));
  const pruned = v.schedule.holidays.filter((h) => holidayKey(h) !== holidayKey(US_26NOV));
  let ledger = foldHolidays(undefined, v.schedule.holidays, T("2026-11-26T00:50:00Z"));
  ledger = foldHolidays(ledger, pruned, T("2026-11-26T12:00:00Z"));
  const cut = T("2026-11-26T00:55:30Z");
  assert.equal(walk(v, closureSchedule({ ...v.schedule, holidays: pruned }, ledger).schedule, cut), T("2026-11-27T01:00:00Z"));
  assert.equal(new Date(walk(v, { ...v.schedule, holidays: pruned }, cut)!).toISOString(), "2026-11-26T01:00:00.000Z");
});

test("the 27 Nov early close", () => {
  const { venue: v } = bundleOf(US_9NOV);
  const pruned = v.schedule.holidays.filter((h) => holidayKey(h) !== holidayKey(US_27NOV));
  let ledger = foldHolidays(undefined, v.schedule.holidays, T("2026-11-27T17:50:00Z"));
  ledger = foldHolidays(ledger, pruned, T("2026-11-28T02:00:00Z"));
  assert.equal(T("2026-11-27T17:55:30Z"), 1795802130000);
  assert.equal(walk(v, closureSchedule({ ...v.schedule, holidays: pruned }, ledger).schedule, 1795802130000), 1796000400000);
  assert.equal(new Date(walk(v, { ...v.schedule, holidays: pruned }, 1795802130000)!).toISOString(), "2026-11-27T21:00:00.000Z");
});

test("venueEvidenceFor refuses evidence that does not re-derive", () => {
  const { venue: v, params, claim } = bundleOf(HOLIDAY_2OCT);
  const r = venueEvidenceFor({ symbol: claim.symbol, cutAtMs: v.cutAtMs }, venueRead(v, params.evaluatedAtMs), params.evaluatedAtMs, 1790904600);
  assert.equal(r.kind, "refuse");
  if (r.kind !== "refuse") return;
  assert.equal(r.alarmKey, `keeper:reopen-evidence:${claim.symbol}`);
  assert.ok(r.message.includes("2026-10-01T01:30:00.000Z"), r.message);
});

test("venueEvidenceFor with the ledger gives evidence every verifier re-derives", () => {
  const { venue: v, params, claim } = bundleOf(HOLIDAY_2OCT);
  let ledger = foldHolidays(undefined, [...v.schedule.holidays, HK_1OCT], T("2026-09-30T04:50:26Z"));
  ledger = foldHolidays(ledger, v.schedule.holidays, T("2026-10-01T17:00:00Z"));
  const r = venueEvidenceFor({ symbol: claim.symbol, cutAtMs: v.cutAtMs, holidayLedger: ledger }, venueRead(v, 7), params.evaluatedAtMs, 1790904600);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const e = r.evidence;
  assert.equal(walk(e, e.schedule, e.cutAtMs), 1790904600000);
  assert.equal(e.predictedReopenMs, 1790904600000);
  assert.deepEqual(e.holidaysKept, [{ ...HK_1OCT, firstSeenMs: T("2026-09-30T04:50:26Z"), lastSeenMs: T("2026-09-30T04:50:26Z") }]);
  assert.ok(e.holidaysKept!.every((k) => e.schedule.holidays.some((h) => holidayKey(h) === holidayKey(k))), "S21");
  assert.equal(e.latestReadAtMs, 7);
  assert.equal(e.holidayLedgerSinceMs, T("2026-09-30T04:50:26Z"));
  assert.equal(expectedCapAt(e.limitsPerPeriod, { mic: e.mic, schedule: e.schedule } as ExchangeSchedule, e.cutAtMs), 0, "S18");
});

test("venueEvidenceFor defers when the live reopen moved", () => {
  const { venue: v, params, claim } = bundleOf(US_9NOV);
  const ok = venueEvidenceFor({ symbol: claim.symbol, cutAtMs: v.cutAtMs }, venueRead(v, 1), params.evaluatedAtMs, claim.settleAfterS);
  assert.equal(ok.kind, "ok", "the committed US row passes I10 and I11 as committed");
  const r = venueEvidenceFor({ symbol: claim.symbol, cutAtMs: v.cutAtMs }, venueRead(v, 1), params.evaluatedAtMs, claim.settleAfterS - 86_400);
  assert.equal(r.kind, "defer");
  if (r.kind !== "defer") return;
  assert.equal(r.reopenMs, claim.settleAfterS * 1000);
  assert.equal(r.reopenMs, nextCapReturnMs(v.limitsPerPeriod, S(v), params.evaluatedAtMs));
});

test("expectedCapAt on real schedules", () => {
  const us = bundleOf(US_9NOV).venue;
  const hk = bundleOf(HK_RECESS).venue;
  const probes: Array<[VenueEvidence, string, number]> = [
    [us, "2026-11-13T15:30:44Z", 100_000_000],   // a phantom blip: the schedule says open
    [us, "2026-11-13T20:54:59Z", 100_000_000],
    [us, "2026-11-13T20:55:00Z", 0],             // exactly 300 s before 21:00
    [us, "2026-11-13T20:56:00Z", 0],
    [us, "2026-11-13T21:00:00Z", 100_000_000],   // extended starts on schedule
    [us, "2026-11-14T00:56:00Z", 0],
    [us, "2026-11-16T00:50:00Z", 0],
    [us, "2026-11-16T01:00:30Z", 20_000_000],
    [hk, "2026-11-13T03:56:00Z", 0],
    [hk, "2026-11-13T04:50:00Z", 0],
    [hk, "2026-11-13T05:00:20Z", 10_000_000],
    [hk, "2026-11-13T07:56:04Z", 0],
    [hk, "2026-11-16T01:20:00Z", 0],
    [hk, "2026-11-12T02:00:00Z", 10_000_000],
  ];
  for (const [v, at, want] of probes) assert.equal(expectedCapAt(v.limitsPerPeriod, S(v), T(at)), want, `${v.mic} ${at}`);
  assert.equal(ISSUER_EARLY_CUT_MS, 300_000);
});

test("I11 refuses a phantom at the commit instant", () => {
  const { venue: v, claim } = bundleOf(US_9NOV);
  const cut = T("2026-11-13T15:30:44Z");
  const now = T("2026-11-13T15:35:00Z");
  const settleAfterS = Math.floor(nextCapReturnMs(v.limitsPerPeriod, S(v), now)! / 1000);
  assert.equal(settleAfterS * 1000, T("2026-11-13T21:00:00Z"));
  const r = venueEvidenceFor({ symbol: claim.symbol, cutAtMs: cut }, venueRead(v, 1), now, settleAfterS);
  assert.equal(r.kind, "refuse");
  if (r.kind === "refuse") assert.equal(r.alarmKey, `keeper:schedule-says-open:${claim.symbol}`);
});

// --- the cut check -------------------------------------------------------------------------------------------

type C = { cutAtMs: number; cutSuspect?: boolean | "unanchorable"; schedOpenSeenMs?: number | null };
const TICK = 30_000;

/** Run checkCut every 30 s from the opening tick, feeding each result back as main.ts does. */
function ticks(v: VenueEvidence, cutIso: string, untilIso: string): Array<[string, CutCheck]> {
  const c: C = { cutAtMs: T(cutIso) };
  const out: Array<[string, CutCheck]> = [];
  for (let now = c.cutAtMs; now <= T(untilIso); now += TICK) {
    const r = checkCut(c, v.limitsPerPeriod, S(v), now, TICK);
    out.push([new Date(now).toISOString(), r]);
    if (r.kind === "ok") c.cutSuspect = false;
    else if (r.kind === "suspect") { c.cutSuspect = true; c.schedOpenSeenMs = r.schedOpenSeenMs; }
    else if (r.kind === "unanchorable") c.cutSuspect = "unanchorable";
    else break;
  }
  return out;
}

test("checkCut: a scheduled cut is ok", () => {
  const { venue: v } = bundleOf(HK_RECESS);
  const at = T("2026-11-13T07:56:04Z");
  assert.deepEqual(checkCut({ cutAtMs: at }, v.limitsPerPeriod, S(v), at, TICK), { kind: "ok" });
  // The archived recess cut itself.
  assert.deepEqual(checkCut({ cutAtMs: v.cutAtMs }, v.limitsPerPeriod, S(v), v.cutAtMs, TICK), { kind: "ok" });
  assert.deepEqual(checkCut({ cutAtMs: at, cutSuspect: false }, v.limitsPerPeriod, S(v), T("2026-11-13T02:00:00Z"), TICK), { kind: "ok" });
});

test("checkCut: a blip merging into the lunch cut is re-anchored at the schedule's cut", () => {
  const { venue: v } = bundleOf(HK_RECESS);
  const cut = T("2026-11-13T03:52:00Z");
  assert.deepEqual(checkCut({ cutAtMs: cut }, v.limitsPerPeriod, S(v), cut, TICK), { kind: "suspect", schedOpenSeenMs: cut });
  const run = ticks(v, "2026-11-13T03:52:00Z", "2026-11-13T04:10:00Z");
  const last = run.at(-1)!;
  assert.deepEqual(last, ["2026-11-13T03:55:00.000Z", { kind: "recut" }]);
  assert.ok(run.slice(0, -1).every(([, r]) => r.kind === "suspect"));
  assert.equal(run.at(-2)![0], "2026-11-13T03:54:30.000Z");
});

test("checkCut: a phantom persisting into the recess is re-anchored", () => {
  const { venue: v } = bundleOf(HK_RECESS);
  const run = ticks(v, "2026-11-13T02:00:00Z", "2026-11-13T04:10:00Z");
  assert.deepEqual(run.at(-1), ["2026-11-13T03:55:00.000Z", { kind: "recut" }]);
  assert.ok(run.slice(0, -1).every(([, r]) => r.kind === "suspect"));
});

test("checkCut: a long US phantom is re-anchored at the 20:55Z cut", () => {
  const { venue: v } = bundleOf(US_9NOV);
  const run = ticks(v, "2026-11-13T15:30:44Z", "2026-11-13T21:30:00Z");
  const [at, r] = run.at(-1)!;
  assert.equal(r.kind, "recut");
  assert.ok(T(at) >= T("2026-11-13T20:55:00Z") && T(at) < T("2026-11-13T20:55:00Z") + TICK, at);
  assert.equal(at, "2026-11-13T20:55:14.000Z");
  assert.ok(run.slice(0, -1).every(([, x]) => x.kind === "suspect"));
});

test("checkCut: an inherited suspect closure is unanchorable", () => {
  const { venue: v } = bundleOf(US_9NOV);
  const r = checkCut({ cutAtMs: T("2026-11-13T15:30:44Z") }, v.limitsPerPeriod, S(v), T("2026-11-13T20:56:00Z"), TICK);
  assert.equal(r.kind, "unanchorable");
});

test("checkCut: a schedule cut the keeper did not see is unanchorable", () => {
  const { venue: v } = bundleOf(HK_RECESS);
  const r = checkCut({ cutAtMs: T("2026-11-13T03:40:00Z"), cutSuspect: true, schedOpenSeenMs: T("2026-11-13T03:50:00Z") },
    v.limitsPerPeriod, S(v), T("2026-11-13T03:56:30Z"), TICK);
  assert.equal(r.kind, "unanchorable");
  // Once unanchorable, always unanchorable, even while the schedule says open again.
  assert.equal(checkCut({ cutAtMs: 0, cutSuspect: "unanchorable" }, v.limitsPerPeriod, S(v), T("2026-11-13T05:30:00Z"), TICK).kind, "unanchorable");
});

test("checkCut: no venue limits means the schedule cannot say open, so the cut is not suspect", () => {
  const { venue: v } = bundleOf(HK_RECESS);
  assert.deepEqual(checkCut({ cutAtMs: T("2026-11-13T02:00:00Z") }, undefined, S(v), T("2026-11-13T02:00:00Z"), TICK), { kind: "ok" });
});

test("applyRecut resets the cut-dependent fields and keeps the rest", () => {
  const ledger: HolidayLedger = { initializedAtMs: 5, entries: [] };
  const c: RecutClosure & { witnessedCut: boolean; holidayLedger: HolidayLedger; reopenMs: number; symbol: string } = {
    symbol: "wXIAOx", witnessedCut: true, holidayLedger: ledger, reopenMs: 1_794_546_000_000,
    cutAtMs: T("2026-11-13T03:52:00Z"), cutBlock: 75_772_900, cutBlockHash: "0x" + "01".repeat(32), cutRead: null,
    midAtCutE18: "1", preCutMidE18: "2", coverage: { ranges: [[75_772_000, 75_773_000]], rows: 4 },
    cutSuspect: true, schedOpenSeenMs: T("2026-11-13T03:54:30Z"),
  };
  const cutRead = { blockNumber: 75_773_080, blockHash: "0x" + "02".repeat(32), blockTimestamp: 1_794_541_700, slot0: "0x1234" };
  const out = applyRecut(c, { nowMs: T("2026-11-13T03:55:00Z"), blockNumber: 75_773_080, blockHash: "0x" + "02".repeat(32), midE18: 3n, cutRead });
  assert.equal(out, c, "updated in place");
  assert.equal(c.cutAtMs, T("2026-11-13T03:55:00Z"));
  assert.equal(c.cutBlock, 75_773_080);
  assert.equal(c.cutBlockHash, "0x" + "02".repeat(32));
  assert.deepEqual(c.cutRead, cutRead);
  assert.equal(c.midAtCutE18, "3");
  assert.equal(c.preCutMidE18, null);
  assert.deepEqual(c.coverage, { ranges: [], rows: 0 });
  assert.equal(c.cutSuspect, false);
  assert.equal(c.schedOpenSeenMs, null);
  assert.deepEqual(c.recut, { fromCutAtMs: T("2026-11-13T03:52:00Z"), fromCutBlock: 75_772_900 });
  assert.equal(c.witnessedCut, true);
  assert.equal(c.holidayLedger, ledger);
  assert.equal(c.reopenMs, 1_794_546_000_000);
});
