/**
 * The home page's markup, as a pure string (no DOM, no network), so it can be written into index.html at
 * author time for LCP and hydrated by page.ts. Regenerate with `node web/lab/ring/scripts/home-markup.mjs`.
 *
 * Everything time-dependent (now, the regime, the countdown, the record, the live 402) is filled in by
 * page.ts; the static text here is true for any week. Captions come from the week's slots; if the live week
 * differs (a holiday), page.ts re-renders them on hydrate.
 */
import { posterMarkup } from '../../ring/poster';
import { SLOTS, formatDuration, slotClock, slotDay, weekCaptions } from '../../ring/layout';
import type { WeekInput } from '../../ring/layout';
import { escapeHTML as esc } from '../../ui/html';

const API = 'https://api.curb.markets';
const ARROW = '<span class="arrow" aria-hidden="true">→</span>';
const EXT = '<span class="arrow arrow--ext" aria-hidden="true">→</span>';

export const CUT = [
  ['11:55', 'Cap to zero', 'Five minutes before the lunch bell, the issuer’s order cap goes to zero. Creation and redemption stop; the pool keeps trading.'],
  ['12:00', 'The bell', 'Hong Kong breaks for lunch. On X Layer nothing pauses.'],
  ['12:50', 'Commit', 'Curb’s keeper writes its reopen mark on chain, before anyone can know the price.'],
  ['13:00', 'Reopen', 'The exchange reopens and the cap returns.'],
  ['13:05', 'Settle', 'Scorecard reads the pool itself and grades the mark against the last print and the closing VWAP.'],
] as const;

export const INSTRUMENTS = [
  { key: 'clock', name: 'Clock', href: '/clock', date: '14 Sep', line: 'Per asset, is the primary market open now, attested every five minutes.' },
  { key: 'scorecard', name: 'Scorecard', href: '/scorecard', date: '21 Sep', line: 'Every mark committed before the reopen, graded by the chain.' },
  { key: 'api', name: 'API', href: '/api', date: '24 Sep', line: 'Three priced routes for agents, paid per call over x402.' },
  { key: 'notes', name: 'Notes', href: '/notes', date: null, line: 'Sell the reopen, not the asset.' },
  { key: 'depth', name: 'Depth', href: '/depth', date: null, line: 'Bond the depth you quote; see the LTV move.' },
] as const;

/** Text equivalent of the ring (the canvas is aria-hidden). `now` adds the live sentence. */
export function ringText(w: WeekInput, now = false): string {
  const shutMin = w.slots.reduce((a, s) => a + s, 0) * 5;
  const base = `This week in Hong Kong, as 2,016 five-minute slots: the exchange is open for ${formatDuration(
    SLOTS * 5 - shutMin,
  )} and shut for ${formatDuration(shutMin)}, and the pools trade through all of it.`;
  return now
    ? `${base} Now is ${slotDay(w.nowIndex)} ${slotClock(w.nowIndex)} HKT; the exchange is ${w.slots[w.nowIndex] ? 'shut' : 'open'}.`
    : base;
}

export const captionItems = (w: WeekInput) =>
  weekCaptions(w.slots)
    .map((c) => `<li class="hm-caption">${esc(c.text)}</li>`)
    .join('');

