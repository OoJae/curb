/**
 * The closure calendar: every window in which an asset's primary market is shut, and when it reopens.
 *
 * "Shut" is Curb's one definition, and it is economic rather than calendrical: the issuer's own primary
 * order cap for the current period is zero, so creation and redemption are off and nothing pins the
 * token to its underlying -- while the AMM keeps trading. MarketClock attests that state as it happens;
 * this answers the forward question an agent actually has to plan around: when is the NEXT one, and how
 * long will it last?
 *
 * Two rules, each borrowed rather than re-invented:
 *
 *   When capacity RETURNS is reopen.ts `nextCapReturnMs`, the same function the keeper commits every
 *   Scorecard row's `settleAfter` with. The calendar therefore cannot disagree with the record it will
 *   later be graded by: the lunch cut reopens at 13:00, not at the 12:00 boundary where the recess
 *   starts, and the afternoon cut reopens at 09:30 the next trading day, three boundaries later.
 *
 *   When capacity is CUT is one boundary earlier than the schedule says. The issuer ends every period
 *   300 seconds before the published session ends (DECISIONS D-4, measured on four consecutive trading
 *   days by two independent witnesses): wTCENTx goes to zero at 11:55 and 15:55 HKT, not 12:00 and 16:00.
 *   A calendar that started the lunch closure at 12:00 would tell an agent it had five minutes of primary
 *   liquidity that does not exist. So a window opens ISSUER_EARLY_CUT_MS before every boundary at which a
 *   capacity-bearing period changes -- including between two capacity-bearing periods, which is why a
 *   US name with overnight and extended caps shows five-minute "handover" windows at 03:55, 09:25, 15:55
 *   and 19:55 ET. Those are real zero-capacity windows; they are labelled so a consumer can ignore them.
 *
 * Cost, and why there is a TimelineCache. `boundaries` walks the schedule a minute at a time (it has to:
 * holidays can start mid-session), which is ~70 ms for 14 days on a laptop. The free preview is callable
 * by anyone, so computing per request would hand out a CPU amplifier. The windows depend only on the
 * (limits, schedule) pair, so they are built once per pair over a span that covers any request for two
 * days, and every request just filters them.
 *
 * Coverage is counted in CUTS, not boundaries. A timeline scanned to boundary T knows every cut up to
 * T - 300s and nothing after, because each cut sits 300s before its boundary. So `cutsCoveredTo` is what a
 * request's horizon is checked against, the build scans ISSUER_EARLY_CUT_MS past its nominal span, and the
 * cache rebuilds by the same measure. Checked against the raw scan end instead, a timeline in the last five
 * minutes of its two-day life silently dropped a closure cut in the last five minutes of a 14-day horizon.
 *
 * Pure and host-timezone independent, like everything it is built on: the suite runs under four TZs.
 */
import { boundaries } from "./calendar.ts";
import { capAt, nextCapReturnMs, periodAt } from "./reopen.ts";
import type { PeriodLimits } from "./reopen.ts";
import type { ExchangeSchedule, Period } from "./regime.ts";

export const CALENDAR_SCHEMA = "curb.asp.calendar/1";
export const PREVIEW_SCHEMA = "curb.asp.calendar.preview/1";
/** Names the reopen rule (reopen.ts), the one the keeper's Scorecard rows are committed under. */
export const CALENDAR_METHOD = "curb.reopen/1";
export const ISSUER_EARLY_CUT_MS = 300_000;
export const DEFAULT_HORIZON_DAYS = 7;
export const MAX_HORIZON_DAYS = 14;

const DAY = 86_400_000;
/** How far back a timeline reaches, so the start of a closure already in progress can be reported. */
const LOOKBACK_MS = 10 * DAY;
/** How long one timeline serves requests before it is rebuilt. */
const REUSE_MS = 2 * DAY;
const SPAN_MS = MAX_HORIZON_DAYS * DAY + REUSE_MS;

/**
 * handover    a 300s gap between two capacity-bearing periods (US names); nothing trades in it.
 * recess      reopens the same venue-local day (the Hong Kong lunch cut).
 * overnight   reopens the next venue-local day.
 * weekend     reopens after one or more skipped days, at least one of them a Saturday or Sunday.
 * holiday     overlaps a holiday the issuer publishes for the venue.
 * multi-day   skips days that are neither weekend nor a published holiday (not seen in practice).
 * open-ended  no reopen within 14 days of the cut, or the cut lies beyond the lookback.
 */
export type WindowKind = "handover" | "recess" | "overnight" | "weekend" | "holiday" | "multi-day" | "open-ended";

