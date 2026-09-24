// The Fri 25 Sep 2026 live window, automated. The lead runs it; it waits on wall-clock UTC.
//
//   caffeinate -dimsu node capture/live-window.mjs --site https://curb.markets
//   node capture/live-window.mjs --dry-run            # rehearse now: no waiting, short deadlines,
//                                                     # outputs to media/dryrun/, clips suffixed -dry
//
// Phase 1 · 03:54:15–03:59Z  the 11:55 HKT cut
//   S01 hero flip (records until the flip + 6 s) · the cut round from host A /healthz lastRound →
//   HZ, T1 cast stateOf(wTCENTx), T5 suffix decode, T4 curb-verify bundle · O2 that tx · S03 /clock
// Phase 2a · 04:49:30Z  the keeper's commit        S04 commit row · O3 commit tx · T4m mark bundle
// Phase 2b · 05:04:30Z  the settle                 S04 graded row · O3 settle tx
// Phase 3 · 05:15:00Z   after the reopen           S09 hero · prints the paid-call steps (T3), which a
//                                                  human runs: this script never pays or signs.
//
// Terminal outputs go to terminal/live/ (or media/dryrun/terminal) and override the rehearsal records
// in the film automatically (capture/term-build.mjs). A manifest of every tx/root/time captured is
// written to terminal/live/manifest.json for the captions.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Hash, Hex } from "ox";
import { SHOTS, defaults, hostA, ADDR, RPC, API } from "./shots.mjs";
import { summary, ok, untilUtc, VIDEO_DIR, MEDIA } from "./capture-lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes("--dry-run");
const DAY = opt("--date", "2026-09-25");
const at = (hms) => `${DAY}T${hms}Z`;

const ctx = defaults({
  site: opt("--site", "https://curb.markets"),
  explorer: opt("--explorer", "https://web3.okx.com/explorer/x-layer"),
  termOut: DRY ? path.join(MEDIA, "dryrun", "terminal") : path.join(VIDEO_DIR, "terminal", "live"),
  clipSuffix: DRY ? "-dry" : "",
  headed: args.includes("--headed"),
});
fs.mkdirSync(ctx.termOut, { recursive: true });
const manifest = { dryRun: DRY, day: DAY, startedAt: new Date().toISOString(), site: ctx.site, shots: {} };
const clips = [];
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}Z] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(id, extra = {}) {
  log(`── ${id} ${extra.phase || ""}`);
  try {
    const r = await SHOTS[id]({ ...ctx, ...extra });
    const p = r.path || (r.record ? path.relative(VIDEO_DIR, path.join(ctx.termOut, `${id}.json`)) : r.note);
    clips.push({ id: id + (extra.phase ? `-${extra.phase}` : ""), path: p });
    manifest.shots[id + (extra.phase ? `-${extra.phase}` : "")] = { at: new Date().toISOString(), path: p, ...(extra.tx ? { tx: extra.tx } : {}), ...(extra.root ? { root: extra.root } : {}) };
    return r;
  } catch (e) {
    const msg = String(e.message).split("\n")[0].slice(0, 160);
    log(`  !! ${id}: ${msg}`);
    ok(id, "shot completed", false, msg);
    clips.push({ id, path: null, error: msg });
    return null;
  }
}

