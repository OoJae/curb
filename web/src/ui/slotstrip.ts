/**
 * Slot strip: the 2D sibling of the Week Ring. One mark per five-minute slot of an HK week
 * (2,016 for a full week), left → right from Mon 00:00 HKT. Ivory = primary market open,
 * Streetlamp = shut but still trading, slate = unknown. Past slots at 70%. Always drawn inside an
 * ink window (Streetlamp never touches ivory), so it is legal in paper hours too.
 *
 *   const strip = slotStrip(el, slots, { nowIndex, days: true, label: 'This week' });
 *   strip.update(nextSlots, nextNowIndex);
 */
import type { SlotState } from '../shell/hkt';

export type { SlotState };

export interface SlotStripOptions {
  /** index of the current slot; draws the "now" tick and dims the past */
  nowIndex?: number | null;
  /** draw Mon…Sun labels under the strip (needs a full 2,016-slot week) */
  days?: boolean;
  /** accessible label; when omitted the strip is decorative (aria-hidden) */
  label?: string;
}

export interface SlotStrip {
  el: HTMLElement;
  update(slots: readonly SlotState[], nowIndex?: number | null): void;
}

export interface SlotSummary {
  open: number;
  shut: number;
  unknown: number;
  total: number;
  /** shut / total, 0–1 */
  shutShare: number;
}

export function summarizeSlots(slots: readonly SlotState[]): SlotSummary {
  let open = 0;
  let shut = 0;
  let unknown = 0;
  for (const s of slots) {
    if (s === 'open') open++;
    else if (s === 'shut') shut++;
    else unknown++;
  }
  const total = slots.length;
  return { open, shut, unknown, total, shutShare: total ? shut / total : 0 };
}

const FILL: Record<SlotState, string> = {
  open: 'var(--ivory)',
  shut: 'var(--streetlamp)',
  unknown: 'var(--slate)',
};

/** Pure SVG string for a strip (also usable in OG templates). */
export function slotStripSVG(slots: readonly SlotState[], nowIndex: number | null = null): string {
  const n = slots.length || 1;
  const rects: string[] = [];
  let start = 0;
  for (let i = 1; i <= slots.length; i++) {
    const boundary = i === slots.length || slots[i] !== slots[start] || (nowIndex !== null && i === nowIndex);
    if (!boundary) continue;
    const state = slots[start]!;
    const past = nowIndex !== null && start < nowIndex;
    rects.push(
      `<rect x="${start}" y="0" width="${i - start}" height="1" fill="${FILL[state]}"${past ? ' fill-opacity="0.7"' : ''}/>`,
    );
    start = i;
  }
  const days =
    n === 2016
      ? Array.from({ length: 6 }, (_, d) => `<line x1="${(d + 1) * 288}" x2="${(d + 1) * 288}" y1="0" y2="1" class="slotstrip__day"/>`).join('')
      : '';
  return `<svg class="slotstrip__svg" viewBox="0 0 ${n} 1" preserveAspectRatio="none" aria-hidden="true" focusable="false" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects.join('')}${days}</svg>`;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function slotStrip(el: HTMLElement, slots: readonly SlotState[], opts: SlotStripOptions = {}): SlotStrip {
  el.classList.add('slotstrip', 'surface-ink');
  if (opts.label) {
    el.setAttribute('role', 'img');
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  const update = (next: readonly SlotState[], nowIndex: number | null = opts.nowIndex ?? null) => {
    const n = next.length || 1;
    const now =
      nowIndex !== null
        ? `<span class="slotstrip__now" style="left:${(((nowIndex + 0.5) / n) * 100).toFixed(3)}%"></span>`
        : '';
    const days =
      opts.days && n === 2016
        ? `<div class="slotstrip__days" aria-hidden="true">${DAY_LABELS.map((d) => `<span>${d}</span>`).join('')}</div>`
        : '';
    el.innerHTML = `<div class="slotstrip__bar">${slotStripSVG(next, nowIndex)}${now}</div>${days}`;
    if (opts.label) {
      const s = summarizeSlots(next);
      el.setAttribute(
        'aria-label',
        `${opts.label}: ${s.open.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} five-minute slots open, ${s.shut.toLocaleString('en-US')} shut (${Math.round(s.shutShare * 100)}%).`,
      );
    }
  };
  update(slots, opts.nowIndex ?? null);
  return { el, update };
}
