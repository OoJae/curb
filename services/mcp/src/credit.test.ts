import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { readCredit } from "./credit.ts";
import { CONTRACTS, requireAsset } from "./assets.ts";
import { BLOCK, fakeChain } from "./fixtures/fakeChain.ts";

const TCENT = requireAsset("wTCENTx");
const MIN_EXPIRY = BLOCK.timestamp + 73 * 3600 + 1800;

interface World { isAsset?: boolean; ltvFor?: number; ltvEff?: number; open?: boolean; regime?: number; price?: bigint | null; depth?: [bigint, bigint, bigint, number] }

function creditChain(w: World) {
  const seen: unknown[][] = [];
  const chain = fakeChain((target, fn, args) => {
    if (target === CONTRACTS.curbCredit) {
      switch (fn) {
        case "isAsset": return [w.isAsset ?? true];
        case "ltvFor": return [w.ltvFor ?? 0];
        case "ltvEffective": return [w.ltvEff ?? w.ltvFor ?? 0];
        case "reserve": return [3_000_000n];
        case "minCertExpiry": return [MIN_EXPIRY];
        case "realisable": return [0n];
        case "totalCollateral": return [parseUnits("0.05", 18)];
        case "totalPrincipal": return [0n];
        case "isOpen": return [w.open ?? false];
        case "LTV_OPEN_BPS": return [6000];
        case "LTV_SHUT_BPS": return [3000];
      }
    }
    if (target === CONTRACTS.marketClock && fn === "regime") return [w.regime ?? 1];
    if (target === CONTRACTS.scorecard && fn === "priceNow") return w.price === null ? undefined : [w.price ?? parseUnits("56", 18)];
    if (target === CONTRACTS.depthCert && fn === "honouredDepth") { seen.push(args); return w.depth ?? [0n, 0n, 0n, 0]; }
    return undefined;
  });
  return { chain, seen };
}

test("honoured depth is read with CurbCredit's own expiry floor, at the same block", async () => {
  const { chain, seen } = creditChain({});
  const r = await readCredit(chain, TCENT);
  assert.equal(chain.calls, 2);
  assert.deepEqual(seen[0].map(String), [TCENT.wrapper, CONTRACTS.curbCredit, String(MIN_EXPIRY)]);
  assert.equal(r.honouredDepth.minCertExpiry, new Date(MIN_EXPIRY * 1000).toISOString());
  assert.equal(r.reserveUsdg, "3.0");
  assert.equal(r.totalCollateralShares, "0.05");
  assert.equal(r.asOf.block, BLOCK.number);
});

test("ltvFor 0 names every input that zeroed it", async () => {
  const noDepth = await readCredit(creditChain({}).chain, TCENT);
  assert.match(noDepth.binding, /^ltvFor is 0 because no bonded DepthCert bid naming CurbCredit expires on or after /);
  assert.match(noDepth.summary, /ltvFor 0\.00%, ltvEffective 0\.00%\. Why: ltvFor is 0 because/);
  const all = await readCredit(creditChain({ regime: 0, price: null }).chain, TCENT);
  assert.match(all.binding, /MarketClock reads UNKNOWN.*; and Scorecard\.priceNow is unreadable.*; and no bonded DepthCert bid/);
  assert.equal(all.priceNowUsd, null);
  assert.equal(all.clockKnown, false);
  assert.equal(all.regimeCapBps.now, null);
});

test("with depth: says whether the regime cap or the bonded bid binds, as _ltv computes it", async () => {
  // Shut (30% cap). Lowest bid 28 USDG a share against a 56 USD price: the bid alone allows 50%, so the cap binds.
  const capBinds = await readCredit(creditChain({ ltvFor: 3000, depth: [parseUnits("10", 18), 280_000_000n, 28_000_000n, MIN_EXPIRY + 60] }).chain, TCENT);
  assert.equal(capBinds.ltvForBps, 3000);
  assert.match(capBinds.binding, /the regime cap binds: 30\.00% while the primary market is shut; the honoured bid alone would allow 50\.00%/);
  assert.equal(capBinds.honouredDepth.minBidUsdgPerShare, "28.0");
  assert.equal(capBinds.honouredDepth.soonestExpiry, new Date((MIN_EXPIRY + 60) * 1000).toISOString());
  // Open (60% cap). The same bid allows 50%, under the cap: the depth binds.
  const depthBinds = await readCredit(creditChain({ ltvFor: 5000, open: true, depth: [parseUnits("10", 18), 280_000_000n, 28_000_000n, MIN_EXPIRY + 60] }).chain, TCENT);
  assert.match(depthBinds.binding, /the bonded depth binds: the lowest honoured bid is 50\.00% of the pool value, under the 60\.00% regime cap/);
});

test("an asset CurbCredit does not list says so", async () => {
  const r = await readCredit(creditChain({ isAsset: false }).chain, requireAsset("wSHEINx"));
  assert.equal(r.supported, false);
  assert.match(r.binding, /does not list wSHEINx as collateral/);
});
