---
workflow: general-video
flow: automation
storyboard: no
canvas: 1920x1080
fps: 30
duration_target: 192
---

# Curb — OKX Dev Day demo film

**Message.** Tokenized Hong Kong stocks keep trading on X Layer for 141 h 20 m of every 168 while the
exchange is shut. Curb records those hours on chain (MarketClock), grades its own reopen marks on chain
(Scorecard), sells that to agents over x402 (agent #13869), and builds the instruments that let a
holder exit without dumping the stock. Every claim on screen is a real capture or a real saved output.

**Audience.** OKX Dev Day judges and X Layer builders who will click the tx links.

**Destination.** The OKX Dev Day submission (deadline 25 Sep 2026 23:59 UTC). 3:00–3:20, target 3:12.

**Narration.** The user records `SCRIPT.md` (8 beats) in Clipchamp in their own voice; no synthetic
voice at any stage. The picture is cut now to the scripted grid `SCRIPTED=[0,14,40,52,84,116,152,178,192]`
and retimed to the real read with `capture/align/` when `media/vo.wav` arrives.

**Look.** Restrained, expensive, human-directed. Design truth is `design.md` (the site's own tokens:
six colours, Bodoni Moda / Libre Franklin / Martian Mono, 4% grain). Cuts and 300 ms crossfades only.
The film's single orchestrated moment is the site's own unroll (S02), with an in-composition Week Ring
as its stand-in until S02 is captured.

## Assets

- `media/clips/*.mp4` — Playwright recordings (1920×1080, DPR 2, visible cursor), transcoded CRF 18.
  Explorer shots come from OKX's explorer (web3.okx.com/explorer/x-layer, OKLink data): oklink.com
  fails its device-risk check from this machine.
- `media/stills/*.png` — stills from the same sessions.
- `terminal/*.json` — verbatim terminal outputs with UTC stamps; `terminal/live/` overrides from the
  Fri 25 Sep live window. `terminal/outputs.js` is generated from them.
- `assets/fonts/*.woff2` — latin subsets from Google Fonts (see `assets/fonts/SOURCE.json`).

## Customizations

- One monolithic `index.html` timeline, deliberately: it retimes cleanly against the real VO.
- Tracks: V1 plates (captures in an ink window frame + capture caption), V2 Bodoni number callouts,
  V3 chapter clock + corner mark (amber arc steps 30° per beat), V4 optional caption rail,
  A1 VO (`<audio id="vo">`, added when the file arrives), A2 optional music bed (dropped unless found).
- Beat 7 has two variants: A (instruments live on mainnet) and B (in build: specimens, honestly
  labelled). Switch with the `instruments` composition variable (`--variables '{"instruments":"A"}'`).
- Placeholder plates read `PENDING: <shot id>` until the capture exists.