export function homeMarkup(w: WeekInput): string {
  return `<div class="hm-home" data-hm>
  <section class="hm-unroll" aria-labelledby="hm-title">
    <div class="hm-stage">
      <div class="hm-copy">
        <h1 class="hm-title t-hero vt-title-home" id="hm-title" data-reveal>The market that trades when the exchange is <em>shut</em>.</h1>
        <p class="hm-lede">Tokenized Tencent keeps trading on X&nbsp;Layer for 141&nbsp;h&nbsp;20&nbsp;m of every 168. Curb records the hours, marks the reopen, and lets you exit without selling.</p>
        <p class="hm-ctas">
          <a class="btn btn--primary hm-cta" href="/clock"><span class="btn__label">Read the clock${ARROW}</span></a>
          <a class="hm-link" href="${API}" rel="external">Ask the API${EXT}</a>
        </p>
      </div>
      <figure class="hm-ring surface-ink vt-week-ring" aria-describedby="hm-ring-text">
        ${posterMarkup('hm-poster')}
        <canvas class="hm-canvas" aria-hidden="true"></canvas>
        <figcaption class="visually-hidden" id="hm-ring-text">${esc(ringText(w))}</figcaption>
      </figure>
      <div class="hm-ledger">
        <p class="hm-legend" aria-hidden="true">
          <span class="hm-key"><span class="hm-swatch surface-ink"><span class="hm-swatch-bar hm-swatch-bar--open"></span></span>Exchange open</span>
          <span class="hm-key"><span class="hm-swatch surface-ink"><span class="hm-swatch-bar hm-swatch-bar--shut"></span></span>Shut, still trading</span>
          <span class="hm-key hm-key--data">2,016 five-minute slots from Mon 00:00 HKT</span>
        </p>
        <ol class="hm-captions">${captionItems(w)}</ol>
        <p class="hm-sentence"></p>
      </div>
      <p class="hm-now vt-now-line" aria-label="Now">
        <span class="hm-now-k">now</span>
        <span class="hm-now-v">wTCENTx</span>
        <span class="hm-now-v" data-now="regime">shut</span>
        <span class="hm-now-v" data-now="cap">cap —</span>
        <span class="hm-now-v" data-now="next"><span data-now="nextlabel">reopens —</span> in <span class="hm-count" data-now="count">--:--:--</span></span>
        <span class="hm-now-v" data-now="attested">reading MarketClock on X Layer…</span>
      </p>
    </div>
  </section>

  <section class="hm-section hm-cut" aria-labelledby="hm-cut-title">
    <h2 class="hm-h2 t-h2" id="hm-cut-title" data-reveal>The cut</h2>
    <p class="hm-intro">Every trading day in Hong Kong has two. This is the lunch cut, in the order it happens (HKT).</p>
    <ol class="hm-cut-list">
      ${CUT.map(([t, k, d]) => `<li class="hm-cut-step"><time class="hm-cut-time">${t}</time><strong class="hm-cut-name">${k}</strong><span class="hm-cut-text">${esc(d)}</span></li>`).join('\n      ')}
    </ol>
  </section>

  <section class="hm-section hm-record" aria-labelledby="hm-record-title">
    <h2 class="hm-h2 t-h2" id="hm-record-title" data-reveal>The record</h2>
    <div class="hm-record-body">
      <p class="hm-numeral" data-record="settled" aria-describedby="hm-record-line">&nbsp;</p>
      <div>
        <p class="hm-record-line" id="hm-record-line" data-record="line">Reading <code>Scorecard.skill()</code> on X&nbsp;Layer…</p>
        <p class="hm-record-tie">A tie is not a win.</p>
        <p class="hm-asof" data-record="asof">&nbsp;</p>
        <p><a class="hm-link" href="/scorecard">Read the Scorecard${ARROW}</a></p>
      </div>
    </div>
  </section>

  <section class="hm-section hm-instruments" aria-labelledby="hm-inst-title">
    <h2 class="hm-h2 t-h2" id="hm-inst-title" data-reveal>Instruments</h2>
    <ol class="hm-inst-list">
      ${INSTRUMENTS.map(
        (i) => `<li class="hm-inst" data-inst="${i.key}">
        <span class="hm-inst-date" data-inst-date>${i.date ?? 'in build'}</span>
        <a class="hm-inst-name" href="${i.href}">${i.name}${ARROW}</a>
        <span class="hm-inst-line">${esc(i.line)}</span>
      </li>`,
      ).join('\n      ')}
    </ol>
  </section>

  <section class="hm-section hm-agents" aria-labelledby="hm-agents-title">
    <h2 class="hm-h2 t-h2" id="hm-agents-title" data-reveal>For agents</h2>
    <div class="hm-agents-body">
      <div class="hm-agents-copy">
        <p>Ask without paying and you get a price and a free preview. Pay one cent from an OKX Agentic Wallet and you get the answer, with a receipt that ties the payment to the exact bytes you received.</p>
        <p><button class="btn btn--primary" type="button" data-ask><span class="btn__label">Ask without paying</span></button></p>
        <p class="hm-small">Listed on OKX’s AI marketplace as agent #13869. <a class="hm-link" href="/api">The three routes${ARROW}</a></p>
      </div>
      <div class="hm-term surface-ink" tabindex="-1" data-term aria-label="An unpaid call and its 402">
        <pre class="hm-pre"><code><span class="hm-dim">$</span> curl -si "${API}/v1/closure-calendar?symbol=wTCENTx"
<span class="hm-status" data-term="status">HTTP/2 402</span>
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
    <h2 class="hm-h2 t-h2" id="hm-name-title" data-reveal>The name</h2>
    <div class="hm-name-body">
      <p class="hm-name-lede">The Curb Market was New York’s outdoor street exchange. Brokers traded on the pavement of Broad Street, signalling orders up to clerks in the windows above.</p>
      <p>It moved indoors in 1921 and was renamed the American Stock Exchange in 1953. Curb is that market for the hours the exchange is shut.</p>
      <p class="hm-small"><a class="hm-link" href="https://en.wikipedia.org/wiki/American_Stock_Exchange" rel="external">History of the American Stock Exchange${EXT}</a></p>
    </div>
  </section>
</div>`;
}
