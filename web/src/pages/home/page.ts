/**
 * Home (/): make the closure felt, then hand off to the proof.
 *
 * Sections: hero + the unroll (pinned 250vh; the Week Ring) · the cut · the record · instruments · for agents ·
 * the name · footer. Desktop pins with CSS sticky and scrubs with ScrollTrigger (scrub 0.6); under 768 px there is
 * no pin and the unroll plays once on a timer when the ring is 40% in view; under reduced motion everything renders
 * in its final state (the ring draws once, in 2D, and three.js is never fetched).
 *
 * The page hydrates markup that is already in index.html; if the <main> is empty it renders `homeMarkup()` first.
 * For LCP, paste `homeMarkup(stubWeek())`'s output into web/index.html (the hero H1 and the poster are the LCP
 * candidates; both are plain HTML).
 */
import './page.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { mountWeekRing, posterMarkup } from '../../ring/poster';
import type { MountedRing } from '../../ring/poster';
import {
  SLOTS,
  SLOT_MS,
  UNROLL,
  captionAt,
  cssToRgb,
  formatDuration,
  isNarrow,
  slotClock,
  slotDay,
  stubWeek,
  weekCaptions,
} from '../../ring/layout';
import type { Caption, Regime, WeekInput } from '../../ring/layout';

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * ADAPTER: the only lines that touch lane A (shell, motion) and lane B (data). The lead wires these at merge.
 *
 * Namespace imports on purpose: if an export is named differently, the page still links and falls back to the
 * local behaviour noted beside each entry (never to an invented number). Each `A.*` states the signature it
 * expects; rename the property lookups below to lane A/B's real exports.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import * as shellBoot from '../../shell/boot';
import * as motionLenis from '../../motion/lenis';
import * as motionReveal from '../../motion/reveal';
import * as motionReduced from '../../motion/reduced';
import * as dataSchedule from '../../data/schedule';
import * as dataClock from '../../data/clock';
import * as dataScorecard from '../../data/scorecard';
import * as dataApi from '../../data/api';
import * as dataAddresses from '../../data/addresses';

/** MarketClock `stateOf(wTCENTx)`, decoded. */
export interface ClockReading {
  symbol: string; // 'wTCENTx'
  regime: 'UNKNOWN' | 'CLOSED' | 'OVERNIGHT' | 'EXTENDED' | 'MARKET';
  capUsd: number; // primaryCapNow, whole USD
  attestedAt: number | null; // ms epoch of the last StateAttested
  block: number | null; // block the reading is as of
  stale?: boolean;
}
/** `Scorecard.skill()` (chain) or the `/v1/accuracy-record` 402 preview (API fallback). */
export interface SkillReading {
  settled: number;
  beatLastPrint: number;
  beatClosingVwap: number;
  ties?: number;
  asOf: { block?: number; at: number; source: 'chain' | 'api' };
}
/** An unpaid call's 402, with PAYMENT-REQUIRED decoded. */
export interface Paywall {
  url: string;
  status: number;
  accepts: Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds?: number; extra?: { name?: string } }>;
  preview: unknown;
  at: number;
}

type Fn<T extends unknown[] = [], R = unknown> = (...a: T) => R;
const get = <T>(mod: object, ...names: string[]): T | undefined => {
  for (const n of names) {
    const v = (mod as Record<string, unknown>)[n];
    if (v !== undefined) return v as T;
  }
  return undefined;
};
const API = 'https://api.curb.markets';

