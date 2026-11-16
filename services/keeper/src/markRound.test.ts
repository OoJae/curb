import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarkRound, verifyMarkBundleOffline } from "./markRound.ts";
import type { MarkInputs } from "./markRound.ts";

const E18 = 10n ** 18n;
const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const POOL = "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f";

function inputs(over: Partial<MarkInputs> = {}): MarkInputs {
  return {
    chainId: 196,
    clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",
    scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f",
    evaluatedAtMs: 1789992000000,
    codeDigest: "sha256:test",
    specs: [{ wrapper: W, symbol: "TCENTx", pool: POOL, equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 }],
    chain: {
      block: { number: 71_200_000, hash: "0x" + "11".repeat(32), timestamp: 1789991995, rpc: "https://rpc.xlayer.tech" },
      results: [{ label: `slot0:${POOL}`, target: POOL, callData: "0x3850c7bd", success: true, returnData: "0x" }],
    },
    closures: [{
      wrapper: W,
      symbol: "TCENTx",
      cutAtMs: 1789988400000,
      cutBlock: 71_196_000,
      settleAfterS: 1789995600,
      input: {
        wrapper: W, symbol: "TCENTx",
        lastPrintE18: 54n * E18, midAtCutE18: 54n * E18, midNowE18: 5508n * E18 / 100n,
        closingVwapE18: 545n * E18 / 10n, swapsDuringClosure: 4,
      },
      closingSwaps: [{ blockNumber: 71_195_900, logIndex: 3, equityAbs: E18, priceE18: 545n * E18 / 10n }],
      closureSwaps: [{ blockNumber: 71_197_000, logIndex: 1, equityAbs: 2n * E18, priceE18: 5508n * E18 / 100n }],
    }],
    ...over,
  };
}

test("a mark round commits its inputs and a stranger re-derives the same mark", () => {
  const r = buildMarkRound(inputs());
  assert.match(r.root, /^0x[0-9a-f]{64}$/);
  assert.equal(r.marks.length, 1);
  assert.equal(r.marks[0].row.markE18, (5454n * E18 / 100n).toString(), "54 x (1 + 0.5 x 2%)");

  const published = JSON.parse(JSON.stringify(r.bundle));
  const v = verifyMarkBundleOffline(published);
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);
  assert.equal(v.root, r.root);
});

test("a tampered mark is caught: the claim no longer follows from the committed inputs", () => {
  const r = buildMarkRound(inputs());
  const bundle = JSON.parse(JSON.stringify(r.bundle));
  const claimHash = Object.keys(bundle.json).find((k) => bundle.json[k].includes('"markEEE') || bundle.json[k].includes('"markE18"'))!;
  const lie = JSON.parse(bundle.json[claimHash]);
  lie.markE18 = (99n * E18).toString();
  bundle.json[claimHash] = JSON.stringify(lie);
  const v = verifyMarkBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("preimage hash mismatch") || f.includes("mark mismatch")), v.failures.join("; "));
});

test("tampering with the committed evidence is caught too", () => {
  const r = buildMarkRound(inputs());
  const bundle = JSON.parse(JSON.stringify(r.bundle));
  const inputHash = Object.keys(bundle.json).find((k) => bundle.json[k].includes('"midAtCutE18"'))!;
  const lie = JSON.parse(bundle.json[inputHash]);
  lie.midNowE18 = (60n * E18).toString();       // claim the pool ran further than it did
  bundle.json[inputHash] = JSON.stringify(lie);
  const v = verifyMarkBundleOffline(bundle);
  assert.equal(v.ok, false);
});

test("the same inputs always build the same root", () => {
  assert.equal(buildMarkRound(inputs()).root, buildMarkRound(inputs()).root);
});

test("a closure with no usable evidence produces no row rather than a wrong one", () => {
  const bad = inputs();
  bad.closures[0].input.lastPrintE18 = 0n;
  const r = buildMarkRound(bad);
  assert.equal(r.marks.length, 0);
  assert.equal(verifyMarkBundleOffline(JSON.parse(JSON.stringify(r.bundle))).ok, true, "still a valid bundle, just with no claim");
});

// --- the graded instant is evidence, not an assertion ------------------------------------------

/** HKEX as published: no session covers 12:00-13:00, and the extended sessions carry no capacity. */
const HKEX_SCHEDULE = {
  timezone: "Asia/Hong_Kong",
  sessions: [
    { kind: "Extended", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:00", close: "09:30" },
    { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:30", close: "12:00" },
    { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "13:00", close: "16:00" },
    { kind: "Extended", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "16:00", close: "16:10" },
  ],
  holidays: [],
};
const HK_LIMITS = {
  market: { maxOrderFiatValue: 2_000_000 },
  extended: { maxOrderFiatValue: 0 },
  overnight: { maxOrderFiatValue: 0 },
  closed: { maxOrderFiatValue: 0 },
};

/** Tuesday 22 Sep 2026: capacity cut at 11:55 HKT, back at 13:00 HKT. */
const CUT_MS = new Date("2026-09-22T11:56:00+08:00").getTime();
const REOPEN_S = Math.floor(new Date("2026-09-22T13:00:00+08:00").getTime() / 1000);

function withVenue(): MarkInputs {
  const i = inputs();
  i.closures[0].cutAtMs = CUT_MS;
  i.closures[0].settleAfterS = REOPEN_S;
  i.closures[0].venue = {
    mic: "XHKG",
    assetUrl: "https://api.xstocks.fi/api/v2/public/assets/TCENTx?network=XLayer",
    assetBodyHash: "0x" + "ab".repeat(32),
    exchangeUrl: "https://api.xstocks.fi/api/v2/public/exchanges/XHKG",
    exchangeBodyHash: "0x" + "cd".repeat(32),
    cutAtMs: CUT_MS,
    limitsPerPeriod: HK_LIMITS,
    schedule: HKEX_SCHEDULE,
    predictedReopenMs: REOPEN_S * 1000,
  };
  return i;
}

test("the reopen instant re-derives from the committed schedule, skipping the 12:00 boundary", () => {
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(buildMarkRound(withVenue()).bundle)));
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);
});

