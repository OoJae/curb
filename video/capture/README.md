# Capture tooling — Curb demo film

Everything the film shows is a real capture: browser recordings (Playwright `recordVideo`, 1920×1080
rendered at DPR 2, visible cursor, eased moves), or a real command's saved output replayed verbatim by
the terminal block in `index.html`. Captures land in `media/` (gitignored). Saved terminal outputs land in
`terminal/` (committed) and `terminal/live/` (the Fri 25 Sep window; overrides `terminal/`).

Run everything from `video/` after `npm install`.

| file | what it does |
|---|---|
| `capture-lib.mjs` | sessions, visible cursor, eased `move`/`scrollTo` (uses the site's Lenis when present), `?capture=1` on site URLs, per-clip text assertions, pass/fail `summary()`, `untilUtc()` |
| `shots.mjs` | one function per shot id (S01–S09, O1–O6, M1, T1–T6, HZ). Site shots take `--site`, so they can point at a Vercel preview now and at curb.markets on the day |
| `run.mjs` | `node capture/run.mjs [--site URL] [--explorer URL] [--tx 0x…] [--root 0x…] [--headed] <ID…>` or `--all-now` |
| `term.mjs` | records one command verbatim (stdout+stderr in arrival order, chunk timings, UTC start/end, exit code). Refuses anything that can pay, sign or broadcast unless a human sets `CURB_ALLOW_SPEND=1` |
| `term-build.mjs` | compiles `terminal/*.json` + `terminal/live/*.json` into `terminal/outputs.js` (what the film reads) |
| `decode-8021.mjs` | reads a tx's calldata and decodes the ERC-8021 Builder Code suffix by hand and with OKX's `ox` |
| `live-window.mjs` | the automated Fri 25 Sep sequence (below) |
| `transcode.sh` | webm → H.264 MP4 (CRF 18, yuv420p, faststart, 30 fps, no audio) + prints the duration |
| `probe-oklink.mjs` | dumps what a page shows (screenshot + text) to find selectors |
| `review-frames.mjs` | one frame per beat from a rendered MP4 into `review/` |
| `align/` | voiceover alignment: see `align/README.md` |

## Explorer: OKX's, not oklink.com

`oklink.com`'s data API answers `403 device risk check failed` from this machine: headless, headed, and
even in an unautomated Chrome on a fresh profile. OKX's own explorer (`web3.okx.com/explorer/x-layer`)
serves the same OKLink data, works headless, and shows the Builder Code chip right next to the tx hash.
All O-shots use it; pass `--explorer https://www.oklink.com/xlayer` to try oklink again.

## Anytime shots (already captured 24 Sep; re-run whenever)

```bash
node capture/run.mjs --all-now          # HZ T1 T2 T3q T3r T4 T4s T5 T6 O1–O6
node capture/run.mjs --site https://<vercel-preview> S02 S05 S08   # once a preview is up
CURB_M1_URL='<the listing page>' node capture/run.mjs M1          # headed Chrome; log in once first
```

## The Fri 25 Sep live window

Mac awake, lid open, on power. Start any time before 03:54Z; it waits on wall-clock UTC:

```bash
cd video
caffeinate -dimsu node capture/live-window.mjs --site https://curb.markets 2>&1 | tee media/live-window.log
```

| UTC | what it records |
|---|---|
| 03:54:15 | **S01** hero (records until the paper → ink flip + 6 s, gives up 03:59:00). Meanwhile polls host A `/healthz` every 5 s for the first round after 03:55:00 whose `stateOf(wTCENTx)` is regime 1 / cap 0 (**the cut round**), then **HZ**, **T1** `cast call stateOf`, **T5** suffix decode of the cut tx, **T4** `curb-verify bundle` of its root, **O2** the cut tx on the explorer, then **S03** `/clock` |
| 04:49:30 | **S04 (commit)** `/scorecard` until the new row appears (gives up 04:53:30); finds the commit tx from storage (`closureCount → closureIds → commitments(id).committedBlock`, then one single-block `getLogs`), **O3 (commit)** that tx, **T4m** `curb-verify` of the mark bundle from the archive (best-effort) |
| 05:04:30 | **S04 (settle)** until graded (gives up 05:08:00); **O3 (settle)** the settle tx |
| 05:15:00 | **S09** hero after the reopen (and **M1** if `CURB_M1_URL` is set). Prints the paid-call steps below |

Outputs: clips in `media/clips/`, stills in `media/stills/`, terminal records in `terminal/live/`,
`terminal/live/manifest.json` (every tx, root and time captured), and a pass/fail summary.
Rehearse it any time with `node capture/live-window.mjs --dry-run` (no waiting; outputs to
`media/dryrun/`; clips suffixed `-dry`).

### T3, the paid call: by hand, never automated

It spends $0.01 from the Agentic Wallet, so the script only prints it. At ~05:15Z:

```bash
node capture/term.mjs T3q --out terminal/live -- onchainos payment quote "https://api.curb.markets/v1/closure-calendar?symbol=wTCENTx"
# read "paymentId" from that output, then:
CURB_ALLOW_SPEND=1 node capture/term.mjs T3 --out terminal/live -- onchainos payment pay --payment-id <paymentId> --yes
npm run terminal
```

Then capture the new settlement on the explorer: `node capture/run.mjs O4` after editing `TX.settlement`
in `shots.mjs` (or keep the 24 Sep settlement, which the film shows today).

## Wiring a new capture into the film

Every pending plate in `index.html` is a `<div id="pl-<ID>" class="clip plate …">` block with a `.ph`
placeholder reading `PENDING: <ID>`. To wire a recorded clip, replace the placeholder's `<div class="win-body">…</div>`
with an empty `<div class="win-body"></div>`, and add a slot right after the plate, copying the O1 pattern:

```html
<div class="slot wide" id="sl-S03"><div class="cam" id="cam-S03" data-layout-allow-overflow><video id="v-S03"
  data-s="52" data-d="6.3" data-start="52" data-duration="6.3" data-media-start="<ready mark, s>"
  data-track-index="0" src="media/clips/S03.mp4" muted playsinline></video></div></div>
```

`data-s`/`data-d` copy the plate's; `data-media-start` is the `ready` mark in `media/clips/<ID>.json`;
the slot class matches the plate (`wide` or `split`). Update the plate's `.win-cap` with the capture time,
then `npm run check`.
