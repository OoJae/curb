# curb.markets (web)

Vite 8 MPA, vanilla TypeScript, cross-document View Transitions. The spec is
`docs/specs/brand-site-video.md` and it is frozen. This file covers the foundation contracts that lane A
ships for the page lanes.

```sh
npm i            # once
npm run dev      # http://localhost:5173  (/, /clock/, /scorecard/, /api/, /notes/, /depth/, /brand/, /404.html)
npm run build    # → dist/
npm run check    # lint-tokens + check-contrast + check-csp + tsc
```

URL flags: `?regime=open|shut` forces the paper or ink hours. `?mock=1` asks lane B's data layer
to use fixtures. `?capture=1` hides the chip popover and the cursor, and exposes `window.__curb`. Internal
links carry these flags across navigations.

## Page contract

Each page is `<name>/index.html` plus `src/pages/<name>/page.ts` and `page.css`. The HTML stays minimal:
`<body data-page="clock">` holds `<main id="main">` and the module script. The `curb-shell` plugin in
`vite.config.ts` writes the head tags (early regime script, font preloads, favicon, speculation rules),
the masthead, the footer ledger and the grain into every page at build and dev time. The shell is
therefore present on first paint, with no layout shift, and it persists across the page transition.
Do not hand-write any of it.

```ts
// src/pages/clock/page.ts
import { boot } from '../../shell/boot';
import './page.css';                         // after boot, so page rules win

const shell = boot({ page: 'clock' });       // idempotent; returns the Shell
shell.regime.subscribe((s, prev) => { /* s.shown, s.live, s.reading */ });
await shell.ready;                           // fonts ready + incoming view transition finished
```

- Put static content in the HTML where you can. For content you render with JS, reserve its height
  (the target is CLS ≤ 0.01).
- `page.css` holds page-prefixed classes only: `.hm- .clk- .sc- .api- .nt- .dp-`, `.br-` for brand and
  `.nf-` for 404. Use tokens only. `lint-tokens` fails on any raw hex colour or px font size outside
  `tokens.css`, and it warns when a class lacks the page prefix.
- Headline reveal: add `data-reveal` to the element (`<h1 class="t-h1" data-reveal>`). `boot()` splits and
  reveals every `[data-reveal]` in `<main>` once, after fonts and the page transition. For headlines you
  render later, call `revealLines(el)` from `src/motion/reveal`.
- Card title → H1 morph: give the card title on `/` and the page's H1 the same `.vt-title-<page>` class.
  Other names in the registry are `.vt-now-line`, `.vt-week-ring` and `.vt-certificate`. Only lane A edits
  `transitions.css`. Ask lane A for a new name.
- Paper-mode law: Streetlamp (`--streetlamp`) is legal only inside `.surface-ink`. Anything amber that
  must appear in paper hours sits in an ink window (`<div class="surface-ink">`).

## Tokens (`src/styles/tokens.css`)

| role | token |
|---|---|
| raw six | `--ink --ivory --streetlamp --slate --brass --graphite` |
| semantic, follows `data-regime` | `--ground --figure --muted --signal --focus --lamp --hairline --hairline-strong --wash --signal-inverse` |
| type | `--t-hero --t-h1 --t-h2 --t-numeral --t-lede --t-body --t-small --t-data`, `--font-display --font-text --font-data`, `--lh-*`, `--wdth-ledger` (87%) / `--wdth-code` |
| grid | `--cols` (4/8/12) `--margin --gutter --max --baseline` |
| space | `--s-half --s-1 --s-1-5 --s-2 --s-3 --s-4 --s-5 --s-6 --s-8 --s-10 --s-12 --s-16 --s-20 --section` |
| motion | `--ease-curb --ease-exit --dur-press --dur-micro --dur-ui --dur-reveal --dur-exit --dur-digit --dur-flip --dur-spin` |

`<html data-regime="shut|unknown">` sets ink, and `data-regime="open"` sets paper. Use `.surface-ink` or
`.surface-paper` to force a local ground.

Classes: `.t-hero .t-h1 .t-h2 .t-numeral .t-display .t-h3 .t-lede .t-body .t-small .t-label .t-data
.t-ledger .t-code .muted .signal .measure` (type); `.wrap .grid .col-ledger .col-instrument .col-half-left
.col-half-right .col-main .col-aside .bleed-right .section .stack .cluster` (grid); `.btn .btn--primary
.btn--secondary .btn--quiet .link-arrow .arrow .arrow--ext .ledger .ledger__row .table .tag .tag--specimen
.pulse .visually-hidden` (ui).

