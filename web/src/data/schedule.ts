/**
 * The deterministic closure schedule: when the issuer's primary market is shut, and when it reopens.
 *
 * MarketClock decides open vs shut NOW. It cannot give a countdown: `nextTransitionAt` is the next
 * schedule boundary (for wTCENTx overnight that is 09:00 HKT, the extended session, cap still zero),
 * not the reopen at 09:30. So every countdown on the site comes from here.
 *
 * PORTED, not reinvented, from the tested service code (keep in step with it):
 *   services/asp/src/regime.ts          venueLocal, sessionAt
 *   services/asp/src/calendar.ts        boundaries, nextBoundaryAfter
 *   services/asp/src/reopen.ts          periodAt, capAt, nextCapReturnMs  (= services/keeper/src/reopen.ts)
 *   services/asp/src/closureCalendar.ts inEarlyCut, effectivePeriodAt, effectiveCapAt, classify, closureWindows
 * One change: `boundaries` walks the schedule in steps of `stepMs(sched)` instead of always one minute.
 * When every session edge and holiday instant sits on a 5-minute mark (true for XHKG and XNAS) no label
 * can change between two 5-minute marks, so the walk finds exactly the same boundaries five times faster.
 * schedule.test.ts pins the 5-minute walk to the 1-minute walk over two weeks on both venues.
 *
 * The facts it encodes (docs/specs/brand-site-video.md §0, DECISIONS D-4):
 *   HKEX sessions 09:30–12:00 and 13:00–16:00 HKT carry primary capacity; 09:00–09:30 and 16:00–16:10
 *   are "extended" with a zero cap; the issuer cuts capacity 300 s before each period ends (11:55, 15:55);
 *   holidays 1 Oct and 19 Oct 2026. So a normal day has 320 open minutes and a normal week 141 h 20 m shut.
 *
 * Pure and host-timezone independent: wall-clock times are read with Intl in the venue's zone, never the
 * host's. The tests run under TZ=UTC, Asia/Hong_Kong, America/Los_Angeles and Pacific/Kiritimati.
 */
import type { ClosureKind, ClosureWindow, Mic } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// issuer / venue data shapes (services/asp/src/regime.ts, reopen.ts)
// ---------------------------------------------------------------------------------------------

export type Period = "market" | "extended" | "overnight" | "closed";

export interface Session {
  kind: string;
  days: string[];
  open: string;
  close: string;
}

export interface ExchangeSchedule {
  mic: string;
  schedule: {
    timezone: string;
    sessions: Session[];
    holidays: { startsAt: string; endsAt: string; kind: string }[];
  };
}

/** Issuer caps per period, in the issuer's units (fiat cents). Only "> 0" matters here. */
export type PeriodLimits = Record<string, { minOrderFiatValue?: number; maxOrderFiatValue: number }>;

export interface Venue {
  mic: Mic;
  sched: ExchangeSchedule;
  limits: PeriodLimits;
}

const WEEKDAYS_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * XHKG as the issuer publishes it (api.xstocks.fi /public/exchanges/XHKG, byte-identical to
 * services/asp/src/fixtures/xhkg.exchange.json), with wTCENTx's limits: only `market` carries a cap.
 */
export const HKEX: Venue = {
  mic: "XHKG",
  sched: {
    mic: "XHKG",
    schedule: {
      timezone: "Asia/Hong_Kong",
      sessions: [
        { kind: "Extended", days: WEEKDAYS_FULL, open: "09:00", close: "09:30" },
        { kind: "Regular", days: WEEKDAYS_FULL, open: "09:30", close: "12:00" },
        { kind: "Regular", days: WEEKDAYS_FULL, open: "13:00", close: "16:00" },
        { kind: "Extended", days: WEEKDAYS_FULL, open: "16:00", close: "16:10" },
      ],
      holidays: [
        { startsAt: "2026-09-30T16:00:00.000Z", endsAt: "2026-10-01T16:00:00.000Z", kind: "Closed" },
        { startsAt: "2026-10-18T16:00:00.000Z", endsAt: "2026-10-19T16:00:00.000Z", kind: "Closed" },
      ],
    },
  },
  limits: {
    market: { minOrderFiatValue: 1000, maxOrderFiatValue: 10_000_000 },
    extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
    overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
    closed: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
  },
};

