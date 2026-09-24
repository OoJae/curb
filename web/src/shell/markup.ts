/**
 * Static shell markup (masthead, footer ledger, grain). Pure string functions with no DOM access:
 * the `curb-shell` plugin in vite.config.ts writes this into every page's HTML at build (and dev)
 * time, so the masthead exists on first paint (no layout shift, and it can persist across the
 * cross-document view transition). The shell's runtime modules only attach behaviour to it.
 */
import { glyphSVG, markSVG } from './mark.ts';

export type PageId = 'home' | 'clock' | 'scorecard' | 'api' | 'notes' | 'depth' | 'brand' | '404';

export interface PageInfo {
  path: string;
  label: string;
  /** CSS class prefix for this page's page.css (enforced by convention, see README). */
  prefix: string;
}

export const PAGES: Record<PageId, PageInfo> = {
  home: { path: '/', label: 'Curb', prefix: 'hm-' },
  clock: { path: '/clock', label: 'Clock', prefix: 'clk-' },
  scorecard: { path: '/scorecard', label: 'Scorecard', prefix: 'sc-' },
  notes: { path: '/notes', label: 'Notes', prefix: 'nt-' },
  depth: { path: '/depth', label: 'Depth', prefix: 'dp-' },
  api: { path: '/api', label: 'API', prefix: 'api-' },
  brand: { path: '/brand', label: 'Brand', prefix: 'br-' },
  '404': { path: '/404', label: 'Not found', prefix: 'nf-' },
};

/** Primary navigation order (spec: Clock · Scorecard · Notes · Depth · API). */
export const NAV: PageId[] = ['clock', 'scorecard', 'notes', 'depth', 'api'];

export const EXTERNAL = {
  api: 'https://api.curb.markets',
  oklink: 'https://www.oklink.com/xlayer',
  builderCode: 'dd7u50nckt5e729f',
  agentId: '13869',
} as const;

export function isPageId(v: string | undefined | null): v is PageId {
  return !!v && Object.prototype.hasOwnProperty.call(PAGES, v);
}

/** Typographic arrow. `ext` is a → rotated to ↗ (no face ships U+2197). Decorative. */
export function arrowHTML(kind: 'int' | 'ext' = 'int'): string {
  return `<span class="arrow${kind === 'ext' ? ' arrow--ext' : ''}" aria-hidden="true">→</span>`;
}

/** The mark split into two stacked layers so the amber arc can step in the page transition. */
export function markTileHTML(extraClass = ''): string {
  return (
    `<span class="mark-tile${extraClass ? ` ${extraClass}` : ''}" aria-hidden="true">` +
    markSVG({ layer: 'c', className: 'mark-tile__c' }) +
    markSVG({ layer: 'arc', className: 'mark-tile__arc' }) +
    `</span>`
  );
}

export function mastheadHTML(page: PageId): string {
  const nav = NAV.map((id) => {
    const p = PAGES[id];
    const current = id === page ? ' aria-current="page"' : '';
    return `<li><a class="nav-link" href="${p.path}"${current}><span class="nav-link__label">${p.label}</span></a></li>`;
  }).join('');
  const homeCurrent = page === 'home' ? ' aria-current="page"' : '';
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="masthead" data-shell="masthead">
  <div class="masthead__bar wrap">
    <a class="masthead__brand" href="/"${homeCurrent} aria-label="Curb, home">${markTileHTML('masthead__mark')}<span class="masthead__word" aria-hidden="true">Curb</span></a>
    <nav class="masthead__nav" aria-label="Primary"><ul role="list">${nav}</ul></nav>
    <div class="masthead__regime">
      <button type="button" class="chip" data-shell="chip" popovertarget="regime-popover">
        <span class="chip__glyph" data-chip-glyph>${glyphSVG('shut', { className: 'chip__svg' })}</span>
        <span class="chip__label" data-chip-label>Shut</span>
        <span class="chip__sep" aria-hidden="true">·</span>
        <span class="chip__time" data-chip-time><span class="chip__hhmm">--:--</span> HKT</span>
      </button>
      <div class="chip-pop" id="regime-popover" popover role="dialog" aria-label="Hong Kong hours" data-shell="chip-popover">
        <p class="chip-pop__lead" data-chip-sentence>Reading MarketClock on X Layer.</p>
        <dl class="chip-pop__facts">
          <div><dt>Asset</dt><dd>wTCENTx</dd></div>
          <div><dt>Primary cap</dt><dd data-chip-cap>—</dd></div>
          <div><dt>Attested</dt><dd data-chip-attested>—</dd></div>
          <div><dt>Block</dt><dd data-chip-block>—</dd></div>
        </dl>
        <div class="chip-pop__actions">
          <button type="button" class="btn btn--quiet chip-pop__preview" data-chip-preview aria-pressed="false">Preview paper hours</button>
          <a class="link-arrow" href="/clock">Read the clock ${arrowHTML('int')}</a>
        </div>
      </div>
    </div>
  </div>
</header>
<div class="visually-hidden" aria-live="polite" data-shell="announcer"></div>`;
}

export function footerHTML(page: PageId): string {
  const instruments = NAV.map((id) => {
    const p = PAGES[id];
    const current = id === page ? ' aria-current="page"' : '';
    return `<a href="${p.path}"${current}>${p.label}</a>`;
  }).join('<span class="ledger__dot" aria-hidden="true"> · </span>');
  return `<footer class="footer-ledger" data-shell="footer">
  <div class="wrap">
    <figure class="footer-ledger__week">
      <div class="slotstrip footer-ledger__strip" data-footer-strip aria-hidden="true"></div>
      <figcaption class="footer-ledger__caption" data-footer-week>This week in Hong Kong, five minutes to a mark: ivory while the exchange is open, amber while it is shut and wTCENTx still trades.</figcaption>
    </figure>
    <dl class="ledger footer-ledger__rows">
      <div class="ledger__row"><dt>Now</dt><dd class="t-ledger" data-footer-now>wTCENTx · reading MarketClock</dd></div>
      <div class="ledger__row"><dt>Instruments</dt><dd>${instruments}</dd></div>
      <div class="ledger__row"><dt>For agents</dt><dd><a href="${EXTERNAL.api}" rel="noopener">api.curb.markets${arrowHTML('ext')}</a><span class="ledger__dot" aria-hidden="true"> · </span>OKX AI marketplace, agent #${EXTERNAL.agentId}</dd></div>
      <div class="ledger__row"><dt>Chain</dt><dd>X Layer, chain 196<span class="ledger__dot" aria-hidden="true"> · </span>Builder Code <code>${EXTERNAL.builderCode}</code></dd></div>
      <div class="ledger__row"><dt>Identity</dt><dd><a href="/brand"${page === 'brand' ? ' aria-current="page"' : ''}>Colours, type and the mark ${arrowHTML('int')}</a></dd></div>
    </dl>
    <p class="footer-ledger__sign">${markTileHTML('footer-ledger__mark')}<span>Curb keeps Hong Kong’s hours.</span></p>
  </div>
</footer>
<div class="grain" aria-hidden="true"></div>`;
}
