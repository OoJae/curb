/**
 * /brand — the single source of the identity: colours with live contrast, type, the mark and its rules, regime
 * glyphs, motion specimens, the guilloche and every file. All colours and sizes are read from the site's tokens.
 */
import './page.css';
import { startShell, pageRoot, TOKENS, TYPE_SCALE, type TokenId } from './shell-adapter';
import { tokenRGB, hex, ratio, grade, type RGB } from './contrast';
import { SPECIMENS, reduced } from './motion';
import { C_HALF_GAP, MARK_ARC, MARK_BOX, MARK_C, MARK_CENTRE, GLYPH_C, GLYPH_ARC, GLYPH_RING, GLYPH_DOTS } from './mark-data';
import { guilloche, guillocheSvg } from '../../certificate/guilloche';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A settlement tx hash from the first paid API call: a real 32-byte seed for the default rosette. */
const SPECIMEN_SEED = '0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7';

// Where each colour may and may not sit (spec §1 laws). Keyed [colour][ground].
const RULES: Record<TokenId, { ink: string; ivory: string }> = {
  ink: { ink: '—', ivory: 'Figure in paper mode' },
  ivory: { ink: 'Figure on ink', ivory: '—' },
  amber: { ink: 'Allowed: its one meaning', ivory: 'Never. On paper, amber lives in an ink tile' },
  slate: { ink: 'Secondary text', ivory: 'Forbidden' },
  brass: { ink: 'Not used on ink', ivory: 'Signal text, links, focus' },
  graphite: { ink: 'Not used on ink', ivory: 'Secondary text' },
};

// ── sections ──────────────────────────────────────────────────────────────────────────────────────────────────────

function hero(): string {
  return `
  <header class="brand-hero">
    <p class="brand-kicker">Brand</p>
    <h1 class="brand-h1">Street ink, certificate ivory, one <em>streetlamp</em>.</h1>
    <p class="brand-lede">The Curb identity in one place: six colours, three typefaces, one mark and the rules that keep them
    honest. Every value on this page is read from the site’s own tokens.</p>
    <nav class="brand-toc" aria-label="On this page">
      ${['colour', 'type', 'mark', 'glyphs', 'motion', 'guilloche', 'downloads'].map((id) => `<a href="#${id}">${id[0].toUpperCase() + id.slice(1)}</a>`).join('')}
    </nav>
  </header>`;
}

function section(id: string, title: string, ledger: string, instrument: string): string {
  return `
  <section class="brand-sec" id="${id}" aria-labelledby="${id}-h">
    <div class="brand-ledger"><h2 class="brand-h2" id="${id}-h">${title}</h2>${ledger}</div>
    <div class="brand-inst">${instrument}</div>
  </section>`;
}

function colours(): string {
  const chips = TOKENS.map(
    (t) => `
    <figure class="brand-sw brand-sw--${t.id}" data-token="${t.id}">
      <div class="brand-sw-chip"><span class="brand-sw-dot"></span></div>
      <figcaption>
        <b>${esc(t.name)}</b>
        <button type="button" class="brand-copy" data-copy="" aria-label="Copy ${esc(t.name)} hex"><span class="brand-hex">—</span></button>
        <code class="brand-prop">var(${t.prop})</code>
        <span class="brand-role">${esc(t.role)}</span>
      </figcaption>
    </figure>`,
  ).join('');
  const table = `
    <table class="brand-table">
      <caption>Contrast (WCAG 2), read live from the tokens</caption>
      <thead><tr><th scope="col">Colour</th><th scope="col">On Street ink</th><th scope="col">On Certificate ivory</th></tr></thead>
      <tbody>${TOKENS.map((t) => `<tr data-row="${t.id}"><th scope="row">${esc(t.name)}</th><td data-on="ink"></td><td data-on="ivory"></td></tr>`).join('')}</tbody>
    </table>`;
  return section(
    'colour',
    'Colour',
    `<p>Six colours. Street ink is the ground for the 84% of the week that Hong Kong is shut; the site turns to
     Certificate ivory only while the exchange is open.</p>
     <p><b>Law 1.</b> Streetlamp only on ink. On paper, amber lives inside an ink window or tile.</p>
     <p><b>Law 2.</b> Amber never touches ivory.</p>
     <p><b>No red, no green.</b> Wins and losses are said in words and signed basis points.</p>
     <p>Hairlines are <code>color-mix(in oklab, figure 14%, ground)</code>.</p>`,
    `<div class="brand-sws">${chips}</div>${table}`,
  );
}

