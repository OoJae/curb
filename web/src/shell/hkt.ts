/**
 * Hong Kong time helpers, plus a TIMETABLE-ONLY fallback of the HKEX week used by the shell until
 * lane B's deterministic `src/data/schedule.ts` is merged (and whenever it is absent).
 *
 * Fallback model (no holidays): the primary cap is > 0 Mon–Fri 09:30–11:55 and 13:00–15:55 HKT,
 * i.e. the published sessions minus the measured 300 s early cut: 64 open five-minute slots a day,
 * 320 a week, 1,696 of 2,016 shut (84%). B's schedule.ts is authoritative; never use this for a
 * number that the chain or schedule.ts can supply.
 */

export const HKT_OFFSET_MS = 8 * 3600_000;
export const SLOT_MS = 5 * 60_000;
export const SLOTS_PER_WEEK = 2016;
const DAY_MS = 86_400_000;

/** [start, end) minutes after HKT midnight when the primary cap is > 0 (timetable fallback). */
export const TIMETABLE_SESSIONS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60 + 30, 11 * 60 + 55],
  [13 * 60, 15 * 60 + 55],
];

export interface HktParts {
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** minutes after HKT midnight */
  minuteOfDay: number;
}

export function hktParts(ms: number): HktParts {
  const t = ms + HKT_OFFSET_MS;
  const d = new Date(t);
  const weekday = (d.getUTCDay() + 6) % 7;
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  return { weekday, hours, minutes, seconds: d.getUTCSeconds(), minuteOfDay: hours * 60 + minutes };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "20:41" (24 h, HKT). */
export function fmtHKT(ms: number, withSeconds = false): string {
  const p = hktParts(ms);
  return withSeconds ? `${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}` : `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

/** Monday 00:00 HKT of the week containing `ms`, as a UTC epoch ms. */
export function hktWeekStart(ms: number): number {
  const local = ms + HKT_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const weekday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - weekday * DAY_MS - HKT_OFFSET_MS;
}

/** Timetable fallback: is the primary cap > 0 at `ms`? */
export function timetableOpenAt(ms: number): boolean {
  const p = hktParts(ms);
  if (p.weekday > 4) return false;
  const m = p.minuteOfDay + p.seconds / 60;
  return TIMETABLE_SESSIONS.some(([a, b]) => m >= a && m < b);
}

/** Timetable fallback: the next open/shut boundary strictly after `ms` (UTC epoch ms). */
export function timetableNextChange(ms: number): number {
  const weekStart = hktWeekStart(ms);
  const boundaries: number[] = [];
  for (let w = 0; w < 2; w++) {
    for (let d = 0; d < 5; d++) {
      for (const [a, b] of TIMETABLE_SESSIONS) {
        const base = weekStart + w * 7 * DAY_MS + d * DAY_MS;
        boundaries.push(base + a * 60_000, base + b * 60_000);
      }
    }
  }
  return boundaries.find((t) => t > ms) ?? ms + DAY_MS;
}

export type SlotState = 'open' | 'shut' | 'unknown';

/** Timetable fallback: 2,016 five-minute slot states for the HK week containing `ms`. */
export function timetableWeekSlots(ms: number): { slots: SlotState[]; nowIndex: number; weekStartMs: number } {
  const weekStartMs = hktWeekStart(ms);
  const slots: SlotState[] = new Array(SLOTS_PER_WEEK);
  for (let i = 0; i < SLOTS_PER_WEEK; i++) {
    slots[i] = timetableOpenAt(weekStartMs + i * SLOT_MS) ? 'open' : 'shut';
  }
  const nowIndex = Math.min(SLOTS_PER_WEEK - 1, Math.max(0, Math.floor((ms - weekStartMs) / SLOT_MS)));
  return { slots, nowIndex, weekStartMs };
}
