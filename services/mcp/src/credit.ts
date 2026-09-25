/**
 * curb_credit: what CurbCredit would lend against one wrapper right now, and the bonded depth behind it.
 *
 * CurbCredit's LTV (src/CurbCredit.sol) is min(regime cap, what the honoured bids would pay):
 *   ltvFor       = 0 if MarketClock is UNKNOWN, Scorecard's priceNow is unreadable, or no honoured depth;
 *                  otherwise min(60% while primaryCapNow > 0 | 30% while shut, minBid / price)
 *   ltvEffective = ltvFor scaled down pro rata once the honoured book no longer covers everything lent
 * Honoured depth is DepthCert.honouredDepth(asset, CurbCredit, minCertExpiry(asset)): only certs naming
 * CurbCredit that outlive the slowest liquidation count, so it is read with the exact expiry floor the
 * contract itself applies, at the same block.
 *
 * Two aggregate3 calls pinned to one block hash: everything, then honouredDepth with that block's floor.
 * When ltvFor is 0 the answer names which of the three inputs zeroed it, from the same reads.
 *
 * Units, as the contract keeps them: USDG has 6 decimals; wrapper shares 18; Scorecard's price is USD per
 * whole share, 1e18-scaled; a DepthCert bid is USDG units per whole share.
 */
import { Interface, formatUnits } from "ethers";
import { CONTRACTS, CHAIN_ID } from "./assets.ts";
import type { Asset } from "./assets.ts";
import { clockAbi } from "./clock.ts";
import { scorecardAbi } from "./scorecard.ts";
import { asOfBlock } from "./sources/chain.ts";
import type { AsOf, Call, CallResult, ChainReader } from "./sources/chain.ts";

export const creditAbi = new Interface([
  "function isAsset(address) view returns (bool)",
  "function ltvFor(address) view returns (uint256)",
  "function ltvEffective(address) view returns (uint256)",
  "function reserve() view returns (uint256)",
  "function minCertExpiry(address) view returns (uint64)",
  "function realisable(address) view returns (uint256)",
  "function totalCollateral(address) view returns (uint256)",
  "function totalPrincipal(address) view returns (uint256)",
  "function isOpen(address) view returns (bool)",
  "function LTV_OPEN_BPS() view returns (uint256)",
  "function LTV_SHUT_BPS() view returns (uint256)",
]);

export const depthAbi = new Interface([
  "function honouredDepth(address wrapper, address beneficiary, uint64 minExpiry) view returns (uint256 shares, uint256 notional, uint128 minBidPx, uint64 soonestExpiry)",
]);

