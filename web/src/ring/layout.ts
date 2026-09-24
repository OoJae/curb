/**
 * Week Ring layout: geometry constants, the unroll timeline, slot/angle maths, week runs, and the palette read.
 * No three.js here, so the home page can import it eagerly (it is a few hundred bytes gzipped).
 *
 * Slot model: one slot per five-minute attestation of the current Hong Kong week, starting Mon 00:00 HKT.
 *   slots: Uint8Array(2016), 0 = primary market open, 1 = shut (the pools keep trading).
 *   nowIndex: the slot that contains "now" (0..2015).
 * The slots come from data/schedule.ts `weekSlots(nowMs).open` via `slotsFromOpen()`.
 */
import { MARK as MARK_SPEC } from '../shell/mark';
import { cssHex } from '../ui/tokens';

export const SLOTS = 2016;
export const SLOT_MS = 5 * 60_000;

export type Regime = 'open' | 'shut' | 'unknown';

export interface WeekInput {
  slots: Uint8Array;
  nowIndex: number;
  regime: Regime;
}

/** schedule.ts speaks `open: boolean[]` (true = open); the ring speaks 0 = open, 1 = shut. */
export function slotsFromOpen(open: readonly boolean[]): Uint8Array {
  const slots = new Uint8Array(SLOTS);
  for (let i = 0; i < SLOTS; i++) slots[i] = open[i] ? 0 : 1;
  return slots;
}

/**
 * Construction in units of the C's centreline radius. The C and the amber arc come from the published mark
 * (shell/mark.ts, measured from the avatar): C 236° with its gap centred east, stroke 0.434 R; amber at
 * 1.00 R, 0.191 R thick, ±46°. The blades, needle and flattening are the ring's own.
 */
export const MARK = {
  bandRadius: 1,
  bandTube: MARK_SPEC.cStroke / 2,
  bandArcDeg: 360 - 2 * MARK_SPEC.cHalfGapDeg,
  bandFlatten: 0.35, // z scale: a flattened enamel badge
  arcRadius: MARK_SPEC.arcRadius,
  arcTube: MARK_SPEC.arcThickness / 2,
  arcSpanDeg: 2 * MARK_SPEC.arcHalfSpanDeg,
  bladeRadius: 1,
  blade: [0.0026, 0.16, 0.02] as const, // tangential width, radial length, depth
  needle: { inner: 0.8, outer: 1.3, width: 0.0055, depth: 0.03 },
} as const;

export const CAMERA = {
  fov: 28,
  rest: [0, 0, 6.2] as const,
  dial: [0, -3.6, 4.4] as const,
} as const;

/**
 * The unroll, as fractions of the 250vh pin. The home page owns the captions; it should read these
 * thresholds rather than restating them.
 */
export const UNROLL = {
  lieDown: [0, 0.25], // camera tilts ~40°, the C lies down into a dial
  sweep: [0.2, 0.6], // the C dissolves in time order; blades rise in time order from Mon 00:00 HKT
  captions: [0.6, 0.8], // four captions in the true sequence of the week (DOM)
  needle: [0.8, 1], // the "now" needle rises at three o'clock; the live sentence resolves (DOM)
} as const;

