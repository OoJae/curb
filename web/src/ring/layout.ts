/**
 * Week Ring layout: geometry constants, the unroll timeline, slot/angle maths, week runs, and the palette read.
 * No three.js here, so the home page can import it eagerly (it is a few hundred bytes gzipped).
 *
 * Slot model: one slot per five-minute attestation of the current Hong Kong week, starting Mon 00:00 HKT.
 *   slots: Uint8Array(2016), 0 = primary market open, 1 = shut (the pools keep trading).
 *   nowIndex: the slot that contains "now" (0..2015).
 */

export const SLOTS = 2016;
export const SLOT_MS = 5 * 60_000;
export const WEEK_MS = SLOTS * SLOT_MS;
const HKT_MS = 8 * 3_600_000; // Hong Kong has no DST
const DAY_MS = 86_400_000;

export type Regime = 'open' | 'shut' | 'unknown';

export interface WeekInput {
  slots: Uint8Array;
  nowIndex: number;
  regime: Regime;
}

/** Construction, in units of the C's centreline radius (spec §1 "Mark" and §4 "Week Ring"). */
export const MARK = {
  bandRadius: 1,
  bandTube: 0.21, // stroke 0.42 × R
  bandArcDeg: 250, // gap 110°, centred due east
  bandFlatten: 0.35, // z scale: a flattened enamel badge
  arcRadius: 1.09,
  arcTube: 0.1, // thickness 0.20
  arcSpanDeg: 96, // centred east
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

// ── Hong Kong week ────────────────────────────────────────────────────────────────────────────────

/** UTC ms of Monday 00:00 HKT of the week containing t. */
export function weekStartHKT(t: number): number {
  const local = t + HKT_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const dow = new Date(dayStart).getUTCDay(); // 0 = Sun
  return dayStart - ((dow + 6) % 7) * DAY_MS - HKT_MS;
}

export function nowSlotIndex(t: number): number {
  return Math.min(SLOTS - 1, Math.max(0, Math.floor((t - weekStartHKT(t)) / SLOT_MS)));
}

/**
 * LOCAL STUB — swapped for lane B's `data/schedule.ts` at merge.
 * Published HKEX sessions 09:30–12:00 and 13:00–16:00 HKT, Mon–Fri, minus the measured 300 s early cut
 * (the cap goes to zero at 11:55 and 15:55). No holidays. 64 open slots a day, 320 a week; 1,696 shut (84%).
 */
export function stubWeek(t: number = Date.now()): WeekInput & { weekStart: number } {
  const slots = new Uint8Array(SLOTS).fill(1);
  const sessions: Array<[number, number]> = [
    [9 * 60 + 30, 11 * 60 + 55],
    [13 * 60, 15 * 60 + 55],
  ];
  for (let d = 0; d < 5; d++) {
    for (const [a, b] of sessions) {
      for (let m = a; m < b; m += 5) slots[d * 288 + m / 5] = 0;
    }
  }
  const nowIndex = nowSlotIndex(t);
  return { slots, nowIndex, regime: slots[nowIndex] ? 'shut' : 'open', weekStart: weekStartHKT(t) };
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

/*
 * ═══ ADAPTER (lane A tokens) ═══ The ring reads its colours from CSS custom properties at runtime.
 * Each role tries these names in order; the lead trims this list to lane A's real token names at merge.
 * The hex fallbacks are the frozen brand values (spec §1) and only apply if no token resolves.
 */
export const RING_TOKENS = {
  ink: ['--ink', '--street-ink', '--color-ink', '--c-ink'],
  ivory: ['--ivory', '--certificate-ivory', '--color-ivory', '--c-ivory'],
  amber: ['--streetlamp', '--amber', '--color-streetlamp', '--c-streetlamp'],
  slate: ['--slate', '--window-slate', '--color-slate', '--c-slate'],
} as const;
const RING_FALLBACK = { ink: '#0F1720', ivory: '#F4EFE6', amber: '#F5A524', slate: '#8A96A3' };

export type Rgb = [number, number, number]; // sRGB 0..1
export type Palette = Record<keyof typeof RING_TOKENS, Rgb>;

let probe: CanvasRenderingContext2D | null = null;
/** Any CSS colour (hex, rgb(), oklch(), color-mix()) → sRGB bytes, via a 1×1 canvas. */
function cssToRgb(value: string): Rgb | null {
  if (!value) return null;
  probe ??= (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.getContext('2d', { willReadFrequently: true });
  })();
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return d[3] ? [d[0] / 255, d[1] / 255, d[2] / 255] : null;
}

export function readPalette(el: Element = document.documentElement): Palette {
  const cs = getComputedStyle(el);
  const out = {} as Palette;
  for (const role of Object.keys(RING_TOKENS) as Array<keyof Palette>) {
    let rgb: Rgb | null = null;
    for (const name of RING_TOKENS[role]) {
      rgb = cssToRgb(cs.getPropertyValue(name).trim());
      if (rgb) break;
    }
    out[role] = rgb ?? (cssToRgb(RING_FALLBACK[role]) as Rgb);
  }
  return out;
}

/** "Past slots at 70% value": HSV value is max(r,g,b), so scaling sRGB by 0.7 scales value by exactly 0.7. */
export const PAST_VALUE = 0.7;

/** Viewport/device class used for DPR caps and the mobile timer path. */
export const isNarrow = () => matchMedia('(max-width: 767.98px)').matches;
