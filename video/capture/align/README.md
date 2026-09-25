# Aligning the picture to the recorded voiceover

The film is cut to the scripted grid `SCRIPTED=[0,14,40,52,84,116,152,178,192]`. When the Clipchamp
export arrives, these steps move every cut onto the real read. Run everything from `video/`.

The export must be one continuous take, about a second of silence between beats, flubs cut. Save it
as `media/vo-raw.m4a` (or .mp4/.wav; adjust the first command).

## 1 · Normalise to a mono 48 kHz WAV at −16 LUFS

```bash
ffmpeg -y -i media/vo-raw.m4a -vn -ac 1 -ar 48000 -af loudnorm=I=-16:TP=-1.5 media/vo.wav
```

## 2 · Transcribe (word-level timestamps, local Whisper)

```bash
HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1 npx --yes hyperframes@0.8.40 transcribe media/vo.wav --json
```

This writes `media/transcript.json` (its JSON result names the path).

## 3 · Find the eight beats → `beats.json`

```bash
node capture/align/align-beats.mjs
```

Each beat is anchored on its first words in SCRIPT.md v1.1 ("At eleven fifty-five in Hong Kong",
"That isn't a glitch", "A century ago", "Curb starts with MarketClock", "Before a reopen", "Agents can
buy all of this", "If you need out while Hong Kong is shut", "The exchange keeps its hours"). Every
anchor must match at least 3 words; a weak one prints `?` and exits 3. Read the words around that seam
in `media/transcript.json` and pin it by hand, e.g. beat 4 at 51.30 s:

```bash
node capture/align/align-beats.mjs 4=51.30
```

Even a full match can start early: Whisper stretches a short first word ("A", "If") back over the pause
before it. Check each start against the real onsets and pin to them. The 25 Sep read was pinned with
`2=8.76 3=26.94 4=33.28 5=55.16 6=81.24 7=103.33 8=133.76` (beats 3 and 7 had come out about 0.4 s early):

```bash
ffmpeg -hide_banner -nostats -i media/vo.wav -af silencedetect=noise=-50dB:d=0.25 -f null - 2>&1 | grep silence_end
```

## 4 · Retime: dry run, then for real

```bash
node capture/align/retime.mjs --dry
node capture/align/retime.mjs
```

`--dry` prints scripted vs recorded length per beat, the new total (the competition allows 2:00–4:00; the
script was paced for 3:00–3:20, the 25 Sep read runs 2:23), and any
video plate that would run past its footage. The real run rewrites `data-start`/`data-duration` of every
timed element from its scripted `data-s`/`data-d`, the root `data-duration`, and `const GRID` in the
script; the previous cut is saved to `index.html.bak`. It always maps from the scripted values, so it is
safe to run again. Options: `--tail 1.2` (hold after the last word), `--pre 0.12` (cut this long before
each beat's first word).

Then put the voice on track A1 (idempotent):

```bash
node capture/align/add-vo.mjs media/vo.wav
```

If the retime changed the total, run `node capture/align/retime.mjs` once more after `add-vo.mjs` so the
audio clip takes the new length (it carries `data-s="0" data-d="192"` like everything else).

## 5 · Check

```bash
HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1 npx --yes hyperframes@0.8.40 check
```

Must report 0 errors. Then eyeball one frame per beat:

```bash
HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1 npx --yes hyperframes@0.8.40 snapshot --at <midpoint of each beat>
```

## 6 · Render the delivery file

```bash
HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1 npx --yes hyperframes@0.8.40 render --quality delivery --video-frame-format png --output renders/curb-demo.mp4
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact renders/curb-demo.mp4
ffmpeg -hide_banner -nostats -i renders/curb-demo.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12
```

Target mix: −14 LUFS integrated, −1 dBTP (the VO alone at −16 is fine; if it measures low, re-run step 1
with `I=-14`). The same `npm` scripts exist: `npm run align`, `npm run retime -- --dry`, `npm run check`,
`npm run render`.

Beat 7: the film defaults to variant B (in build). If the instruments are live on mainnet by picture
lock, render with `--variables '{"instruments":"A"}'` after S06/S07 are captured and wired, and record
the 7A read.
