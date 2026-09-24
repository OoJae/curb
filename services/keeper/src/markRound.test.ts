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