test("a row that settles on the wrong boundary is caught", () => {
  const i = withVenue();
  // 12:00 is a real boundary, but it is not when capacity comes back: claiming it would grade the
  // mark against a market that is still shut, on five minutes of drift instead of sixty.
  i.closures[0].settleAfterS = Math.floor(new Date("2026-09-22T12:00:00+08:00").getTime() / 1000);
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(buildMarkRound(i).bundle)));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("reopen mismatch")), v.failures.join("; "));
});

test("a tampered schedule cannot rescue a wrong reopen: the caps decide, not the sessions", () => {
  const i = withVenue();
  i.closures[0].settleAfterS = Math.floor(new Date("2026-09-22T12:00:00+08:00").getTime() / 1000);
  i.closures[0].venue!.predictedReopenMs = i.closures[0].settleAfterS * 1000;
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(buildMarkRound(i).bundle)));
  assert.equal(v.ok, false, "predictedReopenMs is a claim; the schedule is the evidence");
});

// --- the top-level convenience copy must not be able to lie ------------------------------------

import { isMarkBundleShaped } from "./markRound.ts";

test("a bundle that displays one mark and commits another is caught", () => {
  const bundle = JSON.parse(JSON.stringify(buildMarkRound(inputs()).bundle));
  // Only the leaves are covered by the root, so `marks` is free to say anything. A reader looking at
  // the published JSON sees this number; before this check, the verifier said ok.
  bundle.marks[0].markE18 = (99n * E18).toString();
  const v = verifyMarkBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.startsWith("top-level marks")), v.failures.join("; "));
});

test("a tampered top-level scorecard address is caught", () => {
  const bundle = JSON.parse(JSON.stringify(buildMarkRound(inputs()).bundle));
  bundle.scorecard = "0x0527930187a879B3D8704a92734641679567EddD";   // the retired v1
  const v = verifyMarkBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.startsWith("top-level scorecard")), v.failures.join("; "));
});

test("a tampered top-level chainId or evaluatedAtMs is caught", () => {
  for (const [field, value] of [["chainId", 1], ["evaluatedAtMs", 1]] as const) {
    const bundle = JSON.parse(JSON.stringify(buildMarkRound(inputs()).bundle));
    bundle[field] = value;
    const v = verifyMarkBundleOffline(bundle);
    assert.equal(v.ok, false, field);
    assert.ok(v.failures.some((f) => f.startsWith(`top-level ${field}`)), v.failures.join("; "));
  }
});

test("every top-level failure carries the prefix a strict checker splits on", () => {
  const bundle = JSON.parse(JSON.stringify(buildMarkRound(inputs()).bundle));
  bundle.clock = "0x0000000000000000000000000000000000000001";
  const v = verifyMarkBundleOffline(bundle);
  assert.equal(v.failures.filter((f) => !f.startsWith("top-level ")).length, 0,
    "a label disagreement must not be reported as a failed re-derivation");
});

test("malformed input is refused rather than throwing", () => {
  for (const bad of [null, undefined, 42, "not a bundle", {}, { schema: "curb.scorecard.markbundle/1" }]) {
    const v = verifyMarkBundleOffline(bad as never);
    assert.equal(v.ok, false);
    assert.deepEqual(v.failures, ["bundle is malformed"]);
  }
});

test("a round bundle cannot be verified through the mark path", () => {
  // The two schemas mean different things by the same leaf kinds; crossing them must be refused,
  // not silently "passed" by ignoring every leaf the other schema relies on.
  const round = { schema: "curb.marketclock.bundle/1", inputRoot: "0x" + "11".repeat(32), tree: {}, json: {}, blobs: {}, marks: [] };
  assert.equal(isMarkBundleShaped(round), false);
  assert.equal(verifyMarkBundleOffline(round as never).ok, false);
});

test("an untampered bundle still verifies", () => {
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(buildMarkRound(withVenue()).bundle)));
  assert.deepEqual(v.failures, []);
});

// --- mark/2: the signal's exact bytes are committed, and a verifier reads them again --------------

import { readFileSync } from "node:fs";
import { computeMark, MARK1, MARK2, MARK_METHODS } from "./mark.ts";
import { buildTree, hashBytes, hashJson, jcs, loadTree, LeafKind, subjectOf } from "./tree.ts";
import type { Leaf } from "./tree.ts";
import { deriveSignal, evidenceBytes } from "./sources/signal.ts";
import type { SignalKey } from "./sources/signal.ts";
import { sha256Hex } from "./sources/signalFetch.ts";
import type { SignalExchange } from "./sources/signalFetch.ts";

interface Fx { wrapper: string; ctx: { symbol: string; cutAtMs: number; commitAtMs: number; settleAfterS: number }; lastPrintE18: string; reopenPrintE18: string; exchanges: Array<{ key: string; url: string; body: string }> }
const fixture = (f: string): Fx => JSON.parse(readFileSync(new URL(`./sources/fixtures/${f}`, import.meta.url), "utf8"));
const OVERNIGHT = fixture("mark2-overnight-wTCENTx-20260924.json");
const RECESS = fixture("mark2-recess-wTCENTx-20260924.json");

const exchangeOf = (e: { key: string; url: string; body: string }): SignalExchange => {
  const b = new TextEncoder().encode(e.body);
  return {
    key: e.key as SignalKey, url: e.url, via: e.url, status: 200, fetchedAtMs: 0, bytes: b.length,
    bodyHash: hashBytes(b), sha256: sha256Hex(b), reproducible: e.key.startsWith("perp"), body: e.body,
  };
};

/** Scorecard row #9 (wTCENTx, 23 -> 24 Sep overnight) or #12 (the 24 Sep recess), with the real bytes. */
function mark2Inputs(fx: Fx, exchanges = fx.exchanges.map(exchangeOf)): MarkInputs {
  const lp = BigInt(fx.lastPrintE18);
  return {
    ...inputs(),
    method: MARK2,
    evaluatedAtMs: fx.ctx.commitAtMs,
    specs: [{ wrapper: fx.wrapper, symbol: "wTCENTx", pool: POOL, equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 }],
    closures: [{
      wrapper: fx.wrapper, symbol: "wTCENTx", cutAtMs: fx.ctx.cutAtMs, cutBlock: 71_360_000, settleAfterS: fx.ctx.settleAfterS,
      input: { wrapper: fx.wrapper, symbol: "wTCENTx", lastPrintE18: lp, midAtCutE18: lp, midNowE18: lp, closingVwapE18: null, swapsDuringClosure: 0 },
      closingSwaps: [], closureSwaps: [],
      signal: { exchanges, attempts: [] },
    }],
  };
}

