/**
 * /depth: DepthCert (bonded firm bids whose fade is self-proving) and CurbCredit (published ltvFor,
 * cure clock, refusals), per docs/specs/W3W4-contracts.md and src/interfaces/IDepthCert.sol.
 *
 * While DEPTH_CERT / CURB_CREDIT are null, readers return the specimen fixtures (`specimen: true`) and
 * writers throw. CurbCredit's Solidity types are not in the spec: abi/curbCredit.ts is provisional (GUESS)
 * until `node web/scripts/sync-abi.mjs` regenerates it from forge out/.
 */
import { decodeEventLog, maxUint256, toFunctionSelector } from "viem";
import { CURB_CREDIT, DEPTH_CERT, MARKET_CLOCK, USDG, symbolOf } from "./addresses.ts";
import { curbCreditAbi } from "./abi/curbCredit.ts";
import { depthCertAbi } from "./abi/depthCert.ts";
import { erc20Abi } from "./abi/erc20.ts";
import { marketClockAbi } from "./abi/marketClock.ts";
import { publicClient, units } from "./chain.ts";
import { fixture, isMock } from "./mock.ts";
import { knownIds, rememberId } from "./notes.ts";
import { regimeName } from "./regime.ts";
import { getPriceNow } from "./scorecard.ts";
import type { Address, CertStatus, CertView, CreditPosition, DepthView, Hex, LtvCurve, LtvPoint, RegimeName } from "./types.ts";
import type { WriteOutcome, WriteRequest } from "./wallet.ts";

/** The wallet path (viem wallet actions, EIP-6963) loads only when a visitor actually writes. */
const write = async (req: WriteRequest): Promise<WriteOutcome> => (await import("./wallet.ts")).write(req);

// --- published constants (spec) ----------------------------------------------------------------

export const LTV_OPEN_BPS = 6000;
export const LTV_SHUT_BPS = 3000;
export const APR_BPS = 500;
export const MIN_BOND_BPS = 1000;
export const MIN_LIFE_S = 10 * 60;
export const MAX_LIFE_S = 30 * 86_400;
export const MIN_CERT_LIFE_S = 3600; // CurbCredit counts only certs expiring ≥ 1 h out
export const CURE_OPEN_SECONDS = 1800;
export const CERT_STATUS: CertStatus[] = ["NONE", "LIVE", "FADED", "CLOSED"];

export const depthLive = () => DEPTH_CERT !== null && !isMock();
export const creditLive = () => CURB_CREDIT !== null && !isMock();

// --- pure maths (mirrors the contracts) -------------------------------------------------------

/** notional(S, px) = mulDiv(S, px, 1e18): share wei × USDG-per-share → USDG (6 dp). */
export function notional(sharesWei: bigint, bidPx: bigint): bigint {
  return (sharesWei * bidPx) / 10n ** 18n;
}

/** Minimum bond for a cert: ceil(notional · 1000 / 1e4). */
export function minBond(sizeSharesWei: bigint, bidPx: bigint): bigint {
  const n = notional(sizeSharesWei, bidPx) * BigInt(MIN_BOND_BPS);
  return (n + 9_999n) / 10_000n;
}

/** regimeCap: UNKNOWN → 0; primaryCapNow > 0 → 6000; CLOSED (or any zero-cap state) → 3000. */
export function regimeCapBps(regime: RegimeName, cap: number): number {
  if (regime === "UNKNOWN") return 0;
  return cap > 0 ? LTV_OPEN_BPS : LTV_SHUT_BPS;
}

/**
 * The published LTV function, in display units (shares, USDG/share, USD/share):
 *   basis = totalCollateral > 0 ? totalCollateral : depth;  covered = min(basis, depth)
 *   ltv   = 0 if depth == 0 or no price; else min(regimeCap, covered · minBid / (basis · P) · 1e4)
 */
export function ltvBpsAt(p: { depthShares: number; totalCollateral: number; minBidPx: number; price: number | null; regimeCapBps: number }): number {
  if (!p.price || p.depthShares <= 0 || p.regimeCapBps === 0) return 0;
  const basis = p.totalCollateral > 0 ? p.totalCollateral : p.depthShares;
  const covered = Math.min(basis, p.depthShares);
  return Math.min(p.regimeCapBps, Math.floor(((covered * p.minBidPx) / (basis * p.price)) * 10_000));
}

/** Sample the LTV function from depth 0 to `maxDepth` (for the plot and its drag handle). */
export function ltvPoints(p: { totalCollateral: number; minBidPx: number; price: number | null; regimeCapBps: number }, maxDepth: number, steps = 48): LtvPoint[] {
  const out: LtvPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const depthShares = (maxDepth * i) / steps;
    out.push({ depthShares, ltvBps: ltvBpsAt({ ...p, depthShares }) });
  }
  return out;
}