## Shell API (`src/shell/*`)

```ts
// boot.ts
boot(opts: { page: PageId; getRegime?: RegimeSource; autoReveal?: boolean; smoothScroll?: boolean }): Shell
getShell(): Shell | null
interface Shell {
  page: PageId; flags: Flags; main: HTMLElement; masthead: Masthead;
  regime: { get(): RegimeState; subscribe(fn, immediate = true): () => void; refresh(): Promise<RegimeState>; setPreview(on: boolean): void };
  readonly lenis: Lenis | null;  whenLenis: Promise<Lenis | null>;
  ready: Promise<void>;
  scrollTo(target: number | string | HTMLElement, opts?: { offset?; duration?; immediate? }): void;
}
type PageId = 'home' | 'clock' | 'scorecard' | 'api' | 'notes' | 'depth' | 'brand' | '404';

// regime.ts: the injectable reading
type SiteRegime = 'open' | 'shut' | 'unknown';
interface RegimeReading {
  regime: SiteRegime;            // open = MARKET && cap > 0; unknown = stale
  cap: number | null;            // primaryCapNow, USD
  asOfMs: number;                // attestation time (observedAt × 1000)
  block: number | null;          // block the read was taken at
  nextChangeAtMs?: number | null;// from schedule.ts; drives polling + chip copy
  source?: 'chain' | 'api' | 'fixture' | 'fallback';
}
type RegimeSource = () => Promise<RegimeReading>;
interface RegimeState { reading; live; shown; forced; preview; error; settled }
setRegimeSource(fn) · getRegimeState() · subscribeRegime(fn, immediate?) · refreshRegime() · setPreview(on)
pollDelay() · staleMinutes() · fallbackRegime

// flags.ts
flags: { regime: 'open' | 'shut' | null; mock: boolean; capture: boolean }
withFlags(href): string

// mark.ts (pure strings)
markSVG({ size?, title?, className?, figure?, arc?, layer?: 'both'|'c'|'arc' }) · glyphSVG('open'|'shut'|'unknown', opts)
C_PATH ARC_PATH C_TOP_PATH C_BOTTOM_PATH MARK MARK_VIEWBOX sectorPath()

// markup.ts (pure strings; used by the plugin)
PAGES · NAV · EXTERNAL · mastheadHTML(page) · footerHTML(page) · markTileHTML() · arrowHTML('int'|'ext')

// hkt.ts: HK time plus the TIMETABLE-ONLY fallback week (lane B's schedule.ts is authoritative)
fmtHKT(ms, withSeconds?) · hktParts(ms) · hktWeekStart(ms) · timetableOpenAt(ms) · timetableNextChange(ms)
timetableWeekSlots(ms) → { slots: SlotState[2016], nowIndex, weekStartMs }

// regime-chip.ts
regimeSentence(state): string · hktWhen(ms): "11:55 HKT" | "Mon 09:30 HKT"
// favicon.ts / grain.ts
setFavicon(regime) · ensureGrain() · setGrain(on)
```

**Lane B hooks.** Both are picked up automatically with `import.meta.glob`, with no edit to the shell:

- `src/data/regime.ts` → `export const getRegime: RegimeSource`. Until it exists, the shell uses
  `fallbackRegime` (always `'shut'`, labelled "Specimen" in the chip). The spec wants the global chip on
  `rpc-lite.ts`, not viem, because this module is eagerly bundled into every page.
- `src/data/schedule.ts` → `export function weekSlots(nowMs): { slots: SlotState[]; nowIndex: number }`
  feeds the footer's week strip. Until it exists, the strip uses the timetable fallback, and the caption
  says so.

## Motion (`src/motion/*`)

GSAP, ScrollTrigger, SplitText and Lenis are loaded lazily by `boot()`. The initial shell JS is about
9 KB gz. Importing any of these modules statically pulls GSAP into your page chunk.

```ts
// ease.ts   (registers CustomEase "curb" and "curbExit"; re-exports gsap)
EASE = 'curb' · EASE_EXIT = 'curbExit' · gsap
// timing.ts (no gsap)
DUR { press .09, micro .15, ui .4, reveal .9, exit .2, digit .28, copied 1.2, flip 1.2, spin 1.6 } · STAGGER_LINES .08 · SCRUB .6 · CSS_EASE { curb, exit }
// reveal.ts
revealLines(targets, { stagger?, duration?, delay?, onScroll? = true, start? = 'top 88%' }): Promise<void> · revealAll(root) · whenFontsReady()
// lenis.ts  (Lenis on the GSAP ticker, lenis.on('scroll', ScrollTrigger.update), lagSmoothing(0); off for reduced motion + touch)
startLenis() · stopLenis() · getLenis() · scrollToTarget(target, opts)
// reduced.ts
prefersReducedMotion() · motionAllowed() · isTouch() · isNarrow() · onReducedMotionChange(fn) · whenMotion(full, reduced) · dur(s)
```