/**
 * Rewrite leaves and RE-ROOT the bundle: the forgery available to whoever builds the round. The root is
 * then self-consistent, so only re-deriving from the committed evidence can catch it.
 */
function reroot(bundle: MarkBundleJson, mutate: (kind: number, subject: string, value: any) => unknown) {
  const leaves = [...loadTree(bundle.tree).entries()].map(([, v]: [number, Leaf]) => v);
  const json: Record<string, string> = { ...bundle.json };
  const next = leaves.map(([k, s, h]) => {
    const nv = mutate(Number(k), s, JSON.parse(json[h]));
    if (nv === undefined) return [k, s, h] as Leaf;
    const nh = hashJson(nv);
    json[nh] = jcs(nv);
    return [k, s, nh] as Leaf;
  });
  const { root, tree } = buildTree(next);
  const out = { ...bundle, inputRoot: root, tree: tree.dump(), json };
  // Keep the uncommitted convenience copy in step, so only the real check can fail.
  const claim = next.find(([k]) => Number(k) === LeafKind.CLAIM)!;
  out.marks = [JSON.parse(json[claim[2]])];
  return out;
}
type MarkBundleJson = any;

test("mark/2: a round built from real signal bytes re-derives and verifies offline", () => {
  const r = buildMarkRound(mark2Inputs(OVERNIGHT));
  const row = r.marks[0].row;
  assert.equal(row.signal!.applied, true);
  assert.equal(row.signal!.perpBps, -6, "HK0700USDT 440.91 at the cut -> 440.64 before the commit");
  assert.equal(row.signal!.adrBps, -57, "TCEHY 55.91 x USD/HKD over 0700.HK's HK$441 close");
  assert.equal(row.signal!.rBps, -31);
  assert.equal(row.signal!.appliedBps, -24);
  const expected = computeMark({
    ...mark2Inputs(OVERNIGHT).closures[0].input,
    signal: deriveSignal(OVERNIGHT.ctx, evidenceBytes(OVERNIGHT.exchanges), MARK_METHODS[MARK2].minSignalClosureS!),
  }, MARK2)!;
  assert.equal(row.markE18, expected.markE18.toString());
  // 56.318512711103969424 x (1 - 0.79 x 0.0031), in integer arithmetic
  assert.equal(row.markE18, "56180588673474475803");

  const bundle = JSON.parse(JSON.stringify(r.bundle));
  const v = verifyMarkBundleOffline(bundle);
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);

  // The exact bytes are in the bundle, under the upstream url, next to their hashes.
  const leaves = [...loadTree(bundle.tree).entries()].map(([, x]: [number, Leaf]) => x);
  const cut = leaves.find(([k, s]) => Number(k) === LeafKind.HTTP_EXCHANGE && s === subjectOf(`signal:${OVERNIGHT.wrapper.toLowerCase()}:perp:cut`))!;
  const ex = JSON.parse(bundle.json[cut[2]]);
  assert.equal(ex.url, "https://fapi.binance.com/fapi/v1/klines?symbol=HK0700USDT&interval=1m&startTime=1790150040000&limit=1");
  assert.equal(ex.sha256, "7b3de63c048e38d3edc65a5e967f5dc01d523cc193077fc5e92147fc9c4db96d");
  const params = JSON.parse(bundle.json[leaves.find(([k]) => Number(k) === LeafKind.PARAMS)![2]]);
  assert.equal(params.method, MARK2);
  assert.equal(params.betaBps, 7_900);
  assert.equal(params.signalNotes.adr.reproducible, false, "the bundle says which leg can be refetched");
});

test("mark/2: the signal is always read from the committed bytes, never taken from the caller", () => {
  const i = mark2Inputs(OVERNIGHT);
  const honest = buildMarkRound(i).marks[0].row.markE18;
  i.closures[0].input.signal = { closureS: 1, proxy: "wTCENTx", perp: null, adr: null, missing: ["a lie"] };
  assert.equal(buildMarkRound(i).marks[0].row.markE18, honest);
});

test("mark/2: tampering with the signal bytes fails verification", () => {
  const bundle = JSON.parse(JSON.stringify(buildMarkRound(mark2Inputs(OVERNIGHT)).bundle));
  const w = OVERNIGHT.wrapper.toLowerCase();

  // 1. Edit the bytes in place: the leaf no longer hashes to what the root commits.
  const inPlace = JSON.parse(JSON.stringify(bundle));
  const h = Object.keys(inPlace.json).find((k) => inPlace.json[k].includes('"key":"perp:commit"'))!;
  inPlace.json[h] = inPlace.json[h].replace("440.64000", "450.64000");
  const v1 = verifyMarkBundleOffline(inPlace);
  assert.equal(v1.ok, false);
  assert.ok(v1.failures.some((f) => f.includes("preimage hash mismatch")), v1.failures.join("; "));

  // 2. Re-root with edited bytes but the old recorded hashes: the bytes do not match their keccak/sha256.
  const v2 = verifyMarkBundleOffline(reroot(bundle, (k, s, v) =>
    k === LeafKind.HTTP_EXCHANGE && s === subjectOf(`signal:${w}:perp:commit`) ? { ...v, body: v.body.replace("440.64000", "450.64000") } : undefined));
  assert.equal(v2.ok, false);
  assert.ok(v2.failures.some((f) => f.includes("do not match their recorded keccak256/sha256")), v2.failures.join("; "));

  // 3. Re-root with edited bytes AND fresh hashes: now the committed signal does not follow from them.
  const v3 = verifyMarkBundleOffline(reroot(bundle, (k, s, v) => {
    if (!(k === LeafKind.HTTP_EXCHANGE && s === subjectOf(`signal:${w}:perp:commit`))) return undefined;
    const body = v.body.replace("440.64000", "450.64000");
    const b = new TextEncoder().encode(body);
    return { ...v, body, bodyHash: hashBytes(b), sha256: sha256Hex(b) };
  }));
  assert.equal(v3.ok, false);
  assert.ok(v3.failures.some((f) => f.includes("does not re-derive from the committed bytes")), v3.failures.join("; "));
  // And the forged sha256 is no longer Binance's: anyone refetching the committed url sees the difference.

  // 4. Re-root with a claimed signal the bytes do not support.
  const v4 = verifyMarkBundleOffline(reroot(bundle, (k, s, v) =>
    k === LeafKind.CA_SNAPSHOT && s === subjectOf(`markinput:${w}`) ? { ...v, signal: { ...v.signal, missing: ["yahoo:adr:stale"], adr: null } } : undefined));
  assert.equal(v4.ok, false);
  assert.ok(v4.failures.some((f) => f.includes("does not re-derive")), v4.failures.join("; "));

  // 5. Dropping a leg's bytes after the fact changes the signal, which no longer matches the committed one.
  const v5 = verifyMarkBundleOffline(reroot(bundle, (k, s, v) =>
    k === LeafKind.HTTP_EXCHANGE && s === subjectOf(`signal:${w}:yahoo:adr`) ? { ...v, key: "yahoo:primary" } : undefined));
  assert.equal(v5.ok, false);
});