/** Which caption (0..3) owns progress p, or -1 outside the caption window. */
export function captionAt(p: number): number {
  const [a, b] = UNROLL.captions;
  if (p < a) return -1;
  if (p >= b) return 3; // the last caption holds through the needle
  return Math.min(3, Math.floor(((p - a) / (b - a)) * 4));
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const span = (p: number, [a, b]: readonly [number, number]) => clamp01((p - a) / (b - a));
/** cubic-bezier(0.16,1,0.3,1) is the brand's entrance ease; this expo-out is its cheap stand-in for uniforms. */
export const easeOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Angle (radians, CCW from +X) of slot i: clockwise is forward in time, now sits at +X (three o'clock). */
export function slotAngle(i: number, nowIndex: number): number {
  return (-(i - nowIndex) * 2 * Math.PI) / SLOTS;
}

// ── Runs and captions (derived from the slots, so a holiday week tells the truth) ────────────────────

export interface Run {
  shut: boolean;
  start: number; // slot index
  length: number; // slots; a run may wrap past slot 2015 into the next week's start
}

/** Maximal runs of equal state around the ring, rotated so no run straddles index 0 unless the whole week is one run. */
export function weekRuns(slots: Uint8Array): Run[] {
  const n = slots.length;
  let first = 0;
  while (first < n && slots[first] === slots[(first - 1 + n) % n]) first++;
  if (first === n) return [{ shut: slots[0] === 1, start: 0, length: n }];
  const runs: Run[] = [];
  let i = first;
  let count = 0;
  while (count < n) {
    const s = slots[i % n];
    let len = 0;
    while (len + count < n && slots[(i + len) % n] === s) len++;
    runs.push({ shut: s === 1, start: i % n, length: len });
    i += len;
    count += len;
  }
  return runs;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const slotDay = (i: number) => DAYS[Math.floor((((i % SLOTS) + SLOTS) % SLOTS) / 288)];
export function slotClock(i: number): string {
  const m = ((((i % SLOTS) + SLOTS) % SLOTS) % 288) * 5;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/** 8480 → "141 h 20 m" (the brand's duration form). */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}

export interface Caption {
  text: string;
  /** Slots to light while this caption is up: [start, length] (may wrap), or 'shut' for every shut slot. */
  focus: [number, number] | 'shut';
}

/**
 * The four captions in the true sequence of the week, from the slots:
 *   "Mon 09:30 — opens", "11:55 — cap to zero", "Fri 15:55 → Mon 09:30 — 65 h 35 m", "This week — 141 h 20 m".
 */
export function weekCaptions(slots: Uint8Array): Caption[] {
  const runs = weekRuns(slots);
  const shutMin = slots.reduce((a, s) => a + s, 0) * 5;
  const total: Caption = { text: `This week — ${formatDuration(shutMin)}`, focus: 'shut' };
  const opens = runs.filter((r) => !r.shut).sort((a, b) => a.start - b.start);
  if (!opens.length) return [total];
  const o = opens[0];
  const cutAt = o.start + o.length;
  const after = runs.find((r) => r.shut && r.start === cutAt % SLOTS);
  const longest = runs.filter((r) => r.shut).sort((a, b) => b.length - a.length)[0];
  const out: Caption[] = [
    { text: `${slotDay(o.start)} ${slotClock(o.start)} — opens`, focus: [o.start, o.length] },
    { text: `${slotClock(cutAt)} — cap to zero`, focus: [cutAt % SLOTS, after ? after.length : 1] },
  ];
  if (longest) {
    const end = longest.start + longest.length;
    out.push({
      text: `${slotDay(longest.start)} ${slotClock(longest.start)} → ${slotDay(end)} ${slotClock(end)} — ${formatDuration(longest.length * 5)}`,
      focus: [longest.start, longest.length],
    });
  }
  out.push(total);
  return out;
}

// ── Palette ─────────────────────────────────────────────────────────────────────────────────────────

/** The ring's four colours, read from tokens.css at runtime (ui/tokens.ts); the values never repeat here. */
export const RING_TOKENS = { ink: '--ink', ivory: '--ivory', amber: '--streetlamp', slate: '--slate' } as const;

export type Rgb = [number, number, number]; // sRGB 0..1
export type Palette = Record<keyof typeof RING_TOKENS, Rgb>;

export function readPalette(el: Element = document.documentElement): Palette {
  const out = {} as Palette;
  for (const role of Object.keys(RING_TOKENS) as Array<keyof Palette>) {
    const n = cssHex(RING_TOKENS[role], el);
    out[role] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return out;
}

/** "Past slots at 70% value": HSV value is max(r,g,b), so scaling sRGB by 0.7 scales value by exactly 0.7. */
export const PAST_VALUE = 0.7;

/** Viewport/device class used for DPR caps and the mobile timer path. */
export const isNarrow = () => matchMedia('(max-width: 767.98px)').matches;
