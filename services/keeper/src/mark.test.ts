import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMark, appliedBps, MARK_METHOD_VERSION, MARK1, MARK2 } from "./mark.ts";
import type { ClosureInput, SignalInput } from "./mark.ts";
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
  assert.equal(MARK_METHOD_VERSION, "curb.scorecard.mark/2");
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

// --- curb.scorecard.mark/2: the cross-market term ---------------------------------------------

/** 56.00 last print; perp +100 bp (440 -> 444.40); ADR-implied +50 bp (443.205 at fx 1.0 over a 441 close). */
const still: ClosureInput = { ...base, lastPrintE18: 56n * E18, midAtCutE18: 56n * E18, midNowE18: 56n * E18, swapsDuringClosure: 0 };
const overnight = (over: Partial<SignalInput> = {}): SignalInput => ({
  closureS: 63_000,
  proxy: "wTCENTx",
  perp: { symbol: "HK0700USDT", cutMinuteMs: 0, commitMinuteMs: 60_000, cutE18: (440n * E18).toString(), commitE18: (4444n * E18 / 10n).toString() },
  adr: {
    adr: "TCEHY", sessionEndS: 0, adrCloseE18: (443205n * E18 / 1000n).toString(), fxE18: E18.toString(), sharesPerAdr: 1,
    impliedE18: (443205n * E18 / 1000n).toString(), primary: "0700.HK", primarySessionEndS: 0, primaryCloseE18: (441n * E18).toString(),
  },
  missing: [],
  ...over,
});

test("mark/2: the mean of both legs, times beta 0.79, moves the last print", () => {
  const m = computeMark({ ...still, signal: overnight() }, MARK2)!;
  assert.equal(m.signal!.perpBps, 100);
  assert.equal(m.signal!.adrBps, 50);
  assert.equal(m.signal!.rBps, 75);
  assert.equal(m.signal!.betaBps, 7_900);
  assert.equal(m.signal!.applied, true);
  assert.equal(m.signal!.appliedBps, 59);
  // 56 x (1 + 0.79 x 0.0075) = 56.3318, exactly, in integer arithmetic
  assert.equal(m.markE18, 563318n * E18 / 10_000n);
  assert.equal(m.bandBps, 25 + 37, "the band widens with the undamped move, as mark/1's does with drift");
  assert.equal(m.lastPrintE18, 56n * E18, "the baseline is untouched");
  assert.ok(!m.flags.includes("no-signal"));
});

test("mark/2: one leg missing uses the other, and says which", () => {
  const m = computeMark({ ...still, signal: overnight({ adr: null, missing: ["yahoo:adr:no-bar"] }) }, MARK2)!;
  assert.equal(m.signal!.rBps, 100);
  assert.equal(m.markE18, 564424n * E18 / 10_000n, "56 x (1 + 0.79 x 0.01)");
  assert.ok(m.flags.includes("adr-missing"));
  assert.deepEqual(m.signal!.missing, ["yahoo:adr:no-bar"]);
  const p = computeMark({ ...still, signal: overnight({ perp: null }) }, MARK2)!;
  assert.equal(p.signal!.rBps, 50);
  assert.ok(p.flags.includes("perp-missing"));
});

test("mark/2 with no signal at all IS mark/1: same number, flagged, nothing invented", () => {
  const drifting: ClosureInput = { ...base, midNowE18: 5508n * E18 / 100n };   // the pool ran +2%
  const none = overnight({ perp: null, adr: null, missing: ["perp:cut:absent", "perp:commit:absent", "yahoo:adr:absent"] });
  const m2 = computeMark({ ...drifting, signal: none }, MARK2)!;
  const m1 = computeMark(drifting, MARK1)!;
  assert.equal(m2.markE18, m1.markE18);
  assert.equal(m2.markE18, 5454n * E18 / 100n);
  assert.equal(m2.bandBps, m1.bandBps);
  assert.ok(m2.flags.includes("no-signal"));
  assert.equal(m2.signal!.applied, false);
  assert.equal(m2.signal!.appliedBps, 0);
  assert.equal(computeMark(drifting, MARK2)!.markE18, m1.markE18, "a mark/2 input with no signal field at all, likewise");
});

test("mark/2 in the lunch recess: the perp's move is recorded, weighted zero, and the mark is the last print", () => {
  // Row #12's real move: +26 bp on HK0700USDT over the 24 Sep recess; the pool reopened flat.
  const recess = overnight({
    closureS: 3_891, adr: null,
    perp: { symbol: "HK0700USDT", cutMinuteMs: 0, commitMinuteMs: 60_000, cutE18: "434200000000000000000", commitE18: "435330000000000000000" },
  });
  const m = computeMark({ ...still, signal: recess }, MARK2)!;
  assert.equal(m.markE18, still.lastPrintE18);
  assert.ok(m.flags.includes("recess-no-edge"));
  assert.equal(m.signal!.perpBps, 26, "the evidence is kept");
  assert.equal(m.signal!.applied, false);
  assert.equal(m.signal!.appliedBps, 0);
  assert.equal(m.bandBps, 25);
});

test("mark/2: an asset with no proxy (the US names) gets no cross-market term", () => {
  const m = computeMark({ ...still, signal: { closureS: 200_000, proxy: null, perp: null, adr: null, missing: ["no-proxy"] } }, MARK2)!;
  assert.equal(m.markE18, still.lastPrintE18);
  assert.ok(m.flags.includes("no-proxy") && m.flags.includes("no-signal"));
});

test("mark/2: a leg beyond 20% is a bad print, set aside rather than applied", () => {
  const wild = overnight();
  wild.perp = { ...wild.perp!, commitE18: (550n * E18).toString() };   // +25%
  const m = computeMark({ ...still, signal: wild }, MARK2)!;
  assert.ok(m.flags.includes("perp-implausible"));
  assert.equal(m.signal!.perpBps, null);
  assert.equal(m.signal!.rBps, 50, "the ADR leg alone");
});

test("mark/2: when the signal is applied the pool's drift is not added on top of it", () => {
  const m = computeMark({ ...still, swapsDuringClosure: 3, midNowE18: 5712n * E18 / 100n, signal: overnight() }, MARK2)!;
  assert.equal(m.driftBps, 200, "still recorded");
  assert.ok(m.flags.includes("drift-superseded"));
  assert.equal(m.markE18, 563318n * E18 / 10_000n, "the same mark as with a still pool");
});

test("mark/1 ignores a signal entirely: old rows re-derive exactly as they were committed", () => {
  const m = computeMark({ ...still, signal: overnight() }, MARK1)!;
  assert.equal(m.markE18, still.lastPrintE18);
  assert.equal(m.signal, undefined);
  assert.ok(!m.flags.includes("no-signal"));
});
