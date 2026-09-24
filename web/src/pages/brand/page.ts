/**
 * /brand: the single source of the identity. Colours with live contrast, type, the mark and its rules, regime
 * glyphs and the live week, motion specimens built from the site's own primitives, the guilloche and every file.
 * Colours come from tokens.css, the mark from shell/mark.ts (MARK), motion from motion/timing.ts.
 */
import { boot } from '../../shell/boot';
import './page.css';
import { markSVG, glyphSVG, MARK, C_PATH, ARC_PATH, type GlyphRegime } from '../../shell/mark';
import { COLOUR_TOKENS, cssVar } from '../../ui/tokens';
import { html, raw, render, type SafeHTML } from '../../ui/html';
import { enhanceCopyButtons } from '../../ui/copy';
import { slotStrip } from '../../ui/slotstrip';
import { prefersReducedMotion } from '../../motion/reduced';
import { weekSlots } from '../../data/schedule';
import { guilloche, guillocheSvg } from '../../certificate/guilloche';
import { toRGB, hex, ratio, grade } from './contrast';
import { SPECIMENS } from './motion';

const shell = boot({ page: 'brand' });

/** The settlement of the first paid API call: a real 32-byte seed for the default rosette. */
const SPECIMEN_SEED = '0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7';

type Token = (typeof COLOUR_TOKENS)[number]['token'];
const SWATCH: Record<Token, string> = {
  '--ink': 'ink',
  '--ivory': 'ivory',
  '--streetlamp': 'lamp',
  '--slate': 'slate',
  '--brass': 'brass',
  '--graphite': 'graphite',
};
// Where each colour may sit (spec §1 laws), on Street ink and on Certificate ivory.
const RULES: Record<Token, [string, string]> = {
  '--ink': ['—', 'Figure in paper hours'],
  '--ivory': ['Figure on ink', '—'],
  '--streetlamp': ['Its one meaning', 'Never: amber lives in an ink tile'],
  '--slate': ['Secondary text', 'Forbidden'],
  '--brass': ['Not used on ink', 'Signal text, links, focus'],
  '--graphite': ['Not used on ink', 'Secondary text'],
};

const TYPE_SCALE = [
  ['--t-hero', 'Hero headline · Bodoni 400'],
  ['--t-numeral', 'Static numerals · Bodoni'],
  ['--t-h1', 'Page headline · Bodoni'],
  ['--t-h2', 'Section headline · Bodoni'],
  ['--t-lede', 'Lede · Franklin 400'],
  ['--t-body', 'Body · Franklin 400'],
  ['--t-small', 'Small · Franklin'],
  ['--t-data', 'Data · Martian Mono 400'],
] as const;

const deg = (n: number) => `${+n.toFixed(2)}°`;
const C_SPAN = 360 - 2 * MARK.cHalfGapDeg;
const INK_GAP = MARK.cHalfGapDeg - MARK.arcHalfSpanDeg;

// ── sections ──────────────────────────────────────────────────────────────────────────────────────────────────────

const section = (id: string, title: string, ledger: SafeHTML, instrument: SafeHTML) => html`
  <section class="section br-sec" id="${id}" aria-labelledby="${id}-h">
    <div class="wrap grid">
      <div class="br-ledger"><h2 class="t-h2 br-h2" id="${id}-h">${title}</h2>${ledger}</div>
      <div class="br-inst">${instrument}</div>
    </div>
  </section>`;

function hero(): SafeHTML {
  const toc = ['Colour', 'Type', 'Mark', 'Glyphs', 'Motion', 'Guilloche', 'Downloads'];
  return html`
  <header class="section br-hero">
    <div class="wrap">
      <p class="t-label muted br-kicker">Brand</p>
      <h1 class="t-h1 vt-title-brand br-h1">Street ink, certificate ivory, one <em>streetlamp</em>.</h1>
      <p class="t-lede muted br-lede">The Curb identity in one place: six colours, three typefaces, one mark and the rules
      that keep them honest. Every value on this page is read from the site’s own tokens.</p>
      <nav class="cluster br-toc" aria-label="On this page">
        ${toc.map((t) => html`<a class="link-arrow" href="#${t.toLowerCase()}">${t}</a>`)}
      </nav>
    </div>
  </header>`;
}

