/**
 * COPIED from services/keeper/src/regime.ts. Each service is built standalone from its own directory,
 * so shared pure code is copied rather than imported across packages; keep the copies in step.
 *
 * Regime resolution for tokenized equities on X Layer.
 *
 * The entire contract rests on one definition, and it is an economic one rather than a
 * calendar one: an asset is CLOSED when the issuer's own primary order cap for the
 * current period is zero. At that moment creation and redemption are switched off, so
 * the arbitrage that pins a tokenized stock to its underlying stops working -- while the
 * AMM keeps trading. Everything Curb prices follows from that instant.
 *
 * Sources, both unauthenticated:
 *   GET /public/assets/{SYMBOL}?network=XLayer   -> per-asset trading object
 *   GET /public/exchanges/{MIC}                  -> session schedule + forward holidays
 *
 * We read the exchange schedule as well as the asset because they can disagree, and when
 * they do the schedule is the authority we can defend onstage: it is the venue's own
 * published calendar, not a derived field.
 */

export const API = "https://api.xstocks.fi/api/v2/public";

/** Mirrors IMarketClock.Regime. UNKNOWN is 0 so an unattested asset never reads as open. */
export const Regime = {
  UNKNOWN: 0,
  CLOSED: 1,
  OVERNIGHT: 2,
  EXTENDED: 3,
  MARKET: 4,
} as const;
export type Regime = (typeof Regime)[keyof typeof Regime];

export type Period = "market" | "extended" | "overnight" | "closed";

export interface TradingObject {
  currency: string;
  tradingHoursMode: "TwentyFourFive" | "Regular" | "MarketHours" | "Always" | null;
  isTradingHalted: boolean;
  currentPeriod: Period | null;
  openNow: boolean;
  nextChangeAt: string | null;
  exchange: { mic: string; abbreviation: string; name: string; timezone: string } | null;
  limitsPerPeriod: Record<string, { minOrderFiatValue: number; maxOrderFiatValue: number }>;
}

export interface Session {
  kind: "Regular" | "Extended" | string;
  days: string[];
  open: string;  // "09:30"
  close: string; // "12:00"
}

export interface ExchangeSchedule {
  mic: string;
  timezone: string;
  isOpen: boolean;
  currentSession: string | null;
  nextChangeAt: string | null;
  schedule: {
    timezone: string;
    sessions: Session[];
    holidays: { startsAt: string; endsAt: string; kind: string }[];
  };
}

export interface Resolved {
  regime: Regime;
  /** Raw issuer maxOrderFiatValue for the current period (fiat cents per the issuer spec); 0 when CLOSED. */
  primaryCapRaw: number;
  nextTransitionAt: number; // unix seconds, 0 if unknown
  halted: boolean;
  /** True when the asset and the venue calendar disagree. Logged, never silently resolved. */
  disagreement: boolean;
  reason: string;
}

const PERIOD_TO_REGIME: Record<Period, Regime> = {
  market: Regime.MARKET,
  extended: Regime.EXTENDED,
  overnight: Regime.OVERNIGHT,
  closed: Regime.CLOSED,
};

/**
 * The cap that actually applies right now.
 * Returns 0 when the period is unknown -- failing closed, because a missing cap must never
 * be read as unlimited capacity.
 */