export interface ClosureWindow {
  startMs: number | null;
  endMs: number | null;
  durationS: number | null;
  startIso: string | null;
  endIso: string | null;
  kind: WindowKind;
}

/** Does the issuer's period LABEL change at this boundary? Two adjacent sessions of one kind do not flip it. */
function periodChangesAt(sched: ExchangeSchedule, t: number): boolean {
  return periodAt(sched, t - 1) !== periodAt(sched, t);
}

/** Is `t` inside the issuer's early cut: does the current period end within the next 300 seconds? */
export function inEarlyCut(sched: ExchangeSchedule, t: number): boolean {
  for (const b of boundaries(sched, t, t + ISSUER_EARLY_CUT_MS)) {
    if (periodChangesAt(sched, b.t)) return true;
  }
  return false;
}

/** The period label the issuer reports at `t`: the schedule's, except `closed` during the early cut. */
export function effectivePeriodAt(sched: ExchangeSchedule, t: number): Period {
  const p = periodAt(sched, t);
  return p !== "closed" && inEarlyCut(sched, t) ? "closed" : p;
}

/** The issuer cap in force at `t`, in its own units (fiat cents). Zero during the early cut. */
export function effectiveCapAt(limits: PeriodLimits | undefined, sched: ExchangeSchedule, t: number): number {
  return inEarlyCut(sched, t) ? 0 : capAt(limits, sched, t);
}

