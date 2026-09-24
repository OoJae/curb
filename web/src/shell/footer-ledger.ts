/**
 * Footer ledger: this HK week as a slot strip, the live "now" row, and the site's ledger of links.
 * Week slots come from lane B's `src/data/schedule.ts` (export `weekSlots(nowMs)`) when present,
 * else from the timetable fallback in shell/hkt.ts.
 */
import { EXTERNAL } from './markup';
import { fmtHKT, SLOT_MS, timetableWeekSlots, type SlotState } from './hkt';
import { subscribeRegime, type RegimeState } from './regime';
import { fmtAgo, fmtBlock, fmtUsd } from '../ui/format';
import { escapeHTML } from '../ui/html';
import { slotStrip, summarizeSlots } from '../ui/slotstrip';

type WeekSlots = (nowMs: number) => { slots: SlotState[]; nowIndex: number };

const schedModules = import.meta.glob<{ weekSlots?: WeekSlots }>('../data/schedule.ts', { eager: true });
const bWeekSlots = Object.values(schedModules)[0]?.weekSlots;

export function weekSlotsNow(nowMs = Date.now()): { slots: SlotState[]; nowIndex: number; source: 'schedule' | 'timetable' } {
  if (bWeekSlots) {
    try {
      const w = bWeekSlots(nowMs);
      return { ...w, source: 'schedule' };
    } catch (err) {
      console.warn('schedule.weekSlots failed; using the timetable', err);
    }
  }
  const t = timetableWeekSlots(nowMs);
  return { slots: t.slots, nowIndex: t.nowIndex, source: 'timetable' };
}

const REGIME_WORD = { open: 'open', shut: 'shut', unknown: 'stale' } as const;

function nowRowHTML(s: RegimeState, now = Date.now()): string {
  const r = s.reading;
  if (!s.settled) return 'wTCENTx · reading MarketClock';
  if (!r) return 'wTCENTx · MarketClock unreadable just now';
  if (r.source === 'fallback') return 'wTCENTx · specimen: live reading not wired in yet';
  const parts = [
    'wTCENTx',
    REGIME_WORD[s.live],
    r.cap !== null ? `cap ${escapeHTML(fmtUsd(r.cap))}` : null,
    `attested ${escapeHTML(fmtAgo(r.asOfMs, now))} (${fmtHKT(r.asOfMs)} HKT)`,
    r.block !== null
      ? `<a href="${EXTERNAL.oklink}/block/${r.block}" rel="noopener" target="_blank">block ${escapeHTML(fmtBlock(r.block))}<span class="arrow arrow--ext" aria-hidden="true">→</span><span class="visually-hidden"> (opens OKLink)</span></a>`
      : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export interface FooterLedger {
  el: HTMLElement;
  destroy(): void;
}

export function mountFooterLedger(root: ParentNode = document): FooterLedger | null {
  const footer = root.querySelector<HTMLElement>('[data-shell="footer"]');
  if (!footer) return null;
  const stripEl = footer.querySelector<HTMLElement>('[data-footer-strip]');
  const nowEl = footer.querySelector<HTMLElement>('[data-footer-now]');
  const caption = footer.querySelector<HTMLElement>('[data-footer-week]');

  let strip: ReturnType<typeof slotStrip> | null = null;
  const drawWeek = () => {
    if (!stripEl) return;
    const w = weekSlotsNow();
    if (strip) strip.update(w.slots, w.nowIndex);
    else strip = slotStrip(stripEl, w.slots, { nowIndex: w.nowIndex });
    if (caption) {
      const s = summarizeSlots(w.slots);
      caption.textContent =
        `This week in Hong Kong, one mark per five minutes: ivory while the exchange is open, amber while it is shut ` +
        `and wTCENTx still trades. ${s.shut.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} marks are amber` +
        (w.source === 'timetable' ? ' (published timetable, before holidays).' : '.');
    }
  };
  drawWeek();
  // Redraw on each slot boundary (the "now" tick moves every five minutes).
  let weekTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleWeek = () => {
    weekTimer = setTimeout(() => {
      drawWeek();
      scheduleWeek();
    }, SLOT_MS - (Date.now() % SLOT_MS) + 100);
  };
  scheduleWeek();

  const unsub = subscribeRegime((s) => {
    if (nowEl) nowEl.innerHTML = nowRowHTML(s);
  });

  return {
    el: footer,
    destroy() {
      unsub();
      clearTimeout(weekTimer);
    },
  };
}
