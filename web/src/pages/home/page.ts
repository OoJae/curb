/**
 * Home (/): make the closure felt, then hand off to the proof.
 *
 * Sections: hero + the unroll (the Week Ring, pinned 250vh) · the cut · the record · instruments · for agents ·
 * the name. The markup is static in index.html (markup.ts renders it; LCP is the hero H1 / poster); this module
 * hydrates it. Desktop pins with CSS sticky and scrubs with ScrollTrigger (scrub 0.6); under 768 px there is no
 * pin and the unroll plays once on a timer when the ring is 40% in view; under reduced motion everything renders
 * in its final state (the ring draws once, in 2D, and three.js is never fetched).
 */
import { boot } from '../../shell/boot';
import './page.css';
import { hktWhen } from '../../shell/regime-chip';
import type { RegimeReading } from '../../shell/regime';
import { prefersReducedMotion } from '../../motion/reduced';
import { nextChange, weekSlots } from '../../data/schedule';
import { getRecord } from '../../data/record';
import { askWithoutPaying, formatUsd6 } from '../../data/api';
import { CLOSED_AUCTION, DEPTH_CERT, REOPEN_NOTE, oklinkBlock } from '../../data/addresses';
import { countdown } from '../../ui/countdown';
import type { CountdownHandle } from '../../ui/countdown';
import { fmtAgo, fmtInt } from '../../ui/format';
import { mountWeekRing } from '../../ring/poster';
import { UNROLL, captionAt, isNarrow, slotsFromOpen } from '../../ring/layout';
import type { Regime, WeekInput } from '../../ring/layout';
import { captionItems, homeMarkup, ringText } from './markup';

interface Week extends WeekInput {
  weekStart: number;
}

/** data/schedule.ts → the ring's input. */
function readWeek(nowMs: number): Week {
  const w = weekSlots(nowMs);
  return { slots: slotsFromOpen(w.open), nowIndex: w.nowIndex, regime: w.open[w.nowIndex] ? 'open' : 'shut', weekStart: w.weekStartMs };
}

const HKT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const UTC = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const shell = boot({ page: 'home' });

