/**
 * The venue schedule a closure is predicted, committed and checked with, and the check that its cut was a real one.
 *
 * Two facts about the issuer drive this file.
 *
 * 1. Its holiday list changes under an open closure. It prunes a holiday once it has passed (XHKG 1 Oct and
 *    19 Oct), withdraws a mistaken entry days before it starts (18 Sep: 25 and 28 Sep), and adds entries late
 *    (XHKG 1 Jan first seen 2 Nov). A row commits the schedule and a verifier walks it FROM THE CUT to the
 *    committed settleAfter, so the committed schedule must still hold every holiday the closure spans. Each
 *    closure therefore keeps a ledger: the union of every list read while it was open, minus entries withdrawn
 *    more than 24 hours before they began (a correction, not a passing holiday).
 *
 * 2. Every capacity period ends ISSUER_EARLY_CUT_MS early (D-4) and the next starts on schedule, so the
 *    schedule can say exactly when on-chain capacity should be zero. A closure whose cut the schedule says was
 *    open is a host-A blip, alone or merged into a real cut: `checkCut` never lets it be committed as it
 *    stands. It is re-anchored at the schedule's own cut when this keeper saw the schedule shut, or left
 *    unanchorable.
 *
 * Pure: no network, no clock (every instant is passed in).
 */
import { capAt, nextCapReturnMs } from "./reopen.ts";
import type { PeriodLimits } from "./reopen.ts";
import { nextBoundaryAfter } from "./calendar.ts";
import type { ExchangeSchedule } from "./regime.ts";
import type { VenueEvidence } from "./markRound.ts";
import type { CutRead } from "./swapEvidence.ts";

/** D-4: every period ENDS 300 s early; the next STARTS on schedule. */
export const ISSUER_EARLY_CUT_MS = 300_000;
/** D11: an entry dropped more than this long before it begins was withdrawn, not pruned. */
export const RETRACTION_MARGIN_MS = 24 * 3_600_000;

export interface HolidayEntry { startsAt: string; endsAt: string; kind: string; [k: string]: unknown }
export interface LedgerEntry { startsAt: string; endsAt: string; kind: string; firstSeenMs: number; lastSeenMs: number; raw: HolidayEntry }
export interface HolidayLedger { initializedAtMs: number; entries: LedgerEntry[] }

export const holidayKey = (h: { startsAt: string; endsAt: string; kind: string }): string => `${h.startsAt}|${h.endsAt}|${h.kind}`;

const iso = (ms: number | null): string => (ms === null || !Number.isFinite(ms) ? "never" : new Date(ms).toISOString());

/**
 * Fold one read of the issuer's holiday list into a closure's ledger.
 * Present now: kept, refreshed. Absent now: kept if the read is at, after, or less than 24 h before its start
 * (pruned as it passed); dropped if the read is more than 24 h before its start (withdrawn). New: added.
 */
export function foldHolidays(ledger: HolidayLedger | undefined, read: HolidayEntry[], readAtMs: number): HolidayLedger {
  const now = new Map(read.map((h) => [holidayKey(h), h]));
  const out: LedgerEntry[] = [];
  for (const e of ledger?.entries ?? []) {
    const k = holidayKey(e);
    if (now.has(k)) { out.push({ ...e, lastSeenMs: readAtMs, raw: now.get(k)! }); now.delete(k); continue; }
    if (readAtMs < Date.parse(e.startsAt) - RETRACTION_MARGIN_MS) continue;   // withdrawn well before it began
    out.push(e);                                                              // pruned at/after (or just before) its start
  }
  for (const h of now.values()) {
    out.push({ startsAt: h.startsAt, endsAt: h.endsAt, kind: h.kind, firstSeenMs: readAtMs, lastSeenMs: readAtMs, raw: h });
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt) || a.kind.localeCompare(b.kind));
  return { initializedAtMs: ledger?.initializedAtMs ?? readAtMs, entries: out };
}

/**
 * The schedule a closure is predicted and committed with: the latest read's sessions, holidays = latest ∪ ledger.
 * The latest list keeps its order; ledger entries it no longer has (`kept`) are appended in ledger order. With
 * nothing kept, the latest schedule object itself is returned, byte for byte.
 */