test("mark/2: PARAMS must carry the method's own beta and proxies", () => {
  const bundle = JSON.parse(JSON.stringify(buildMarkRound(mark2Inputs(OVERNIGHT)).bundle));
  const v = verifyMarkBundleOffline(reroot(bundle, (k, _s, p) => (k === LeafKind.PARAMS ? { ...p, betaBps: 10_000 } : undefined)));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("committed PARAMS.betaBps")), v.failures.join("; "));
});

test("mark/2 in the recess: the perp's bytes are committed, the mark is the last print, and it verifies", () => {
  const r = buildMarkRound(mark2Inputs(RECESS));
  const row = r.marks[0].row;
  assert.ok(row.flags.includes("recess-no-edge"));
  assert.equal(row.markE18, RECESS.lastPrintE18);
  assert.equal(row.signal!.perpBps, 26);
  assert.equal(row.signal!.applied, false);
  assert.deepEqual(verifyMarkBundleOffline(JSON.parse(JSON.stringify(r.bundle))).failures, []);
});

test("mark/2 with every fetch failed: no-signal, the failures are in the bundle, and it verifies", () => {
  const i = mark2Inputs(OVERNIGHT, []);
  i.closures[0].signal!.attempts = [{
    key: "perp:cut", url: "https://fapi.binance.com/fapi/v1/klines?symbol=HK0700USDT&interval=1m&startTime=1790150040000&limit=1",
    via: "https://api.curb.markets/v1/relay/binance/klines?symbol=HK0700USDT&startTime=1790150040000&limit=1",
    status: 502, ok: false, reqStartMs: 1, respEndMs: 2, bodyHash: null, error: "http 502",
  }];
  const r = buildMarkRound(i);
  const row = r.marks[0].row;
  assert.ok(row.flags.includes("no-signal"));
  assert.equal(row.markE18, OVERNIGHT.lastPrintE18, "a still pool and no signal: the last print, exactly mark/1");
  const bundle = JSON.parse(JSON.stringify(r.bundle));
  assert.ok(Object.values(bundle.json).some((s) => String(s).includes('"error":"http 502"')), "the failed fetch is committed");
  assert.deepEqual(verifyMarkBundleOffline(bundle).failures, []);
});

test("mark/1 bundles still build and verify exactly as before", () => {
  const i = inputs();
  i.method = MARK1;
  const r = buildMarkRound(i);
  assert.equal(r.marks[0].row.signal, undefined);
  assert.equal(r.marks[0].row.markE18, (5454n * E18 / 100n).toString());
  const bundle = JSON.parse(JSON.stringify(r.bundle));
  const leaves = [...loadTree(bundle.tree).entries()].map(([, x]: [number, Leaf]) => x);
  const params = JSON.parse(bundle.json[leaves.find(([k]) => Number(k) === LeafKind.PARAMS)![2]]);
  assert.deepEqual(Object.keys(params).sort(), [
    "bandCapBps", "bandFloorBps", "chainId", "clock", "closingVwapWindowMs", "codeDigest", "evaluatedAtMs", "lambdaBps", "method", "scorecard",
  ], "mark/1's PARAMS shape is unchanged");
  assert.deepEqual(verifyMarkBundleOffline(bundle).failures, []);
});

// --- deploy 2: swap evidence, by era (W8a) ---------------------------------------------------------------------

import { getAddress } from "ethers";
import {
  RECESS as NOV13, ROOTS, inputsFromBundle, leafValue, loadBundle, slot0Of, strictRecessInputs,
} from "./fixtures/markFixtures.test.ts";
import type { RecessSymbol } from "./fixtures/markFixtures.test.ts";
import { swapListDigest } from "./swapEvidence.ts";
import type { CutRead, SwapEvidenceFields } from "./swapEvidence.ts";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const strictly = (b: unknown) => verifyMarkBundleOffline(clone(b) as never, { era: "swap-evidence" });
const has = (xs: string[], s: string) => xs.some((x) => x.includes(s));

/** Rewrite the leaf list itself (drop or add leaves) and re-root, keeping the convenience copy in step. */
function rerootLeaves(bundle: MarkBundleJson, edit: (leaves: Leaf[], json: Record<string, string>) => Leaf[]) {
  const json: Record<string, string> = { ...bundle.json };
  const next = edit([...loadTree(bundle.tree).entries()].map(([, v]: [number, Leaf]) => v), json);
  const { root, tree } = buildTree(next);
  const claims = next.filter(([k]) => Number(k) === LeafKind.CLAIM).map(([, , h]) => JSON.parse(json[h]));
  return { ...bundle, inputRoot: root, tree: tree.dump(), json, marks: claims };
}