function type(): string {
  const scale = TYPE_SCALE.map(
    (t) => `<tr><th scope="row"><code>${t.prop}</code></th><td>${esc(t.use)}</td><td class="brand-num" data-size="${t.prop}">—</td></tr>`,
  ).join('');
  return section(
    'type',
    'Type',
    `<p><b>Bodoni Moda</b> for headlines, big static numerals and the wordmark: the engraved Didone of share
     certificates and banknotes. Sentence case only, never tracked capitals, never below 28 px, and one italic word per
     headline.</p>
     <p><b>Libre Franklin</b> for text and interface, at 400, 500 and 600 only: a Franklin Gothic revival, the face of the
     curb-era financial press.</p>
     <p><b>Martian Mono</b> for numbers, hashes, code and timestamps. Width 87 in ledgers reads as condensed ticker tape;
     width 100 for code. Ticking numbers sit in fixed-width cells.</p>`,
    `<div class="brand-window brand-type">
       <p class="brand-spec-label">Bodoni Moda · display</p>
       <p class="brand-spec-hero">The exchange is <em>shut</em>.</p>
       <p class="brand-spec-numeral">141 h 20 m</p>
       <p class="brand-spec-label">Libre Franklin · 400 / 500 / 600</p>
       <p class="brand-spec-text">Tokenized Tencent keeps trading on X Layer while Hong Kong is shut.</p>
       <p class="brand-spec-text brand-w500">Curb records the hours and marks the reopen.</p>
       <p class="brand-spec-text brand-w600">Read the clock →</p>
       <p class="brand-spec-label">Martian Mono · width 87 / 100</p>
       <p class="brand-spec-data">0x160Dc415902971a7a9B5ade7f43005b36FE5B09b</p>
       <p class="brand-spec-code">cast call $CLOCK "stateOf(address)" $WTCENTX</p>
     </div>
     <table class="brand-table"><caption>Type scale (fluid; size at this viewport)</caption>
       <thead><tr><th scope="col">Token</th><th scope="col">Use</th><th scope="col">Now</th></tr></thead><tbody>${scale}</tbody></table>`,
  );
}

/** Construction drawing: the mark with its measured angles and radii. */
function construction(): string {
  const c = MARK_CENTRE;
  const pt = (r: number, deg: number) => [c + r * Math.cos((deg * Math.PI) / 180), c - r * Math.sin((deg * Math.PI) / 180)].map((v) => v.toFixed(1)).join(' ');
  const ray = (deg: number, r0: number, r1: number) => `<path class="brand-cx-ray" d="M${pt(r0, deg)}L${pt(r1, deg)}"/>`;
  const L = 118; // room for the labels on the left
  const Rt = 150; // and on the right
  return `
  <svg class="brand-cx" viewBox="${-L} -22 ${MARK_BOX + L + Rt} ${MARK_BOX + 44}" font-size="10" role="img"
       aria-label="Construction: a C of 236 degrees with a 124 degree gap facing east, stroke 0.42 R; an amber arc of 92 degrees on the centreline, 0.20 R thick, 16 degrees of ink from each end of the C">
    <circle class="brand-cx-guide" cx="${c}" cy="${c}" r="100"/>
    <path class="brand-mk-c" d="${MARK_C}"/><path class="brand-mk-arc" d="${MARK_ARC}"/>
    ${ray(C_HALF_GAP, 20, 142)}${ray(-C_HALF_GAP, 20, 142)}${ray(46, 60, 134)}${ray(-46, 60, 134)}${ray(0, 0, 168)}
    <circle class="brand-cx-dot" cx="${c}" cy="${c}" r="2.5"/>
    <text x="${c + 174}" y="${c + 4}">E · now</text>
    <text x="${pt(146, C_HALF_GAP).split(' ')[0]}" y="${pt(146, C_HALF_GAP).split(' ')[1]}" dx="4">C ends ±${C_HALF_GAP}°</text>
    <text x="${pt(138, 46).split(' ')[0]}" y="${pt(138, 46).split(' ')[1]}" dx="6" dy="6">arc ends ±46°</text>
    <g text-anchor="end"><text x="-14" y="${c - 4}">C 236°, gap 124°</text><text x="-14" y="${c + 12}">stroke 0.42 R</text></g>
    <text x="${c + 138}" y="${c + 70}">arc 92°, 0.20 R thick</text>
    <text x="${c + 138}" y="${c + 86}">on the centreline R</text>
    <text x="${c + 138}" y="${c + 102}">16° of ink to each end</text>
  </svg>`;
}