export function closureSchedule(latest: ExchangeSchedule["schedule"], ledger: HolidayLedger | undefined):
  { schedule: ExchangeSchedule["schedule"]; kept: LedgerEntry[] } {
  const have = new Set((latest.holidays ?? []).map(holidayKey));
  const kept = (ledger?.entries ?? []).filter((e) => !have.has(holidayKey(e)));
  if (kept.length === 0) return { schedule: latest, kept };
  return { schedule: { ...latest, holidays: [...(latest.holidays ?? []), ...kept.map((e) => e.raw)] }, kept };
}

/** The venue schedule with the closure's ledger folded in: what the reopen is predicted and the cut checked with. */
export function closureVenue(sched: ExchangeSchedule, ledger: HolidayLedger | undefined): ExchangeSchedule {
  const { schedule } = closureSchedule(sched.schedule, ledger);
  return schedule === sched.schedule ? sched : { ...sched, schedule };
}

/**
 * The issuer cap the schedule says applies at `tMs`, with D-4's early end: zero inside the last 300 s of a
 * period (a boundary at most ISSUER_EARLY_CUT_MS ahead) as well as in a zero-cap period.
 */
export function expectedCapAt(limits: PeriodLimits | undefined, sched: ExchangeSchedule, tMs: number): number {
  const cap = capAt(limits, sched, tMs);
  if (cap <= 0) return 0;
  return nextBoundaryAfter(sched, tMs, ISSUER_EARLY_CUT_MS) ? 0 : cap;
}

export type VenueCheck =
  | { kind: "ok"; evidence: VenueEvidence }
  | { kind: "defer"; reason: string; reopenMs: number | null }
  | { kind: "refuse"; alarmKey: string; message: string };

export interface VenueRead {
  mic: string;
  assetUrl: string;
  assetBodyHash: string;
  exchangeUrl: string;
  exchangeBodyHash: string;
  limits: PeriodLimits;
  sched: ExchangeSchedule;
  /** When the latest venue body was read. */
  atMs: number;
}

/**
 * The venue evidence a row commits, or why there is none yet. Runs before any network call in buildPlan.
 *
 * - The live prediction (the closure's schedule walked from now) must still be the planned settleAfter, else
 *   defer with the live value (the asset was skipped this tick and its reopenMs is stale).
 * - Walked from the cut, the same schedule must give the same settleAfter (I10): exactly what every verifier
 *   checks. Refuse otherwise: a keeper-side schedule fault, never a data fault.
 * - The schedule must say the market is shut at the commit instant (I11). Refuse otherwise.
 */
export function venueEvidenceFor(
  c: { symbol: string; cutAtMs: number; holidayLedger?: HolidayLedger },
  v: VenueRead, nowMs: number, settleAfterS: number,
): VenueCheck {
  const { schedule, kept } = closureSchedule(v.sched.schedule, c.holidayLedger);
  const S: ExchangeSchedule = { ...v.sched, mic: v.mic, schedule };
  const live = nextCapReturnMs(v.limits, S, nowMs);
  if (live === null || Math.floor(live / 1000) !== settleAfterS) {
    return { kind: "defer", reopenMs: live, reason: `the closure's schedule now reopens at ${iso(live)}, not at the planned ${iso(settleAfterS * 1000)}` };
  }
  const fromCut = nextCapReturnMs(v.limits, S, c.cutAtMs);
  if (fromCut === null || Math.floor(fromCut / 1000) !== settleAfterS) {
    return {
      kind: "refuse", alarmKey: `keeper:reopen-evidence:${c.symbol}`,
      message: `${c.symbol}: the committed schedule walked from the cut gives ${iso(fromCut)}, the keeper settles after ${iso(settleAfterS * 1000)}`,
    };
  }
  const cap = expectedCapAt(v.limits, S, nowMs);
  if (cap !== 0) {
    return {
      kind: "refuse", alarmKey: `keeper:schedule-says-open:${c.symbol}`,
      message: `${c.symbol}: the closure's schedule says the market is open at ${iso(nowMs)} (expected cap ${cap}); no row while the venue says it trades`,
    };
  }
  return {
    kind: "ok",
    evidence: {
      mic: v.mic, assetUrl: v.assetUrl, assetBodyHash: v.assetBodyHash, exchangeUrl: v.exchangeUrl, exchangeBodyHash: v.exchangeBodyHash,
      cutAtMs: c.cutAtMs, limitsPerPeriod: v.limits, schedule, predictedReopenMs: settleAfterS * 1000,
      holidaysKept: kept.map(({ startsAt, endsAt, kind, firstSeenMs, lastSeenMs }) => ({ startsAt, endsAt, kind, firstSeenMs, lastSeenMs })),
      latestReadAtMs: v.atMs,
      holidayLedgerSinceMs: c.holidayLedger?.initializedAtMs ?? v.atMs,
    },
  };
}