/** Refusal reasons are error selectors (bytes4). */
export const REFUSAL_REASONS = [
  "Ineligible", "UnsupportedAsset", "MarketUnknown", "PriceUnavailable", "NoDepth",
  "ExceedsLtv", "ExceedsDepth", "ReserveShort", "InCure", "WouldBreach",
] as const;
const REFUSAL_BY_SELECTOR: Record<string, string> = Object.fromEntries(REFUSAL_REASONS.map((n) => [toFunctionSelector(`${n}()`), n]));

export function refusalName(reason: Hex): string | null {
  return REFUSAL_BY_SELECTOR[reason.toLowerCase()] ?? null;
}

/** Refusal events in a receipt (borrow/withdraw succeed as txs but may refuse). */
export function refusalsIn(o: WriteOutcome): { reason: string; requested: bigint; allowed: bigint }[] {
  const out: { reason: string; requested: bigint; allowed: bigint }[] = [];
  for (const log of o.receipt.logs) {
    if (!CURB_CREDIT || log.address.toLowerCase() !== CURB_CREDIT.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: curbCreditAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Refusal") {
        const a = ev.args as { reason: Hex; requested: bigint; allowed: bigint };
        out.push({ reason: refusalName(a.reason) ?? a.reason, requested: a.requested, allowed: a.allowed });
      }
    } catch {
      /* other event */
    }
  }
  return out;
}

// --- readers ---------------------------------------------------------------------------------

type CertTuple = {
  maker: Address; wrapper: Address; beneficiary: Address; sizeShares: bigint; remainingShares: bigint;
  bidPx: bigint; bond: bigint; postedAt: bigint; expiry: bigint; status: number;
};

function certView(id: bigint, c: CertTuple, honourable: boolean | null, block: number): CertView {
  return {
    id: id.toString(),
    maker: c.maker,
    wrapper: c.wrapper,
    symbol: symbolOf(c.wrapper),
    beneficiary: c.beneficiary,
    sizeSharesRaw: c.sizeShares.toString(),
    sizeShares: units(c.sizeShares),
    remainingSharesRaw: c.remainingShares.toString(),
    remainingShares: units(c.remainingShares),
    bidPx: units(c.bidPx, 6),
    bidPxRaw: c.bidPx.toString(),
    bond: units(c.bond, 6),
    bondRaw: c.bond.toString(),
    notional: units(notional(c.remainingShares, c.bidPx), 6),
    postedAtMs: Number(c.postedAt) * 1000,
    expiryMs: Number(c.expiry) * 1000,
    status: CERT_STATUS[c.status] ?? "NONE",
    makerHonourable: honourable,
    specimen: false,
    block,
    source: "chain",
  };
}

export async function getCert(id: number | bigint): Promise<CertView> {
  if (!depthLive()) {
    const all = await fixture("certs");
    return all.find((c) => c.id === String(id)) ?? all[0];
  }
  const pc = publicClient();
  const block = await pc.getBlockNumber();
  const c = (await pc.readContract({ address: DEPTH_CERT!, abi: depthCertAbi, functionName: "certOf", args: [BigInt(id)], blockNumber: block })) as unknown as CertTuple;
  const honourable = await pc.readContract({ address: DEPTH_CERT!, abi: depthCertAbi, functionName: "isHonourable", args: [c.maker], blockNumber: block }).catch(() => null);
  return certView(BigInt(id), c, honourable, Number(block));
}

export async function getCerts(ids: (number | bigint)[] = knownIds("certs")): Promise<CertView[]> {
  if (!depthLive()) return fixture("certs");
  return Promise.all(ids.map((id) => getCert(id)));
}

async function regimeOf(wrapper: Address): Promise<{ regime: RegimeName; cap: number }> {
  const pc = publicClient();
  const [r, cap] = await pc.multicall({
    allowFailure: false,
    contracts: [
      { address: MARKET_CLOCK, abi: marketClockAbi, functionName: "regime", args: [wrapper] },
      { address: MARKET_CLOCK, abi: marketClockAbi, functionName: "primaryCapNow", args: [wrapper] },
    ],
  });
  return { regime: regimeName(Number(r)), cap: Number(cap as bigint) };
}

/** The LTV curve for `wrapper`, "you are here" at today's honoured depth. */
export async function getLtvCurve(wrapper: Address): Promise<LtvCurve> {
  if (!creditLive() || !depthLive()) {
    const all = await fixture("depth");
    return (all.find((d) => d.wrapper.toLowerCase() === wrapper.toLowerCase()) ?? all[0]).curve;
  }
  return (await getDepth(wrapper)).curve;
}

