// Retime the whole film against the real voiceover. Adapted from Hindsight's retime.mjs.
//
// index.html is authored on the scripted grid SCRIPTED=[0,14,40,52,84,116,152,178,192]. A human read
// is never those lengths. Every timed element carries its SCRIPTED time in data-s / data-d, so this
// derives data-start / data-duration from them with a piecewise-linear map onto the recorded grid:
// a beat that runs long stretches its own cues and nothing downstream drifts. Timeline cues are
// written in scripted seconds through T(), so only `const GRID = [...]` changes in the script.
// Because it always maps from data-s/data-d, running it twice is safe.
//
//   node capture/align/retime.mjs --dry                     # from beats.json, print, write nothing
//   node capture/align/retime.mjs                           # from beats.json, write index.html
//   node capture/align/retime.mjs --durations 13.1,27.4,…   # or pass the eight beat lengths
//   options: --lead <s> (silence before the first word; beat 1 absorbs it)  --tail <s> (after the last
//            word; default 1.2)  --pre <s> (cut this much before each beat's first word; default 0.12)
//
// Tween durations are NOT stretched: a 0.9 s reveal stays 0.9 s whether its beat grows or shrinks.
// A video's data-media-start is a source offset and is never touched.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(VIDEO_DIR);

const SCRIPTED = [0, 14, 40, 52, 84, 116, 152, 178, 192];
const NAMES = ["1 11:55", "2 the week", "3 the name", "4 MarketClock", "5 Scorecard", "6 agents pay", "7 instruments", "8 close"];
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const num = (flag, dflt) => {
  const i = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (i < 0) return dflt;
  return Number(args[i].includes("=") ? args[i].split("=")[1] : args[i + 1]);
};

let lengths, lead;
const dFlag = args.find((a) => a.startsWith("--durations"));
if (dFlag) {
  lengths = (dFlag.includes("=") ? dFlag.split("=")[1] : args[args.indexOf(dFlag) + 1]).split(",").map(Number);
  lead = num("--lead", 0);
} else if (fs.existsSync("beats.json")) {
  const b = JSON.parse(fs.readFileSync("beats.json", "utf8"));
  lengths = b.lengths; lead = num("--lead", b.lead);
} else {
  console.error("need beats.json (node capture/align/align-beats.mjs) or --durations a,b,c,d,e,f,g,h");
  process.exit(1);
}
if (lengths.length !== 8 || lengths.some((n) => !isFinite(n) || n <= 0)) {
  console.error("eight positive beat lengths required; got: " + lengths.join(", "));
  process.exit(1);
}
const TAIL = num("--tail", 1.2), PRE = num("--pre", 0.12);

// The recorded grid in composition time (the VO starts at t = 0): beat b+1's first word lands at
// lead + L1 + … + Lb; each interior cut comes PRE seconds before it; the film ends TAIL after the last word.
const GRID = [0];
let t = lead;
for (let i = 0; i < 8; i++) { t += lengths[i]; GRID.push(+(i < 7 ? t - PRE : t + TAIL).toFixed(3)); }

console.log(`${"beat".padEnd(16)}${"scripted".padStart(10)}${"recorded".padStart(10)}   window`);
for (let i = 0; i < 8; i++) {
  const was = SCRIPTED[i + 1] - SCRIPTED[i], now = GRID[i + 1] - GRID[i];
  console.log(`${NAMES[i].padEnd(16)}${was.toFixed(1).padStart(10)}${now.toFixed(1).padStart(10)}   ${GRID[i].toFixed(2)}–${GRID[i + 1].toFixed(2)}${Math.abs(now - was) > 3 ? "  ←" : ""}`);
}
const total = GRID[8];
// The bound is the competition's 2–4 minute rule, not the 3:00–3:20 the script was paced for: the
// recorded read (Clipchamp, 25 Sep) runs 2:23, so the cut compresses to it. Informational only.
const [MIN_S, MAX_S] = [120, 240];
console.log(`\ntotal ${SCRIPTED[8]}s → ${total.toFixed(2)}s (${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}; allowed 2:00–4:00 ${total >= MIN_S && total <= MAX_S ? "✓" : "✗ OUTSIDE"})`);

const T = (s) => {
  if (s <= 0) return 0;
  for (let i = 0; i < 8; i++) {
    if (s <= SCRIPTED[i + 1] || i === 7) {
      const f = (s - SCRIPTED[i]) / (SCRIPTED[i + 1] - SCRIPTED[i]);
      return +(GRID[i] + f * (GRID[i + 1] - GRID[i])).toFixed(3);
    }
  }
  return s;
};

let html = fs.readFileSync("index.html", "utf8");
let n = 0;
// 1. every timed element: data-start/data-duration from data-s/data-d
html = html.replace(/<(\w+)([^>]*?)\sdata-s="([\d.]+)"\s+data-d="([\d.]+)"\s+data-start="[\d.]+"\s+data-duration="[\d.]+"/g,
  (m, tag, pre, s, d) => {
    n++;
    const st = T(+s), du = +(T(+s + +d) - T(+s)).toFixed(3);
    return `<${tag}${pre} data-s="${s}" data-d="${d}" data-start="${st}" data-duration="${du}"`;
  });
// 2. the root's render length, and 3. the grid the timeline plays on
html = html.replace(/(data-composition-id="main"[^>]*?data-duration=")[\d.]+(")/, (m, a, b) => a + String(+total.toFixed(3)) + b);
html = html.replace(/const GRID = \[[^\]]*\];/, `const GRID = [${GRID.join(", ")}];`);

// A plate that grows past its footage holds the last frame: say so.
for (const tag of html.match(/<video\b[^>]*>/g) || []) {
  const get = (k) => (tag.match(new RegExp(`${k}="([^"]+)"`)) || [])[1];
  const src = get("src"), ms = Number(get("data-media-start") || 0), du = Number(get("data-duration") || 0);
  if (!src || !fs.existsSync(src)) continue;
  try {
    const len = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], { encoding: "utf8" }));
    if (ms + du > len) console.log(`  note: ${src} runs out ${(ms + du - len).toFixed(2)}s before its plate ends (holds the last frame)`);
  } catch { /* no ffprobe: skip */ }
}

if (dry) { console.log(`\n--dry: ${n} timed elements would move; GRID = [${GRID.join(", ")}]; nothing written.`); process.exit(0); }
fs.writeFileSync("index.html.bak", fs.readFileSync("index.html"));
fs.writeFileSync("index.html", html);
console.log(`\n${n} timed elements retimed; GRID = [${GRID.join(", ")}]. Previous cut saved to index.html.bak.`);