const A = {
  /** lane A `boot({ page })`. Fallback: no-op (the page still works without the shell). */
  boot: async () => get<Fn<[{ page: string }]>>(shellBoot, 'boot')?.({ page: 'home' }),
  /** lane A `motion/reduced`. Fallback: the media query. */
  reducedMotion: (): boolean =>
    get<Fn<[], boolean>>(motionReduced, 'prefersReducedMotion', 'reducedMotion', 'isReduced')?.() ??
    matchMedia('(prefers-reduced-motion: reduce)').matches,
  /** lane A `motion/lenis`: the Lenis instance (already on the GSAP ticker) or null. */
  lenis: (): { on?: Fn<[string, Fn]> } | null => get<Fn<[], null>>(motionLenis, 'getLenis', 'lenis')?.() ?? null,
  /** lane A `motion/reveal`: SplitText headlines + [data-reveal] entrances inside root. Fallback: none. */
  reveal: (root: Element) => get<Fn<[Element]>>(motionReveal, 'reveal', 'revealAll')?.(root),
  /** lane B `schedule.ts`: this HK week's 2,016 slots (0 open, 1 shut), "now", and Mon 00:00 HKT. Fallback: stub. */
  week: (t: number): WeekInput & { weekStart: number } =>
    get<Fn<[number], WeekInput & { weekStart: number }>>(dataSchedule, 'weekSlots', 'currentWeek', 'week')?.(t) ??
    stubWeek(t),
  /** lane B `clock.ts`/`regime.ts`: stateOf(wTCENTx) via rpc-lite. Fallback: null (the now-line says so). */
  clock: async (): Promise<ClockReading | null> =>
    (await get<Fn<[string], Promise<ClockReading>>>(dataClock, 'readClock', 'readState', 'stateOf')?.('wTCENTx')) ?? null,
  /** lane B `scorecard.ts`: skill() from chain. Fallback: the /v1/accuracy-record 402 preview (spec §3). */
  skill: async (): Promise<SkillReading | null> =>
    (await get<Fn<[], Promise<SkillReading>>>(dataScorecard, 'readSkill', 'skill')?.()) ?? skillFromPreview(),
  /** lane B `api.ts`: an unpaid call and its decoded 402. Fallback: the same, fetched here. */
  paywall: async (path: string): Promise<Paywall> =>
    (await get<Fn<[string], Promise<Paywall>>>(dataApi, 'preview402', 'askWithoutPaying', 'paywall')?.(path)) ??
    fetchPaywall(path),
  /** lane B `addresses.ts`: whether Notes / Depth have deployed addresses. Fallback: both "in build". */
  live: (name: 'notes' | 'depth'): boolean =>
    !!get<Fn<[string], boolean>>(dataAddresses, 'isLive', 'instrumentLive')?.(name),
};