/** Depth for `wrapper` as CurbCredit counts it: honouredDepth(wrapper, CurbCredit, now + 1 h), plus the LTV. */
export async function getDepth(wrapper: Address, certIds: (number | bigint)[] = knownIds("certs")): Promise<DepthView> {
  if (!creditLive() || !depthLive()) {
    const all = await fixture("depth");
    return all.find((d) => d.wrapper.toLowerCase() === wrapper.toLowerCase()) ?? all[0];
  }
  const pc = publicClient();
  const block = await pc.getBlock({ blockTag: "latest" });
  const minExpiry = block.timestamp + BigInt(MIN_CERT_LIFE_S);
  const res = await pc.multicall({
    blockNumber: block.number,
    allowFailure: true,
    contracts: [
      { address: DEPTH_CERT!, abi: depthCertAbi, functionName: "honouredDepth", args: [wrapper, CURB_CREDIT!, minExpiry] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "ltvFor", args: [wrapper] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "realisable", args: [wrapper] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "totalCollateral", args: [wrapper] },
    ],
  });
  const [dS, dN, minBid, soonest] = res[0].status === "success" ? (res[0].result as readonly [bigint, bigint, bigint, bigint]) : [0n, 0n, 0n, 0n];
  const ltv = res[1].status === "success" ? Number(res[1].result as bigint) : 0;
  const realisable = res[2].status === "success" ? units(res[2].result as bigint, 6) : 0;
  const totalCollateral = res[3].status === "success" ? units(res[3].result as bigint) : 0;
  const { regime, cap } = await regimeOf(wrapper);
  const price = (await getPriceNow(wrapper)).price;
  const capBps = regimeCapBps(regime, cap);
  const minBidPx = minBid > 0n ? units(minBid, 6) : null;
  const honouredShares = units(dS);
  const certs = (await getCerts(certIds)).filter((c) => c.wrapper.toLowerCase() === wrapper.toLowerCase());
  const maxDepth = Math.max(honouredShares * 2, totalCollateral * 1.5, 0.01);
  const curve: LtvCurve = {
    wrapper,
    symbol: symbolOf(wrapper),
    regime,
    regimeCapBps: capBps,
    priceNow: price,
    minBidPx,
    totalCollateral,
    points: ltvPoints({ totalCollateral, minBidPx: minBidPx ?? 0, price, regimeCapBps: capBps }, maxDepth),
    here: { depthShares: honouredShares, ltvBps: ltv },
    specimen: false,
    block: Number(block.number),
    source: "chain",
  };
  return {
    wrapper,
    symbol: symbolOf(wrapper),
    honouredShares,
    honouredNotional: units(dN, 6),
    minBidPx,
    soonestExpiryMs: soonest > 0n ? Number(soonest) * 1000 : null,
    ltvBps: ltv,
    realisable,
    certs,
    curve,
    specimen: false,
    block: Number(block.number),
    source: "chain",
  };
}

export async function getCreditPosition(borrower: Address, wrapper: Address): Promise<CreditPosition> {
  if (!creditLive()) {
    const all = await fixture("credit");
    return all.find((p) => p.wrapper.toLowerCase() === wrapper.toLowerCase()) ?? all[0];
  }
  const pc = publicClient();
  const block = await pc.getBlockNumber();
  const res = await pc.multicall({
    blockNumber: block,
    allowFailure: true,
    contracts: [
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "positions", args: [borrower, wrapper] }, // GUESS getter
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "debtOf", args: [borrower, wrapper] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "limitOf", args: [borrower, wrapper] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "ltvFor", args: [wrapper] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "isBreached", args: [borrower, wrapper] },
      { address: CURB_CREDIT!, abi: curbCreditAbi, functionName: "cureOf", args: [borrower, wrapper] },
    ],
  });
  const ok = <T,>(i: number, d: T): T => (res[i].status === "success" ? (res[i].result as T) : d);
  const pos = ok<readonly [bigint, bigint, bigint, bigint]>(0, [0n, 0n, 0n, 0n]);
  const debt = ok<bigint>(1, 0n);
  const limit = ok<bigint>(2, 0n);
  const [known, breached] = ok<readonly [boolean, boolean]>(4, [false, false]);
  const cure = res[5].status === "success"
    ? (res[5].result as { active: boolean; lastOpen: boolean; openedAt: bigint; lastTickAt: bigint; openSecondsUsed: bigint; priceAtBreach: bigint })
    : null;
  return {
    borrower,
    wrapper,
    symbol: symbolOf(wrapper),
    collateralRaw: pos[0].toString(),
    collateral: units(pos[0]),
    debt: units(debt, 6),
    debtRaw: debt.toString(),
    limit: units(limit, 6),
    limitRaw: limit.toString(),
    ltvBps: Number(ok<bigint>(3, 0n)),
    breach: { known, breached },
    cure: cure
      ? {
          active: cure.active,
          lastOpen: cure.lastOpen,
          openedAtMs: cure.openedAt > 0n ? Number(cure.openedAt) * 1000 : null,
          lastTickAtMs: cure.lastTickAt > 0n ? Number(cure.lastTickAt) * 1000 : null,
          openSecondsUsed: Number(cure.openSecondsUsed),
          requiredSeconds: CURE_OPEN_SECONDS,
          priceAtBreach: cure.priceAtBreach > 0n ? units(cure.priceAtBreach) : null,
        }
      : null,
    specimen: false,
    block: Number(block),
    source: "chain",
  };
}