function mark(): string {
  const tile = (inner: string, cls = '') => `<div class="brand-rule-stage ${cls}">${inner}</div>`;
  const img = (f: string, cls = '', alt = '') => `<img src="/brand/${f}" alt="${esc(alt)}" class="${cls}" loading="lazy" decoding="async">`;
  const inline = (arcCls: string, cls = '') =>
    `<svg class="brand-mk ${cls}" viewBox="0 0 ${MARK_BOX} ${MARK_BOX}" aria-hidden="true"><path class="brand-mk-c" d="${MARK_C}"/><path class="${arcCls}" d="${MARK_ARC}"/></svg>`;
  const rules = [
    ['do', 'The gap faces east: forward in time.', tile(img('mark.svg', 'brand-rule-mark', 'The mark'), 'is-ink')],
    ['do', 'On paper the mark sits inside its ink tile.', tile(img('mark-tile.svg', 'brand-rule-mark', 'The mark on its tile'), 'is-paper')],
    ['do', 'Clear space: half the mark’s diameter on every side.', tile(`<span class="brand-clear">${img('mark.svg', 'brand-rule-mark', '')}</span>`, 'is-ink')],
    ['do', 'Never smaller than 16 px.', tile(`${img('mark.svg', 'brand-px16', '')}${img('mark.svg', 'brand-px24', '')}${img('mark.svg', 'brand-px32', '')}`, 'is-ink')],
    ['dont', 'Rotate the mark. The gap never turns away from east.', tile(img('mark.svg', 'brand-rule-mark is-rotated', ''), 'is-ink')],
    ['dont', 'Set the amber arc on ivory.', tile(img('mark.svg', 'brand-rule-mark', ''), 'is-paper')],
    ['dont', 'Recolour the arc. It is Streetlamp or the mark is one colour.', tile(inline('brand-mk-arc is-slate', 'brand-rule-mark'), 'is-ink')],
    ['dont', 'Stretch it, outline it or add effects.', tile(img('mark.svg', 'brand-rule-mark is-stretched', ''), 'is-ink')],
  ]
    .map(
      ([k, text, stage]) =>
        `<figure class="brand-rule brand-rule--${k}">${stage}<figcaption><span class="brand-rule-k">${k === 'do' ? 'Do' : 'Don’t'}</span> ${esc(text)}</figcaption></figure>`,
    )
    .join('');
  return section(
    'mark',
    'Mark',
    `<p>A C with its gap facing east, and a Streetlamp arc in the gap: the market shut, still trading. It is drawn
     from the agent avatar and checked against it to within 2 px.</p>
     <p>C: 236° of arc, a 124° gap centred due east, stroke 0.42 × the centreline radius R. Arc: 92° centred east on the
     centreline, 0.20 R thick, with 16° of ink to each end of the C.</p>
     <p>The wordmark is “Curb” in Bodoni Moda at optical size 96, weight 500, outlined.</p>`,
    `<div class="brand-window">${construction()}</div>
     <div class="brand-window brand-lockups">
       ${img('lockup-horizontal.svg', 'brand-lockup-h', 'Curb lockup')}
       ${img('lockup-stacked-tagline.svg', 'brand-lockup-s', 'Curb: the market that trades when the exchange is shut.')}
     </div>
     <div class="brand-rules">${rules}</div>`,
  );
}