function colours(): SafeHTML {
  const chips = COLOUR_TOKENS.map(
    (t) => html`
    <figure class="br-sw br-sw--${SWATCH[t.token]}" data-token="${t.token}">
      <div class="br-sw-chip"><span class="br-sw-dot"></span></div>
      <figcaption>
        <b>${t.name}</b>
        <button type="button" class="br-copy" data-copy="" aria-label="Copy the ${t.name} hex value">—</button>
        <code class="br-prop">var(${t.token})</code>
        <span class="muted">${t.role}</span>
      </figcaption>
    </figure>`,
  );
  const rows = COLOUR_TOKENS.map(
    (t) => html`<tr data-row="${t.token}"><th scope="row">${t.name}</th><td data-on="--ink"></td><td data-on="--ivory"></td></tr>`,
  );
  return section(
    'colour',
    'Colour',
    html`<p>Six colours. Street ink is the ground for the 84% of the week that Hong Kong is shut; the site turns to
      Certificate ivory only while the exchange is open.</p>
      <p><b>Law 1.</b> Streetlamp only on ink. On paper, amber lives inside an ink window or tile.</p>
      <p><b>Law 2.</b> Amber never touches ivory.</p>
      <p><b>No red, no green.</b> Wins and losses are said in words and signed basis points.</p>
      <p>Hairlines are <code>color-mix(in oklab, figure 14%, ground)</code>.</p>`,
    html`<div class="br-sws">${chips}</div>
      <table class="br-table">
        <caption>Contrast (WCAG 2), computed here from the live tokens</caption>
        <thead><tr><th scope="col">Colour</th><th scope="col">On Street ink</th><th scope="col">On Certificate ivory</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`,
  );
}

function type(): SafeHTML {
  return section(
    'type',
    'Type',
    html`<p><b>Bodoni Moda</b> for headlines, big static numerals and the wordmark: the engraved Didone of share
      certificates and banknotes. Sentence case only, never tracked capitals, never below 28 px, and one italic word per
      headline.</p>
      <p><b>Libre Franklin</b> for text and interface, at 400, 500 and 600 only: a Franklin Gothic revival, the face of the
      curb-era financial press.</p>
      <p><b>Martian Mono</b> for numbers, hashes, code and timestamps. Width 87 in ledgers reads as condensed ticker tape;
      width 100 for code. Ticking numbers sit in fixed-width cells.</p>`,
    html`<div class="surface-ink br-window br-type">
        <p class="br-spec-label">Bodoni Moda · display</p>
        <p class="br-spec-hero">The exchange is <em>shut</em>.</p>
        <p class="br-spec-numeral">141 h 20 m</p>
        <p class="br-spec-label">Libre Franklin · 400 / 500 / 600</p>
        <p class="br-spec-text">Tokenized Tencent keeps trading on X Layer while Hong Kong is shut.</p>
        <p class="br-spec-text br-w500">Curb records the hours and marks the reopen.</p>
        <p class="br-spec-text br-w600">Read the clock<span class="arrow" aria-hidden="true">→</span></p>
        <p class="br-spec-label">Martian Mono · width 87 / 100</p>
        <p class="br-spec-data">0x160Dc415902971a7a9B5ade7f43005b36FE5B09b</p>
        <p class="br-spec-code">cast call $CLOCK "stateOf(address)" $WTCENTX</p>
      </div>
      <table class="br-table">
        <caption>Type scale: fluid, with its size at this viewport</caption>
        <thead><tr><th scope="col">Token</th><th scope="col">Use</th><th scope="col">Now</th></tr></thead>
        <tbody>${TYPE_SCALE.map(([t, use]) => html`<tr><th scope="row"><code>${t}</code></th><td>${use}</td><td class="br-num" data-size="${t}">—</td></tr>`)}</tbody>
      </table>`,
  );
}