// --- writers ---------------------------------------------------------------------------------

function need(addr: Address | null, name: string): Address {
  if (!addr || isMock()) throw new Error(`${name} is not deployed yet (Specimen).`);
  return addr;
}

/** USDG allowance for DepthCert (the bond, and later the maker leg of every fill) or CurbCredit (repay). */
export function approveUsdg(spender: "depth" | "credit", amount: bigint = maxUint256) {
  const to = spender === "depth" ? need(DEPTH_CERT, "DepthCert") : need(CURB_CREDIT, "CurbCredit");
  return write({ address: USDG, abi: erc20Abi, functionName: "approve", args: [to, amount] });
}

/** Approve a wrapper to DepthCert (taker delivers shares first) or CurbCredit (collateral). */
export function approveWrapper(wrapper: Address, spender: "depth" | "credit", amount: bigint = maxUint256) {
  const to = spender === "depth" ? need(DEPTH_CERT, "DepthCert") : need(CURB_CREDIT, "CurbCredit");
  return write({ address: wrapper, abi: erc20Abi, functionName: "approve", args: [to, amount] });
}

export async function postCert(p: { wrapper: Address; beneficiary: Address; sizeShares: bigint; bidPx: bigint; expiry: number; bond: bigint }): Promise<WriteOutcome & { certId: bigint | null }> {
  const dc = need(DEPTH_CERT, "DepthCert");
  const o = await write({ address: dc, abi: depthCertAbi, functionName: "post", args: [p.wrapper, p.beneficiary, p.sizeShares, p.bidPx, BigInt(p.expiry), p.bond] });
  let certId: bigint | null = null;
  for (const log of o.receipt.logs) {
    if (log.address.toLowerCase() !== dc.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: depthCertAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Posted") certId = (ev.args as { id: bigint }).id;
    } catch {
      /* other event */
    }
  }
  if (certId !== null) rememberId("certs", certId);
  return { ...o, certId };
}

/** Take a cert: fills (USDG to `to`) or, if the maker can't pay, fades (bond to `to`, shares back). */
export function takeCert(id: bigint, shares: bigint, to: Address) {
  return write({ address: need(DEPTH_CERT, "DepthCert"), abi: depthCertAbi, functionName: "take", args: [id, shares, to] });
}

export function withdrawCert(id: bigint) {
  return write({ address: need(DEPTH_CERT, "DepthCert"), abi: depthCertAbi, functionName: "withdraw", args: [id] });
}

export function claimShares(wrapper: Address, to: Address) {
  return write({ address: need(DEPTH_CERT, "DepthCert"), abi: depthCertAbi, functionName: "claimShares", args: [wrapper, to] });
}

export function deposit(wrapper: Address, shares: bigint) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "deposit", args: [wrapper, shares] });
}

/** Borrow never reverts on refusal: check `refusalsIn(outcome)`. */
export function borrow(wrapper: Address, amount: bigint) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "borrow", args: [wrapper, amount] });
}

export function repay(borrower: Address, wrapper: Address, amount: bigint) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "repay", args: [borrower, wrapper, amount] });
}

/** Withdraw collateral; like borrow, a refusal is an event, not a revert. */
export function withdrawCollateral(wrapper: Address, shares: bigint) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "withdraw", args: [wrapper, shares] });
}

export function flagBreach(borrower: Address, wrapper: Address) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "flagBreach", args: [borrower, wrapper] });
}

export function tick(borrower: Address, wrapper: Address) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "tick", args: [borrower, wrapper] });
}

export function liquidate(borrower: Address, wrapper: Address) {
  return write({ address: need(CURB_CREDIT, "CurbCredit"), abi: curbCreditAbi, functionName: "liquidate", args: [borrower, wrapper] });
}