test("legacy fixtures stay reproduced, with notes", () => {
  const v = verifyMarkBundleOffline(clone(buildMarkRound(inputs()).bundle));
  assert.equal(v.ok, true);
  assert.deepEqual(v.failures, []);
  assert.equal(v.era, "pre-swap-fix", "read at block 71,200,000: a row already on chain");
  assert.equal(v.evidenceComplete, null);
  assert.ok(has(v.notes, "swap lists present but not checked"), v.notes.join(" | "));
  assert.ok(has(v.notes, "swapsDuringClosure=4 but closureSwaps lists 1"), v.notes.join(" | "));
  assert.ok(has(v.notes, "is not the price after the last committed closing swap"), v.notes.join(" | "));
  assert.ok(!has(v.notes, "decoded no pool Swap logs"), "E0 is only for empty lists");
  // Still pre-fix once the era's first block is set (every legacy read block is far below any real cutover).
  assert.equal(verifyMarkBundleOffline(clone(buildMarkRound(inputs()).bundle), { swapEvidenceFromBlock: 75_776_413 }).era, "pre-swap-fix");
});

test("the same legacy bundle fails strict mode", () => {
  const v = strictly(buildMarkRound(inputs()).bundle);
  assert.equal(v.ok, false);
  assert.equal(v.era, "swap-evidence");
  assert.ok(v.failures[0].includes("commits no scan ranges"), v.failures.join(" | "));
});

test("without swap evidence the swaps leaf is exactly the pre-fix shape: every archived fixture rebuilds to its own root", () => {
  for (const root of Object.values(ROOTS)) assert.equal(buildMarkRound(inputsFromBundle(loadBundle(root))).root, root);
});

test("the six holiday rows reproduce from the commit instant, neutrally", () => {
  for (const [root, fromCut] of [[ROOTS.holiday2Oct, "2026-10-01T01:30:00"], [ROOTS.holiday20Oct, "2026-10-19T01:30:00"]]) {
    const v = verifyMarkBundleOffline(loadBundle(root));
    assert.equal(v.ok, true, root);
    assert.deepEqual(v.failures, []);
    assert.equal(v.era, "pre-swap-fix");
    const e6 = v.notes.find((n) => n.includes("reopen re-derived from the commit instant"));
    assert.ok(e6, v.notes.join(" | "));
    assert.ok(e6.includes(fromCut), e6);
    assert.ok(!e6.includes("holiday the issuer"), "E6 asserts no cause");
    assert.ok(v.notes[0].startsWith("pre-fix row") && v.notes[0].includes("decoded no pool Swap logs"));
  }
});

test("the fallback never applies in strict mode", () => {
  const v = strictly(loadBundle(ROOTS.holiday2Oct));
  assert.equal(v.ok, false);
  assert.ok(has(v.failures, "reopen mismatch"), v.failures.join(" | "));
  assert.ok(!has(v.notes, "reopen re-derived"));
});

test("the fallback rejects a reopen the commit instant does not give", () => {
  const i = inputsFromBundle(loadBundle(ROOTS.holiday2Oct));
  i.closures[0].settleAfterS += 86_400;
  i.closures[0].venue!.predictedReopenMs += 86_400_000;
  const v = verifyMarkBundleOffline(clone(buildMarkRound(i).bundle));
  assert.equal(v.ok, false);
  assert.ok(has(v.failures, "reopen mismatch"), v.failures.join(" | "));
  assert.ok(!has(v.notes, "reopen re-derived"));
});

test("the US pre-fix row is surfaced, not failed", () => {
  const v = verifyMarkBundleOffline(loadBundle(ROOTS.us9Nov));
  assert.equal(v.ok, true);
  assert.deepEqual(v.failures, []);
  assert.ok(has(v.notes, "pre-fix row"));
  assert.ok(has(v.notes, "decoded no pool Swap logs"));
  assert.ok(has(v.notes, "moved -373.9 bp"), v.notes.join(" | "));
  assert.ok(has(v.notes, "-2.2 bp from the pool mid at the cut block"), v.notes.join(" | "));
});

test("a strict v2 bundle built from real evidence verifies", () => {
  const r = buildMarkRound(strictRecessInputs("wXIAOx"));
  assert.equal(r.marks[0].row.markE18, "3701436175140696810");
  assert.equal(r.marks[0].row.bandBps, 37);
  const v = strictly(r.bundle);
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);
  assert.equal(v.evidenceComplete, true);
  assert.deepEqual(v.notes, ["the cut mid is not bound to a committed pool read (closure opened before this keeper build)"]);
  // Under the default era (the placeholder: every read block is pre-fix) it is a pre-fix row with lists.
  const d = verifyMarkBundleOffline(clone(r.bundle));
  assert.equal(d.ok, true);
  assert.equal(d.era, "pre-swap-fix");
  assert.ok(d.notes[0].startsWith("pre-fix row") && d.notes[0].includes("swap lists present but not checked"), d.notes[0]);
  // And once the era's first block is at or below its read block, it is strict by default.
  const s = verifyMarkBundleOffline(clone(r.bundle), { swapEvidenceFromBlock: NOV13.pinnedBlock });
  assert.equal(s.era, "swap-evidence");
  assert.equal(s.ok, true);
  // The two other recess rows too: a swap in the cut block only, and nothing traded.
  for (const sym of ["wTCENTx", "wMEITx"] as RecessSymbol[]) assert.deepEqual(strictly(buildMarkRound(strictRecessInputs(sym)).bundle).failures, [], sym);
});

/** The wMEITx recess row with a cut read: the pool did not trade, so its pinned slot0 IS the slot0 at the cut. */
function meitCutRead(): CutRead {
  return { blockNumber: NOV13.cutBlock, blockHash: "0x" + "ab".repeat(32), blockTimestamp: 1794542157, slot0: slot0Of(loadBundle(ROOTS.recessMEIT), "wMEITx") };
}

test("a cut read binds midAtCut: the wMEITx round with its cut read verifies with no note", () => {
  const v = strictly(buildMarkRound(strictRecessInputs("wMEITx", meitCutRead())).bundle);
  assert.deepEqual(v.failures, []);
  assert.deepEqual(v.notes, []);
});

type Closure0 = MarkInputs["closures"][number];
type Tamper = [id: string, text: string, sym: RecessSymbol, mutate: (i: MarkInputs, c: Closure0, ev: SwapEvidenceFields) => void, cutRead?: boolean];

