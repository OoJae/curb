import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMark, appliedBps, MARK_METHOD_VERSION } from "./mark.ts";
import type { ClosureInput } from "./mark.ts";
import { priceFromSqrt, vwap, twapTick } from "./sources/pools.ts";

const E18 = 10n ** 18n;
const base: ClosureInput = {
  wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E",
  symbol: "TCENTx",
  lastPrintE18: 54n * E18,
  midAtCutE18: 54n * E18,
  midNowE18: 54n * E18,
  closingVwapE18: 545n * E18 / 10n,
  swapsDuringClosure: 3,
};

test("a still pool means the mark IS the last print, and says so", () => {
  const m = computeMark({ ...base, swapsDuringClosure: 0, midNowE18: 60n * E18 })!;
  assert.equal(m.markE18, base.lastPrintE18, "no trades means no evidence, whatever the stale mid says");
  assert.equal(m.driftBps, 0);
  assert.ok(m.flags.includes("no-drift"));
});

test("the pool's move during the closure is applied at half weight", () => {
  // The AMM ran 2% up with the primary shut; half of that is evidence, half is overshoot.
  const m = computeMark({ ...base, midNowE18: 5508n * E18 / 100n })!; // 55.08 = +2%
  assert.equal(m.driftBps, 200);
  assert.equal(appliedBps(m.driftBps), 100);
  // 54 x (1 + 0.5 x 0.02) = 54.54
  assert.equal(m.markE18, 5454n * E18 / 100n);
});

test("a fall is damped the same way, and the band widens with the move", () => {
  const m = computeMark({ ...base, midNowE18: 5292n * E18 / 100n })!; // 52.92 = -2%
  assert.equal(m.driftBps, -200);
  assert.equal(m.markE18, 5346n * E18 / 100n);              // 54 x (1 - 0.01)
  assert.equal(m.bandBps, 125);                              // 25 + 200/2
  const calm = computeMark(base)!;
  assert.equal(calm.bandBps, 25, "a still market gets the floor band, not a wide one");
});

test("the mark never claims a precision the method does not have: the band is capped", () => {
  const m = computeMark({ ...base, midNowE18: 540n * E18 })!; // a 900% move
  assert.equal(m.bandBps, 2_000);
});

test("no closing VWAP falls back to the last print, flagged, rather than recording a zero baseline", () => {
  const m = computeMark({ ...base, closingVwapE18: null })!;
  assert.equal(m.closingVwapE18, base.lastPrintE18);
  assert.ok(m.flags.includes("no-closing-vwap"));
});

test("without a last print there is no mark at all, and none is committed", () => {
  assert.equal(computeMark({ ...base, lastPrintE18: 0n }), null);
  assert.equal(computeMark({ ...base, midAtCutE18: 0n }), null);
});

test("an unknown method is refused rather than silently defaulting", () => {
  assert.throws(() => computeMark(base, "curb.scorecard.mark/9"), /unknown mark method/);
  assert.equal(MARK_METHOD_VERSION, "curb.scorecard.mark/1");
});

// --- the price arithmetic, pinned to real chain state ---------------------------------------

test("sqrtPriceX96 converts to the same price the contract computes, on real pool data", () => {
  // wTCENTx/USDG on X Layer, read 21 Sep 2026: 18-decimal wrapper as token0, 6-decimal USDG.
  const spec = { equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 };
  const price = priceFromSqrt(585417536637190936853387n, spec);
  assert.equal(price, 54597441088191159066n, "$54.5974, matching Scorecard._priceFromSqrt to the wei");
});

test("the same price expressed with the stable as token0 comes back identical", () => {
  const inverted = priceFromSqrt(10722439463315307592378999951434176n, {
    equityIsToken0: false, equityDecimals: 18, stableDecimals: 6,
  });
  // Three of the five live pools list the stable first; getting this backwards prices the wrong leg.
  const diff = inverted > 54597441088191159066n ? inverted - 54597441088191159066n : 54597441088191159066n - inverted;
  assert.ok(diff * 10_000n / 54597441088191159066n < 10n, `within 10bp, got ${inverted}`);
});

test("VWAP weighs by size and ignores an empty window", () => {
  assert.equal(vwap([]), null);
  assert.equal(vwap([{ blockNumber: 1, logIndex: 0, equityAbs: 0n, priceE18: 50n * E18 }]), null);
  const v = vwap([
    { blockNumber: 1, logIndex: 0, equityAbs: 1n * E18, priceE18: 50n * E18 },
    { blockNumber: 2, logIndex: 0, equityAbs: 3n * E18, priceE18: 54n * E18 },
  ]);
  assert.equal(v, 53n * E18, "the larger trade dominates");
});

test("the TWAP tick matches the spot tick when nothing has traded", () => {
  // The exact cumulatives the live pool returned during a closure.
  assert.equal(twapTick([-635625813176n, -635554916276n], 300), -236323);
});
