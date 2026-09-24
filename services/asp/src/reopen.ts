/**
 * COPIED from services/keeper/src/reopen.ts. Each service is built standalone from its own directory,
 * so shared pure code is copied rather than imported across packages; keep the copies in step.
 *
 * When does primary capacity come back?
 *
 * This is the single most consequential number in a Scorecard row. It is half the closure id
 * (`keccak256(wrapper, settleAfter, inputRoot)`), it is the instant the mark is graded against, and
 * the contract has no revision path -- so getting it wrong produces a permanently wrong row.
 *
 * MarketClock cannot answer it. `nextTransitionAt` is the next *schedule* boundary, and a closure
 * routinely spans several: the Hong Kong lunch cut runs MARKET -> (11:55 cap cut) -> 12:00 recess ->
 * 13:00 reopen, and the afternoon cut runs 15:55 -> 16:00 extended (cap zero for HK names) -> 16:10
 * venue close -> 09:00 extended next day (still zero) -> 09:30. Trusting the next boundary would
 * commit a 17-hour closure as if it were a 5-minute one, and mark it on 5 minutes of drift.
 *
 * So the reopen is computed the way the issuer computes capacity: walk the venue's published
 * boundaries forward and return the first instant whose period carries a non-zero cap. Holidays fall
 * out of `sessionAt` for free, which is what makes a Friday-evening closure predict Monday and 1 Oct
 * predict 2 Oct without a special case.
 *
 * Pure, so a verifier re-runs it against the committed schedule bytes and gets the same instant.
 */
import { sessionAt } from "./regime.ts";
import { nextBoundaryAfter } from "./calendar.ts";
import type { ExchangeSchedule, Period } from "./regime.ts";

/** The issuer's period name for a venue session kind. Anything unrecognised fails closed. */
const SESSION_KIND_TO_PERIOD: Record<string, Period> = {
  regular: "market",
  extended: "extended",
  overnight: "overnight",
};

export type PeriodLimits = Record<string, { minOrderFiatValue?: number; maxOrderFiatValue: number }>;

export function periodAt(sched: ExchangeSchedule, atMs: number): Period {
  const s = sessionAt(sched, new Date(atMs));
  if (!s) return "closed";
  return SESSION_KIND_TO_PERIOD[String(s.kind).toLowerCase()] ?? "closed";
}

/** The issuer cap that applies at `atMs`, in the issuer's own units. Zero when unknown. */
export function capAt(limits: PeriodLimits | undefined, sched: ExchangeSchedule, atMs: number): number {
  return limits?.[periodAt(sched, atMs)]?.maxOrderFiatValue ?? 0;
}

const DAY = 24 * 60 * 60_000;

/**
 * The first instant strictly after `fromMs` at which the cap becomes non-zero, or null if none
 * inside the horizon -- which is the correct answer for an asset whose every period caps at zero,
 * and the reason `commit` is skipped rather than guessed for one.
 */
export function nextCapReturnMs(
  limits: PeriodLimits | undefined,
  sched: ExchangeSchedule,
  fromMs: number,
  horizonMs = 14 * DAY,
  maxBoundaries = 200,
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