async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** stateOf(wTCENTx) via cast: [regime, cap, nextTransitionAt, observedAt, nonce, halted]. */
function stateOf() {
  const out = execFileSync("cast", ["call", ADDR.clock, "stateOf(address)((uint8,uint128,uint64,uint64,uint32,bool))", ADDR.wTCENTx, "--rpc-url", RPC], { encoding: "utf8" });
  const m = out.match(/\((\d+), (\d+), (\d+)[^,]*, (\d+)/);
  return m ? { regime: +m[1], cap: +m[2], next: +m[3], observed: +m[4] } : null;
}

/**
 * The newest Scorecard commit or settle, found the way the spec prescribes (§0.1): never scan history.
 * Both public RPCs cap eth_getLogs near 100 blocks, so read storage for the block number
 * (closureCount → closureIds → commitments(id).committedBlock / settlements(id).settledBlock), then
 * make ONE single-block getLogs for that event to get its tx hash.
 */
const TOPIC = {
  commit: Hash.keccak256(Hex.fromString("ClosureCommitted(bytes32,address,uint128,uint32,uint64,uint64,bytes32,bytes32)")),
  settle: Hash.keccak256(Hex.fromString("ClosureSettled(bytes32,address,uint128,uint32,uint32,uint32,uint32,uint8,uint64)")),
};
const castLines = (sig, ...a) =>
  execFileSync("cast", ["call", ADDR.scorecard, sig, ...a, "--rpc-url", RPC], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(" ")[0]);
async function latestScorecardEvent(kind) {
  const n = Number(castLines("closureCount()(uint256)")[0]);
  for (let i = n - 1; i >= Math.max(0, n - 3); i--) {
    const id = castLines("closureIds(uint256)(bytes32)", String(i))[0];
    let block, inputRoot = null;
    if (kind === "commit") {
      const c = castLines("commitments(bytes32)(address,uint64,uint64,uint64,uint128,uint32,bytes32,bytes32,uint128,uint128,uint128)", id);
      block = Number(c[2]); inputRoot = c[6];
    } else {
      const s = castLines("settlements(bytes32)(uint64,uint64,uint128,uint32,uint32,uint32,uint32,uint8,bool)", id);
      if (s[8] !== "true") continue;
      block = Number(s[1]);
    }
    const hex = "0x" + block.toString(16);
    const logs = await rpc(RPC, "eth_getLogs", [{ address: ADDR.scorecard, topics: [TOPIC[kind], id], fromBlock: hex, toBlock: hex }]);
    if (logs.length) return { tx: logs[0].transactionHash, block, id, inputRoot, index: i, count: n };
  }
  return null;
}
async function waitEvent(kind, sinceBlock, deadlineMs) {
  for (;;) {
    const e = await latestScorecardEvent(kind).catch((err) => { log(`  scorecard read: ${String(err.message).slice(0, 120)}`); return null; });
    if (e && e.block >= sinceBlock) return e;
    if (Date.now() >= deadlineMs) return null;
    await sleep(8000);
  }
}

log(`live window ${DRY ? "DRY RUN (no waiting)" : "for " + DAY} · site ${ctx.site} · terminal → ${path.relative(VIDEO_DIR, ctx.termOut)}`);

// ── Phase 1 · the cut ───────────────────────────────────────────────────────────────────────────
if (!DRY) await untilUtc(at("03:54:15"), "phase 1 (03:54:15Z, the 11:55 HKT cut)");
log("PHASE 1 · the 11:55 HKT cut");
const s01 = shot("S01", { flipDeadline: DRY ? new Date(Date.now() + 20000).toISOString() : at("03:59:00") });

// Wait for host A's first round after 03:55:00Z that shows wTCENTx closed with cap 0: the cut round.
let cut = null;
{
  const cutMs = DRY ? 0 : Date.parse(at("03:55:00"));
  const deadline = DRY ? Date.now() : Date.parse(at("03:59:30"));
  for (;;) {
    const h = await hostA().catch(() => null);
    const st = (() => { try { return stateOf(); } catch { return null; } })();
    if (h && h.lastRound && h.lastRound.atMs >= cutMs && st && st.regime === 1 && st.cap === 0) { cut = h.lastRound; break; }
    if (Date.now() > deadline) { cut = h && h.lastRound; log("  no post-cut round by the deadline; using host A's latest round"); break; }
    await sleep(5000);
  }
  log(`  cut round: tx ${cut && cut.tx} · root ${cut && cut.root} · ${cut && new Date(cut.atMs).toISOString()}`);
  manifest.cutRound = cut;
}
await shot("HZ");
await shot("T1");
if (cut) {
  await shot("T5", { tx: cut.tx });
  await shot("T4", { root: cut.root });
  await shot("O2", { tx: cut.tx });
}
await s01;
await shot("S03");

// ── Phase 2a · the keeper's commit (~04:50Z) ────────────────────────────────────────────────────
if (!DRY) await untilUtc(at("04:49:30"), "phase 2a (04:49:30Z, the commit)");
log("PHASE 2a · the commit");
{
  const head = parseInt(await rpc(RPC, "eth_blockNumber", []), 16);
  const s04 = shot("S04", { phase: "commit", until: DRY ? new Date(Date.now() + 20000).toISOString() : at("04:53:30") });
  const ev = await waitEvent("commit", DRY ? 0 : head - 60, DRY ? Date.now() : Date.parse(at("04:55:00")));
  await s04;
  if (ev) {
    log(`  ClosureCommitted: tx ${ev.tx} · block ${ev.block} · inputRoot ${ev.inputRoot}`);
    manifest.commit = ev;
    await shot("O3", { tx: ev.tx, phase: "commit" });
    // T4m · the mark bundle, re-derived (archive first; the keeper publishes marks there).
    const { record } = await import("./term.mjs");
    try {
      const r = await record({ id: "T4m", out: ctx.termOut, title: "curb-verify", cwd: path.resolve(VIDEO_DIR, ".."),
        argv: ["node", "tools/curb-verify/src/cli.ts", "bundle", ev.inputRoot, "--archive", "https://archive.curb.markets"],
        show: `node tools/curb-verify/src/cli.ts bundle ${ev.inputRoot} --archive https://archive.curb.markets` });
      ok("T4m", "mark bundle verified", r.exitCode === 0, `exit ${r.exitCode}`);
    } catch (e) { ok("T4m", "mark bundle verified", false, e.message); }
  } else ok("O3", "a ClosureCommitted event was seen", false, "none in the window");
}

// ── Phase 2b · the settle (~05:05Z) ─────────────────────────────────────────────────────────────
if (!DRY) await untilUtc(at("05:04:30"), "phase 2b (05:04:30Z, the settle)");
log("PHASE 2b · the settle");
{
  const head = parseInt(await rpc(RPC, "eth_blockNumber", []), 16);
  const s04 = shot("S04", { phase: "settle", until: DRY ? new Date(Date.now() + 20000).toISOString() : at("05:08:00") });
  const ev = await waitEvent("settle", DRY ? 0 : head - 60, DRY ? Date.now() : Date.parse(at("05:10:00")));
  await s04;
  if (ev) {
    log(`  ClosureSettled: tx ${ev.tx} · block ${ev.block}`);
    manifest.settle = ev;
    await shot("O3", { tx: ev.tx, phase: "settle" });
  } else ok("O3", "a ClosureSettled event was seen", false, "none in the window");
}

// ── Phase 3 · after the reopen (~05:15Z) ────────────────────────────────────────────────────────
if (!DRY) await untilUtc(at("05:15:00"), "phase 3 (05:15Z, after the reopen)");
log("PHASE 3 · after the reopen");
await shot("S09");
if (process.env.CURB_M1_URL) await shot("M1");
console.log(`
┌─ T3 · the paid call is run BY HAND (it spends $0.01 from the Agentic Wallet) ─────────────────
│ cd video
│ node capture/term.mjs T3q --out terminal/live -- onchainos payment quote "${API}/v1/closure-calendar?symbol=wTCENTx"
│   → read "paymentId" from that output, then:
│ CURB_ALLOW_SPEND=1 node capture/term.mjs T3 --out terminal/live -- onchainos payment pay --payment-id <paymentId> --yes
│ npm run terminal            # rebuild terminal/outputs.js so the film types the real call
└──────────────────────────────────────────────────────────────────────────────────────────────`);

manifest.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(ctx.termOut, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
if (!DRY) execFileSync("node", [path.join(VIDEO_DIR, "capture", "term-build.mjs")], { stdio: "inherit" });
log(`manifest → ${path.relative(VIDEO_DIR, path.join(ctx.termOut, "manifest.json"))}`);
process.exit(summary(clips));