function glyphs(): string {
  const g = (cls: string, body: string) => `<svg class="brand-glyph ${cls}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const set = [
    ['Open', 'Closed ring: the primary market is trading, cap above zero.', `<path fill="currentColor" d="${GLYPH_RING}"/>`],
    ['Shut, still trading', 'C and Streetlamp arc: cap zero, the pool trades on.', `<path fill="currentColor" d="${GLYPH_C}"/><path class="brand-glyph-arc" d="${GLYPH_ARC}"/>`],
    ['Unknown', 'Dotted ring: no fresh attestation; the clock is stale.', `<path fill="currentColor" d="${GLYPH_DOTS}"/>`],
  ];
  const rows = set
    .map(
      ([name, text, body]) =>
        `<li><span class="brand-glyph-sizes">${g('is-16', body)}${g('is-24', body)}${g('is-48', body)}</span><span><b>${esc(name)}</b><br>${esc(text)}</span></li>`,
    )
    .join('');
  return section(
    'glyphs',
    'Regime glyphs',
    `<p>The only icons. No icon library: arrows come from the type, → for internal links and ↗ for external ones.</p>
     <p>The week, below, is the ring unrolled: 2,016 five-minute slots from Monday 00:00 in Hong Kong. Ivory is the
     primary market open; Streetlamp is shut but still trading.</p>`,
    `<div class="brand-window"><ul class="brand-glyphs">${rows}</ul></div>
     <figure class="brand-window brand-week">
       <img src="/brand/patterns/slot-strip-week.svg" alt="The Hong Kong week in 2,016 five-minute slots: 320 open, 1,696 shut but trading" loading="lazy">
       <figcaption><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></figcaption>
       <p class="brand-note">Sessions 09:30–12:00 and 13:00–16:00 HKT, each cut five minutes early: 320 open minutes a
       weekday, 141 h 20 m shut of 168.</p>
     </figure>`,
  );
}

function motion(): string {
  const cards = SPECIMENS.map(
    (s) => `
    <figure class="brand-mo" data-mo="${s.id}">
      <div class="brand-mo-stage">${s.stage}</div>
      <figcaption><b>${esc(s.title)}</b> ${esc(s.spec)}</figcaption>
      <button type="button" class="brand-replay" hidden>Play</button>
    </figure>`,
  ).join('');
  return section(
    'motion',
    'Motion',
    `<p>Motion reports change: the chain changed or you acted. Entrances ease on <code>cubic-bezier(0.16, 1, 0.3, 1)</code>;
     exits on <code>cubic-bezier(0.7, 0, 0.84, 0)</code> in 200 ms. Micro 120–180 ms, interface 320–480 ms, reveals
     900 ms. Only transform and opacity move. Numbers never count up.</p>
     ${reduced() ? '<p class="brand-note">Reduced motion is on, so each specimen shows its final state.</p>' : ''}`,
    `<div class="brand-mos">${cards}</div>`,
  );
}

function rosette(): string {
  return section(
    'guilloche',
    'Guilloche',
    `<p>Every certificate carries its own fingerprint: an epitrochoid rosette seeded from 32 bytes, the keccak hash of
     its tokenId or of a round’s inputRoot. Three to five layers, R 40–60, r 3–9, d 2–12, drawn in 0.4 px lines.</p>
     <p>Faint on OG images and the 404; full strength on notes and certificates.</p>`,
    `<div class="brand-window brand-ros">
       <div class="brand-ros-art" aria-hidden="true"></div>
       <form class="brand-ros-form">
         <label for="brand-seed">Seed (32 bytes, hex)</label>
         <input id="brand-seed" name="seed" spellcheck="false" autocomplete="off" value="${SPECIMEN_SEED}">
         <div class="brand-ros-actions"><button type="submit">Engrave</button><button type="button" data-random>Another seed</button></div>
         <p class="brand-ros-params" aria-live="polite"></p>
       </form>
     </div>`,
  );
}

function downloads(): string {
  const groups: [string, [string, string][]][] = [
    ['Mark', [['brand/mark.svg', 'Mark, for ink'], ['brand/mark-tile.svg', 'Mark on its ink tile, for paper'], ['brand/mark-mono-ink.svg', 'One colour, ink'], ['brand/mark-mono-ivory.svg', 'One colour, ivory'], ['brand/avatar-512.png', 'Avatar, 512 px'], ['brand/avatar-1024.png', 'Avatar, 1024 px']]],
    ['Wordmark and lockups', [['brand/wordmark.svg', 'Wordmark, ivory'], ['brand/wordmark-ink.svg', 'Wordmark, ink'], ['brand/lockup-horizontal.svg', 'Horizontal, for ink'], ['brand/lockup-horizontal-tile.svg', 'Horizontal on an ink tile'], ['brand/lockup-horizontal-paper.svg', 'Horizontal, for paper'], ['brand/lockup-stacked-tagline.svg', 'Stacked, with tagline']]],
    ['Glyphs and icons', [['brand/glyph-open.svg', 'Open'], ['brand/glyph-shut.svg', 'Shut, still trading'], ['brand/glyph-unknown.svg', 'Unknown'], ['favicon.svg', 'Favicon, adaptive'], ['favicon.ico', 'Favicon, 16/32/48'], ['apple-touch-icon.png', 'Apple touch icon, 180'], ['icon-512.png', 'App icon, 512'], ['icon-maskable-512.png', 'Maskable icon, 512']]],
    ['Patterns', [['brand/patterns/guilloche-specimen.svg', 'Guilloche specimen'], ['brand/patterns/slot-strip-week.svg', 'The week, 2,016 slots']]],
    ['Social', [['og/home.png', 'Link preview, home'], ['social/x-header-1500x500.png', 'X header'], ['social/square-1080.png', 'Square, 1080'], ['social/video-thumb-1920x1080.png', 'Video thumbnail']]],
  ];
  const html = groups
    .map(
      ([name, files]) =>
        `<div class="brand-dl"><h3 class="brand-h3">${esc(name)}</h3><ul>${files
          .map(([f, label]) => `<li><a href="/${f}" download>${esc(label)}</a><code>${f.split('/').pop()}</code></li>`)
          .join('')}</ul></div>`,
    )
    .join('');
  return section(
    'downloads',
    'Downloads',
    `<p>Vector files are outlined and optimised; colours are exact. Use the tile or the paper lockup on light grounds.</p>`,
    `<div class="brand-dls">${html}</div>`,
  );
}

// ── behaviour ─────────────────────────────────────────────────────────────────────────────────────────────────────

function fillColours(root: HTMLElement) {
  const rgb = Object.fromEntries(TOKENS.map((t) => [t.id, tokenRGB(t.prop)])) as Record<TokenId, RGB | null>;
  for (const t of TOKENS) {
    const v = rgb[t.id];
    const fig = root.querySelector<HTMLElement>(`[data-token="${t.id}"]`);
    if (fig && v) {
      fig.querySelector('.brand-hex')!.textContent = hex(v);
      fig.querySelector<HTMLElement>('.brand-copy')!.dataset.copy = hex(v);
    }
    const row = root.querySelector(`[data-row="${t.id}"]`);
    for (const on of ['ink', 'ivory'] as const) {
      const cell = row?.querySelector<HTMLElement>(`[data-on="${on}"]`);
      const g = rgb[on];
      if (!cell) continue;
      if (t.id === on) {
        cell.textContent = '—';
        continue;
      }
      const r = v && g ? ratio(v, g) : NaN;
      cell.innerHTML = `<span class="brand-num">${Number.isFinite(r) ? r.toFixed(1) + ':1' : '—'}</span> <span class="brand-grade">${Number.isFinite(r) ? grade(r) : ''}</span><br><span class="brand-rule-note">${esc(RULES[t.id][on])}</span>`;
    }
  }
}

function fillScale(root: HTMLElement) {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  root.append(probe);
  for (const cell of root.querySelectorAll<HTMLElement>('[data-size]')) {
    probe.style.fontSize = `var(${cell.dataset.size})`;
    const px = parseFloat(getComputedStyle(probe).fontSize);
    cell.textContent = Number.isFinite(px) ? `${Math.round(px)} px` : '—';
  }
  probe.remove();
}

function wireCopy(root: HTMLElement) {
  root.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.brand-copy');
    if (!btn?.dataset.copy) return;
    const label = btn.querySelector('.brand-hex')!;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      label.textContent = 'Copied';
    } catch {
      label.textContent = 'Copy failed';
    }
    setTimeout(() => (label.textContent = btn.dataset.copy!), 1200);
  });
}

function wireMotion(root: HTMLElement) {
  for (const s of SPECIMENS) {
    const fig = root.querySelector<HTMLElement>(`[data-mo="${s.id}"]`);
    if (!fig) continue;
    const play = s.mount(fig);
    const btn = fig.querySelector<HTMLButtonElement>('.brand-replay')!;
    if (play) {
      btn.hidden = false;
      btn.textContent = s.id === 'regime' ? 'Switch' : 'Play';
      btn.addEventListener('click', play);
    }
  }
}

function wireRosette(root: HTMLElement) {
  const art = root.querySelector<HTMLElement>('.brand-ros-art')!;
  const form = root.querySelector<HTMLFormElement>('.brand-ros-form')!;
  const input = form.querySelector<HTMLInputElement>('input')!;
  const params = form.querySelector<HTMLElement>('.brand-ros-params')!;
  const draw = () => {
    try {
      const g = guilloche(input.value);
      art.innerHTML = guillocheSvg(input.value, { stroke: 'currentColor' });
      params.textContent = g.layers.map((l, i) => `${i + 1}: R ${l.R} · r ${l.r} · d ${l.d} · ${l.lobes} lobes`).join('\n');
      input.removeAttribute('aria-invalid');
    } catch {
      input.setAttribute('aria-invalid', 'true');
      params.textContent = 'A seed is 32 bytes: 64 hex characters, with or without 0x.';
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    draw();
  });
  form.querySelector('[data-random]')!.addEventListener('click', () => {
    const b = crypto.getRandomValues(new Uint8Array(32));
    input.value = '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    draw();
  });
  draw();
}

async function main() {
  await startShell();
  const root = pageRoot();
  const page = document.createElement('article');
  page.className = 'brand-page';
  page.innerHTML = hero() + colours() + type() + mark() + glyphs() + motion() + rosette() + downloads();
  root.append(page);
  await document.fonts?.ready;
  fillColours(page);
  fillScale(page);
  wireCopy(page);
  wireMotion(page);
  wireRosette(page);
}

main();
