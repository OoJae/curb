// Find where each of the eight scripted beats begins inside one continuous take.
// Adapted from Hindsight's align-beats.mjs.
//
// The read arrives as a single file, so the beat seams have to be recovered. Pause length alone
// cannot do it (SCRIPT.md asks for breaths mid-beat, as long as the ones between beats), so we align
// the WORDS: anchor each beat by its opening phrase, searched forward from the previous anchor, and
// take the timestamp of its first word.
//
//   node capture/align/align-beats.mjs [transcript.json] [--override 3=40.12] [--variant A|B]
//
// Reads the first transcript it finds: the argument, transcript.json, media/transcript.json,
// media/vo.transcript.json. Writes beats.json and prints the --durations line for retime.mjs.
// Each anchor must match at least 3 of its first N words; a weaker match is flagged "?" and should be
// pinned by hand with --override <beat>=<seconds> after reading the words around the seam.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(VIDEO_DIR);
const args = process.argv.slice(2);

// The opening phrase of each beat, as written in SCRIPT.md v1.1, with the spellings a transcriber
// actually produces (whisper writes "eleven fifty-five" as "11.55" and splits "MarketClock").
const BEATS = [
  ["1 11:55",       ["At eleven fifty-five in Hong Kong", "At 11:55 in Hong Kong the", "At 1155 in Hong Kong the"]],
  ["2 the week",    ["That isn't a glitch"]],
  ["3 the name",    ["A century ago New York's Curb Market"]],
  ["4 MarketClock", ["Curb starts with MarketClock", "Curb starts with Market Clock"]],
  ["5 Scorecard",   ["Before a reopen Curb commits its price"]],
  ["6 agents pay",  ["Agents can buy all of this"]],
  ["7 instruments", ["If you need out while Hong Kong is shut"]],
  ["8 close",       ["The exchange keeps its hours"]],
];

const src = [args.find((a) => !a.startsWith("--") && !/^\d+=/.test(a)), "transcript.json", "media/transcript.json", "media/vo.transcript.json"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!src) { console.error("no transcript found: run `npx hyperframes transcribe media/vo.wav --json` first"); process.exit(1); }

/** Collect word objects from any of the shapes transcribers emit (flat list, {words}, {segments:[{words}]}). */
function collect(x, out = []) {
  if (Array.isArray(x)) { for (const y of x) collect(y, out); return out; }
  if (x && typeof x === "object") {
    const w = x.word ?? x.text ?? x.w;
    const t = x.start ?? x.t ?? x.from;
    if (typeof w === "string" && t != null && !/\s/.test(w.trim())) {
      out.push({ w: w.trim(), t: Number(t), e: Number(x.end ?? x.to ?? t) });
      return out;
    }
    for (const k of ["words", "segments", "transcript", "result", "data"]) if (k in x) collect(x[k], out);
  }
  return out;
}
const words = collect(JSON.parse(fs.readFileSync(src, "utf8"))).filter((w) => w.w).sort((a, b) => a.t - b.t);
if (!words.length) { console.error(`no word-level timestamps in ${src}`); process.exit(1); }

// Numbers may come back as digits ("11:55") or words; normalise both sides the same way.
const norm = (s) => s.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9']+/g, "").replace(/'/g, "");
const toks = (phrase) => phrase.split(/[\s-]+/).map(norm).filter(Boolean);

function anchorOne(phrase, from) {
  const probe = toks(phrase).slice(0, 6);
  const n = probe.length;
  let best = { i: -1, score: -1 };
  for (let i = from; i <= words.length - n; i++) {
    let hit = 0;
    for (let k = 0; k < n; k++) if (norm(words[i + k].w) === probe[k]) hit++;
    if (hit > best.score) best = { i, score: hit };
    if (hit === n) break;
  }
  return { ...best, of: n };
}
/** Best of the phrase's spellings, by fraction of words matched (earliest wins a tie). */
function anchor(phrases, from) {
  let best = null;
  for (const p of phrases) {
    const a = anchorOne(p, from);
    if (!best || a.score / a.of > best.score / best.of || (a.score / a.of === best.score / best.of && a.i < best.i)) best = a;
  }
  return best;
}

const OVERRIDE = {};
for (const a of args) { const m = a.match(/^--override=?(\d)=([\d.]+)$/) || a.match(/^(\d)=([\d.]+)$/); if (m) OVERRIDE[Number(m[1])] = Number(m[2]); }

console.log(`transcript: ${src} · ${words.length} words · ${words[words.length - 1].e.toFixed(1)}s\n`);
const anchors = [];
let cursor = 0;
BEATS.forEach(([name, phrase], b) => {
  const a = anchor(phrase, cursor);
  const idx = Math.max(0, a.i);
  anchors.push({ name, idx, t: OVERRIDE[b + 1] ?? words[idx].t, score: a.score, of: a.of, pinned: b + 1 in OVERRIDE,
    heard: words.slice(idx, idx + a.of).map((x) => x.w).join(" ") });
  cursor = idx + 1;
});

const END = words[words.length - 1].e;
console.log(`${"beat".padEnd(16)}${"starts".padStart(9)}${"length".padStart(9)}  match  heard`);
const lengths = [];
let weak = 0;
anchors.forEach((a, i) => {
  const end = i + 1 < anchors.length ? anchors[i + 1].t : END;
  const len = +(end - a.t).toFixed(2);
  lengths.push(len);
  const ok = a.pinned || a.score >= 3;
  if (!ok) weak++;
  console.log(`${a.name.padEnd(16)}${a.t.toFixed(2).padStart(9)}${len.toFixed(2).padStart(9)}  ${a.score}/${a.of}${a.pinned ? " pin" : ok ? "    " : " ?  "}  "${a.heard}"`);
});
const lead = anchors[0].t;
console.log(`\nlead-in silence before the first word: ${lead.toFixed(2)}s · speech ends at ${END.toFixed(2)}s`);
console.log(`\n--durations ${lengths.join(",")} --lead ${lead.toFixed(2)}`);
fs.writeFileSync("beats.json", JSON.stringify({ transcript: src, lead, end: END, anchors, lengths }, null, 2) + "\n");
console.log("wrote beats.json");
if (weak) { console.log(`\n${weak} anchor(s) below 3 matching words: pin them with N=<seconds> before retiming.`); process.exit(3); }