const XIAO_POOL = "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417";
const TCENT_POOL = "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f";

const TAMPERS: Tamper[] = [
  ["S1", "commits no scan ranges", "wXIAOx", (_i, _c, ev) => { (ev as { evidence: string }).evidence = "curb.scorecard.swaps/1"; }],
  ["S1 (no v2 keys)", "commits no scan ranges", "wXIAOx", (_i, c) => { delete c.swapEvidence; }],
  ["S2 pool", "pool", "wXIAOx", (_i, _c, ev) => { ev.pool = TCENT_POOL; }],
  ["S2 topic0", "topic0", "wXIAOx", (_i, _c, ev) => { ev.topic0 = "0x" + "00".repeat(32); }],
  ["S3", "closing range", "wXIAOx", (_i, _c, ev) => { ev.closingRange = { fromBlock: NOV13.closingFrom + 1, toBlock: NOV13.cutBlock }; }],
  ["S4", "closure range", "wXIAOx", (_i, _c, ev) => { ev.closureRange = { fromBlock: NOV13.cutBlock + 1, toBlock: NOV13.pinnedBlock - 1 }; }],
  ["S5", "gaps", "wXIAOx", (_i, _c, ev) => { ev.gaps = [[75_776_100, 75_776_200]]; }],
  ["S5 order", "gaps", "wXIAOx", (_i, _c, ev) => { ev.gaps = [[75_776_300, 75_776_310], [75_776_100, 75_776_200]]; ev.complete = false; }],
  ["S6", "closing swaps", "wXIAOx", (_i, _c, ev) => { ev.closingComplete = false; }],
  ["S6 order", "closing swaps", "wXIAOx", (_i, c) => { c.closingSwaps = [...c.closingSwaps]; [c.closingSwaps[0], c.closingSwaps[1]] = [c.closingSwaps[1], c.closingSwaps[0]]; }],
  ["S7", "closure swaps", "wXIAOx", (_i, c, ev) => { const b = c.closureSwaps[5].blockNumber; ev.gaps = [[b, b]]; ev.complete = false; }],
  ["S8 block", "cut read", "wMEITx", (_i, _c, ev) => { ev.cutRead = { ...ev.cutRead!, blockNumber: NOV13.cutBlock + 1 }; }, true],
  ["S8 hash", "cut read", "wMEITx", (_i, _c, ev) => { ev.cutBlockHash = "0x" + "cd".repeat(32); }, true],
  ["S8 slot0", "cut read", "wMEITx", (_i, _c, ev) => { ev.cutRead = { ...ev.cutRead!, slot0: slot0Of(loadBundle(ROOTS.recessMEIT), "wXIAOx") }; }, true],
  ["S8 counts", "counts", "wXIAOx", (_i, _c, ev) => { ev.counts = { ...ev.counts, closingLogs: ev.counts.closingLogs + 1 }; }],
  ["S9", "swapsDuringClosure", "wXIAOx", (_i, c) => { c.input = { ...c.input, swapsDuringClosure: c.input.swapsDuringClosure - 1 }; }],
  ["S10 digest", "digest", "wXIAOx", (_i, c, ev) => { ev.closureDigest = swapListDigest(c.closureSwaps.slice(1)); }],
  ["S10 omitted", "omitted", "wXIAOx", (_i, _c, ev) => { ev.closureOmitted = { fromIndex: 5000, toIndex: 9999 }; }],
  ["S11", "closingVwap", "wXIAOx", (_i, c) => { c.input = { ...c.input, closingVwapE18: c.input.closingVwapE18! + 1n }; }],
  ["S12", "lastPrint", "wXIAOx", (_i, c) => { c.input = { ...c.input, lastPrintE18: c.input.lastPrintE18 + 1n }; }],
  ["S13", "mid at the cut", "wXIAOx", (_i, c) => { c.input = { ...c.input, midAtCutE18: c.input.midAtCutE18 + 1n }; }],
  ["S14", "midNow", "wXIAOx", (_i, c, ev) => {
    const K = c.closureSwaps.slice(0, -1);
    c.closureSwaps = K;
    c.input = { ...c.input, swapsDuringClosure: K.length };
    Object.assign(ev, { closureCount: K.length, counts: { ...ev.counts, closureLogs: K.length }, closureDigest: swapListDigest(K) });
  }],
  ["S14 no swap", "midNow", "wMEITx", (_i, c) => { c.input = { ...c.input, midNowE18: c.input.midNowE18 + 1n }; }],
  ["S15", "slot0", "wXIAOx", (i) => {
    const want = `slot0:${getAddress(XIAO_POOL)}`;
    const other = i.chain.results.find((r) => r.label === `slot0:${getAddress(TCENT_POOL)}`)!.returnData;
    i.chain = { ...i.chain, results: i.chain.results.map((r) => (r.label === want ? { ...r, returnData: other } : r)) };
  }],
  ["S16", "venue", "wXIAOx", (_i, c) => { delete c.venue; }],
  ["S17", "cutBlockHash", "wXIAOx", (_i, _c, ev) => { ev.cutBlockHash = "0x1234"; }],
  ["S18", "the committed schedule says the market was open at the cut", "wXIAOx", (_i, c) => {
    c.cutAtMs = Date.parse("2026-11-13T03:52:00Z");
    c.venue = { ...c.venue!, cutAtMs: c.cutAtMs };
  }],
  ["S19", "cut time", "wXIAOx", (_i, c) => { c.venue = { ...c.venue!, cutAtMs: c.venue!.cutAtMs + 1000 }; }],
  ["S20", "predicted reopen", "wXIAOx", (_i, c) => { c.venue = { ...c.venue!, predictedReopenMs: c.venue!.predictedReopenMs + 1000 }; }],
  ["S22", "after the cut read's block time", "wMEITx", (_i, c) => {
    c.cutAtMs += 120_000;                       // the reviewer's V/08b: a cut moved 2 min later, still inside the recess
    c.venue = { ...c.venue!, cutAtMs: c.cutAtMs };
  }, true],
  ["S21", "holidaysKept", "wXIAOx", (_i, c) => {
    c.venue = { ...c.venue!, holidaysKept: [{ startsAt: "2026-11-12T16:00:00.000Z", endsAt: "2026-11-13T16:00:00.000Z", kind: "Closed", firstSeenMs: 1, lastSeenMs: 2 }] };
  }],
];

