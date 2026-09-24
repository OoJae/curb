# Brand, site and video spec — frozen 24 Sep 2026 for parallel build

Single source of truth for web sub-lanes A–F and the video lane. Build what is written; if something is wrong,
tell the lead rather than improvising.

## 0. Findings this plan rests on

1. **Never scan history from the browser.** `rpc.xlayer.tech` caps `eth_getLogs` at 100 blocks and ~7 req/s/IP
   (CORS `*`); `xlayer.drpc.org` allows 10,000 blocks. Scorecard v2 was deployed at block 71,231,806. Read storage
   (`commitments(id).committedBlock`, `settlements(id).settledBlock`) and make one single-block `getLogs` per tx hash,
   cached in localStorage forever.
2. **`nextTransitionAt` is not the reopen.** `stateOf(wTCENTx)` → `(1, 0, 1790298000, …)` = 01:00Z (extended session start,
   cap still 0); the real reopen is 09:30 HKT. Reopen countdowns come from a deterministic `schedule.ts` (published sessions
   minus the measured 300 s early cut). MarketClock only decides open vs shut.
3. **The Scorecard grows during the build** (a row ~01:35Z and ~05:05Z Fri). Never hard-code or speak row counts; read live.
4. **The recess falls inside the deadline window**: Fri 25 Sep cap cut 03:55Z, keeper commit ~04:50Z, reopen 05:00Z,
   settle ~05:05Z — capturable live (Mac awake: `caffeinate`, lid open).