/** Construction drawing from MARK in shell/mark.ts (R = 100, centred on 0,0), so it always shows the live constants. */
function construction(): SafeHTML {
  const R = MARK.R;
  const p = (r: number, a: number): [number, number] => [
    +(r * Math.cos((a * Math.PI) / 180)).toFixed(1),
    +(-r * Math.sin((a * Math.PI) / 180)).toFixed(1),
  ];
  const ray = (a: number, r0: number, r1: number) => `<path class="br-cx-ray" d="M${p(r0, a).join(' ')}L${p(r1, a).join(' ')}"/>`;
  const [ex, ey] = p(R * 1.44, MARK.cHalfGapDeg);
  const [ax, ay] = p(R * 1.36, MARK.arcHalfSpanDeg);
  return raw(`
  <svg class="br-cx" viewBox="-240 -145 540 290" font-size="10" role="img"
       aria-label="Construction: a C of ${C_SPAN} degrees with its gap facing east, stroke ${MARK.cStroke} R; an amber arc of ${2 * MARK.arcHalfSpanDeg} degrees at radius ${MARK.arcRadius} R, ${MARK.arcThickness} R thick; ${INK_GAP} degrees of ink to each end of the C">
    <circle class="br-cx-guide" r="${R}"/>
    <path class="br-cx-c" d="${C_PATH}"/><path class="br-cx-arc" d="${ARC_PATH}"/>
    ${ray(MARK.cHalfGapDeg, 20, R * 1.42)}${ray(-MARK.cHalfGapDeg, 20, R * 1.42)}${ray(MARK.arcHalfSpanDeg, 60, R * 1.34)}${ray(-MARK.arcHalfSpanDeg, 60, R * 1.34)}${ray(0, 0, R * 1.66)}
    <circle class="br-cx-dot" r="2.5"/>
    <text x="${R * 1.72}" y="4">E · now</text>
    <text x="${ex + 4}" y="${ey}">C ends ±${deg(MARK.cHalfGapDeg)}</text>
    <text x="${ax + 6}" y="${ay + 6}">arc ends ±${deg(MARK.arcHalfSpanDeg)}</text>
    <g text-anchor="end"><text x="${-R * 1.3}" y="-4">C ${deg(C_SPAN)}, gap ${deg(2 * MARK.cHalfGapDeg)}</text><text x="${-R * 1.3}" y="12">stroke ${MARK.cStroke} R</text></g>
    <text x="${R * 1.36}" y="70">arc ${deg(2 * MARK.arcHalfSpanDeg)}, ${MARK.arcThickness} R thick</text>
    <text x="${R * 1.36}" y="86">at radius ${MARK.arcRadius} R</text>
    <text x="${R * 1.36}" y="102">${deg(INK_GAP)} of ink to each end</text>
  </svg>`);
}

