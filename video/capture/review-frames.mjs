// One review frame per beat, pulled from a RENDERED file (not the live composition), into review/.
//   node capture/review-frames.mjs [renders/curb-draft.mp4]
// The times are scripted seconds, mapped through the current GRID in index.html, so the frames stay on
// the same moments after a retime.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(VIDEO_DIR);
const input = process.argv[2] || "renders/curb-draft.mp4";
const SCRIPTED = [0, 14, 40, 52, 84, 116, 152, 178, 192];
const GRID = JSON.parse(fs.readFileSync("index.html", "utf8").match(/const GRID = (\[[^\]]*\]);/)[1]);
const T = (s) => { for (let i = 0; i < 8; i++) if (s <= SCRIPTED[i + 1] || i === 7) return GRID[i] + ((s - SCRIPTED[i]) / (SCRIPTED[i + 1] - SCRIPTED[i])) * (GRID[i + 1] - GRID[i]); };
const FRAMES = [
  [7.0, "b1-1155-clock-and-S01"],
  [33.0, "b2-week-ring-141h20m"],
  [49.0, "b3-name-card"],
  [78.6, "b4-O2-builder-code"],
  [106.0, "b5-a-tie-is-not-a-win"],
  [140.0, "b6-O4-one-cent"],
  [158.0, "b7-specimen-certificate"],
  [188.5, "b8-end-card"],
];
fs.mkdirSync("review", { recursive: true });
FRAMES.forEach(([s, name], i) => {
  const t = T(s).toFixed(3);
  const out = `review/${String(i + 1).padStart(2, "0")}-${name}.png`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", t, "-i", input, "-frames:v", "1", "-compression_level", "9", out]);
  console.log(`${out}  @ ${t}s`);
});