export type CutCheck =
  | { kind: "ok" }                                         // the cut is a scheduled cut (expectedCapAt(cutAtMs) == 0)
  | { kind: "suspect"; schedOpenSeenMs: number | null }    // chain shut, schedule open: wait for the schedule's own cut
  | { kind: "recut" }                                      // the schedule just shut: re-anchor the closure at this tick
  | { kind: "unanchorable"; reason: string };              // cannot be re-anchored honestly: never commit it

const UNANCHORABLE = "the schedule shut without this keeper seeing it open since the cut; the cut cannot be re-anchored";

/**
 * Was this closure's cut a scheduled one? `sched` is the closure's schedule (`closureVenue(latest, ledger)`).
 * Run on the opening tick (`nowMs === c.cutAtMs`) and on every later tick until the closure has a plan.
 *
 * A cut the schedule says was open is suspect. While the schedule still says open, it stays suspect (and the
 * last tick that saw it open is remembered). When the schedule shuts within two ticks of the last such
 * sighting, the schedule's own cut fell between two ticks this keeper saw: re-anchor there. Otherwise the true
 * cut is unknown and the closure is never committed.
 */
export function checkCut(
  c: { cutAtMs: number; cutSuspect?: boolean | "unanchorable"; schedOpenSeenMs?: number | null },
  limits: PeriodLimits | undefined, sched: ExchangeSchedule, nowMs: number, tickMs: number,
): CutCheck {
  if (c.cutSuspect === false) return { kind: "ok" };
  if (c.cutSuspect === "unanchorable") return { kind: "unanchorable", reason: UNANCHORABLE };
  let seen: number | null;
  if (c.cutSuspect === undefined) {
    if (expectedCapAt(limits, sched, c.cutAtMs) === 0) return { kind: "ok" };
    seen = nowMs === c.cutAtMs ? c.cutAtMs : null;   // only the opening tick itself saw the schedule open at the cut
  } else {
    seen = c.schedOpenSeenMs ?? null;
  }
  if (expectedCapAt(limits, sched, nowMs) > 0) return { kind: "suspect", schedOpenSeenMs: nowMs };
  if (seen !== null && nowMs - seen <= 2 * tickMs) return { kind: "recut" };
  return { kind: "unanchorable", reason: UNANCHORABLE };
}

/** The fields `applyRecut` rewrites; everything else on the closure is left as it is. */
export interface RecutClosure {
  cutAtMs: number;
  cutBlock: number;
  cutBlockHash?: string | null;
  cutRead?: CutRead | null;
  midAtCutE18: string;
  preCutMidE18: string | null;
  coverage?: { ranges: Array<[number, number]>; rows: number };
  cutSuspect?: boolean | "unanchorable";
  schedOpenSeenMs?: number | null;
  recut?: { fromCutAtMs: number; fromCutBlock: number };
}

/**
 * Re-anchor a suspect closure at this tick (the schedule's own cut). A field update, nothing else: the caller
 * removes the old closure file FIRST (it is named by the old cutBlock). `preCutMidE18` becomes null because the
 * last open reading predates the blip and may lie outside the new 900-block window, where I8 would misfire.
 * witnessedCut, holidayLedger and reopenMs are kept.
 */
export function applyRecut<T extends RecutClosure>(
  c: T, at: { nowMs: number; blockNumber: number; blockHash: string; midE18: bigint; cutRead: CutRead | null },
): T {
  c.recut = { fromCutAtMs: c.cutAtMs, fromCutBlock: c.cutBlock };
  c.cutAtMs = at.nowMs;
  c.cutBlock = at.blockNumber;
  c.cutBlockHash = at.blockHash;
  c.cutRead = at.cutRead;
  c.midAtCutE18 = at.midE18.toString();
  c.preCutMidE18 = null;
  c.coverage = { ranges: [], rows: 0 };
  c.cutSuspect = false;
  c.schedOpenSeenMs = null;
  return c;
}