test("each strict check catches its own tamper, and only the evidence checks fail", () => {
  for (const [id, text, sym, mutate, withCutRead] of TAMPERS) {
    const i = strictRecessInputs(sym, withCutRead ? meitCutRead() : null);
    assert.deepEqual(strictly(buildMarkRound(i).bundle).failures, [], `${id}: the unmutated bundle is clean`);
    mutate(i, i.closures[0], i.closures[0].swapEvidence!);
    const v = strictly(buildMarkRound(i).bundle);
    assert.equal(v.ok, false, `${id} was not caught`);
    assert.ok(has(v.failures, text), `${id}: no failure contains "${text}": ${v.failures.join(" | ")}`);
    // buildMarkRound keeps the claim consistent with markinput, so nothing but the evidence checks can fail.
    assert.ok(v.failures.every((f) => f.startsWith("swap evidence for ")), `${id}: ${v.failures.join(" | ")}`);
  }
});

test("the swaps leaf's settleAfterS is bound to the claim", () => {
  const b = buildMarkRound(strictRecessInputs("wXIAOx")).bundle;
  const w = leafValue(b, LeafKind.CLAIM).wrapper.toLowerCase();
  const v = strictly(reroot(clone(b), (k, s, x) => (k === LeafKind.FETCH_LOG && s === subjectOf(`swaps:${w}`) ? { ...x, settleAfterS: x.settleAfterS + 1 } : undefined)));
  assert.equal(v.ok, false);
  assert.ok(has(v.failures, "settleAfterS"), v.failures.join(" | "));
});

test("the era fails closed", () => {
  const b = buildMarkRound(strictRecessInputs("wXIAOx")).bundle;
  const noRead = rerootLeaves(clone(b), (leaves) => leaves.filter(([k]) => Number(k) !== LeafKind.CHAIN_CALL));
  const i = strictRecessInputs("wXIAOx");
  i.chain = { ...i.chain, block: { ...i.chain.block, number: "75776392" as unknown as number } };
  const stringBlock = buildMarkRound(i).bundle;
  const twoReads = rerootLeaves(clone(b), (leaves, json) => {
    const chain = leaves.find(([k]) => Number(k) === LeafKind.CHAIN_CALL)!;
    const other = { ...JSON.parse(json[chain[2]]), block: { number: 70_000_000, hash: "0x" + "77".repeat(32), timestamp: 1 } };
    const h = hashJson(other);
    json[h] = jcs(other);
    return [...leaves, [LeafKind.CHAIN_CALL, subjectOf(`multicall@${other.block.hash}`), h] as Leaf];
  });
  for (const [name, x] of [["no CHAIN_CALL", noRead], ["string block", stringBlock], ["two CHAIN_CALLs", twoReads]] as const) {
    const v = verifyMarkBundleOffline(clone(x));
    assert.equal(v.era, "swap-evidence", name);
    assert.equal(v.ok, false, name);
    assert.ok(has(v.failures, "pinned chain read"), `${name}: ${v.failures.join(" | ")}`);
    assert.ok(v.notes.includes("era unknown: checked as swap-evidence"), `${name}: ${v.notes.join(" | ")}`);
  }
});

test("block-time drift is a note, never a failure", () => {
  const i = strictRecessInputs("wXIAOx");
  i.chain = { ...i.chain, block: { ...i.chain.block, timestamp: i.chain.block.timestamp + 120 } };
  const v = strictly(buildMarkRound(i).bundle);
  assert.equal(v.ok, true, v.failures.join(" | "));
  assert.ok(has(v.notes, "one block per second"), v.notes.join(" | "));
  assert.ok(has(v.notes, "(+119 s off)"), v.notes.join(" | "));
});

test("strict notes: gaps, a closing window not committed, a truncated list", () => {
  const i = strictRecessInputs("wMEITx");
  const ev = i.closures[0].swapEvidence!;
  ev.gaps = [[75_774_000, 75_774_999]];
  ev.complete = false;
  ev.closingComplete = false;
  const v = strictly(buildMarkRound(i).bundle);
  assert.deepEqual(v.failures, []);
  assert.equal(v.evidenceComplete, false);
  assert.ok(has(v.notes, "closure scan incomplete: gaps 75774000..75774999"), v.notes.join(" | "));
  assert.ok(has(v.notes, "closing window not committed"), v.notes.join(" | "));
});

test("a malformed v2 leaf is a failure, never a throw", () => {
  const b = buildMarkRound(strictRecessInputs("wXIAOx")).bundle;
  const w = leafValue(b, LeafKind.CLAIM).wrapper.toLowerCase();
  const garbage: unknown[] = [
    { gaps: "x", closingSwaps: null, closureSwaps: [{ blockNumber: "1" }], counts: [], closureOmitted: 5, cutRead: "x" },
    { closingRange: null, closureRange: [], closureCount: -1, cutBlock: 1.5 },
    { cutRead: { blockNumber: NOV13.cutBlock, blockHash: "0x" + "ab".repeat(32), blockTimestamp: 1, slot0: "0xzz" }, cutBlockHash: "0x" + "ab".repeat(32) },
  ];
  for (const g of garbage) {
    const x = reroot(clone(b), (k, s, v) => (k === LeafKind.FETCH_LOG && s === subjectOf(`swaps:${w}`) ? { ...v, ...(g as object) } : undefined));
    const v = strictly(x);
    assert.equal(v.ok, false, JSON.stringify(g));
    assert.ok(v.failures.length > 0);
  }
});

test("a pre-fix row with garbage lists still verifies (notes are never failures)", () => {
  const b = buildMarkRound(inputs()).bundle;
  const w = W.toLowerCase();
  const x = reroot(clone(b), (k, s, v) => (k === LeafKind.FETCH_LOG && s === subjectOf(`swaps:${w}`) ? { ...v, closingSwaps: [{ nonsense: true }], closureSwaps: "no" } : undefined));
  const v = verifyMarkBundleOffline(x);
  assert.deepEqual(v.failures, []);
  assert.ok(v.notes[0].startsWith("pre-fix row"));
});

