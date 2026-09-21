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
