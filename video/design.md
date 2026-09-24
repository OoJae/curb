# design.md — Curb demo film

Brand truth is `docs/specs/brand-site-video.md` §1. This file restates what the film uses; if the two
disagree, the spec wins.

## Colours (six, no others)

| token | hex | film role |
|---|---|---|
| Street ink | `#0F1720` | the ground of the film (the site's default, 84% of the week) |
| Certificate ivory | `#F4EFE6` | figure on ink: headlines, numerals, terminal text |
| Streetlamp | `#F5A524` | **one meaning only: trading while the exchange is shut.** The mark's arc, the shut slots of the Week Ring, the "now" pulse. Never on ivory. Never decoration. |
| Window slate | `#8A96A3` | secondary text on ink: captions, labels, the chapter clock |
| Bell brass | `#8A5A00` | Streetlamp's twin in paper mode (only inside ivory cards, e.g. the specimen certificate) |
| Graphite | `#5B6470` | secondary text on ivory |

Hairlines: `color-mix(in oklab, var(--figure) 14%, var(--ground))`. No red, no green: status in words.

## Type

| role | face | film use |
|---|---|---|
| Display | **Bodoni Moda** (variable opsz 6–96, wght 400–900, italic) | number callouts (V2), the name card, the end card. Sentence case, ≥ 28 px, never tracked caps, one italic word per line at most. Numbers never count up: they arrive whole. |
| Text / UI | **Libre Franklin** (variable), 400/500/600 only | captions, chapter titles, labels |
| Data | **Martian Mono** (variable wdth 75–112.5) | terminal blocks (wdth 100), hashes, timestamps, the chapter clock (wdth 87, fixed-width cells) |

All three are local latin woff2 subsets under `assets/fonts/`, declared with `@font-face` in `index.html`.

## Texture

Static 256 px grain tile (`assets/grain-256.png`) at 4% over the whole frame, overlay blend. Never
animated. No shadows; depth only from the window frames' hairlines. 2 px radius on every frame.

## Frames

- **Window (V1).** Captures sit inside an ink window: 2 px radius, 1 px hairline, a 36 px title bar in
  Martian Mono slate, and a caption under the frame: `<source> · captured <date> <time>Z`.
- **Terminal.** The same window, the body in Martian Mono wdth 100 on ink, ivory text; the title bar
  carries the command's recorded UTC time and exit code. Output is typed verbatim at its recorded pace.
- **Corner mark (V3).** Top left: the C (250° arc, gap due east) with the amber arc at r 1.09. The arc
  steps 30° clockwise at each beat change: the film's clock hand. Beside it, the chapter: `04 MarketClock`.

## Motion

Entrances `cubic-bezier(0.16,1,0.3,1)` ("curb"); exits `cubic-bezier(0.7,0,0.84,0)` 200 ms. Micro
120–180 ms, UI 320–480 ms, reveals 900 ms. Headlines rise out of a mask (`yPercent 110 → 0`, stagger
0.08). Between plates: cuts and 300 ms crossfades only. Camera moves inside a plate are slow push-ins
(≤ 6% over the shot) toward the thing the voice names.