function mark(): SafeHTML {
  const stage = (cls: string, inner: string) => html`<div class="br-rule-stage ${cls}">${raw(inner)}</div>`;
  const m = (className = '', o: { arc?: string } = {}) => markSVG({ className: `br-rule-mark ${className}`.trim(), ...o });
  const rules: [string, string, SafeHTML][] = [
    ['do', 'The gap faces east: forward in time.', stage('surface-ink', m())],
    ['do', 'On paper the mark sits inside its ink tile.', stage('surface-paper', `<span class="br-tile">${m()}</span>`)],
    ['do', 'Clear space: half the mark’s diameter on every side.', stage('surface-ink', `<span class="br-clear">${m()}</span>`)],
    ['do', 'Never smaller than 16 px.', stage('surface-ink br-sizes', [16, 24, 32].map((size) => markSVG({ size })).join(''))],
    ['dont', 'Rotate the mark: the gap never turns from east.', stage('surface-ink', m('is-rotated'))],
    ['dont', 'Set the amber arc on ivory.', stage('surface-paper', m())],
    ['dont', 'Recolour the arc. It is Streetlamp, or the mark is one colour.', stage('surface-ink', m('', { arc: 'var(--slate)' }))],
    ['dont', 'Stretch it, outline it or add effects.', stage('surface-ink', m('is-stretched'))],
  ];
  return section(
    'mark',
    'Mark',
    html`<p>A C with its gap facing east, and a Streetlamp arc in the gap: the market shut, still trading. It is drawn
      from the agent avatar published on the OKX AI marketplace and checked against it to within 2 px.</p>
      <p>C: ${deg(C_SPAN)} of arc, a ${deg(2 * MARK.cHalfGapDeg)} gap centred due east, stroke ${MARK.cStroke} × the
      centreline radius R. Arc: ${deg(2 * MARK.arcHalfSpanDeg)} centred east at radius ${MARK.arcRadius} R,
      ${MARK.arcThickness} R thick, with ${deg(INK_GAP)} of ink to each end of the C.</p>
      <p>The wordmark is “Curb” in Bodoni Moda at optical size 96, weight 500, outlined.</p>`,
    html`<div class="surface-ink br-window">${construction()}</div>
      <div class="surface-ink br-window br-lockups">
        <img src="/brand/lockup-horizontal.svg" alt="Curb" class="br-lockup-h" loading="lazy" decoding="async">
        <img src="/brand/lockup-stacked-tagline.svg" alt="Curb: the market that trades when the exchange is shut." class="br-lockup-s" loading="lazy" decoding="async">
      </div>
      <div class="br-rules">${rules.map(
        ([k, text, st]) => html`<figure class="br-rule br-rule--${k}">${st}<figcaption><span class="br-rule-k">${k === 'do' ? 'Do' : 'Don’t'}</span> ${text}</figcaption></figure>`,
      )}</div>`,
  );
}

function glyphs(): SafeHTML {
  const set: [GlyphRegime, string, string][] = [
    ['open', 'Open', 'Closed ring: the primary market is trading, cap above zero.'],
    ['shut', 'Shut, still trading', 'C and Streetlamp arc: cap zero, the pool trades on.'],
    ['unknown', 'Unknown', 'Dotted ring: no fresh attestation; the clock is stale.'],
  ];
  return section(
    'glyphs',
    'Regime glyphs',
    html`<p>The only icons. No icon library: arrows come from the type, → for internal links and a turned arrow for
      external ones.</p>
      <p>The strip is this week in Hong Kong, live: 2,016 five-minute slots from Monday 00:00 HKT, the Week Ring
      unrolled. Ivory is the primary market open; Streetlamp is shut but still trading.</p>`,
    html`<div class="surface-ink br-window"><ul class="br-glyphs">${set.map(
      ([g, name, text]) => html`<li><span class="br-glyph-sizes">${raw([16, 24, 48].map((size) => glyphSVG(g, { size })).join(''))}</span><span><b>${name}</b><br>${text}</span></li>`,
    )}</ul></div>
      <figure class="surface-ink br-window br-week">
        <div class="br-strip"></div>
        <figcaption class="br-note"></figcaption>
      </figure>`,
  );
}

function motion(): SafeHTML {
  return section(
    'motion',
    'Motion',
    html`<p>Motion reports change: the chain changed or you acted. Entrances ease on <code>--ease-curb</code>, exits on
      <code>--ease-exit</code> in 200 ms. Micro 120–180 ms, interface 320–480 ms, reveals 900 ms. Only transform and
      opacity move. Numbers never count up.</p>
      <p>These specimens are the site’s own components.</p>
      ${prefersReducedMotion() ? html`<p class="muted">Reduced motion is on, so each specimen shows its final state.</p>` : ''}`,
    html`<div class="br-mos">${SPECIMENS.map(
      (s) => html`<figure class="surface-ink br-mo" data-mo="${s.id}">
        <div class="br-mo-stage">${raw(s.stage)}</div>
        <figcaption><b>${s.title}</b> ${s.caption}</figcaption>
        <button type="button" class="btn btn--secondary br-play" hidden>Play</button>
      </figure>`,
    )}</div>`,
  );
}

