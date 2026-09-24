/**
 * Specimen view models for the W3/W4 instruments until they are deployed: the live-demo plan from
 * docs/specs/W3W4-contracts.md (team wallets curb-desk ↔ Agentic Wallet), priced with today's real
 * Scorecard.priceNow and timed by the real schedule. Every object carries `specimen: true`.
 */
import { AGENTIC_WALLET, CURB_CREDIT, CURB_DESK, assetBySymbol } from "../addresses.ts";
import { ltvBpsAt, ltvPoints, notional, regimeCapBps } from "../depth.ts";
import { discountBps, FALLBACK_AFTER_MS, lotPriceAt, valueUsdg } from "../notes.ts";
import { closureAt, nextClosure, nextReopenMs } from "../schedule.ts";
import type { Address, AssetBoardRow, AuctionLot, CertView, CreditPosition, DepthView, NoteView, PointerEpoch, PriceNow } from "../types.ts";

const E18 = 10n ** 18n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const usd = (v: bigint) => Number(v) / 1e6;
const sh = (v: bigint) => Number(v) / 1e18;

export function specimenFixtures(p: { nowMs: number; prices: PriceNow[]; block: number; regime: AssetBoardRow[] }) {
  const tc = assetBySymbol("wTCENTx")!;
  const priceE18 = BigInt(p.prices.find((x) => x.symbol === "wTCENTx")?.priceE18 ?? "55780000000000000000");
  const price = sh(priceE18);
  const row = p.regime.find((r) => r.symbol === "wTCENTx");
  const shut = !row || row.cap === 0;

  // Timeline: the closure in progress (or the next one) and its reopen.
  const cur = closureAt(p.nowMs) ?? nextClosure(p.nowMs)!;
  const cutMs = cur.startMs!;
  const reopenMs = nextReopenMs(p.nowMs) ?? cur.endMs!;
  const mintedAtMs = cutMs + 25 * 60_000;
  const listAtMs = mintedAtMs + 5 * 60_000;

  // Note 1: curb-desk escrows 0.1 wTCENTx during the closure.
  const noteShares = E18 / 10n;
  const notes: NoteView[] = [{
    id: "1",
    wrapper: tc.wrapper,
    symbol: tc.symbol,
    issuer: CURB_DESK,
    wrapperSharesRaw: noteShares.toString(),
    shares: sh(noteShares),
    underlyingAtMintRaw: noteShares.toString(),
    multiplierNonce: row?.multiplierNonce ?? 0,
    epochAtMint: 0,
    mintedAtMs,
    mintedBlock: p.block - Math.round((p.nowMs - mintedAtMs) / 1000),
    outstandingRaw: noteShares.toString(),
    balanceRaw: null,
    redeemable: false,
    epochNow: 0,
    reopened: false,
    fallbackAtMs: mintedAtMs + FALLBACK_AFTER_MS,
    expectedReopenMs: reopenMs,
    print: null,
    valueNowUsd: sh(noteShares) * price,
    specimen: true,
    block: p.block,
    source: "fixture",
  }];

  // Lot 1: 5.60 → 5.43 USDG over 20 min, ends 5 min before the reopen.
  const startPrice = 5_600_000n;
  const floorPrice = 5_430_000n;
  const refPrice = valueUsdg(noteShares, priceE18);
  const decaySeconds = 1200;
  const startAt = Math.floor(listAtMs / 1000);
  const current = lotPriceAt({ startPrice, floorPrice, startAt, decaySeconds }, Math.floor(p.nowMs / 1000));
  const lots: AuctionLot[] = [{
    lotId: "1",
    seller: CURB_DESK,
    wrapper: tc.wrapper,
    symbol: tc.symbol,
    noteId: "1",
    amountRaw: noteShares.toString(),
    shares: sh(noteShares),
    startPrice: usd(startPrice),
    startPriceRaw: startPrice.toString(),
    floorPrice: usd(floorPrice),
    floorPriceRaw: floorPrice.toString(),
    refPrice: usd(refPrice),
    refPriceRaw: refPrice.toString(),
    startAtMs: startAt * 1000,
    endAtMs: reopenMs - 5 * 60_000,
    decaySeconds,
    epochAtMint: 0,
    status: "LIVE",
    buyer: null,
    clearedPrice: null,
    clearedAtMs: null,
    currentPrice: usd(current),
    discountBpsVsRef: discountBps(refPrice, current),
    realisedDiscountBps: null,
    specimen: true,
    block: p.block,
    source: "fixture",
  }];

  const pointer: PointerEpoch[] = [{
    wrapper: tc.wrapper, symbol: tc.symbol, epoch: 0, open: !shut,
    shutSeenAtMs: null, openedAtMs: null, openedBlock: null, print: null, printE18: null, printedAtMs: null,
  }];

  // Cert 1: curb-desk bids 52 USDG/share for 0.028 wTCENTx, for CurbCredit, 26 h, bond 1 USDG.
  const size = (28n * E18) / 1000n;
  const bidPx = 52_000_000n;
  const bond = 1_000_000n;
  const postedAtMs = mintedAtMs + 10 * 60_000;
  const certs: CertView[] = [{
    id: "1",
    maker: CURB_DESK,
    wrapper: tc.wrapper,
    symbol: tc.symbol,
    beneficiary: (CURB_CREDIT ?? ZERO) as Address,
    sizeSharesRaw: size.toString(),
    sizeShares: sh(size),
    remainingSharesRaw: size.toString(),
    remainingShares: sh(size),
    bidPx: usd(bidPx),
    bidPxRaw: bidPx.toString(),
    bond: usd(bond),
    bondRaw: bond.toString(),
    notional: usd(notional(size, bidPx)),
    postedAtMs,
    expiryMs: postedAtMs + 26 * 3_600_000,
    status: "LIVE",
    makerHonourable: true,
    specimen: true,
    block: p.block,
    source: "fixture",
  }];

  // Agentic Wallet deposits 0.05 wTCENTx and borrows 1.4 USDG.
  const collateral = 0.05;
  const capBps = regimeCapBps(row?.regime ?? "CLOSED", row?.cap ?? 0);
  const ltv = ltvBpsAt({ depthShares: sh(size), totalCollateral: collateral, minBidPx: usd(bidPx), price, regimeCapBps: capBps });
  const limit = collateral * price * (ltv / 10_000);
  const debt = 1.4;
  const credit: CreditPosition[] = [{
    borrower: AGENTIC_WALLET,
    wrapper: tc.wrapper,
    symbol: tc.symbol,
    collateralRaw: (5n * E18 / 100n).toString(),
    collateral,
    debt,
    debtRaw: "1400000",
    limit: Math.floor(limit * 1e6) / 1e6,
    limitRaw: String(Math.floor(limit * 1e6)),
    ltvBps: ltv,
    breach: { known: true, breached: debt > limit },
    cure: debt > limit
      ? { active: true, lastOpen: false, openedAtMs: cutMs, lastTickAtMs: cutMs, openSecondsUsed: 0, requiredSeconds: 1800, priceAtBreach: price }
      : null,
    specimen: true,
    block: p.block,
    source: "fixture",
  }];

  const curve = {
    wrapper: tc.wrapper,
    symbol: tc.symbol,
    regime: row?.regime ?? "CLOSED",
    regimeCapBps: capBps,
    priceNow: price,
    minBidPx: usd(bidPx),
    totalCollateral: collateral,
    points: ltvPoints({ totalCollateral: collateral, minBidPx: usd(bidPx), price, regimeCapBps: capBps }, 0.1),
    here: { depthShares: sh(size), ltvBps: ltv },
    specimen: true,
    block: p.block,
    source: "fixture" as const,
  };
  const depth: DepthView[] = [{
    wrapper: tc.wrapper,
    symbol: tc.symbol,
    honouredShares: sh(size),
    honouredNotional: usd(notional(size, bidPx)),
    minBidPx: usd(bidPx),
    soonestExpiryMs: certs[0].expiryMs,
    ltvBps: ltv,
    realisable: usd(notional(size, bidPx)),
    certs,
    curve,
    specimen: true,
    block: p.block,
    source: "fixture",
  }];

  return { notes, lots, pointer, certs, credit, depth };
}
