/**
 * The masthead regime chip ("◖ Shut · 20:41 HKT") and its native popover: the live sentence,
 * cap / attested / block facts, and the keyboard-accessible "preview the other hours" toggle.
 * ?capture=1 disables the popover.
 */
import { EXTERNAL } from './markup';
import { flags } from './flags';
import { fmtHKT, hktParts, timetableNextChange } from './hkt';
import { glyphSVG } from './mark';
import { setPreview, staleMinutes, subscribeRegime, type RegimeState, type SiteRegime } from './regime';
import { fmtAgo, fmtBlock, fmtUsd } from '../ui/format';
import { escapeHTML } from '../ui/html';

const LABEL: Record<SiteRegime, string> = { open: 'Open', shut: 'Shut', unknown: 'Stale' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "11:55 HKT" today, "Mon 09:30 HKT" on another day. */
export function hktWhen(ms: number, now = Date.now()): string {
  const a = hktParts(ms);
  const b = hktParts(now);
  const sameDay = Math.abs(ms - now) < 86_400_000 && a.weekday === b.weekday;
  return `${sameDay ? '' : `${DAYS[a.weekday]} `}${fmtHKT(ms)} HKT`;
}

/** The chip's sentence for a state (exported for the home hero and /brand specimens). */
export function regimeSentence(s: RegimeState, now = Date.now()): string {
  const r = s.reading;
  let lead: string;
  if (!s.settled) lead = 'Reading MarketClock on X Layer.';
  else if (!r) lead = 'MarketClock could not be read just now, so the site keeps street hours.';
  else if (r.source === 'fallback') lead = 'Specimen: the live MarketClock reading is not wired in yet, so the site keeps street hours.';
  else if (s.live === 'open') lead = `Paper hours: Hong Kong is open. Curb goes dark at ${hktWhen(r.nextChangeAtMs ?? timetableNextChange(now), now)}.`;
  else if (s.live === 'unknown') lead = `Clock stale: no attestation for ${staleMinutes(s, now) ?? '?'} min.`;
  else
    lead = r.nextChangeAtMs
      ? `Street hours: the exchange is shut and wTCENTx still trades on X Layer. Paper returns ${hktWhen(r.nextChangeAtMs, now)}.`
      : 'Street hours: the exchange is shut and wTCENTx still trades on X Layer.';
  if (s.forced) return `${lead} Showing ${s.forced === 'open' ? 'paper' : 'street'} hours because of ?regime=${s.forced}.`;
  if (s.preview) return `${lead} You are previewing ${s.shown === 'open' ? 'paper' : 'street'} hours.`;
  return lead;
}

export interface RegimeChip {
  el: HTMLButtonElement;
  popover: HTMLElement | null;
  destroy(): void;
}

export function mountRegimeChip(root: ParentNode = document): RegimeChip | null {
  const chip = root.querySelector<HTMLButtonElement>('[data-shell="chip"]');
  if (!chip) return null;
  const pop = root.querySelector<HTMLElement>('[data-shell="chip-popover"]');
  const q = <T extends Element>(sel: string) => (pop ?? chip).querySelector<T>(sel) ?? chip.querySelector<T>(sel);
  const glyph = chip.querySelector<HTMLElement>('[data-chip-glyph]');
  const label = chip.querySelector<HTMLElement>('[data-chip-label]');
  const hhmm = chip.querySelector<HTMLElement>('.chip__hhmm');
  const sentence = q<HTMLElement>('[data-chip-sentence]');
  const cap = q<HTMLElement>('[data-chip-cap]');
  const attested = q<HTMLElement>('[data-chip-attested]');
  const block = q<HTMLElement>('[data-chip-block]');
  const preview = q<HTMLButtonElement>('[data-chip-preview]');

  if (flags.capture && pop) {
    chip.removeAttribute('popovertarget');
    pop.remove();
  }

  let glyphFor: SiteRegime | null = null;
  const render = (s: RegimeState) => {
    const now = Date.now();
    if (glyph && glyphFor !== s.live) {
      glyph.innerHTML = glyphSVG(s.live, { className: 'chip__svg' });
      glyphFor = s.live;
    }
    chip.dataset.live = s.live;
    chip.toggleAttribute('data-preview', s.preview || !!s.forced);
    if (label) label.textContent = LABEL[s.live];
    if (sentence) sentence.textContent = regimeSentence(s, now);
    const r = s.reading;
    if (cap) cap.textContent = r && r.cap !== null ? fmtUsd(r.cap) : '—';
    if (attested) attested.textContent = r && r.source !== 'fallback' ? `${fmtAgo(r.asOfMs, now)} · ${fmtHKT(r.asOfMs)} HKT` : '—';
    if (block) {
      block.innerHTML =
        r && r.block !== null
          ? `<a href="${EXTERNAL.oklink}/block/${r.block}" rel="noopener" target="_blank">${escapeHTML(fmtBlock(r.block))}<span class="arrow arrow--ext" aria-hidden="true">→</span><span class="visually-hidden"> (opens OKLink)</span></a>`
          : '—';
    }
    if (preview) {
      preview.hidden = !!s.forced;
      preview.setAttribute('aria-pressed', String(s.preview));
      const text = s.preview ? 'Back to live hours' : s.shown === 'open' ? 'Preview street hours' : 'Preview paper hours';
      const previewLabel = preview.querySelector('.btn__label') ?? preview;
      previewLabel.textContent = text;
    }
  };

  const unsub = subscribeRegime((s) => render(s));

  const onPreview = () => {
    const pressed = preview?.getAttribute('aria-pressed') === 'true';
    setPreview(!pressed);
  };
  preview?.addEventListener('click', onPreview);

  // HKT wall clock, ticking on the minute.
  let clockTimer: ReturnType<typeof setTimeout> | undefined;
  const tickClock = () => {
    const now = Date.now();
    if (hhmm) hhmm.textContent = fmtHKT(now);
    clockTimer = setTimeout(tickClock, 60_000 - (now % 60_000) + 50);
  };
  tickClock();

  return {
    el: chip,
    popover: pop,
    destroy() {
      unsub();
      clearTimeout(clockTimer);
      preview?.removeEventListener('click', onPreview);
    },
  };
}