test("several claims in one bundle: each note names its symbol", () => {
  const i = inputs();
  const W2 = "0x076CF393E701839FC7a5832D2c68AaFA235682AE";
  i.specs = [...i.specs, { wrapper: W2, symbol: "XIAOx", pool: XIAO_POOL, equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 }];
  i.closures = [...i.closures, { ...i.closures[0], wrapper: W2, symbol: "XIAOx", input: { ...i.closures[0].input, wrapper: W2, symbol: "XIAOx" } }];
  const v = verifyMarkBundleOffline(clone(buildMarkRound(i).bundle));
  assert.equal(v.ok, true, v.failures.join(" | "));
  assert.ok(v.notes.some((n) => n.startsWith("TCENTx: pre-fix row")) && v.notes.some((n) => n.startsWith("XIAOx: pre-fix row")), v.notes.join(" | "));
});

// --- review fixes (16 Nov): cutAtMs bound to the cut read (F1), clock slack at the cut shared with checkCut (F2) ---

import { CUT_READ_LAG_MAX_S, CUT_READ_LAG_MIN_S } from "./swapEvidence.ts";
import { checkCut } from "./venueTime.ts";
import type { ExchangeSchedule } from "./regime.ts";

/** The real cut read of the 13 Nov recess, wMEITx (block 75,773,120 at 03:55:56Z; read with eth_call at that block). */
const REAL_MEIT_CUT_READ: CutRead = {
  blockNumber: 75_773_120, blockHash: "0x430f6e6c725e16574ed783aeb8a11b3034623d7013770abbfbd62f82e07ad5ca", blockTimestamp: 1_794_542_156,
  slot0: "0x0000000000000000000000000000000000050ed0774e1d15612b4d3de016c5ad000000000000000000000000000000000000000000000000000000000003e11e000000000000000000000000000000000000000000000000000000000000016f00000000000000000000000000000000000000000000000000000000000002d000000000000000000000000000000000000000000000000000000000000002d000000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000001",
};

/** The wMEITx recess round with `cutRead`, its cut moved by `shiftS` seconds (venue and swaps leaf alike). */
function meitShifted(cutRead: CutRead, shiftS: number) {
  const i = strictRecessInputs("wMEITx", cutRead);
  const c = i.closures[0];
  c.cutAtMs += shiftS * 1000;
  c.venue = { ...c.venue!, cutAtMs: c.cutAtMs };
  return i;
}

test("S22: the observed cut instant is bound to the committed cut read (the real 13 Nov read: honest +1 s; +2 min and +30 min fail)", () => {
  const honest = strictly(buildMarkRound(strictRecessInputs("wMEITx", REAL_MEIT_CUT_READ)).bundle);
  assert.deepEqual(honest.failures, []);
  assert.deepEqual(honest.notes, []);
  for (const shift of [120, 1_800]) {
    const v = strictly(buildMarkRound(meitShifted(REAL_MEIT_CUT_READ, shift)).bundle);
    assert.equal(v.ok, false, `+${shift} s`);
    assert.ok(has(v.failures, "after the cut read's block time"), v.failures.join(" | "));
  }
  // The bounds, exactly: the cut at -5..+60 s from the read's block passes, one second further does not.
  const cutS = Math.floor(strictRecessInputs("wMEITx").closures[0].cutAtMs / 1000);
  const read = (lagS: number): CutRead => ({ ...REAL_MEIT_CUT_READ, blockTimestamp: cutS - lagS });
  for (const lag of [CUT_READ_LAG_MIN_S, 0, 1, CUT_READ_LAG_MAX_S]) {
    assert.deepEqual(strictly(buildMarkRound(strictRecessInputs("wMEITx", read(lag))).bundle).failures, [], `lag ${lag}`);
  }
  for (const lag of [CUT_READ_LAG_MIN_S - 1, CUT_READ_LAG_MAX_S + 1]) {
    assert.ok(has(strictly(buildMarkRound(strictRecessInputs("wMEITx", read(lag))).bundle).failures, "after the cut read's block time"), `lag ${lag}`);
  }
});

test("block-time drift is computed from the observed cut instant, not from the cut read", () => {
  // A cut read 60 s before the cut instant (allowed), and a pinned read that ran 61 s slow per block from the cut.
  const i0 = strictRecessInputs("wMEITx");
  const cutS = Math.floor(i0.closures[0].cutAtMs / 1000);
  const i = strictRecessInputs("wMEITx", { ...REAL_MEIT_CUT_READ, blockTimestamp: cutS - 60 });
  i.chain = { ...i.chain, block: { ...i.chain.block, timestamp: cutS + (i.chain.block.number - NOV13.cutBlock) - 61 } };
  const v = strictly(buildMarkRound(i).bundle);
  assert.deepEqual(v.failures, []);
  assert.ok(has(v.notes, "(-61 s off)"), v.notes.join(" | "));
});

test("S18 allows the same clock slack as the keeper's cut check, and no more", () => {
  const hk = leafValue(loadBundle(ROOTS.recessXIAO), LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${leafValue(loadBundle(ROOTS.recessXIAO), LeafKind.CLAIM).wrapper.toLowerCase()}`));
  const S = { mic: hk.mic, schedule: hk.schedule } as ExchangeSchedule;
  const zero = Date.parse("2026-11-13T03:55:00Z");
  for (let offS = -10; offS <= 10; offS++) {
    const cutAtMs = zero + offS * 1000;
    const i = strictRecessInputs("wXIAOx");
    i.closures[0].cutAtMs = cutAtMs;
    i.closures[0].venue = { ...i.closures[0].venue!, cutAtMs };
    const verifierOk = !has(strictly(buildMarkRound(i).bundle).failures, "open at the cut");
    const keeperOk = checkCut({ cutAtMs }, hk.limitsPerPeriod, S, cutAtMs, 30_000).kind === "ok";
    assert.equal(verifierOk, keeperOk, `${offS} s: the keeper's cut check and S18 must agree`);
    assert.equal(verifierOk, offS >= -5, `${offS} s`);
  }
});