async function fetchPaywall(path: string): Promise<Paywall> {
  const url = `${API}${path}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const header = res.headers.get('PAYMENT-REQUIRED');
  // base64 → UTF-8 (the asset is named "USD₮0"; atob alone would hand back Latin-1 bytes)
  const decoded = header
    ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))))
    : { accepts: [] };
  const preview = await res.json().catch(() => null);
  return { url, status: res.status, accepts: decoded.accepts ?? [], preview, at: Date.now() };
}
async function skillFromPreview(): Promise<SkillReading | null> {
  try {
    const p = await fetchPaywall('/v1/accuracy-record');
    const s = (p.preview as { skill?: { settled: number; beatLastPrint: number; beatClosingVwap: number } })?.skill;
    return s ? { ...s, asOf: { at: p.at, source: 'api' } } : null;
  } catch {
    return null;
  }
}
/* ═══ end ADAPTER ═══ */

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtInt = (n: number) => n.toLocaleString('en-US');
const HKT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hktNow = () => HKT.format(new Date());
const UTC = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Next slot (after now) whose state differs from now's; returns [slot index (may exceed 2015), ms epoch]. */
function nextChange(w: WeekInput & { weekStart: number }): [number, number] {
  const s = w.slots[w.nowIndex];
  for (let i = w.nowIndex + 1; i < w.nowIndex + SLOTS; i++) if (w.slots[i % SLOTS] !== s) return [i, w.weekStart + i * SLOT_MS];
  return [w.nowIndex + SLOTS, w.weekStart + (w.nowIndex + SLOTS) * SLOT_MS];
}
function nextOpen(w: WeekInput & { weekStart: number }): [number, number] | null {
  for (let i = w.nowIndex + 1; i <= w.nowIndex + SLOTS; i++) if (w.slots[i % SLOTS] === 0) return [i, w.weekStart + i * SLOT_MS];
  return null;
}
const when = (slot: number, nowIndex: number) =>
  Math.floor(slot / 288) === Math.floor(nowIndex / 288) ? slotClock(slot) : `${slotDay(slot)} ${slotClock(slot)}`;

// ── markup ──────────────────────────────────────────────────────────────────────────────────────────────────

const CUT = [
  ['11:55', 'Cap to zero', 'Five minutes before the lunch bell, the issuer’s order cap goes to zero. Creation and redemption stop; the pool keeps trading.'],
  ['12:00', 'The bell', 'Hong Kong breaks for lunch. On X Layer nothing pauses.'],
  ['12:50', 'Commit', 'Curb’s keeper writes its reopen mark on chain, before anyone can know the price.'],
  ['13:00', 'Reopen', 'The exchange reopens and the cap returns.'],
  ['13:05', 'Settle', 'Scorecard reads the pool itself and grades the mark against the last print and the closing VWAP.'],
] as const;

const INSTRUMENTS = [
  { key: 'clock', name: 'Clock', href: '/clock', date: '14 Sep', line: 'Per asset, is the primary market open now, attested every five minutes.' },
  { key: 'scorecard', name: 'Scorecard', href: '/scorecard', date: '21 Sep', line: 'Every mark committed before the reopen, graded by the chain.' },
  { key: 'api', name: 'API', href: '/api', date: '24 Sep', line: 'Three priced routes for agents, paid per call over x402.' },
  { key: 'notes', name: 'Notes', href: '/notes', date: null, line: 'Sell the reopen, not the asset.' },
  { key: 'depth', name: 'Depth', href: '/depth', date: null, line: 'Bond the depth you quote; see the LTV move.' },
] as const;

function ringText(w: WeekInput): string {
  const shutMin = w.slots.reduce((a, s) => a + s, 0) * 5;
  return `This week in Hong Kong, as 2,016 five-minute slots: the exchange is open for ${formatDuration(
    SLOTS * 5 - shutMin,
  )} and shut for ${formatDuration(shutMin)}, and the pools trade through all of it. Now is ${slotDay(w.nowIndex)} ${slotClock(
    w.nowIndex,
  )} HKT; the exchange is ${w.slots[w.nowIndex] ? 'shut' : 'open'}.`;
}

export function homeMarkup(w: WeekInput): string {
  const caps = weekCaptions(w.slots);
  return `
<div class="hm" data-hm>
  <section class="hm-unroll" aria-labelledby="hm-title">
    <div class="hm-stage">
      <div class="hm-copy">
        <h1 class="hm-title" id="hm-title" data-reveal="lines">The market that trades when the exchange is <em>shut</em>.</h1>
        <p class="hm-lede">Tokenized Tencent keeps trading on X&nbsp;Layer for 141&nbsp;h&nbsp;20&nbsp;m of every 168. Curb records the hours, marks the reopen, and lets you exit without selling.</p>
        <p class="hm-ctas">
          <a class="hm-cta" href="/clock">Read the clock <span aria-hidden="true">→</span></a>
          <a class="hm-link" href="${API}" rel="external">Ask the API <span aria-hidden="true">↗</span></a>
        </p>
      </div>
      <figure class="hm-ring" aria-describedby="hm-ring-text">
        ${posterMarkup('hm-poster')}
        <canvas class="hm-canvas" aria-hidden="true"></canvas>
        <figcaption class="hm-sr" id="hm-ring-text">${esc(ringText(w))}</figcaption>
      </figure>
      <div class="hm-ledger" aria-hidden="true">
        <p class="hm-legend">
          <span class="hm-key"><span class="hm-swatch hm-swatch--open"></span>Exchange open</span>
          <span class="hm-key"><span class="hm-swatch hm-swatch--shut"></span>Shut, still trading</span>
          <span class="hm-key hm-key--data">2,016 five-minute slots from Mon 00:00 HKT</span>
        </p>
        <ol class="hm-captions">
          ${caps.map((c) => `<li class="hm-caption">${esc(c.text)}</li>`).join('')}
        </ol>
        <p class="hm-sentence"></p>
      </div>
      <p class="hm-now" aria-label="Now">
        <span class="hm-now-k">now</span>
        <span class="hm-now-v" data-now="symbol">wTCENTx</span>
        <span class="hm-now-v" data-now="regime">·</span>
        <span class="hm-now-v" data-now="cap">cap —</span>
        <span class="hm-now-v" data-now="next">·</span>
        <span class="hm-now-v" data-now="attested">reading the clock…</span>
      </p>
    </div>
  </section>

  <section class="hm-section hm-cut" aria-labelledby="hm-cut-title">
    <h2 class="hm-h2" id="hm-cut-title" data-reveal="lines">The cut</h2>
    <p class="hm-intro">Every trading day in Hong Kong has two. This is the lunch cut, in the order it happens (HKT).</p>
    <ol class="hm-cut-list">
      ${CUT.map(
        ([t, k, d]) => `<li class="hm-cut-step" data-reveal><time class="hm-cut-time">${t}</time><strong class="hm-cut-name">${k}</strong><span class="hm-cut-text">${d}</span></li>`,
      ).join('')}
    </ol>
  </section>

  <section class="hm-section hm-record" aria-labelledby="hm-record-title">
    <h2 class="hm-h2" id="hm-record-title" data-reveal="lines">The record</h2>
    <div class="hm-record-body">
      <p class="hm-numeral" data-record="settled" aria-describedby="hm-record-line">&nbsp;</p>
      <div>
        <p class="hm-record-line" id="hm-record-line" data-record="line">Reading <code>Scorecard.skill()</code> on X Layer…</p>
        <p class="hm-record-tie">A tie is not a win.</p>
        <p class="hm-asof" data-record="asof">&nbsp;</p>
        <p><a class="hm-link" href="/scorecard">Read the Scorecard <span aria-hidden="true">→</span></a></p>
      </div>
    </div>
  </section>

  <section class="hm-section hm-instruments" aria-labelledby="hm-inst-title">
    <h2 class="hm-h2" id="hm-inst-title" data-reveal="lines">Instruments</h2>
    <ol class="hm-inst-list">
      ${INSTRUMENTS.map(
        (i) => `<li class="hm-inst" data-inst="${i.key}" data-reveal>
          <span class="hm-inst-date" data-inst-date>${i.date ?? 'in build'}</span>
          <a class="hm-inst-name" href="${i.href}">${i.name} <span aria-hidden="true">→</span></a>
          <span class="hm-inst-line">${i.line}</span>
        </li>`,
      ).join('')}
    </ol>
  </section>

  <section class="hm-section hm-agents" aria-labelledby="hm-agents-title">
    <h2 class="hm-h2" id="hm-agents-title" data-reveal="lines">For agents</h2>
    <div class="hm-agents-body">
      <div class="hm-agents-copy">
        <p>Ask without paying and you get a price and a free preview. Pay one cent from an OKX Agentic Wallet and you get the answer, with a receipt that ties the payment to the exact bytes you received.</p>
        <p><button class="hm-button" type="button" data-ask>Ask without paying</button></p>
        <p class="hm-small">Listed on OKX’s AI marketplace as agent #13869. <a class="hm-link" href="/api">The three routes <span aria-hidden="true">→</span></a></p>
      </div>
      <div class="hm-term" tabindex="-1" data-term aria-label="An unpaid call and its 402">
        <pre class="hm-pre"><code><span class="hm-dim">$</span> curl -si "${API}/v1/closure-calendar?symbol=wTCENTx"
<span data-term="status">HTTP/2 402</span>
<span class="hm-dim">PAYMENT-REQUIRED, decoded:</span>
  scheme   <span data-term="scheme">exact</span>
  network  <span data-term="network">eip155:196</span>  <span class="hm-dim">(X Layer)</span>
  amount   <span data-term="amount">10000</span>  <span class="hm-dim" data-term="usd">(USD₮0, $0.01)</span>
  payTo    <span data-term="payTo">0x277c…6068</span>
<span class="hm-dim" data-term="note">Press “Ask without paying” to make this call live.</span></code></pre>
      </div>
    </div>
  </section>

  <section class="hm-section hm-name" aria-labelledby="hm-name-title">
    <h2 class="hm-h2" id="hm-name-title" data-reveal="lines">The name</h2>
    <div class="hm-name-body">
      <p class="hm-name-lede">The Curb Market was New York’s outdoor street exchange. Brokers traded on the pavement of Broad Street, signalling orders up to clerks in the windows above.</p>
      <p>It moved indoors in 1921 and was renamed the American Stock Exchange in 1953. Curb is that market for the hours the exchange is shut.</p>
      <p class="hm-small"><a class="hm-link" href="https://en.wikipedia.org/wiki/American_Stock_Exchange" rel="external">History of the American Stock Exchange <span aria-hidden="true">↗</span></a></p>
    </div>
  </section>

  <footer class="hm-foot" data-hm-foot>
    <p class="hm-foot-mark">Curb</p>
    <p class="hm-foot-line">The market that trades when the exchange is shut. Live on X&nbsp;Layer (chain 196).</p>
    <ul class="hm-foot-links">
      <li><a href="/clock">Clock</a></li><li><a href="/scorecard">Scorecard</a></li><li><a href="/notes">Notes</a></li>
      <li><a href="/depth">Depth</a></li><li><a href="/api">API</a></li><li><a href="/brand">Brand</a></li>
      <li><a href="${API}" rel="external">api.curb.markets <span aria-hidden="true">↗</span></a></li>
    </ul>
    <p class="hm-foot-line hm-dim">OKX AI marketplace agent #13869 · Builder Code <code>dd7u50nckt5e729f</code></p>
  </footer>
</div>`;
}

// ── mount ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface HomeHandle {
  ring: MountedRing;
  dispose(): void;
}

export async function mountHome(root: HTMLElement = document.querySelector('main') ?? document.body): Promise<HomeHandle> {
  await A.boot();
  const reduced = A.reducedMotion();
  const narrow = isNarrow();
  let week = A.week(Date.now());
  if (!root.querySelector('[data-hm]')) root.insertAdjacentHTML('afterbegin', homeMarkup(week));
  const hm = root.querySelector<HTMLElement>('[data-hm]')!;
  // The shell owns the site footer; ours only stands in until it exists.
  if (document.querySelectorAll('footer').length > 1) hm.querySelector('[data-hm-foot]')?.remove();
  hm.dataset.mode = reduced ? 'reduced' : narrow ? 'timer' : 'pin';

  const $ = <T extends Element = HTMLElement>(s: string) => hm.querySelector<T>(s)!;
  const figure = $('.hm-ring');
  const copy = $('.hm-copy');
  const legend = $('.hm-legend');
  const sentence = $('.hm-sentence');
  let captions: Caption[] = weekCaptions(week.slots);
  let captionEls = [...hm.querySelectorAll<HTMLElement>('.hm-caption')];
  const cleanups: Array<() => void> = [];

  let regime: Regime = week.regime;
  let clock: ClockReading | null = null;

  const ring = mountWeekRing(figure, { ...week, regime, reducedMotion: reduced });

  // Paper hours follow whatever ground the shell has painted (lane A flips the theme), not this page's own clock
  // read: a light ground puts the ring in its ink window, so amber never touches ivory.
  const syncPaper = () => {
    const g = cssToRgb(getComputedStyle(hm).getPropertyValue('--hm-ground').trim());
    hm.toggleAttribute('data-paper', !!g && 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2] > 0.5);
  };
  syncPaper();
  const themeWatch = new MutationObserver(syncPaper);
  themeWatch.observe(document.documentElement, { attributes: true });
  cleanups.push(() => themeWatch.disconnect());

  // ── the unroll: progress → ring + DOM (DOM only changes at thresholds; transitions do the motion) ──
  let domKey = '';
  const apply = (p: number) => {
    ring.setProgress(p);
    const k = captionAt(p);
    const key = [p < 0.18 ? 1 : 0, p >= UNROLL.sweep[0] ? 1 : 0, k, p >= UNROLL.needle[0] + 0.04 ? 1 : 0].join();
    if (key === domKey) return;
    domKey = key;
    copy.classList.toggle('is-away', !narrow && !reduced && p >= 0.18);
    legend.classList.toggle('is-on', p >= UNROLL.sweep[0]);
    captionEls.forEach((li, i) => {
      li.classList.toggle('is-on', k >= i);
      li.classList.toggle('is-now', k === i);
    });
    sentence.classList.toggle('is-on', p >= UNROLL.needle[0] + 0.04);
    hm.classList.toggle('is-unrolled', p >= UNROLL.needle[0] + 0.04);
  };

  const proxy = { p: 0 };
  if (reduced) {
    apply(1);
  } else if (narrow) {
    // < 768 px: no pin; play once on a timer when the ring is 40% in view.
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        gsap.to(proxy, { p: 1, duration: 5.6, ease: 'none', onUpdate: () => apply(proxy.p) });
      },
      { threshold: 0.4 },
    );
    io.observe(figure);
    cleanups.push(() => io.disconnect());
  } else {
    gsap.registerPlugin(ScrollTrigger);
    const tween = gsap.to(proxy, {
      p: 1,
      ease: 'none',
      scrollTrigger: { trigger: $('.hm-unroll'), start: 'top top', end: 'bottom bottom', scrub: 0.6 },
      onUpdate: () => apply(proxy.p),
    });
    cleanups.push(() => tween.scrollTrigger?.kill());
    apply(0);
  }

  // ── live: schedule every slot boundary, the clock, the sentence and the now-line ──
  const nowEls = Object.fromEntries([...hm.querySelectorAll<HTMLElement>('[data-now]')].map((n) => [n.dataset.now, n]));
  const renderLive = () => {
    const shut = regime !== 'open';
    const [changeSlot] = nextChange(week);
    const open = nextOpen(week);
    const reopen = open ? when(open[0], week.nowIndex) : null;
    sentence.textContent = shut
      ? `It is ${hktNow()} in Hong Kong. The exchange is shut and wTCENTx is trading on X Layer.${reopen ? ` It reopens at ${reopen} HKT.` : ''}`
      : `It is ${hktNow()} in Hong Kong. The exchange is open; Curb goes dark at ${when(changeSlot, week.nowIndex)} HKT.`;
    nowEls.regime.textContent = clock ? (clock.stale ? 'stale' : shut ? 'shut' : 'open') : shut ? 'shut (schedule)' : 'open (schedule)';
    nowEls.cap.textContent = clock ? `cap $${fmtInt(clock.capUsd)}` : 'cap —';
    if (clock?.attestedAt) {
      const mins = Math.max(0, Math.round((Date.now() - clock.attestedAt) / 60_000));
      nowEls.attested.innerHTML = `attested ${mins} min ago${clock.block ? ` · <a class="hm-link" href="https://www.oklink.com/x-layer/block/${clock.block}" rel="external">block ${fmtInt(clock.block)} <span aria-hidden="true">↗</span></a>` : ''}`;
    }
  };
  const countdown = () => {
    const target = shutNow() ? nextOpen(week) : nextChange(week);
    if (!target) return;
    const s = Math.max(0, Math.floor((target[1] - Date.now()) / 1000));
    const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    const cells = hms.replace(/\d/g, (d) => `<span class="hm-digit">${d}</span>`);
    nowEls.next.innerHTML = `${shutNow() ? 'reopens' : 'shuts'} ${when(target[0], week.nowIndex)} HKT in <span class="hm-count">${cells}</span>`;
  };
  const shutNow = () => regime !== 'open';

  const tickSlot = () => {
    const w = A.week(Date.now());
    const changed = w.nowIndex !== week.nowIndex || w.weekStart !== week.weekStart;
    week = w;
    if (!clock) regime = w.regime; // the schedule speaks only until MarketClock does
    if (changed) {
      ring.setSlots(w.slots, w.nowIndex, regime);
      const next = weekCaptions(w.slots);
      if (next.map((c) => c.text).join() !== captions.map((c) => c.text).join()) {
        captions = next;
        $('.hm-captions').innerHTML = captions.map((c) => `<li class="hm-caption">${esc(c.text)}</li>`).join('');
        captionEls = [...hm.querySelectorAll<HTMLElement>('.hm-caption')];
        domKey = '';
        apply(reduced ? 1 : proxy.p);
      }
      $('#hm-ring-text').textContent = ringText(w);
    }
    renderLive();
  };
  const poll = async () => {
    try {
      const c = await A.clock();
      if (c) {
        const attested = clock?.attestedAt !== c.attestedAt && clock !== null;
        clock = c;
        const next: Regime = c.stale || c.regime === 'UNKNOWN' ? 'unknown' : c.regime === 'MARKET' && c.capUsd > 0 ? 'open' : 'shut';
        if (next !== regime) {
          regime = next;
          ring.setRegime(regime);
        }
        if (attested) ring.pulse();
        hm.dataset.regime = regime;
      } else if (!clock) {
        nowEls.attested.textContent = 'clock unavailable; showing the published schedule';
      }
    } catch {
      if (!clock) nowEls.attested.textContent = 'clock unavailable; showing the published schedule';
    }
    renderLive();
  };
  tickSlot();
  countdown();
  void poll();
  const t1 = window.setInterval(countdown, 1000);
  const t2 = window.setInterval(tickSlot, 15_000); // cheap; only re-lays the ring when the slot changes
  const t3 = window.setInterval(() => document.visibilityState === 'visible' && poll(), 60_000);
  cleanups.push(() => [t1, t2, t3].forEach(clearInterval));

  // ── the record: live tally, never hard-coded ──
  void A.skill().then((s) => {
    const line = $('[data-record="line"]');
    if (!s) {
      line.textContent = 'The Scorecard could not be read just now.';
      return;
    }
    $('[data-record="settled"]').textContent = fmtInt(s.settled);
    const wins = s.beatLastPrint + s.beatClosingVwap;
    line.textContent = `${s.settled === 1 ? 'mark' : 'marks'} committed before a reopen and graded by the chain. ${
      wins === 0
        ? `No wins${s.ties !== undefined ? `, ${fmtInt(s.ties)} ${s.ties === 1 ? 'tie' : 'ties'}` : ''}.`
        : `Beat the last print ${fmtInt(s.beatLastPrint)}×; beat the closing VWAP ${fmtInt(s.beatClosingVwap)}×.`
    }`;
    $('[data-record="asof"]').textContent =
      s.asOf.source === 'chain' && s.asOf.block
        ? `As of block ${fmtInt(s.asOf.block)}.`
        : `As of ${UTC.format(new Date(s.asOf.at))} UTC, via api.curb.markets.`;
  });

  // ── instruments: Notes / Depth say "in build" until their addresses exist ──
  for (const key of ['notes', 'depth'] as const) {
    const li = hm.querySelector<HTMLElement>(`[data-inst="${key}"]`);
    if (li && A.live(key)) {
      li.querySelector('[data-inst-date]')!.textContent = 'live';
      li.classList.add('is-live');
    }
  }

  // ── for agents: a real unpaid call, decoded ──
  const ask = $<HTMLButtonElement>('[data-ask]');
  const onAsk = async () => {
    ask.disabled = true;
    const term = $('[data-term]');
    const set = (k: string, v: string) => (term.querySelector(`[data-term="${k}"]`)!.textContent = v);
    set('note', 'Calling…');
    try {
      const p = await A.paywall('/v1/closure-calendar?symbol=wTCENTx');
      const a = p.accepts[0];
      set('status', `HTTP/2 ${p.status}`);
      if (a) {
        set('scheme', a.scheme);
        set('network', a.network);
        set('amount', a.amount);
        set('usd', `(${a.extra?.name ?? 'USD₮0'}, $${(Number(a.amount) / 1e6).toFixed(2)})`);
        set('payTo', `${a.payTo.slice(0, 6)}…${a.payTo.slice(-4)}`);
      }
      set('note', `Live at ${UTC.format(new Date(p.at))} UTC. No payment was made.`);
    } catch {
      set('note', 'The API did not answer just now. Try again in a moment.');
    } finally {
      ask.disabled = false;
      term.focus();
    }
  };
  ask.addEventListener('click', onAsk);
  cleanups.push(() => ask.removeEventListener('click', onAsk));

  A.reveal(hm);
  document.fonts?.ready.then(() => ScrollTrigger.refresh?.());

  return {
    ring,
    dispose() {
      cleanups.forEach((f) => f());
      ring.dispose();
    },
  };
}

// Entry: index.html loads this module. (If lane A's boot() mounts pages itself, delete this line and export only.)
if (typeof document !== 'undefined' && document.querySelector('main')) void mountHome();
