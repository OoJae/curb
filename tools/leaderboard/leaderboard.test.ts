/**
 * The committed Benchmarks files agree with each other, with D-13, and with the page's own arithmetic. No network.
 *   node --test --experimental-strip-types tools/leaderboard/leaderboard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEADERBOARD_SCHEMA, tally } from "./build.ts";
import type { LeaderboardRow } from "./build.ts";
import { LEADERBOARD_SCHEMA as WEB_SCHEMA, tallyLive, tallySnapshot } from "../../web/src/data/leaderboard.ts";
import type { Leaderboard } from "../../web/src/data/leaderboard.ts";
import type { ScorecardRow } from "../../web/src/data/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIT = join(ROOT, "tools/research/hk-closures/fit.mjs");
const RESULTS = join(ROOT, "tools/research/hk-closures/out/results.json");
const LEADERBOARD = join(ROOT, "web/public/data/leaderboard.json");

const results = JSON.parse(readFileSync(RESULTS, "utf8"));
const lb = JSON.parse(readFileSync(LEADERBOARD, "utf8")) as Leaderboard & { onChain: { rows: LeaderboardRow[]; recount: unknown } };
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("fit.mjs reproduces D-13 exactly, and out/results.json is what it writes", () => {
  const r = spawnSync(process.execPath, [FIT, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /D-13 reproduced exactly\./);
  assert.match(r.stdout, /out\/results\.json is current\./);
  assert.equal(results.d13.reproduced, true);
  assert.equal(results.d13.damped, 0.79);
  assert.equal(results.d13.beta.toFixed(3), "0.983");
});

test("leaderboard.json names the exact results.json and data files it was built from", () => {
  assert.equal(lb.schema, LEADERBOARD_SCHEMA);
  assert.equal(WEB_SCHEMA, LEADERBOARD_SCHEMA, "the page's loader and the builder agree on the schema");
  assert.equal(lb.inputs["tools/research/hk-closures/out/results.json"], sha256(RESULTS));
  for (const [f, want] of Object.entries(results.inputs as Record<string, string>)) {
    const path = join(ROOT, "tools/research/hk-closures", f);
    assert.equal(sha256(path), want, f);
    assert.equal(lb.inputs[`tools/research/hk-closures/${f}`], want, f);
  }
});

test("the on-chain tally is a strict recount of the rows, and equals skill() at the same block", () => {
  const rows = lb.onChain.rows;
  assert.equal(rows.length, lb.onChain.closureCount);
  assert.deepEqual(tally(rows), lb.onChain.all);
  assert.equal(lb.onChain.recountMatchesSkill, true);
  assert.equal(lb.onChain.skill.settled, lb.onChain.all.settled);
  assert.equal(lb.onChain.skill.beatLast, lb.onChain.all.vsLastPrint.wins);
  assert.equal(lb.onChain.skill.beatVwap, lb.onChain.all.vsClosingVwap.wins);
  for (const r of rows) {
    if (r.status !== "settled") {
      assert.equal(r.vsLastPrint, null);
      continue;
    }
    const want = r.curbErrorBps! < r.lastPrintErrorBps! ? "win" : r.curbErrorBps === r.lastPrintErrorBps ? "tie" : "loss";
    assert.equal(r.vsLastPrint, want, r.id);
    assert.equal(r.bandCovered, r.curbErrorBps! <= r.bandBps, r.id);
  }
  const bySum = Object.values(lb.onChain.byMethod).reduce((a, t) => a + t.rows, 0);
  assert.equal(bySum, rows.length, "every row is under exactly one method");
});

test("the page's live tally and the build-time snapshot agree on the same rows", () => {
  const asPageRows = lb.onChain.rows.map((r) => ({
    status: r.status === "settled" ? "settled" : "committed",
    method: r.method, methodDigest: r.methodDigest, vsLastPrint: r.vsLastPrint,
    markE18: r.markE18, lastPrintE18: r.lastPrintE18, curbErrorBps: r.curbErrorBps, lastPrintErrorBps: r.lastPrintErrorBps, bandBps: r.bandBps,
  })) as unknown as ScorecardRow[];
  assert.deepEqual(tallyLive(asPageRows), tallySnapshot(lb));
});

test("the backtest is copied through unchanged and kept apart from the on-chain record", () => {
  assert.deepEqual(lb.backtest.walkForward.groups, results.walkForward.groups);
  assert.deepEqual(lb.backtest.inSample.groups, results.inSample.groups);
  assert.deepEqual(lb.backtest.walkForward.band, results.walkForward.band);
  assert.equal(lb.band.backtest.walkForward.p68ErrorBp, results.walkForward.groups.pooled.mark2.absErrorBp.p68);
  assert.equal(lb.band.backtest.inSample.p68ErrorBp, results.inSample.groups.pooled.mark2.absErrorBp.p68);
  assert.match(lb.backtest.label, /not on chain/i);
  assert.equal(lb.band.committed.covered, lb.onChain.all.band.covered);
});

test("walk-forward never looks ahead: each beta is the published rule on strictly earlier reopens", () => {
  type Row = { asset: string; reopen: string; gapBp: number; rBp: number; walkForwardBeta: number | null };
  const rows = results.rows as Row[];
  const publish = (b: number) => Math.min(1, Math.max(0, Math.round(0.8 * b * 100) / 100));
  let marked = 0;
  for (const r of rows) {
    const train = rows.filter((t) => t.reopen < r.reopen);
    if (r.walkForwardBeta === null) {
      assert.ok(train.length < results.walkForward.minTrain, `${r.asset} ${r.reopen} has ${train.length} earlier closures but no mark`);
      continue;
    }
    marked++;
    const beta = train.reduce((s, t) => s + t.rBp * t.gapBp, 0) / train.reduce((s, t) => s + t.rBp * t.rBp, 0);
    assert.equal(r.walkForwardBeta, publish(beta), `${r.asset} ${r.reopen}`);
  }
  assert.equal(marked, results.walkForward.n);
});

test("the in-sample last-close errors recompute from the published rows", () => {
  for (const name of ["wTCENTx", "wXIAOx", "wMEITx"]) {
    const rows = (results.rows as { asset: string; gapBp: number }[]).filter((r) => r.asset === name);
    const mae = rows.reduce((s, r) => s + Math.abs(r.gapBp), 0) / rows.length;
    assert.equal(Math.round(mae * 10) / 10, results.inSample.groups[name].lastClose.maeBp, name);
  }
});