/** XNAS (services/asp/src/fixtures/xnas.exchange.json) with wNVDAx's limits: every open period carries a cap. */
export const NASDAQ: Venue = {
  mic: "XNAS",
  sched: {
    mic: "XNAS",
    schedule: {
      timezone: "America/New_York",
      sessions: [
        { kind: "Extended", days: WEEKDAYS_FULL, open: "04:00", close: "09:30" },
        { kind: "Regular", days: WEEKDAYS_FULL, open: "09:30", close: "16:00" },
        { kind: "Extended", days: WEEKDAYS_FULL, open: "16:00", close: "20:00" },
        { kind: "Overnight", days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], open: "20:00", close: "04:00" },
      ],
      holidays: [
        { startsAt: "2026-11-26T01:00:00.000Z", endsAt: "2026-11-27T01:00:00.000Z", kind: "Closed" },
        { startsAt: "2026-11-27T18:00:00.000Z", endsAt: "2026-11-28T01:00:00.000Z", kind: "Closed" },
      ],
    },
  },
  limits: {
    market: { minOrderFiatValue: 1000, maxOrderFiatValue: 100_000_000 },
    extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 100_000_000 },
    overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 20_000_000 },
    closed: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
  },
};

export function venueFor(mic: Mic): Venue {
  return mic === "XNAS" ? NASDAQ : HKEX;
}

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

export const MINUTE = 60_000;
export const DAY = 86_400_000;
/** The issuer ends every period 300 s before the published session ends (D-4; 16/16 measured). */
export const ISSUER_EARLY_CUT_MS = 300_000;
/** One Week Ring blade = one five-minute attestation slot. */
export const SLOT_MS = 300_000;
export const SLOTS_PER_WEEK = 2016;
const LOOKBACK_MS = 10 * DAY;
const REOPEN_HORIZON_MS = 14 * DAY;
const REOPEN_MAX_BOUNDARIES = 200;

// ---------------------------------------------------------------------------------------------
// regime.ts: venue wall clock and the published session at an instant
// ---------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Venue-local weekday and minute-of-day for an instant, read with Intl in the venue's zone. */
export function venueLocal(tz: string, at: Date): { day: string; mins: number } {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatterCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(part("hour")) % 24; // guard against ICU rendering midnight as "24"
  return { day: part("weekday"), mins: hour * 60 + Number(part("minute")) };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function previousDay(day: string): string {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7];
}

const holidayMs = new WeakMap<ExchangeSchedule, [number, number][]>();
function holidaysOf(sched: ExchangeSchedule): [number, number][] {
  let h = holidayMs.get(sched);
  if (!h) {
    h = (sched.schedule.holidays ?? []).map((x) => [new Date(x.startsAt).getTime(), new Date(x.endsAt).getTime()]);
    holidayMs.set(sched, h);
  }
  return h;
}