// ---------------------------------------------------------------------------------------------
// venue-local dates, for labelling a window
// ---------------------------------------------------------------------------------------------

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Venue-local calendar date as [y, m, d], read from the instant with Intl (never the host's zone). */
function localYmd(tz: string, ms: number): [number, number, number] {
  let f = dateFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return [n("year"), n("month"), n("day")];
}

/** Days since the epoch for a civil date: plain arithmetic on the date, so no zone can shift it. */
function civilDay([y, m, d]: [number, number, number]): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

export function classify(sched: ExchangeSchedule, startMs: number | null, endMs: number | null): WindowKind {
  if (startMs === null || endMs === null) return "open-ended";
  if (endMs - startMs <= ISSUER_EARLY_CUT_MS) return "handover";
  for (const h of sched.schedule.holidays ?? []) {
    if (new Date(h.startsAt).getTime() < endMs && new Date(h.endsAt).getTime() > startMs) return "holiday";
  }
  const tz = sched.schedule.timezone;
  const a = civilDay(localYmd(tz, startMs));
  const b = civilDay(localYmd(tz, endMs));
  if (b - a <= 0) return "recess";
  if (b - a === 1) return "overnight";
  for (let d = a + 1; d < b; d++) {
    const wd = new Date(d * DAY).getUTCDay();
    if (wd === 0 || wd === 6) return "weekend";
  }
  return "multi-day";
}

export function makeWindow(sched: ExchangeSchedule, startMs: number | null, endMs: number | null): ClosureWindow {
  return {
    startMs, endMs,
    durationS: startMs !== null && endMs !== null ? Math.round((endMs - startMs) / 1000) : null,
    startIso: startMs === null ? null : new Date(startMs).toISOString(),
    endIso: endMs === null ? null : new Date(endMs).toISOString(),
    kind: classify(sched, startMs, endMs),
  };
}

/**
 * Every closure whose cut falls in (fromMs - 300s, toMs - 300s]: one per boundary in (fromMs, toMs] at
 * which a capacity-bearing period ends. A boundary where capacity was ALREADY zero (16:10 extended ->
 * closed for a Hong Kong name, 09:00 closed -> extended) is inside a closure, not the start of one.
 */
export function closureWindows(limits: PeriodLimits | undefined, sched: ExchangeSchedule, fromMs: number, toMs: number): ClosureWindow[] {
  const bs = boundaries(sched, fromMs, toMs);
  const out: ClosureWindow[] = [];
  for (const b of bs) {
    if (!periodChangesAt(sched, b.t)) continue;
    if (capAt(limits, sched, b.t - 1) <= 0) continue;
    const start = b.t - ISSUER_EARLY_CUT_MS;
    out.push(makeWindow(sched, start, reopenAfter(limits, sched, bs, fromMs, start)));
  }
  return out;
}

const REOPEN_HORIZON_MS = 14 * DAY;   // nextCapReturnMs's default horizon
const REOPEN_MAX_BOUNDARIES = 200;    // and its default boundary budget

/**
 * `nextCapReturnMs(limits, sched, start)`, answered from a boundary list already in hand.
 *
 * nextCapReturnMs finds each next boundary by walking a whole day of minutes, so calling it once per
 * window re-walks most of the span several times over (it made a 26-day timeline cost ~400 ms). Every
 * boundary it could visit after `start` is already in `bs`: boundaries fall only on absolute minute
 * marks and published holiday instants, so the list and a fresh walk see the same instants. This scans
 * the list under nextCapReturnMs's own horizon and budget, and defers to nextCapReturnMs itself whenever
 * the list cannot decide -- `start` before the list's coverage, or no reopen before the list ends.
 * The test suite pins the two to the same answer for every window over two weeks on both venues.
 */
function reopenAfter(limits: PeriodLimits | undefined, sched: ExchangeSchedule, bs: { t: number }[], coveredFromMs: number, start: number): number | null {
  if (start < coveredFromMs) return nextCapReturnMs(limits, sched, start);
  let visited = 0;
  for (const b of bs) {
    if (b.t <= start) continue;
    if (b.t - start > REOPEN_HORIZON_MS || ++visited > REOPEN_MAX_BOUNDARIES) return null;
    if (capAt(limits, sched, b.t) > 0) return b.t;
  }
  return nextCapReturnMs(limits, sched, start);
}

export interface Timeline {
  inputsKey: string;
  anchorMs: number;
  fromMs: number;
  toMs: number;
  windows: ClosureWindow[];
}

/** The last instant a timeline lists EVERY cut up to: closureWindows covers cuts in (fromMs - 300s, toMs - 300s]. */
export function cutsCoveredTo(t: Timeline): number {
  return t.toMs - ISSUER_EARLY_CUT_MS;
}

export function buildTimeline(limits: PeriodLimits | undefined, sched: ExchangeSchedule, inputsKey: string, anchorMs: number): Timeline {
  const fromMs = anchorMs - LOOKBACK_MS;
  // Scanned one early cut past the span, so cuts are complete through anchorMs + SPAN_MS itself.
  const toMs = anchorMs + SPAN_MS + ISSUER_EARLY_CUT_MS;
  return { inputsKey, anchorMs, fromMs, toMs, windows: closureWindows(limits, sched, fromMs, toMs) };
}

/** One timeline per wrapper, rebuilt when the issuer's inputs change or it stops covering the longest horizon. */
export class TimelineCache {
  private readonly byWrapper = new Map<string, Timeline>();

  get(wrapper: string, v: { limits: PeriodLimits; sched: ExchangeSchedule; inputsKey: string }, nowMs: number): Timeline {
    const t = this.byWrapper.get(wrapper);
    if (t && t.inputsKey === v.inputsKey && nowMs >= t.anchorMs && nowMs + MAX_HORIZON_DAYS * DAY <= cutsCoveredTo(t)) return t;
    const built = buildTimeline(v.limits, v.sched, v.inputsKey, nowMs);
    this.byWrapper.set(wrapper, built);
    return built;
  }
}

// ---------------------------------------------------------------------------------------------
// the answer
// ---------------------------------------------------------------------------------------------

export interface VenueEvidence {
  assetUrl: string;
  assetBodyHash: string;
  exchangeUrl: string;
  exchangeBodyHash: string;
  fetchedAtMs: number;
}

export interface CalendarAnswer {
  schema: typeof CALENDAR_SCHEMA;
  symbol: string;
  wrapper: string;
  mic: string;
  timezone: string;
  asOfMs: number;
  horizonDays: number;
  method: typeof CALENDAR_METHOD;
  nowPeriod: Period;
  /** Whole US dollars, floored: the issuer publishes maxOrderFiatValue in fiat cents (derive/2 convention). */
  nowCapFiat: number;
  capUnit: "USD";
  marketOpen: boolean;
  nextClosure: ClosureWindow | null;
  windows: ClosureWindow[];
  venueEvidence: VenueEvidence;
  warnings: string[];
}

export interface CalendarPreview {
  schema: typeof PREVIEW_SCHEMA;
  symbol: string;
  mic: string;
  marketOpen: boolean;
  nowPeriod: Period;
  nextClosure: ClosureWindow | null;
}

export interface CalendarInput {
  symbol: string;
  wrapper: string;
  venue: {
    mic: string; limits: PeriodLimits; sched: ExchangeSchedule; atMs: number;
    reportedPeriod: Period | null; halted: boolean;
    assetUrl: string; assetBodyHash: string; exchangeUrl: string; exchangeBodyHash: string;
  };
  timeline: Timeline;
  nowMs: number;
  horizonDays: number;
  /** Disclosures the caller already knows about, such as stale issuer bytes. */
  warnings?: string[];
}

export function buildCalendar(i: CalendarInput): CalendarAnswer {
  const { venue, nowMs, timeline } = i;
  const sched = venue.sched;
  const horizonEnd = nowMs + i.horizonDays * DAY;
  if (nowMs < timeline.anchorMs || horizonEnd > cutsCoveredTo(timeline)) {
    // A timeline that does not list every cut up to the horizon would silently drop windows. Refuse loudly
    // instead; TimelineCache never hands one out, so this only fires on a programming error.
    throw new Error("timeline does not cover the requested horizon");
  }

  const nowPeriod = effectivePeriodAt(sched, nowMs);
  const capRaw = effectiveCapAt(venue.limits, sched, nowMs);
  const marketOpen = capRaw > 0 && !venue.halted;

  const ongoing = timeline.windows.find((w) => w.startMs! <= nowMs && (w.endMs === null || w.endMs > nowMs)) ?? null;
  const upcoming = timeline.windows.filter((w) => w.startMs! > nowMs && w.startMs! <= horizonEnd);
  const windows = ongoing ? [ongoing, ...upcoming] : upcoming;

  const warnings = [...(i.warnings ?? [])];
  const anyCap = Object.values(venue.limits ?? {}).some((l) => (l?.maxOrderFiatValue ?? 0) > 0);
  if (!anyCap) {
    warnings.push("no period in the issuer's published limits carries a non-zero cap: primary capacity is zero throughout, so there is no closure to bound and no reopen to predict");
  } else if (capRaw === 0 && !ongoing) {
    // Shut, but the cut is older than the lookback. The reopen is still well defined, so report it with
    // an unknown start rather than dropping the window an agent most needs.
    windows.unshift(makeWindow(sched, null, nextCapReturnMs(venue.limits, sched, nowMs)));
    warnings.push("primary capacity is zero now, but the cut that started this closure lies beyond the 10-day lookback; its start is reported as null");
  }
  if (venue.halted) {
    warnings.push("the issuer reported trading halted for this asset when its bytes were fetched; primary capacity is treated as zero regardless of the schedule");
  }
  for (const w of windows) {
    if (w.startMs !== null && w.endMs === null) {
      warnings.push(`no reopen found within 14 days of the cut at ${w.startIso}; its end is reported as null rather than guessed`);
    }
  }
  const expected = effectivePeriodAt(sched, venue.atMs);
  if (venue.reportedPeriod !== null && venue.reportedPeriod !== expected) {
    warnings.push(
      `when fetched, the issuer reported period "${venue.reportedPeriod}" where the published schedule gives "${expected}"; ` +
      "the issuer API is cached at its edge for up to ~90s, so a mismatch within a minute or two of a boundary is expected, and a persistent one means the schedule is not the whole story",
    );
  }
  const holidays = sched.schedule.holidays ?? [];
  const lastHolidayEnd = holidays.reduce((m, h) => Math.max(m, new Date(h.endsAt).getTime()), 0);
  if (holidays.length === 0) {
    warnings.push(`the issuer publishes no forward holidays for ${venue.mic}; a venue holiday inside the horizon would not appear in this calendar`);
  } else if (lastHolidayEnd < horizonEnd) {
    warnings.push(`the issuer's published holiday list for ${venue.mic} ends ${new Date(lastHolidayEnd).toISOString()}; a holiday after that would not appear in this calendar`);
  }

  return {
    schema: CALENDAR_SCHEMA,
    symbol: i.symbol,
    wrapper: i.wrapper,
    mic: venue.mic,
    timezone: sched.schedule.timezone,
    asOfMs: nowMs,
    horizonDays: i.horizonDays,
    method: CALENDAR_METHOD,
    nowPeriod,
    nowCapFiat: Math.floor(capRaw / 100),
    capUnit: "USD",
    marketOpen,
    nextClosure: upcoming[0] ?? null,
    windows,
    venueEvidence: {
      assetUrl: venue.assetUrl, assetBodyHash: venue.assetBodyHash,
      exchangeUrl: venue.exchangeUrl, exchangeBodyHash: venue.exchangeBodyHash,
      fetchedAtMs: venue.atMs,
    },
    warnings,
  };
}

/** The free sample: enough to show the endpoint is live and truthful, not the calendar itself. */
export function previewOf(a: CalendarAnswer): CalendarPreview {
  return { schema: PREVIEW_SCHEMA, symbol: a.symbol, mic: a.mic, marketOpen: a.marketOpen, nowPeriod: a.nowPeriod, nextClosure: a.nextClosure };
}