export function applicableCap(t: TradingObject): number {
  if (!t.currentPeriod) return 0;
  const lim = t.limitsPerPeriod?.[t.currentPeriod];
  return lim?.maxOrderFiatValue ?? 0;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Venue-local weekday and minute-of-day for an instant.
 *
 * This must not depend on the host's timezone. An earlier version built a host-local Date from
 * venue wall-clock digits and then formatted it again, converting twice: on a UTC host it
 * reported HKEX open on a Sunday afternoon. `formatToParts` reads the venue's wall clock
 * directly from the instant, so every host and every third-party verifier gets the same answer.
 */
export function venueLocal(tz: string, at: Date): { day: string; mins: number } {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
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
  const i = WEEKDAYS.indexOf(day);
  return WEEKDAYS[(i + 6) % 7];
}

/**
 * The published session covering `at`, or null when the venue is shut.
 *
 * Sessions whose close is not after their open cross midnight, and belong to the day they OPEN
 * on. XNAS lists `Overnight 20:00-04:00` for Sunday-Thursday, so Monday 03:59 ET is inside
 * Sunday's overnight session. Holidays are instant intervals checked first, which also handles
 * half-day closures such as HKEX on 25 Sep 2026 (closed from 12:00 HKT).
 */
export function sessionAt(sched: ExchangeSchedule, at: Date): Session | null {
  for (const h of sched.schedule.holidays ?? []) {
    if (at >= new Date(h.startsAt) && at < new Date(h.endsAt)) return null;
  }
  const { day, mins } = venueLocal(sched.schedule.timezone, at);
  for (const s of sched.schedule.sessions ?? []) {
    const open = toMinutes(s.open);
    const close = toMinutes(s.close);
    if (close > open) {
      if (s.days.includes(day) && mins >= open && mins < close) return s;
    } else {
      // crosses midnight: the evening part belongs to `day`, the morning part to the day before
      if (s.days.includes(day) && mins >= open) return s;
      if (s.days.includes(previousDay(day)) && mins < close) return s;
    }
  }
  return null;
}

/**
 * Is the venue inside a published session at `at`?
 * HKEX's schedule has no session covering 12:00-13:00, so the lunch recess is an explicit
 * gap rather than a flag. That gap is exactly what the finale demo is staged on.
 */
export function inPublishedSession(sched: ExchangeSchedule, at: Date): boolean {
  return sessionAt(sched, at) !== null;
}

/**
 * Rule-set switches that distinguish derivation methods. Every historical round must stay
 * re-derivable under the rules that produced it, so rules are versioned rather than edited in place.
 *
 *   v1 (curb.marketclock.derive/1, rounds from 14 Sep 2026 11:46Z until the v2 deploy):
 *        only `market` with a zero cap became CLOSED; disagreement compared that adjusted regime.
 *   v2 (curb.marketclock.derive/2): ANY open-labelled period with a zero cap is CLOSED;
 *        disagreement compares the issuer's LABEL with the venue calendar.
 */
export interface ResolveRules {
  zeroCapClosesAllPeriods: boolean;
}

export const RULES_V2: ResolveRules = { zeroCapClosesAllPeriods: true };

export function resolve(
  t: TradingObject,
  sched: ExchangeSchedule | null,
  now = new Date(),
  rules: ResolveRules = RULES_V2,
): Resolved {
  const cap = applicableCap(t);
  const period = t.currentPeriod;
  const labelRegime: Regime = period ? PERIOD_TO_REGIME[period] : Regime.UNKNOWN;
  let regime: Regime = labelRegime;

  if (rules.zeroCapClosesAllPeriods) {
    // The economic definition wins over the label, for EVERY open-labelled period. MarketClock's own
    // enum defines CLOSED as "primary creation/redemption capacity is zero". HKEX names report
    // `extended` with a zero cap from 09:00-09:30 and 16:00-16:10 HKT; writing that as EXTENDED would
    // let a consumer that checks `regime != CLOSED` treat an asset as open while issuance is off.
    // (Found by the first-round adversarial verification on 14 Sep 2026, before any such write.)
    if (cap === 0 && regime !== Regime.UNKNOWN) regime = Regime.CLOSED;
  } else if (cap === 0 && regime === Regime.MARKET) {
    regime = Regime.CLOSED; // v1 behaviour, kept only so v1 rounds re-derive exactly
  }

  let disagreement = false;
  let reason = `period=${period} cap=${cap}`;

  if (sched) {
    const venueOpen = inPublishedSession(sched, now);
    // v2: disagreement compares LABELS, not capacity: "the issuer's period says open but the venue is
    // shut" (or the reverse). Comparing the capacity-adjusted regime would flag every zero-cap
    // extended session as a disagreement. OVERNIGHT counts as open: XNAS publishes an overnight
    // session, and leaving it out made every US weeknight at 20:00 ET look like a false close.
    const basis = rules.zeroCapClosesAllPeriods ? labelRegime : regime;
    const assetOpen = basis === Regime.MARKET || basis === Regime.EXTENDED || basis === Regime.OVERNIGHT;
    if (venueOpen !== assetOpen) {
      disagreement = true;
      reason += ` | DISAGREEMENT venueOpen=${venueOpen} assetOpen=${assetOpen}`;
      // Defer to the venue's own published calendar when it says shut. It is the artifact
      // we can put on screen, and the conservative direction for anything we underwrite.
      if (!venueOpen) regime = Regime.CLOSED;
    }
  }

  if (t.isTradingHalted) {
    regime = Regime.CLOSED;
    reason += " | HALTED";
  }

  const next = t.nextChangeAt ? Math.floor(new Date(t.nextChangeAt).getTime() / 1000) : 0;
  return {
    regime,
    // RAW issuer value. The issuer's API spec defines maxOrderFiatValue in fiat CENTS; conversion to
    // MarketClock's whole-USD unit happens in derive(), where it is versioned.
    primaryCapRaw: regime === Regime.CLOSED ? 0 : cap,
    nextTransitionAt: next,
    halted: t.isTradingHalted,
    disagreement,
    reason,
  };
}