/** The published session covering `at`, or null when the venue is shut (holidays first). */
export function sessionAt(sched: ExchangeSchedule, at: Date): Session | null {
  const t = at.getTime();
  for (const [s, e] of holidaysOf(sched)) if (t >= s && t < e) return null;
  const { day, mins } = venueLocal(sched.schedule.timezone, at);
  for (const s of sched.schedule.sessions ?? []) {
    const open = toMinutes(s.open);
    const close = toMinutes(s.close);
    if (close > open) {
      if (s.days.includes(day) && mins >= open && mins < close) return s;
    } else {
      if (s.days.includes(day) && mins >= open) return s;
      if (s.days.includes(previousDay(day)) && mins < close) return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// calendar.ts: boundaries
// ---------------------------------------------------------------------------------------------

export interface Boundary {
  t: number;
  kind: "venue-open" | "venue-close" | "session-change";
  from: string | null;
  to: string | null;
}

function label(s: Session | null): string | null {
  return s ? `${s.kind}|${s.open}|${s.close}` : null;
}

function kindOf(lbl: string | null): string | null {
  return lbl ? lbl.split("|")[0] : null;
}

const stepCache = new WeakMap<ExchangeSchedule, number>();
/**
 * The walk step: 5 minutes when every session edge and holiday instant is on a 5-minute mark (so no
 * boundary can fall between two marks), else the original 1 minute.
 */
export function stepMs(sched: ExchangeSchedule): number {
  let s = stepCache.get(sched);
  if (s === undefined) {
    const edgesOk = (sched.schedule.sessions ?? []).every((x) => toMinutes(x.open) % 5 === 0 && toMinutes(x.close) % 5 === 0);
    const holsOk = holidaysOf(sched).every(([a, b]) => a % (5 * MINUTE) === 0 && b % (5 * MINUTE) === 0);
    s = edgesOk && holsOk ? 5 * MINUTE : MINUTE;
    stepCache.set(sched, s);
  }
  return s;
}

/** Every boundary in (fromMs, toMs]. */
export function boundaries(sched: ExchangeSchedule, fromMs: number, toMs: number, step = stepMs(sched)): Boundary[] {
  const candidates = new Set<number>();
  for (let t = Math.floor(fromMs / step) * step + step; t <= toMs; t += step) candidates.add(t);
  for (const [s, e] of holidaysOf(sched)) {
    if (s > fromMs && s <= toMs) candidates.add(s);
    if (e > fromMs && e <= toMs) candidates.add(e);
  }
  const out: Boundary[] = [];
  let prev = label(sessionAt(sched, new Date(fromMs)));
  for (const t of [...candidates].sort((a, b) => a - b)) {
    const cur = label(sessionAt(sched, new Date(t)));
    if (cur === prev) continue;
    const kind = prev === null ? "venue-open" : cur === null ? "venue-close" : "session-change";
    out.push({ t, kind, from: kindOf(prev), to: kindOf(cur) });
    prev = cur;
  }
  return out;
}

/** The first boundary strictly after `atMs`, searching up to `horizonMs` ahead. */
export function nextBoundaryAfter(sched: ExchangeSchedule, atMs: number, horizonMs = 8 * DAY): Boundary | null {
  for (let start = atMs; start < atMs + horizonMs; start += DAY) {
    const found = boundaries(sched, start, Math.min(start + DAY, atMs + horizonMs));
    if (found.length) return found[0];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// reopen.ts: period, cap, next cap return
// ---------------------------------------------------------------------------------------------

const SESSION_KIND_TO_PERIOD: Record<string, Period> = { regular: "market", extended: "extended", overnight: "overnight" };

export function periodAt(sched: ExchangeSchedule, atMs: number): Period {
  const s = sessionAt(sched, new Date(atMs));
  if (!s) return "closed";
  return SESSION_KIND_TO_PERIOD[String(s.kind).toLowerCase()] ?? "closed";
}

export function capAt(limits: PeriodLimits | undefined, sched: ExchangeSchedule, atMs: number): number {
  return limits?.[periodAt(sched, atMs)]?.maxOrderFiatValue ?? 0;
}

/** The first instant strictly after `fromMs` at which the cap becomes non-zero (the reopen). */
export function nextCapReturnMs(
  limits: PeriodLimits | undefined,
  sched: ExchangeSchedule,
  fromMs: number,
  horizonMs = REOPEN_HORIZON_MS,
  maxBoundaries = REOPEN_MAX_BOUNDARIES,
): number | null {
  let t = fromMs;
  for (let i = 0; i < maxBoundaries; i++) {
    const remaining = horizonMs - (t - fromMs);
    if (remaining <= 0) return null;
    const b = nextBoundaryAfter(sched, t, remaining);
    if (!b) return null;
    if (capAt(limits, sched, b.t) > 0) return b.t;
    t = b.t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// closureCalendar.ts: the early cut, labels, windows
// ---------------------------------------------------------------------------------------------

function periodChangesAt(sched: ExchangeSchedule, t: number): boolean {
  return periodAt(sched, t - 1) !== periodAt(sched, t);
}

/** Is `t` inside the issuer's early cut: does the current period end within the next 300 s? */
export function inEarlyCut(sched: ExchangeSchedule, t: number): boolean {
  for (const b of boundaries(sched, t, t + ISSUER_EARLY_CUT_MS)) if (periodChangesAt(sched, b.t)) return true;
  return false;
}

export function effectivePeriodAt(sched: ExchangeSchedule, t: number): Period {
  const p = periodAt(sched, t);
  return p !== "closed" && inEarlyCut(sched, t) ? "closed" : p;
}

export function effectiveCapAt(limits: PeriodLimits | undefined, sched: ExchangeSchedule, t: number): number {
  return inEarlyCut(sched, t) ? 0 : capAt(limits, sched, t);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
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

function civilDay([y, m, d]: [number, number, number]): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

export function classify(sched: ExchangeSchedule, startMs: number | null, endMs: number | null): ClosureKind {
  if (startMs === null || endMs === null) return "open-ended";
  if (endMs - startMs <= ISSUER_EARLY_CUT_MS) return "handover";
  for (const [s, e] of holidaysOf(sched)) if (s < endMs && e > startMs) return "holiday";
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
    startMs,
    endMs,
    durationS: startMs !== null && endMs !== null ? Math.round((endMs - startMs) / 1000) : null,
    kind: classify(sched, startMs, endMs),
  };
}

function reopenAfter(v: Venue, bs: Boundary[], coveredFromMs: number, start: number): number | null {
  if (start < coveredFromMs) return nextCapReturnMs(v.limits, v.sched, start);
  let visited = 0;
  for (const b of bs) {
    if (b.t <= start) continue;
    if (b.t - start > REOPEN_HORIZON_MS || ++visited > REOPEN_MAX_BOUNDARIES) return null;
    if (capAt(v.limits, v.sched, b.t) > 0) return b.t;
  }
  return nextCapReturnMs(v.limits, v.sched, start);
}

/**
 * Every closure whose cut falls in (fromMs − 300 s, toMs − 300 s]: one per boundary in (fromMs, toMs]
 * at which a capacity-bearing period ends.
 */
export function closureWindows(fromMs: number, toMs: number, v: Venue = HKEX): ClosureWindow[] {
  const bs = boundaries(v.sched, fromMs, toMs);
  const out: ClosureWindow[] = [];
  for (const b of bs) {
    if (!periodChangesAt(v.sched, b.t)) continue;
    if (capAt(v.limits, v.sched, b.t - 1) <= 0) continue;
    const start = b.t - ISSUER_EARLY_CUT_MS;
    out.push(makeWindow(v.sched, start, reopenAfter(v, bs, fromMs, start)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// the site's questions
// ---------------------------------------------------------------------------------------------

/** Primary capacity is on at `ms` (schedule view: published sessions minus the 300 s early cut). */
export function isOpenAt(ms: number, v: Venue = HKEX): boolean {
  return effectiveCapAt(v.limits, v.sched, ms) > 0;
}

// Pollers ask these every few seconds; a window stays the answer for as long as `now` is inside it.
const inProgress = new Map<Venue, ClosureWindow>();
const upcoming = new Map<Venue, { fromMs: number; w: ClosureWindow }>();

/** The closure in progress at `nowMs` (start ≤ now < end), or null when open. */
export function closureAt(nowMs: number, v: Venue = HKEX): ClosureWindow | null {
  const c = inProgress.get(v);
  if (c && c.startMs !== null && c.endMs !== null && c.startMs <= nowMs && nowMs < c.endMs) return c;
  if (isOpenAt(nowMs, v)) return null;
  const ws = closureWindows(nowMs - LOOKBACK_MS, nowMs + ISSUER_EARLY_CUT_MS, v);
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i];
    if (w.startMs! <= nowMs && (w.endMs === null || w.endMs > nowMs)) {
      inProgress.set(v, w);
      return w;
    }
  }
  // Shut, but the cut lies beyond the lookback: report the reopen with an unknown start.
  return makeWindow(v.sched, null, nextCapReturnMs(v.limits, v.sched, nowMs));
}

/** The next closure whose cut is strictly after `nowMs`. */
export function nextClosure(nowMs: number, v: Venue = HKEX): ClosureWindow | null {
  const c = upcoming.get(v);
  if (c && c.fromMs <= nowMs && nowMs < c.w.startMs!) return c.w;
  for (const span of [2 * DAY, 8 * DAY, 15 * DAY]) {
    const w = closureWindows(nowMs, nowMs + span + ISSUER_EARLY_CUT_MS, v).find((x) => x.startMs! > nowMs);
    if (w) {
      upcoming.set(v, { fromMs: nowMs, w });
      return w;
    }
  }
  return null;
}

/** The start of the closure in progress, or null when open. */
export function closureStartMs(nowMs: number, v: Venue = HKEX): number | null {
  return closureAt(nowMs, v)?.startMs ?? null;
}

/** The next reopen: the end of the closure in progress, else of the next one. */
export function nextReopenMs(nowMs: number, v: Venue = HKEX): number | null {
  const cur = closureAt(nowMs, v);
  if (cur) return cur.endMs;
  return nextClosure(nowMs, v)?.endMs ?? null;
}

/** What happens next and when: a reopen if shut, a cut if open. */
export function nextChange(nowMs: number, v: Venue = HKEX): { atMs: number; kind: "cut" | "reopen" } | null {
  const cur = closureAt(nowMs, v);
  if (cur) return cur.endMs === null ? null : { atMs: cur.endMs, kind: "reopen" };
  const nx = nextClosure(nowMs, v);
  return nx?.startMs != null ? { atMs: nx.startMs, kind: "cut" } : null;
}

// ---------------------------------------------------------------------------------------------
// the week: Monday 00:00 venue-local, 2,016 five-minute slots
// ---------------------------------------------------------------------------------------------

const MON_INDEX: Record<string, number> = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

/** Monday 00:00 venue-local (HKT by default) of the week containing `nowMs`. */
export function weekStartMs(nowMs: number, tz = HKEX.sched.schedule.timezone): number {
  const at = new Date(Math.floor(nowMs / MINUTE) * MINUTE);
  const { day, mins } = venueLocal(tz, at);
  let t = at.getTime() - (MON_INDEX[day] * 1440 + mins) * MINUTE;
  // A DST change inside the week shifts local midnight by an hour; settle on the true Monday 00:00.
  for (let i = 0; i < 2; i++) {
    const l = venueLocal(tz, new Date(t));
    if (l.day === "Monday" && l.mins === 0) break;
    const off = l.day === "Monday" ? l.mins : l.mins - 1440;
    t -= off * MINUTE;
  }
  return t;
}

export interface WeekSlots {
  /** Monday 00:00 HKT of this week (unix ms). Slot i covers [weekStartMs + i·5 min, + 5 min). */
  weekStartMs: number;
  slotMs: number;
  /** 2,016 entries; true = primary market open (ivory blade), false = shut but trading (amber). */
  open: boolean[];
  /** Slot containing `nowMs` (0…2015); "now" sits at three o'clock on the ring. */
  nowIndex: number;
  openSlots: number;
  shutSlots: number;
  openMinutes: number;
  shutMinutes: number;
}

const weekCache = new Map<string, WeekSlots>();

/** The ring's data: every five-minute slot of the HK week containing `nowMs`, open or shut. */
export function weekSlots(nowMs: number, v: Venue = HKEX): WeekSlots {
  const start = weekStartMs(nowMs, v.sched.schedule.timezone);
  const key = `${v.mic}:${start}`;
  let base = weekCache.get(key);
  if (!base) {
    const open = slotStates(start, v);
    const openSlots = open.filter(Boolean).length;
    base = {
      weekStartMs: start,
      slotMs: SLOT_MS,
      open,
      nowIndex: 0,
      openSlots,
      shutSlots: SLOTS_PER_WEEK - openSlots,
      openMinutes: (openSlots * SLOT_MS) / MINUTE,
      shutMinutes: ((SLOTS_PER_WEEK - openSlots) * SLOT_MS) / MINUTE,
    };
    if (weekCache.size > 8) weekCache.clear();
    weekCache.set(key, base);
  }
  const nowIndex = Math.min(SLOTS_PER_WEEK - 1, Math.max(0, Math.floor((nowMs - start) / SLOT_MS)));
  return { ...base, nowIndex };
}

/**
 * Open/shut per slot, at each slot's start. Fast path when the walk step is 5 minutes (slot-aligned):
 * a slot is open iff its period carries a cap and the next slot's period is the same (otherwise the
 * boundary at the slot's end puts the whole slot inside the 300 s early cut). Otherwise, the generic rule.
 */
export function slotStates(weekStart: number, v: Venue = HKEX, forceGeneric = false): boolean[] {
  const open: boolean[] = new Array(SLOTS_PER_WEEK);
  if (!forceGeneric && stepMs(v.sched) === SLOT_MS) {
    const periods: Period[] = new Array(SLOTS_PER_WEEK + 1);
    for (let i = 0; i <= SLOTS_PER_WEEK; i++) periods[i] = periodAt(v.sched, weekStart + i * SLOT_MS);
    for (let i = 0; i < SLOTS_PER_WEEK; i++) {
      open[i] = (v.limits[periods[i]]?.maxOrderFiatValue ?? 0) > 0 && periods[i + 1] === periods[i];
    }
    return open;
  }
  for (let i = 0; i < SLOTS_PER_WEEK; i++) open[i] = isOpenAt(weekStart + i * SLOT_MS, v);
  return open;
}

/** Closures overlapping [weekStart, weekStart + 7 d), for captions ("Fri 15:55 → Mon 09:30 — 65 h 35 m"). */
export function closuresInWeek(weekStart: number, v: Venue = HKEX): ClosureWindow[] {
  const end = weekStart + 7 * DAY;
  const ws = closureWindows(weekStart - LOOKBACK_MS, end + ISSUER_EARLY_CUT_MS, v);
  return ws.filter((w) => (w.endMs === null || w.endMs > weekStart) && (w.startMs === null || w.startMs < end));
}

// ---------------------------------------------------------------------------------------------
// formatting helpers (venue-local, host-TZ independent)
// ---------------------------------------------------------------------------------------------

const hmFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Mon 09:30" etc. in the venue's zone (HKT by default). */
export function venueClock(ms: number, tz = HKEX.sched.schedule.timezone): { weekday: string; hh: string; mm: string; hm: string; label: string } {
  let f = hmFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    hmFormatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = String(Number(get("hour")) % 24).padStart(2, "0");
  const mm = get("minute");
  const weekday = get("weekday");
  return { weekday, hh, mm, hm: `${hh}:${mm}`, label: `${weekday} ${hh}:${mm}` };
}

/** 236_100_000 → "65 h 35 m"; under an hour → "55 m". */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / MINUTE);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m`;
}

/** Countdown parts for fixed-width digit cells. Negative inputs clamp to zero. */
export function countdown(toMs: number, nowMs: number): { h: string; m: string; s: string; totalS: number } {
  const totalS = Math.max(0, Math.floor((toMs - nowMs) / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  return { h: String(h).padStart(2, "0"), m: String(m).padStart(2, "0"), s: String(s).padStart(2, "0"), totalS };
}
