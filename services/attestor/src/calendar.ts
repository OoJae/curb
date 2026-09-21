/**
 * Venue calendar: the exact instants at which a published session starts, ends or changes kind.
 *
 * The attestor schedules its most important rounds from this. A close depends only on the venue's
 * published schedule, so the 12:00:00 HKT close can be built in advance and broadcast to land in
 * the block stamped 12:00:00, instead of being discovered from an API response after the fact.
 *
 * Pure and host-timezone independent: it is built on `sessionAt`, which reads venue wall-clock
 * time with Intl.DateTimeFormat. Third-party verifiers run the same code and get the same answer.
 */
import { sessionAt } from "./regime.ts";
import type { ExchangeSchedule, Session } from "./regime.ts";

export type BoundaryKind = "venue-open" | "venue-close" | "session-change";

export interface Boundary {
  /** Unix milliseconds, exactly on the boundary. */
  t: number;
  mic: string;
  kind: BoundaryKind;
  /** Session kind before and after, null when the venue is shut. */
  from: string | null;
  to: string | null;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Identity of a session, so two adjacent sessions of the same kind still produce a boundary. */
function label(s: Session | null): string | null {
  return s ? `${s.kind}|${s.open}|${s.close}` : null;
}

function kindOf(lbl: string | null): string | null {
  return lbl ? lbl.split("|")[0] : null;
}

/**
 * Every boundary in (fromMs, toMs].
 *
 * Session opens and closes are published as HH:MM, so every session boundary falls on a minute.
 * Holidays are published as instants and may start mid-session (HKEX 25 Sep 2026 closes from
 * 12:00 HKT), so their start and end instants are checked explicitly as well.
 */
export function boundaries(sched: ExchangeSchedule, fromMs: number, toMs: number): Boundary[] {
  const candidates = new Set<number>();
  for (let t = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE; t <= toMs; t += MINUTE) {
    candidates.add(t);
  }
  for (const h of sched.schedule.holidays ?? []) {
    for (const iso of [h.startsAt, h.endsAt]) {
      const t = new Date(iso).getTime();
      if (t > fromMs && t <= toMs) candidates.add(t);
    }
  }

  const out: Boundary[] = [];
  let prev = label(sessionAt(sched, new Date(fromMs)));
  for (const t of [...candidates].sort((a, b) => a - b)) {
    const cur = label(sessionAt(sched, new Date(t)));
    if (cur === prev) continue;
    const kind: BoundaryKind = prev === null ? "venue-open" : cur === null ? "venue-close" : "session-change";
    out.push({ t, mic: sched.mic, kind, from: kindOf(prev), to: kindOf(cur) });
    prev = cur;
  }
  return out;
}

/** The first boundary strictly after `atMs`, searching up to `horizonMs` ahead. */
export function nextBoundaryAfter(
  sched: ExchangeSchedule,
  atMs: number,
  horizonMs = 8 * DAY,
): Boundary | null {
  // Search a day at a time so the common case (a boundary within hours) stays cheap.
  for (let start = atMs; start < atMs + horizonMs; start += DAY) {
    const found = boundaries(sched, start, Math.min(start + DAY, atMs + horizonMs));
    if (found.length) return found[0];
  }
  return null;
}