function rosette(): SafeHTML {
  return section(
    'guilloche',
    'Guilloche',
    html`<p>Every certificate carries its own fingerprint: an epitrochoid rosette seeded from 32 bytes, the keccak hash of
      its tokenId or of a round’s inputRoot. Three to five layers, R 40–60, r 3–9, d 2–12, in 0.4 px lines.</p>
      <p>Faint on link previews and the 404; full strength on notes and certificates.</p>`,
    html`<div class="surface-ink br-window br-ros">
        <div class="br-ros-art" aria-hidden="true"></div>
        <form class="br-ros-form">
          <label for="br-seed">Seed: 32 bytes of hex</label>
          <input id="br-seed" name="seed" spellcheck="false" autocomplete="off" value="${SPECIMEN_SEED}">
          <div class="cluster br-ros-actions"><button type="submit" class="btn btn--primary">Engrave</button><button type="button" class="btn btn--secondary" data-random>Another seed</button></div>
          <p class="br-ros-params" aria-live="polite"></p>
        </form>
      </div>`,
  );
}

function downloads(): SafeHTML {
  const groups: [string, [string, string][]][] = [
    ['Mark', [['brand/mark.svg', 'Mark, for ink'], ['brand/mark-tile.svg', 'Mark on its ink tile, for paper'], ['brand/mark-mono-ink.svg', 'One colour, ink'], ['brand/mark-mono-ivory.svg', 'One colour, ivory'], ['brand/avatar-512.png', 'Avatar, 512 px'], ['brand/avatar-1024.png', 'Avatar, 1024 px']]],
    ['Wordmark and lockups', [['brand/wordmark.svg', 'Wordmark, ivory'], ['brand/wordmark-ink.svg', 'Wordmark, ink'], ['brand/lockup-horizontal.svg', 'Horizontal, for ink'], ['brand/lockup-horizontal-tile.svg', 'Horizontal on an ink tile'], ['brand/lockup-horizontal-paper.svg', 'Horizontal, for paper'], ['brand/lockup-stacked-tagline.svg', 'Stacked, with the line']]],
    ['Glyphs and icons', [['brand/glyph-open.svg', 'Open'], ['brand/glyph-shut.svg', 'Shut, still trading'], ['brand/glyph-unknown.svg', 'Unknown'], ['favicon.svg', 'Favicon, adaptive'], ['favicon.ico', 'Favicon, 16/32/48'], ['apple-touch-icon.png', 'Apple touch icon, 180'], ['icon-512.png', 'App icon, 512'], ['icon-maskable-512.png', 'Maskable icon, 512']]],
    ['Patterns', [['brand/patterns/guilloche-specimen.svg', 'Guilloche specimen'], ['brand/patterns/slot-strip-week.svg', 'The week, 2,016 slots']]],
    ['Link previews and social', [['og/home.png', 'Link preview, home'], ['og/brand.png', 'Link preview, brand'], ['social/x-header-1500x500.png', 'X header'], ['social/square-1080.png', 'Square, 1080'], ['social/video-thumb-1920x1080.png', 'Video thumbnail']]],
  ];
  return section(
    'downloads',
    'Downloads',
    html`<p>Vector files are outlined and optimised, and the colours are exact. On light grounds use the tile or the
      paper lockup.</p>`,
    html`<div class="br-dls">${groups.map(
      ([name, files]) => html`<div class="br-dl"><h3 class="br-h3">${name}</h3><ul>${files.map(
        ([f, label]) => html`<li><a href="/${f}" download>${label}</a><code>${f.split('/').pop()}</code></li>`,
      )}</ul></div>`,
    )}</div>`,
  );
}

// ── behaviour ─────────────────────────────────────────────────────────────────────────────────────────────────────

