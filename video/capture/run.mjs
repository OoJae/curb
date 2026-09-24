// Run shots by id and print the pass/fail summary.
//
//   node capture/run.mjs O1 O2 O4 T1 T2            # selected shots
//   node capture/run.mjs --all-now                 # everything capturable before the site is live
//   node capture/run.mjs --site https://curb-git-web-a.vercel.app S02 S05
//
// Options: --site <base>  --explorer <base>  --term-out <dir>  --suffix <clip suffix>  --headed
// O2, T4 and T5 share one read of host A's /healthz so the tx, the bundle and the decode agree.

import path from "node:path";
import { SHOTS, defaults, hostA } from "./shots.mjs";
import { summary, ok, VIDEO_DIR } from "./capture-lib.mjs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const NOW = ["HZ", "T1", "T2", "T3q", "T3r", "T4", "T4s", "T5", "T6", "O1", "O2", "O3", "O4", "O5", "O6"];
const valued = new Set(["--site", "--explorer", "--term-out", "--suffix", "--tx", "--root"]);
let ids = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
if (args.includes("--all-now")) ids = NOW;
if (!ids.length) { console.error("usage: node capture/run.mjs [--all-now] [--site URL] [--explorer URL] [--headed] <ID…>\nids: " + Object.keys(SHOTS).join(" ")); process.exit(2); }

const ctx = defaults({
  ...(opt("--site") ? { site: opt("--site") } : {}),
  ...(opt("--explorer") ? { explorer: opt("--explorer") } : {}),
  ...(opt("--term-out") ? { termOut: path.resolve(opt("--term-out")) } : {}),
  clipSuffix: opt("--suffix") || "",
  headed: args.includes("--headed"),
  ...(opt("--tx") ? { tx: opt("--tx") } : {}),
  ...(opt("--root") ? { root: opt("--root") } : {}),
});

if (ids.some((id) => ["O2", "T4", "T5"].includes(id)) && !ctx.tx) {
  const h = await hostA();
  ctx.tx = h.lastRound.tx; ctx.root = h.lastRound.root;
  console.log(`host A lastRound: tx ${ctx.tx} · root ${ctx.root} · ${new Date(h.lastRound.atMs).toISOString()}`);
}

const clips = [];
for (const id of ids) {
  const fn = SHOTS[id];
  if (!fn) { console.log(`\n${id}: unknown shot id`); clips.push({ id, path: null, error: "unknown id" }); continue; }
  console.log(`\n── ${id} ─────────────────────────────`);
  try {
    // O3 during a normal run is the contract page; ctx.tx belongs to O2/T5.
    const r = await fn(id === "O3" ? { ...ctx, tx: undefined } : ctx);
    clips.push({ id, path: r.path || (r.record ? path.relative(VIDEO_DIR, path.join(ctx.termOut, `${id}.json`)) : r.note) });
  } catch (e) {
    console.log("  !! " + String(e.message).split("\n")[0].slice(0, 200));
    ok(id, "shot completed", false, String(e.message).split("\n")[0].slice(0, 160));
    clips.push({ id, path: null, error: String(e.message).split("\n")[0].slice(0, 120) });
  }
}

// Rebuild the terminal data the composition reads.
if (ids.some((id) => /^(T|HZ)/.test(id))) {
  execFileSync("node", [path.join(VIDEO_DIR, "capture", "term-build.mjs")], { stdio: "inherit" });
}
process.exit(summary(clips));