function mount(): void {
  const main = shell.main;
  let week = readWeek(Date.now());
  if (!main.querySelector('[data-hm]')) main.innerHTML = homeMarkup(week); // index.html normally carries it
  const hm = main.querySelector<HTMLElement>('[data-hm]')!;
  const $ = <T extends Element = HTMLElement>(s: string) => hm.querySelector<T>(s)!;

  const reduced = prefersReducedMotion();
  const narrow = isNarrow();
  hm.dataset.mode = reduced ? 'reduced' : narrow ? 'timer' : 'pin';

  const figure = $('.hm-ring');
  const copy = $('.hm-copy');
  const legend = $('.hm-legend');
  const sentence = $('.hm-sentence');
  const captionList = $('.hm-captions');
  let captionEls: HTMLElement[] = [];
  const syncCaptions = () => {
    const html = captionItems(week);
    if (captionList.innerHTML !== html) captionList.innerHTML = html;
    captionEls = [...captionList.querySelectorAll<HTMLElement>('.hm-caption')];
  };
  syncCaptions();
  $('#hm-ring-text').textContent = ringText(week, true);

  let regime: Regime = shell.regime.get().shown;
  const ring = mountWeekRing(figure, { ...week, regime, reducedMotion: reduced });

  // Paper hours: the ring's ink window must not sit under the hero copy (ink text on ink). Measure how far the
  // copy's text actually reaches into the ring's box and let CSS clip the window (and canvas) past it.
  const fitWindow = () => {
    if (narrow) return;
    const range = document.createRange();
    let right = 0;
    for (const el of copy.querySelectorAll('.hm-title, .hm-lede, .hm-ctas')) {
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) right = Math.max(right, r.right);
    }
    const inset = Math.max(0, Math.ceil(right + 24 - figure.getBoundingClientRect().left));
    figure.style.setProperty('--hm-window-inset', `${inset}px`);
  };
  new ResizeObserver(fitWindow).observe($('.hm-stage'));
  void shell.ready.then(fitWindow);

  // ── the unroll: progress → ring + DOM (the DOM changes only at thresholds; CSS transitions do the motion) ──
  let domKey = '';
  let progress = 0;
  const apply = (p: number) => {
    progress = p;
    ring.setProgress(p);
    const k = captionAt(p);
    const done = p >= UNROLL.needle[0] + 0.04;
    const key = `${p < 0.18 ? 1 : 0}${p >= UNROLL.sweep[0] ? 1 : 0}${k}${done ? 1 : 0}${captionEls.length}`;
    if (key === domKey) return;
    domKey = key;
    copy.classList.toggle('is-away', !narrow && !reduced && p >= 0.18);
    legend.classList.toggle('is-on', p >= UNROLL.sweep[0]);
    captionEls.forEach((li, i) => {
      li.classList.toggle('is-on', k >= i);
      li.classList.toggle('is-now', k === i);
    });
    sentence.classList.toggle('is-on', done);
    hm.classList.toggle('is-unrolled', done);
  };

  if (reduced) {
    apply(1);
  } else if (narrow) {
    // < 768 px: no pin; the unroll plays once, linearly, when the ring is 40% in view.
    apply(0);
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / 5600);
          apply(p);
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(figure);
  } else {
    apply(0);
    void Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(([{ gsap }, { ScrollTrigger }]) => {
      gsap.registerPlugin(ScrollTrigger);
      const proxy = { p: progress };
      gsap.to(proxy, {
        p: 1,
        ease: 'none',
        scrollTrigger: { trigger: $('.hm-unroll'), start: 'top top', end: 'bottom bottom', scrub: 0.6 },
        onUpdate: () => apply(proxy.p),
      });
      void shell.ready.then(() => ScrollTrigger.refresh());
    });
  }

  // ── live: the regime (the shell's store, fed by data/regime.ts), the schedule, the now-line, the sentence ──
  const now = Object.fromEntries([...hm.querySelectorAll<HTMLElement>('[data-now]')].map((n) => [n.dataset.now!, n]));
  let reading: RegimeReading | null = null;
  let cd: CountdownHandle | null = null;
  const renderLive = () => {
    const t = Date.now();
    const next = nextChange(t); // the published schedule's next cut or reopen (MarketClock's nextTransitionAt is not the reopen)
    const when = next ? hktWhen(next.atMs, t) : null;
    const verb = next?.kind === 'reopen' ? 'reopens' : 'shuts';
    if (next) {
      now.nextlabel!.textContent = `${verb} ${when}`;
      if (cd) cd.set(next.atMs);
      else cd = countdown(now.count!, { target: next.atMs, format: 'hms', boxed: true, label: `${verb === 'reopens' ? 'Reopens' : 'Shuts'} in`, onDone: renderLive });
    }
    const clock = HKT.format(t);
    const then = !when ? '' : next?.kind === 'reopen' ? ` It reopens at ${when}.` : ` Curb goes dark at ${when}.`;
    sentence.textContent =
      regime === 'open'
        ? `It is ${clock} in Hong Kong. The exchange is open.${then}`
        : regime === 'unknown'
          ? `It is ${clock} in Hong Kong. The clock is stale, so the site keeps street hours.${then}`
          : `It is ${clock} in Hong Kong. The exchange is shut and wTCENTx is trading on X Layer.${then}`;
    now.regime!.textContent = regime === 'unknown' ? 'stale' : regime;
    now.cap!.textContent = reading?.cap != null ? `cap $${fmtInt(reading.cap)}` : 'cap —';
    if (reading && reading.source !== 'fallback') {
      const block = reading.block ? ` · <a class="hm-link hm-link--data" href="${oklinkBlock(reading.block)}" rel="external">block ${fmtInt(reading.block)}<span class="arrow arrow--ext" aria-hidden="true">→</span></a>` : '';
      now.attested!.innerHTML = `attested ${fmtAgo(reading.asOfMs, t)}${block}`;
    } else if (shell.regime.get().settled) {
      now.attested!.textContent = 'clock unavailable · published schedule';
    }
  };
  shell.regime.subscribe((s, prev) => {
    reading = s.reading;
    if (s.shown !== regime) {
      regime = s.shown;
      ring.setRegime(regime);
    }
    if (prev.reading && s.reading && s.reading.asOfMs !== prev.reading.asOfMs) ring.pulse();
    renderLive();
  });

  // Every slot boundary: re-read the week (it only re-lays the ring when "now" moves to a new slot).
  setInterval(() => {
    const w = readWeek(Date.now());
    if (w.nowIndex === week.nowIndex && w.weekStart === week.weekStart) return renderLive();
    week = w;
    ring.setSlots(w.slots, w.nowIndex, regime);
    syncCaptions();
    $('#hm-ring-text').textContent = ringText(w, true);
    domKey = '';
    apply(progress);
    renderLive();
  }, 15_000);

  // ── the record: live tally (chain first, API preview as the fallback), never hard-coded ──
  void getRecord()
    .then((r) => {
      $('[data-record="settled"]').textContent = fmtInt(r.settled);
      const wins = r.beatLastPrint + r.beatClosingVwap;
      const of = r.closureCount != null ? ` of ${fmtInt(r.closureCount)} committed before a reopen` : '';
      $('[data-record="line"]').textContent = `${r.settled === 1 ? 'mark' : 'marks'} graded by the chain${of}. ${
        wins === 0
          ? 'No wins.'
          : `Beat the last print ${fmtInt(r.beatLastPrint)}×; beat the closing VWAP ${fmtInt(r.beatClosingVwap)}×.`
      }`;
      $('[data-record="asof"]').innerHTML =
        r.block != null
          ? `As of <a class="hm-link hm-link--data" href="${oklinkBlock(r.block)}" rel="external">block ${fmtInt(r.block)}<span class="arrow arrow--ext" aria-hidden="true">→</span></a>${r.source === 'fixture' ? ' (fixture)' : ''}.`
          : `As of ${UTC.format(new Date(r.readAtMs))} UTC, via api.curb.markets.`;
    })
    .catch(() => {
      $('[data-record="line"]').textContent = 'The Scorecard could not be read just now.';
    });

  // ── instruments: Notes / Depth read "in build" until their addresses are set in data/addresses.ts ──
  const live = { notes: REOPEN_NOTE !== null && CLOSED_AUCTION !== null, depth: DEPTH_CERT !== null };
  for (const key of ['notes', 'depth'] as const) {
    const li = hm.querySelector<HTMLElement>(`[data-inst="${key}"]`);
    if (li && live[key]) {
      li.querySelector('[data-inst-date]')!.textContent = 'live';
      li.classList.add('is-live');
    }
  }

  // ── for agents: a real unpaid call, decoded ──
  const ask = $<HTMLButtonElement>('[data-ask]');
  ask.addEventListener('click', async () => {
    ask.disabled = true;
    const term = $('[data-term]');
    const set = (k: string, v: string) => (term.querySelector(`[data-term="${k}"]`)!.textContent = v);
    set('note', 'Calling…');
    try {
      const u = await askWithoutPaying('/v1/closure-calendar', { symbol: 'wTCENTx' });
      const a = u.paymentRequired?.accepts[0];
      set('status', `HTTP/2 ${u.status}`);
      if (a) {
        set('scheme', a.scheme);
        set('network', a.network);
        set('amount', a.amount);
        set('usd', `(${a.extra?.name ?? 'USD₮0'}, ${formatUsd6(a.amount)})`);
        set('payTo', `${a.payTo.slice(0, 6)}…${a.payTo.slice(-4)}`);
      }
      set('note', `${u.source === 'api' ? 'Live' : 'Fixture'} at ${UTC.format(new Date(u.readAtMs))} UTC. No payment was made.`);
    } catch {
      set('note', 'The API did not answer just now. Try again in a moment.');
    } finally {
      ask.disabled = false;
      term.focus();
    }
  });
}

mount();