Use `gsap.registerPlugin(ScrollTrigger)` in your page. It is the same instance that Lenis feeds.

## UI primitives (`src/ui/*`)

```ts
// html.ts: escaping tagged template
html`<td>${value}</td>` → SafeHTML · raw(trustedString) · render(el, SafeHTML) · frag(SafeHTML) · el<T>(SafeHTML) · escapeHTML(s) · safeUrl(u)

// button.ts
txButton(el: HTMLButtonElement, run: () => Promise<{ hash: string; block: number | bigint }>, opts?: {
  status?: HTMLElement; errorName?(err): string; resetAfterMs?: number | null; onConfirmed?(r); onReverted?(err)
}): { readonly state: 'idle'|'pending'|'confirmed'|'reverted'; run(); reset(); destroy() }
//   pending   → 16 px C, amber arc turning 1 turn / 1.6 s
//   confirmed → the C halves rotate ±55° to meet; status "Confirmed in block N ↗ · Builder Code dd7u50nckt5e729f attached"
//   reverted  → the arc stops; status "Reverted: ErrorName()"  (throw new TxReverted('ErrorName()') or let viem errors through)
TxReverted · defaultErrorName(err) · enhanceButton(el) · SPINNER_HTML

// countdown.ts: fixed-width digit cells, −100%/+100% digit swap (280 ms)
countdown(el, { target: epochMs, format?: 'hms'|'hm', boxed?, label?, onDone? }): { set(targetMs); stop() }

// txlink.ts: OKLink
OKLINK · txUrl(hash) → https://www.oklink.com/xlayer/tx/<hash> · addressUrl · blockUrl
txLinkHTML(hash, { label?, full? }) · addressLinkHTML · blockLinkHTML · txLink(hash) → HTMLAnchorElement

// copy.ts
copyText(text) · copyButton(button, text | () => text, { copiedLabel?, holdMs? }) · enhanceCopyButtons(root)   // <button data-copy="…">

// stat.ts: label, value and as-of; numbers never count up
statHTML({ label, value, unit?, asOf?, note?, size?: 'numeral'|'display'|'data' }) · stat(el, opts) → { update(partial) }

// slotstrip.ts: the 2D week strip
slotStrip(el, slots: SlotState[], { nowIndex?, days?, label? }) → { update(slots, nowIndex?) } · slotStripSVG(slots, nowIndex) · summarizeSlots(slots)

// format.ts
fmtBlock · fmtInt · fmtUsd · fmtBp (signed, "−3.5 bp") · fmtDuration ("65 h 35 m") · fmtAgo · shortHash · shortAddress
```

## Checks

- `scripts/lint-tokens.mjs`: fails on a raw hex colour or px font size outside `tokens.css`. To skip a
  line on purpose, end it with `// lint-tokens-ignore (reason)`.
- `scripts/check-contrast.mjs`: checks the spec §1 pairs, each regime's semantic roles, and Law 2
  (amber never on ivory).
- `scripts/check-csp.mjs`: checks the exact `connect-src`, `frame-ancestors 'none'`, and the sha256 of
  the one inline script (`src/shell/early-inline.js`). After you edit that script, run it with `--fix`.
  `vite build` also refuses to build while the hash is stale.
- `scripts/gen-font-fallbacks.mjs`: regenerates the fontaine metric-matched fallback faces in
  `src/styles/fonts.css`.

## Fonts

The fonts are self-hosted latin subsets in `public/fonts/`: Bodoni Moda roman and italic (variable
opsz 6–96, wght 400–900), Libre Franklin roman and italic (variable wght), Martian Mono (variable wdth
75–112.5, wght 100–800), and `curb-arrows.woff2`, which holds Martian's ← ↑ → ↓ mapped into all three
families. No face ships ↗, so write external arrows with `arrowHTML('ext')` or
`<span class="arrow arrow--ext">→</span>`, which is a → rotated −45°. Bodoni Moda and Libre Franklin
are preloaded.

## Deploy

`vercel.json` sets `cleanUrls`, the www → apex redirect, immutable caching for `/assets/*` and
`/fonts/*`, and the CSP (with `frame-ancestors 'none'`). Only the lead runs `vercel --prod`.
