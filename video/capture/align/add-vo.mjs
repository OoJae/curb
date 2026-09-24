// Put the voiceover on track A1: insert <audio id="vo"> at the <!-- A1:vo --> marker in index.html.
//   node capture/align/add-vo.mjs [media/vo.wav]
// Idempotent. The VO starts at composition time 0 and is never stretched; retime.mjs moves the
// picture to it. data-s/data-d let retime size the clip to the recorded grid like everything else.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(VIDEO_DIR);
const src = process.argv[2] || "media/vo.wav";
if (!fs.existsSync(src)) { console.error(`${src} not found`); process.exit(1); }
let html = fs.readFileSync("index.html", "utf8");
if (/<audio[^>]+id="vo"/.test(html)) { console.log("vo already on A1; nothing to do"); process.exit(0); }
const root = html.match(/data-composition-id="main"[^>]*?data-duration="([\d.]+)"/);
const dur = root ? root[1] : "192";
const tag = `<audio id="vo" src="${src}" data-s="0" data-d="192" data-start="0" data-duration="${dur}" data-track-index="10" data-volume="1"></audio>`;
if (!html.includes("<!-- A1:vo -->")) { console.error("marker <!-- A1:vo --> not found in index.html"); process.exit(1); }
html = html.replace("<!-- A1:vo -->", tag);
fs.writeFileSync("index.html", html);
console.log("added: " + tag);