5. Hindsight (the user's last project) used Archivo/Newsreader/IBM Plex Mono — all rejected here.
6. Hours shut: timetable 140.5 h; with the measured 300 s early cut (16/16) **141 h 20 m** (320 open min/day). Copy uses the
   measured figure. The origin claim must be source-checked (see copy rules).
7. Don't copy the cached HyperFrames font shards; download latin subsets from Google Fonts / @fontsource.

## 1. Brand tokens

### Colours (6)

| token | hex | role | contrast |
|---|---|---|---|
| **Street ink** | `#0F1720` | ground when shut (default); figure in paper mode | — |
| **Certificate ivory** | `#F4EFE6` | figure on ink; ground in paper mode | 15.7:1 vs ink |
| **Streetlamp** | `#F5A524` | means one thing only: **trading while the exchange is shut** — the mark's arc, shut slots, the live "now" pulse, focus ring on ink | 8.8:1 on ink; **1.8:1 on ivory → never on ivory** |
| **Window slate** | `#8A96A3` | secondary text on ink | 6.0:1 on ink; forbidden on ivory |
| **Bell brass** | `#8A5A00` | Streetlamp's twin in paper mode: signal text, links, focus | 5.2:1 on ivory |
| **Graphite** | `#5B6470` | secondary text in paper mode | 5.2:1 on ivory |

Hairlines: `color-mix(in oklab, var(--figure) 14%, var(--ground))`. Law 1: Streetlamp only on ink (on paper, amber lives
inside an ink window/tile). Law 2: amber never touches ivory. **No red, no green**: wins/losses in words and signed bp.

### Type

| role | face | why |
|---|---|---|
| Display: headlines, big static numerals, wordmark | **Bodoni Moda** (variable opsz 6–96, wght 400–900, italic) | engraved Didone of share certificates and banknotes |
| Text / UI | **Libre Franklin** (variable, italic), 400/500/600 only | Franklin Gothic revival (ATF 1902): curb-era financial press |
| Data: numbers, hashes, code, timestamps | **Martian Mono** (variable wdth 75–112.5, wght 100–800) | wdth 87 in ledgers ≈ condensed ticker tape; wdth 100 for code |

```css
--t-hero:    clamp(2.75rem,  1.429rem + 5.634vw, 6.5rem);   /* 44→104 Bodoni 400, lh .96, -0.02em */
--t-h1:      clamp(2.25rem,  1.458rem + 3.380vw, 4.5rem);   /* 36→72 */
--t-h2:      clamp(1.75rem,  1.310rem + 1.878vw, 3rem);     /* 28→48, lh 1.05 */
--t-numeral: clamp(3.5rem,   1.211rem + 9.765vw, 10rem);    /* 56→160 Bodoni, -0.03em, static only */
--t-lede:    clamp(1.125rem, 1.037rem + 0.376vw, 1.375rem); /* 18→22 Franklin 400, lh 1.4 */
--t-body:    clamp(1rem,     0.978rem + 0.094vw, 1.0625rem);/* 16→17, lh 1.55 */
--t-small:   clamp(0.8125rem,0.791rem + 0.094vw, 0.875rem); /* 13→14 */
--t-data:    clamp(0.75rem,  0.706rem + 0.188vw, 0.875rem); /* 12→14 Martian 400, lh 1.4 */
```
Ticking numbers use Martian Mono in **fixed-width cells** (no layout shift). Italic is reserved for **one word per headline**
(*shut*, *reopen*). Bodoni: sentence case only, never tracked caps, ≥28 px.

### Grid

12 cols ≥1024, 8 at 768, 4 at 375. Max 1440. Margin `clamp(20px, 5.2vw, 80px)`; gutter `clamp(12px, 1.8vw, 28px)`;
8 px baseline. Only the Week Ring (bleeds off right) and hanging Bodoni numerals break it.
**Layout concept:** ledger left, instrument right — each page is a ruled column of plain sentences beside one live instrument
reading the chain, like the view from a clerk's window down to the street.

### Mark and iconography

Construction (from `script/asp/curb-avatar.png`): C = 250° of arc, 110° gap centred due east, stroke 0.42 × centreline
radius. Amber arc at radius 1.09, thickness 0.20, spans 96° centred east; ≥7° of ink between the arc and each end of the C.
Rules: the gap always faces east (forward in time); never rotate the whole mark; min 16 px; clear space 0.5 × diameter;
on paper the mark sits inside its ink tile. Regime glyphs (the only icons): closed ring O = cap > 0; C + amber arc = shut but
trading; dotted ring = unknown/stale. No icon library; arrows from type (→ internal, ↗ external).

### Motion

1. Motion reports change (chain changed or user acted). 2. Entrances `cubic-bezier(0.16,1,0.3,1)` (GSAP CustomEase "curb");
exits `cubic-bezier(0.7,0,0.84,0)` 200 ms; scrub `0.6`. 3. Micro 120–180 ms; UI 320–480 ms; reveals 900 ms; the orchestrated
moment is a 250vh scrub. 4. DOM animates only transform/opacity (WebGL uniforms exempt); the theme flip is a View
Transition crossfade. 5. Headlines: SplitText lines, masked, `yPercent 110→0`, stagger 0.08, after `document.fonts.ready`,
`once: true`. 6. **Numbers never count up.**

**The one orchestrated moment — "the unroll"** (home hero pins 250vh): 0–25% camera tilts ~40°, the logo C lies down into a
dial; 20–60% the C dissolves in time order while 2,016 blades rise in time order from Mon 00:00 HKT; 60–80% four captions in
the true sequence of the week: "Mon 09:30 — opens", "11:55 — cap to zero", "Fri 15:55 → Mon 09:30 — 65 h 35 m",
"This week — 141 h 20 m"; 80–100% the "now" needle rises at three o'clock and the live sentence resolves.

**Signature element — the Week Ring:** 2,016 enamel blades, one per five-minute attestation slot of the current HK week.
Ivory = primary market open; Streetlamp = shut but still trading. "Now" always at three o'clock, where the logo's amber arc
lives. At rest it is the logo; unrolled it is the truth: amber is 84% of the ring.

**The one aesthetic risk — the site keeps Hong Kong's hours.** When MarketClock reports wTCENTx `MARKET` with cap > 0, the
site turns to paper (ivory ground, ink figure, ring inside an ink window); otherwise (84%) Street ink. Favicon shows the
regime glyph. Mitigations: mark/type/layout/Streetlamp constant; a masthead regime chip ("Paper hours: Hong Kong is open. Curb
goes dark at 11:55 HKT."); keyboard-accessible "preview the other hours" toggle; `?regime=open|shut` override for captures.

Critique record: #0A0A0A → Street ink; accent CTAs → ivory/ink CTAs, amber only as hover hairline + focus; red/green removed;
Instrument Serif + Inter → Bodoni Moda + Libre Franklin; Bodoni guarded (sentence case, ≥28 px, one italic word);
JetBrains/Plex Mono → Martian Mono; rounded cards + shadows → 2 px radius, rules not cards, no shadows (depth only in the
ring); Lucide → regime glyphs; animated grain → static 256 px tile at 4% on ink, 3% on ivory.
**Removed thing: the scrolling ticker-tape marquee** — data sits still until the chain changes it.

## 2. Assets and repository layout (`curb/web/`)

```
curb/web/
  package.json vite.config.ts tsconfig.json vercel.json          (A)
  index.html  clock/ scorecard/ api/ notes/ depth/ brand/ 404.html (entries; each owned by its page's lane)
  public/
    fonts/  bodoni-moda[-italic].woff2 libre-franklin.woff2 martian-mono.woff2   (A; latin subsets)
    brand/  mark.svg mark-tile.svg mark-mono-{ink,ivory}.svg wordmark.svg (outlined)
            lockup-horizontal[-tile].svg lockup-stacked-tagline.svg
            glyph-{open,shut,unknown}.svg avatar-{512,1024}.png
            patterns/guilloche-specimen.svg patterns/slot-strip-week.svg        (F)
    favicon.svg favicon-{open,shut}.svg favicon.ico apple-touch-icon.png
    icon-192.png icon-512.png icon-maskable-512.png site.webmanifest            (F)
    og/{home,clock,scorecard,api,notes,depth,brand}.png (1200×630)              (F)
    social/{x-header-1500x500,square-1080,video-thumb-1920x1080}.png            (F)
    textures/grain-256.png (A)   posters/ring-logo.avif (C)
  og/templates/*.html og/render.mjs   (F; Playwright renders OG images from live tokens)
  scripts/ lint-tokens.mjs check-contrast.mjs (A)  sync-abi.mjs (B)
  src/
    styles/ tokens.css base.css type.css grid.css ui.css transitions.css      (A)
    shell/  boot.ts masthead.ts regime-chip.ts footer-ledger.ts favicon.ts grain.ts (A)
    motion/ lenis.ts reveal.ts ease.ts reduced.ts                              (A)
    ui/     button.ts countdown.ts txlink.ts copy.ts stat.ts slotstrip.ts html.ts (A)
    data/   types.ts addresses.ts suffix.ts rpc-lite.ts chain.ts api.ts schedule.ts(+test)
            regime.ts clock.ts scorecard.ts notes.ts depth.ts wallet.ts abi/*.ts fixtures/*.json (B)
    ring/   ring.ts blades.ts cband.ts layout.ts fallback2d.ts poster.ts      (C)
    certificate/ guilloche.ts certificate.ts                                   (E)
    pages/{home,clock,scorecard,api,notes,depth,brand}/ page.ts page.css      (page owners)
```
Asset specs: mark SVG from the construction above, overlaid on the 512 px avatar (≤2 px deviation). Wordmark "Curb" in Bodoni
Moda opsz 96 wght 500, outlined (opentype.js). Adaptive favicon (SVG with `prefers-color-scheme`; `favicon.ts` swaps open/shut
by regime). No 3D model files — procedural geometry. Guilloche: epitrochoid rosette seeded from `keccak(tokenId|inputRoot)`
(R 40–60, r 3–9, d 2–12, 3–5 layers, 0.4 px strokes) — each certificate's fingerprint; uses: note/cert certificates, faint on
OG backgrounds, 404. Slot strip: 2D sibling of the ring (/clock, footer). /brand: colour/type sheet, mark rules, downloads,
live motion specimens, all read from `tokens.css`.

## 3. Information architecture (MPA + cross-document View Transitions)

| page | single job | sections | live data | interactions |
|---|---|---|---|---|
| `/` | make the closure felt, then hand off to the proof | hero; the unroll; "the cut" (11:55 → 12:00 → 12:50 commit → 13:00 → 13:05 settle, labelled by time); the record; instruments (by go-live date: Clock 14 Sep, Scorecard 21 Sep, API 24 Sep, Notes + Depth "in build" until live); for agents (inline 402); the name; footer ledger | `stateOf(wTCENTx)` via rpc-lite; `schedule.ts`; `Scorecard.skill()` (fallback: `/v1/accuracy-record` 402 preview) | scroll pin; "ask without paying"; regime-chip popover |
| `/clock` | per asset, is the primary market open now — and prove it | board of 6 rows (glyph, regime, cap, next change, "attested N min ago", week strip); latest round (tx + inputRoot → host A bundle link); integration snippet; the two hosts | Multicall `stateOf` + `isInMultiplierBlackout` for the 6 wrappers from `/v1/assets`; `registeredCount()`; latest `StateAttested` by scanning back in 100-block steps (≤4 calls); per-symbol `/v1/closure-calendar` 402 preview (`nextClosure`) | row hover; copy address; OKLink links |
| `/scorecard` | the graded record, including no wins | headline from live values ("N graded. No wins, N ties. A tie is not a win."); ledger; grading strips (three bars, identical for a tie); method (mark/1, mark/2) | `closureCount()`, `closureIds(i)`, `commitments(id)`, `settlements(id)`, `skill()`, `priceNow(w)`; tx hashes via single-block getLogs, cached | new row slides in once; filter by asset |
| `/api` | get an agent to its first call | three priced routes; try-it console; the paid-call proof (settlement `0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7`, receipt `0xcee1ee75f7323746b96afa5f4056640507a96d02316ba40f9010ac2d58a9817c`); onchainos commands; marketplace #13869 | `/.well-known/x402`, `/healthz`, `/v1/assets`; unpaid calls with `PAYMENT-REQUIRED` decoded (exposed via CORS) | "ask without paying" animates 402 → preview; copy commands |
| `/notes` | sell the reopen, not the asset | the certificate (guilloche, CSS 3D tilt ≤6°); descending clock; mint → list → bid → settle | reopen from `schedule.ts`; ReopenNote/ClosedAuction/ReopenPointer views (ABI synced from `out/`) | EIP-6963 connect; switch/add chain 196; approve → mint → list → bid → observe/redeem |
| `/depth` | bond depth, see LTV move | LTV function plot (depth → LTV, "you are here"); bond; fade → slash; credit line | `ltvFor(w)`, `honouredDepth`, certs, positions (DepthCert/CurbCredit) | approve USDG → post; take/fade; deposit/borrow/repay; drag handle for hypothetical depth |
| `/brand` | single source of the identity | colours + contrast, type, mark rules, downloads | — | copy hex |
| `404` | say it plainly | "This page is shut. The pools aren't." | regime | — |

Data rules: chain first, API fallback (never the API for a number that lives on chain). Global chip uses `rpc-lite.ts` (raw
`eth_call`, selector `0x45b4903a` for `stateOf`, hand-decoded 6-word return, ~1 KB); viem only on /clock, /scorecard, /notes,
/depth. Polling `clamp((transitionAt − now)/10, 5 s, 60 s)`, paused when hidden. Paper mode only when `regime == MARKET &&
primaryCapNow > 0`; UNKNOWN/stale → ink + "Clock stale: no attestation for N min." Unset contract address → honest
**"Specimen"** label + "in build".

Hero wireframe (desktop):
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◖ Curb   Clock  Scorecard  Notes  Depth  API            [◖ Shut · 20:41 HKT]   │
├─ cols 1–7 ──────────────────┬─ cols 8–12 ─────────────────────────── bleed → ┤
│ The market that trades      │            ·│││││││││││││││││·                  │
│ when the exchange           │          │││    WEEK RING      │││═══ now (3:00) │
│ is *shut*.                  │          │││  2,016 blades     │││   amber needle│
│ Tokenized Tencent keeps     │            ·│││││││││││││││││·                  │
│ trading on X Layer for      │                                                │
│ 141 h 20 m of every 168.    │                                                │
│ Curb records the hours,     │                                                │
│ marks the reopen, and lets  │                                                │
│ you exit without selling.   │                                                │
│ [ Read the clock → ]  Ask the API ↗                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ now  wTCENTx · shut · cap $0 · reopens 09:30 HKT in [1][2]:[4][8]:[0][2] · attested 2 min ago · block 71,484,120 ↗ │
└──────────────────────────────────────────────────────────────────────────────┘
375 px: masthead → 3-line H1 → ring (100vw square, cropped 12% right) → lede → CTA → 2-row now-line
```

Page transition "the window": masthead persists (`view-transition-name: masthead`); the mark's amber arc steps 30° once;
old page opacity 0 / −12 px in 200 ms ease-in; new page +24 px → 0 in 560 ms "curb" ease after 60 ms; card title morphs into
the page H1 (`title-<page>`); intros wait for `pagereveal` + `viewTransition.finished`; live paper/ink flip =
`document.startViewTransition` 1.2 s crossfade.

Micro-interactions (transform/opacity only): button press scale 0.98 / 90 ms; hover draws an amber hairline under the label
(scaleX from left); tx pending → label becomes a 16 px C whose amber arc rotates (1 turn / 1.6 s; the only infinite animation);
confirmed → the two C halves rotate ±55° to meet, label "Confirmed in block 71,4xx,xxx ↗" + "Builder Code dd7u50nckt5e729f
attached"; reverted → arc stops, "Reverted: `ErrorName()`"; countdown digits −100%/+100% 280 ms; copy → "Copied" 1.2 s;
nav underline in from left, out to right; ledger row hover scales in the left rule.

Accessibility: focus 2 px Streetlamp, 3 px offset on ink, Bell brass on paper; skip link; real `<table>` with captions; wallet
picker in `<dialog>`; chip uses native popover; canvas `aria-hidden` + text equivalent; `aria-live="polite"` only on regime
change; touch targets ≥44 px.

Copy rules: sentence case; every live number carries its as-of block or time; the history section is source-checked — the
Curb Market was New York's outdoor street exchange (moved indoors 1921, renamed the American Stock Exchange 1953); do not write
"traded when the Big Board shut" unless tied to the sourced 1914 closure.

## 4. Technical architecture

Vite 8.3 MPA (all 8 inputs registered up front by A; use `build.rolldownOptions.input` if Vite 8 warns), vanilla TS with a tiny
escaping `html` helper, gsap 3.15 (ScrollTrigger, SplitText, CustomEase — all free), lenis 1.3.26, three 0.186 (dynamic import on
`/` only), viem 2.x (xLayer chain; read/wallet pages only), fontaine for metric-matched fallbacks. MPA + View Transitions (not an
SPA): clean ownership per page, no router lifecycle bugs between ScrollTrigger/WebGL/Lenis, pages cut independently, unsupported
browsers navigate normally; speculation-rules prefetch.

Wiring: Lenis on the GSAP ticker (`lenis.on('scroll', ScrollTrigger.update)`, `lagSmoothing(0)`); Lenis off for reduced motion
and touch.

Week Ring: `InstancedMesh` of 2,016 `BoxGeometry(0.0026, 0.16, 0.02)` at R = 1; angle −(i − i_now)·2π/2016 (clockwise = forward
in time, now at +X). Past slots at 70% value. Colours read from CSS variables at runtime. C band `TorusGeometry(1, 0.21, 32, 320,
250°)` flattened to z = 0.35 (enamel badge), `MeshPhysicalMaterial` (roughness 0.32, clearcoat 1). Amber arc
`TorusGeometry(1.09, 0.10, …, 96°)` light emissive. C dissolves along its angle in time order (fragment discard vs a sweep
uniform). Lighting `RoomEnvironment` PMREM 0.6 + one key; `NeutralToneMapping`; rendered ivory ΔE < 5 of the hex. Camera FOV 28,
(0,0,6.2) → (0,−3.6,4.4). Render on demand only (progress change, resize, attestation pulse); IntersectionObserver pause; DPR cap
1.75 desktop / 1.5 mobile; ≤5 draw calls; no post-processing.

Fallbacks: reduced motion → no Lenis/pins/SplitText/VT animation, ring renders final state, spinner static. No WebGL / Save-Data /
low memory → `fallback2d.ts` Canvas2D over the poster. <768 px → no pin; the unroll plays once on a timer at 40% in view. No CLS:
canvas `aspect-ratio`, matching poster, reserved now-line heights, fontaine fallbacks.

Budgets: home initial JS ≤70 KB gz; CSS ≤25 KB gz; preloaded fonts ≤170 KB; poster ≤60 KB; three chunk ≤160 KB gz (lazy); viem
chunk ≤50 KB gz; mobile LCP ≤2.2 s; CLS ≤0.01; TBT ≤150 ms; unroll 60 fps M1, ≥45 mid Android; Lighthouse mobile home ≥85 perf,
others ≥90, a11y 100.

Wallet: EIP-6963 discovery (OKX Wallet `com.okex.wallet` first); `wallet_switchEthereumChain 0xc4` → `wallet_addEthereumChain`;
every write: `simulateContract` → `writeContract({ dataSuffix: 0x6464377535306e636b74356537323966100080218021802180218021802180218021 })`
→ receipt → OKLink link.

Deploy: **Vercel for the apex `curb.markets`** (static global CDN; preview URL per lane; isolation from the Railway project that
holds volume-bound live services). In `web/`: `vercel link`, `vercel --prod`, `vercel domains add curb.markets www.curb.markets`.
Cloudflare: `A @ 76.76.21.21`, `CNAME www → cname.vercel-dns.com`, both **DNS-only**; check no CAA blocks Let's Encrypt; never touch
`api` or `archive`. `vercel.json`: `cleanUrls`, www → apex redirect, immutable caching for `/assets/*` + fonts, CSP
`connect-src 'self' https://api.curb.markets https://rpc.xlayer.tech https://xlayer.drpc.org https://archive.curb.markets`,
`frame-ancestors 'none'`.

Parallel build: A ships by T+2 `tokens.css`, shell `boot({page})`, UI primitive signatures, all page stubs and nav entries; B ships
by T+1 `data/types.ts` + fixtures; `?mock=1` renders every page from fixtures (also a capture fallback). Only A edits
`package.json`, `vite.config.ts`, `transitions.css`; only B edits `data/` and `abi/` (contracts lane hands over forge `out/`, B runs
`sync-abi.mjs`). Page CSS prefixes `.hm- .clk- .sc- .api- .nt- .dp-`, tokens only; `lint-tokens.mjs` fails on raw hex or px font
sizes. One worktree per lane on branch `web/<lane>`; the lead merges and alone runs `--prod`. Page DoD: 375/768/1440 × both regimes
× reduced motion; axe zero serious; no console errors; CLS under Playwright; full keyboard pass.

## 5. Demo video (target 3:12)

VO: ~145 wpm, ~414 words, ~20 s of air; never speaks a changeable number (row count, tallies); tense/date-neutral; captions carry
dates and live figures; no synthetic voice; each beat's first phrase is its alignment anchor. The script is `curb/video/SCRIPT.md`.

| # | grid (s) | beat | picture | anchor |
|---|---|---|---|---|
| 1 | 0–14 | 11:55 | S01 live hero flips paper → ink; chapter clock "11:55:0x HKT" | "At eleven fifty-five in Hong Kong…" |
| 2 | 14–40 | the week | S02 unroll (or ring rendered in HyperFrames); 141 h 20 m / 168 | "That isn't a glitch…" |
| 3 | 40–52 | the name | type card, guilloche frame; the mark resolves | "A century ago…" |
| 4 | 52–84 | MarketClock | S03 /clock; O2 OKLink cut tx with Builder Code; T1 `cast`; T5 decoded suffix | "Curb starts with MarketClock…" |
| 5 | 84–116 | Scorecard | S04 row committed then graded; O3 commit + settle; T4 `curb-verify` verified | "Before every reopen…" |
| 6 | 116–152 | agents pay | M1 marketplace #13869; S05 402 try-it; T2 curl 402; T3 onchainos quote → pay → 200; O4 $0.01 settlement; receipt | "Agents can buy…" |
| 7 | 152–178 | instruments | S06 certificate + descending clock; S07 LTV curve (variant A live / B in build) | "If you need out…" |
| 8 | 178–192 | close | S09 live hero + chip; end card: curb.markets · api.curb.markets · agent #13869 · X Layer | "The exchange keeps its hours…" |

Capture (`video/capture/*.mjs`; Playwright `recordVideo` 1920×1080, `?capture=1` hides the cursor, scripted `lenis.scrollTo`,
ffmpeg → MP4 CRF 16; terminal outputs saved verbatim with UTC stamps):
- Anytime after the site is live: S02 unroll · S05 /api 402 · S08 mobile 390×844 · O1 MarketClock contract page · O4 settlement
  `0xe874…4de7` · O5/O6 registration + Builder Code mint · M1 marketplace (user's logged-in browser) · T2 `curl -si` unpaid.
- Fri 03:54:15–03:59Z (automated): S01 hero flip · S03 /clock · T1 `cast call stateOf(wTCENTx)` · cut round tx from attestor-a
  `/healthz` `lastRound.tx` → O2 + T5 · T4 `curb-verify bundle https://attestor-a-production.up.railway.app/rounds/<root>.json`.
- Fri 04:49:30–05:08Z: S04 commit (~04:50) and settle (~05:05) → O3 stills.
- Fri ~05:15Z: T3 fresh paid call via onchainos ($0.01 from the Agentic Wallet) · S09.
- After contracts land: S06, S07 (else specimens with variant B).

Transcode (proven in past projects): `ffmpeg -y -v error -i in.webm -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -r 30 -an out.mp4`.

Aligning the user's Clipchamp VO: one continuous take, ~1 s silence between beats, flubs cut; export; `ffmpeg -vn -ac 1 -ar 48000
-af loudnorm=I=-16:TP=-1.5 media/vo.wav`; `npx hyperframes transcribe media/vo.wav --json`; `align-beats.mjs` (copy from
`/Users/oluwademilade/Desktop/Hookathon/videos/hindsight-demo/`) with the 8 anchors → `beats.json` (each anchor ≥3/N words);
`retime.mjs --durations … --dry` then real, `SCRIPTED=[0,14,40,52,84,116,152,178,192]`; `check`; render.

HyperFrames structure (`curb/video/`): `BRIEF.md` (general-video, 1920×1080, 30 fps, 192 s target); `design.md` (same 6 colours,
3 faces, 4% grain); `SCRIPT.md` first; **one monolithic `index.html` timeline** (retimes cleanly). Tracks: V1 plates (captures in an
ink "window" frame, 2 px radius, caption "curb.markets/clock · captured 25 Sep 03:56:10Z"); V2 Bodoni number callouts; V3 chapter
clock + corner mark whose arc ticks 30° per beat; V4 optional caption rail; A1 VO (`<audio id="vo">`); A2 optional sparse music bed
~−28 LUFS (drop if nothing suitable in 20 min). Transitions: cuts and 300 ms crossfades only; the film's single orchestrated moment
is the site's own unroll. Mix −14 LUFS integrated, −1 dBTP; H.264 CRF 18. Reuse: BlastRadius
`/Users/oluwademilade/Desktop/blastradius-video/capture-lib.mjs` (visible cursor, per-clip text assertions), Hindsight
`align-beats.mjs` + `retime.mjs`, Ripcord `SCRIPT.md` format. Pin hyperframes (0.8.40) in package.json.