function fillColours(root: HTMLElement) {
  const rgb = new Map(COLOUR_TOKENS.map((t) => [t.token, toRGB(cssVar(t.token))]));
  for (const t of COLOUR_TOKENS) {
    const v = rgb.get(t.token) ?? null;
    const btn = root.querySelector<HTMLButtonElement>(`[data-token="${t.token}"] .br-copy`);
    if (btn && v) {
      btn.textContent = hex(v);
      btn.dataset.copy = hex(v);
    }
    for (const on of ['--ink', '--ivory'] as const) {
      const cell = root.querySelector<HTMLElement>(`[data-row="${t.token}"] [data-on="${on}"]`);
      if (!cell) continue;
      const g = rgb.get(on) ?? null;
      const note = RULES[t.token][on === '--ink' ? 0 : 1];
      if (t.token === on || !v || !g) {
        cell.textContent = '—';
        continue;
      }
      const r = ratio(v, g);
      render(cell, html`<span class="br-num">${r.toFixed(1)}:1</span> <b>${grade(r)}</b><br><span class="muted">${note}</span>`);
    }
  }
  enhanceCopyButtons(root);
}

function fillScale(root: HTMLElement) {
  const probe = document.createElement('span');
  probe.className = 'br-probe';
  root.append(probe);
  for (const cell of root.querySelectorAll<HTMLElement>('[data-size]')) {
    probe.style.fontSize = `var(${cell.dataset.size})`;
    const px = parseFloat(getComputedStyle(probe).fontSize);
    cell.textContent = Number.isFinite(px) ? `${Math.round(px)} px` : '—';
  }
  probe.remove();
}

function liveWeek(root: HTMLElement) {
  const el = root.querySelector<HTMLElement>('.br-strip')!;
  const note = root.querySelector<HTMLElement>('.br-week .br-note')!;
  const draw = () => {
    const w = weekSlots(Date.now());
    const slots = w.open.map((o) => (o ? 'open' : 'shut') as 'open' | 'shut');
    slotStrip(el, slots, { nowIndex: w.nowIndex, days: true, label: 'This week in Hong Kong' });
    const h = Math.floor(w.shutMinutes / 60);
    const m = w.shutMinutes % 60;
    note.textContent =
      `This week: ${w.openSlots.toLocaleString('en-US')} slots open and ${w.shutSlots.toLocaleString('en-US')} shut but ` +
      `trading, ${h} h ${m} m of 168 h. Sessions 09:30–12:00 and 13:00–16:00 HKT, each cut five minutes early.`;
  };
  draw();
  setInterval(() => !document.hidden && draw(), 60_000);
}

function wireMotion(root: HTMLElement) {
  for (const s of SPECIMENS) {
    const fig = root.querySelector<HTMLElement>(`[data-mo="${s.id}"]`);
    if (!fig) continue;
    const btn = fig.querySelector<HTMLButtonElement>('.br-play')!;
    const play = s.mount(fig, shell);
    if (play) {
      btn.hidden = false;
      if (s.play) btn.textContent = s.play;
      btn.addEventListener('click', () => play(btn));
    }
  }
}

function wireRosette(root: HTMLElement) {
  const art = root.querySelector<HTMLElement>('.br-ros-art')!;
  const form = root.querySelector<HTMLFormElement>('.br-ros-form')!;
  const input = form.querySelector<HTMLInputElement>('input')!;
  const params = form.querySelector<HTMLElement>('.br-ros-params')!;
  const draw = () => {
    try {
      const g = guilloche(input.value);
      art.innerHTML = guillocheSvg(input.value, { stroke: 'currentColor' });
      params.textContent = g.layers.map((l, i) => `${i + 1}  R ${l.R} · r ${l.r} · d ${l.d} · ${l.lobes} lobes`).join('\n');
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
    input.value = '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    draw();
  });
  draw();
}

// ── mount ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const page = document.createElement('article');
page.className = 'br-page';
render(page, html`${hero()}${colours()}${type()}${mark()}${glyphs()}${motion()}${rosette()}${downloads()}`);
shell.main.replaceChildren(page);

fillColours(page);
liveWeek(page);
wireMotion(page);
wireRosette(page);
void shell.ready.then(() => {
  fillScale(page);
  if (!prefersReducedMotion()) void import('../../motion/reveal').then((m) => m.revealLines(page.querySelector('.br-h1')!));
});