const usdg = (v: bigint) => formatUnits(v, 6);
const shares = (v: bigint) => formatUnits(v, 18);
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(2)}%`;
const iso = (s: number) => new Date(s * 1000).toISOString();

export interface CreditResult {
  summary: string;
  asOf: AsOf;
  source: { chainId: number; curbCredit: string; depthCert: string; marketClock: string; scorecard: string };
  symbol: string;
  wrapper: string;
  supported: boolean;
  ltvForBps: number;
  ltvEffectiveBps: number;
  /** Why ltvFor is what it is, in the contract's own terms. */
  binding: string;
  regimeCapBps: { open: number; shut: number; now: number | null };
  marketOpen: boolean;
  clockKnown: boolean;
  priceNowUsd: string | null;
  reserveUsdg: string;
  totalPrincipalUsdg: string;
  totalCollateralShares: string;
  realisableUsdg: string;
  honouredDepth: {
    minCertExpiry: string;
    shares: string;
    notionalUsdg: string;
    minBidUsdgPerShare: string;
    soonestExpiry: string | null;
    note: string;
  };
}

function ok(results: CallResult[], label: string): CallResult | null {
  const r = results.find((x) => x.label === label);
  return r && r.success && r.returnData !== "0x" ? r : null;
}

function need(results: CallResult[], label: string): CallResult {
  const r = ok(results, label);
  if (!r) throw new Error(`read failed: ${label}`);
  return r;
}

export async function readCredit(chain: ChainReader, a: Asset): Promise<CreditResult> {
  const cc = CONTRACTS.curbCredit, w = a.wrapper;
  const c = (label: string, fn: string, args: unknown[] = []): Call => ({ label, target: cc, callData: creditAbi.encodeFunctionData(fn, args) });
  const block = await chain.pin();
  const r1 = await chain.multicall(block, [
    c("isAsset", "isAsset", [w]), c("ltvFor", "ltvFor", [w]), c("ltvEff", "ltvEffective", [w]), c("reserve", "reserve"),
    c("minExpiry", "minCertExpiry", [w]), c("realisable", "realisable", [w]), c("coll", "totalCollateral", [w]),
    c("principal", "totalPrincipal", [w]), c("isOpen", "isOpen", [w]), c("capOpen", "LTV_OPEN_BPS"), c("capShut", "LTV_SHUT_BPS"),
    { label: "regime", target: CONTRACTS.marketClock, callData: clockAbi.encodeFunctionData("regime", [w]) },
    // priceNow reverts when the pool's guard refuses; allowFailure turns that into "unreadable", which is the point.
    { label: "price", target: CONTRACTS.scorecard, callData: scorecardAbi.encodeFunctionData("priceNow", [w]) },
  ]);
  const dec = (label: string, fn: string, abi: Interface = creditAbi) => abi.decodeFunctionResult(fn, need(r1, label).returnData)[0];
  const supported = Boolean(dec("isAsset", "isAsset"));
  const ltvFor = BigInt(dec("ltvFor", "ltvFor"));
  const ltvEff = BigInt(dec("ltvEff", "ltvEffective"));
  const reserve = BigInt(dec("reserve", "reserve"));
  const minExpiry = Number(dec("minExpiry", "minCertExpiry"));
  const realisable = BigInt(dec("realisable", "realisable"));
  const coll = BigInt(dec("coll", "totalCollateral"));
  const principal = BigInt(dec("principal", "totalPrincipal"));
  const open = Boolean(dec("isOpen", "isOpen"));
  const capOpen = Number(dec("capOpen", "LTV_OPEN_BPS"));
  const capShut = Number(dec("capShut", "LTV_SHUT_BPS"));
  const regime = Number(dec("regime", "regime", clockAbi));
  const priceRes = ok(r1, "price");
  const price = priceRes ? BigInt(scorecardAbi.decodeFunctionResult("priceNow", priceRes.returnData)[0]) : 0n;

  const r2 = await chain.multicall(block, [{
    label: "depth", target: CONTRACTS.depthCert,
    callData: depthAbi.encodeFunctionData("honouredDepth", [w, cc, minExpiry]),
  }]);
  const dd = depthAbi.decodeFunctionResult("honouredDepth", need(r2, "depth").returnData);
  const dShares = BigInt(dd[0]), dNotional = BigInt(dd[1]), minBid = BigInt(dd[2]), soonest = Number(dd[3]);

  const known = regime !== 0;
  const priced = price > 0n;
  const hasDepth = dShares > 0n && minBid > 0n;
  const regimeCapNow = known ? (open ? capOpen : capShut) : null;

  let binding: string;
  if (!supported) {
    binding = `CurbCredit does not list ${a.symbol} as collateral (isAsset is false), so ltvFor is 0`;
  } else if (ltvFor === 0n) {
    const why: string[] = [];
    if (!known) why.push("MarketClock reads UNKNOWN for it");
    if (!priced) why.push("Scorecard.priceNow is unreadable (no price source, or the pool's TWAP guard refuses)");
    if (!hasDepth) why.push(`no bonded DepthCert bid naming CurbCredit expires on or after ${iso(minExpiry)}`);
    binding = `ltvFor is 0 because ${why.length ? why.join("; and ") : "the honoured bid rounds to 0 against the price"}`;
  } else {
    const depthBps = (minBid * 10n ** 12n * 10_000n) / price;
    binding = BigInt(regimeCapNow ?? 0) <= depthBps
      ? `the regime cap binds: ${pct(regimeCapNow ?? 0)} while the primary market is ${open ? "open" : "shut"}; the honoured bid alone would allow ${pct(depthBps)}`
      : `the bonded depth binds: the lowest honoured bid is ${pct(depthBps)} of the pool value, under the ${pct(regimeCapNow ?? 0)} regime cap`;
  }

  const summary =
    `${a.symbol} on CurbCredit at block ${block.number}: ltvFor ${pct(ltvFor)}, ltvEffective ${pct(ltvEff)}. Why: ${binding}. ` +
    `Reserve ${usdg(reserve)} USDG; honoured depth ${shares(dShares)} shares at a lowest bid of ${usdg(minBid)} USDG per share.`;

  return {
    summary,
    asOf: asOfBlock(block, chain.rpcs),
    source: { chainId: CHAIN_ID, curbCredit: cc, depthCert: CONTRACTS.depthCert, marketClock: CONTRACTS.marketClock, scorecard: CONTRACTS.scorecard },
    symbol: a.symbol,
    wrapper: w,
    supported,
    ltvForBps: Number(ltvFor),
    ltvEffectiveBps: Number(ltvEff),
    binding,
    regimeCapBps: { open: capOpen, shut: capShut, now: regimeCapNow },
    marketOpen: open,
    clockKnown: known,
    priceNowUsd: priced ? formatUnits(price, 18) : null,
    reserveUsdg: usdg(reserve),
    totalPrincipalUsdg: usdg(principal),
    totalCollateralShares: shares(coll),
    realisableUsdg: usdg(realisable),
    honouredDepth: {
      minCertExpiry: iso(minExpiry),
      shares: shares(dShares),
      notionalUsdg: usdg(dNotional),
      minBidUsdgPerShare: usdg(minBid),
      soonestExpiry: soonest ? iso(soonest) : null,
      note:
        "DepthCert.honouredDepth(asset, CurbCredit, minCertExpiry(asset)): bonded bids naming CurbCredit whose expiry is at least " +
        "minCertExpiry, which is now + 1 h 30 min while the market is open with no close due within that time, and at least " +
        "now + 73 h 30 min while it is shut or a close is due (CurbCredit.sol, WHICH CERTS COUNT)",
    },
  };
}
