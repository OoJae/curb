/**
 * curb_regime: whether each wrapper's home market is open, as MarketClock says it right now.
 *
 * Status comes from `regime()` and `primaryCapNow()` only, because those are the views that fail closed:
 * an attestation older than 30 minutes reads UNKNOWN with capacity 0. `stateOf()` returns the stored struct
 * whatever its age, so it is read for one thing, `observedAt` (when the attestor last read the issuer), and
 * never for the status. README.md "Honest limits" and docs/MARKETCLOCK.md say the same to integrators.
 *
 * The wording is pure and tested on its own (clock.test.ts): an agent acting on this reads the sentence,
 * so the sentence must say exactly what the codes say and no more.
 */
import { Interface } from "ethers";
import { CONTRACTS, CHAIN_ID } from "./assets.ts";
import type { Asset } from "./assets.ts";
import { asOfBlock } from "./sources/chain.ts";
import type { AsOf, Call, CallResult, ChainReader, PinnedBlock } from "./sources/chain.ts";

export const clockAbi = new Interface([
  "function regime(address) view returns (uint8)",
  "function primaryCapNow(address) view returns (uint128)",
  "function secondsToNextTransition(address) view returns (uint256)",
  "function isInMultiplierBlackout(address) view returns (bool)",
  "function blackoutUntil(address) view returns (uint64)",
  "function stateOf(address) view returns ((uint8 regime, uint128 primaryCapUsd, uint64 nextTransitionAt, uint64 observedAt, uint32 multiplierNonce, bool halted))",
]);

/** MarketClock.MAX_ATTESTATION_AGE: past this, regime() reads UNKNOWN and primaryCapNow() reads 0. */
export const MAX_ATTESTATION_AGE_S = 30 * 60;

/** IMarketClock.Regime, in its declared order: by how much primary capacity exists. */
export const REGIMES: readonly { name: string; meaning: string }[] = [
  { name: "UNKNOWN", meaning: "never attested, or the last attestation is older than 30 minutes; MarketClock fails closed and reports capacity 0" },
  { name: "CLOSED", meaning: "the issuer's primary creation/redemption capacity is zero" },
  { name: "OVERNIGHT", meaning: "reduced-cap overnight session (US names only)" },
  { name: "EXTENDED", meaning: "pre- or post-market session (MarketClock does not split the two)" },
  { name: "MARKET", meaning: "regular session, full primary capacity" },
];

/** Whole US dollars with thousands separators, for sentences: "$100,000". JSON fields keep the plain decimal string. */
export function usd(whole: bigint | string): string {
  return `$${BigInt(whole).toLocaleString("en-US")}`;
}

export function describeRegime(code: number): { code: number; name: string; meaning: string } {
  const r = REGIMES[code];
  if (!Number.isInteger(code) || !r) {
    return { code, name: "UNRECOGNISED", meaning: `code ${code} is not in IMarketClock.Regime (0-4); treat the primary market as shut` };
  }
  return { code, ...r };
}

export type Status = "OPEN" | "SHUT" | "UNKNOWN";

export interface StatusInput {
  symbol: string;
  mic: string;
  regime: number;
  /** primaryCapNow(), whole USD. */
  capUsd: bigint;
  blackout: boolean;
  blackoutUntil: number | null;
}

/**
 * OPEN iff the regime is a known, attested one AND primaryCapNow() > 0: MarketClock's own definition, and
 * the one CurbCredit.isOpen and Scorecard.settle use. A zero cap under an open-sounding label (HKEX's
 * 09:00-09:30 pre-open is EXTENDED by name with a zero cap) is SHUT.
 */
export function statusOf(i: StatusInput): { status: Status; primaryMarketOpen: boolean; explanation: string } {
  const r = describeRegime(i.regime);
  const venue = i.mic === "XHKG" ? "Hong Kong (HKEX)" : i.mic === "XNAS" ? "the US (Nasdaq)" : i.mic;
  let status: Status;
  let explanation: string;
  if (r.name === "UNKNOWN" || r.name === "UNRECOGNISED") {
    status = "UNKNOWN";
    explanation =
      `MarketClock cannot vouch for ${i.symbol} right now (${r.meaning}). Treat its primary market as shut: ` +
      "nothing says creation and redemption are available.";
  } else if (i.capUsd === 0n) {
    status = "SHUT";
    explanation =
      `${i.symbol}'s primary market is shut: MarketClock reads ${r.name} with primary capacity $0, so the issuer is not ` +
      `creating or redeeming and no arbitrage holds the token to the ${venue} share. The pool still trades, unanchored.`;
  } else {
    status = "OPEN";
    explanation =
      `${i.symbol}'s primary market is open: MarketClock reads ${r.name} (${r.meaning}) with the issuer's order cap at ` +
      `${usd(i.capUsd)}, so creation and redemption are available and arbitrage can hold the token to the ${venue} share.`;
  }
  if (i.blackout) {
    explanation +=
      ` A corporate-action blackout is active${i.blackoutUntil ? ` until ${new Date(i.blackoutUntil * 1000).toISOString()}` : ""}: ` +
      "the raw token's multiplier nonce just changed, and nothing denominated in balances should settle until it passes.";
  }
  return { status, primaryMarketOpen: status === "OPEN", explanation };
}

export interface RegimeAnswer {
  symbol: string;
  ticker: string;
  wrapper: string;
  venue: string;
  status: Status;
  primaryMarketOpen: boolean;
  regime: { code: number; name: string; meaning: string };
  /** primaryCapNow(), whole USD, as a decimal string. */
  primaryCapUsd: string;
  multiplierBlackout: boolean;
  blackoutUntil: string | null;
  /** 0 when MarketClock has no future transition on record (it passed, or none was published). */
  secondsToNextTransition: number;
  /** The next schedule boundary the attestor published. Not necessarily the reopen: see curb_next_reopen. */
  nextTransitionAt: string | null;
  /** stateOf().observedAt: when the attestor last read the issuer for this wrapper. The timestamp only. */
  observedAt: string | null;
  observedAgeSeconds: number | null;
  explanation: string;
}

export function regimeCalls(a: Asset): Call[] {
  const c = CONTRACTS.marketClock;
  const w = a.wrapper;
  return [
    { label: `regime:${w}`, target: c, callData: clockAbi.encodeFunctionData("regime", [w]) },
    { label: `cap:${w}`, target: c, callData: clockAbi.encodeFunctionData("primaryCapNow", [w]) },
    { label: `toNext:${w}`, target: c, callData: clockAbi.encodeFunctionData("secondsToNextTransition", [w]) },
    { label: `blackout:${w}`, target: c, callData: clockAbi.encodeFunctionData("isInMultiplierBlackout", [w]) },
    { label: `blackoutUntil:${w}`, target: c, callData: clockAbi.encodeFunctionData("blackoutUntil", [w]) },
    { label: `state:${w}`, target: c, callData: clockAbi.encodeFunctionData("stateOf", [w]) },
  ];
}

/** Decode one wrapper's reads. A failed status read throws: an answer with a hole in it is not an answer. */
export function decodeRegime(a: Asset, results: CallResult[], block: PinnedBlock): RegimeAnswer {
  const get = (label: string) => {
    const r = results.find((x) => x.label === `${label}:${a.wrapper}`);
    if (!r || !r.success || r.returnData === "0x") throw new Error(`MarketClock ${label}(${a.symbol}) failed at block ${block.number}`);
    return r;
  };
  const one = (label: string, fn: string) => clockAbi.decodeFunctionResult(fn, get(label).returnData)[0];
  const code = Number(one("regime", "regime"));
  const cap = BigInt(one("cap", "primaryCapNow"));
  const toNext = Number(one("toNext", "secondsToNextTransition"));
  const blackout = Boolean(one("blackout", "isInMultiplierBlackout"));
  const until = Number(one("blackoutUntil", "blackoutUntil"));
  const state = clockAbi.decodeFunctionResult("stateOf", get("state").returnData)[0];
  const observedAt = Number(state.observedAt);
  const s = statusOf({ symbol: a.symbol, mic: a.mic, regime: code, capUsd: cap, blackout, blackoutUntil: until || null });
  return {
    symbol: a.symbol,
    ticker: a.ticker,
    wrapper: a.wrapper,
    venue: a.mic,
    status: s.status,
    primaryMarketOpen: s.primaryMarketOpen,
    regime: describeRegime(code),
    primaryCapUsd: cap.toString(),
    multiplierBlackout: blackout,
    blackoutUntil: blackout && until ? new Date(until * 1000).toISOString() : null,
    secondsToNextTransition: toNext,
    nextTransitionAt: toNext > 0 ? new Date((block.timestamp + toNext) * 1000).toISOString() : null,
    observedAt: observedAt ? new Date(observedAt * 1000).toISOString() : null,
    observedAgeSeconds: observedAt ? Math.max(0, block.timestamp - observedAt) : null,
    explanation: s.explanation,
  };
}

export interface RegimeResult {
  summary: string;
  asOf: AsOf;
  source: { chainId: number; marketClock: string; reads: string };
  assets: RegimeAnswer[];
}

/** One pinned block, one aggregate3 call, every requested wrapper. */
export async function readRegimes(chain: ChainReader, assets: readonly Asset[]): Promise<RegimeResult> {
  const block = await chain.pin();
  const results = await chain.multicall(block, assets.flatMap(regimeCalls));
  const answers = assets.map((a) => decodeRegime(a, results, block));
  return {
    summary: answers.map((r) => `${r.symbol} ${r.status} (${r.regime.name}, cap ${usd(r.primaryCapUsd)})`).join("; ") + ` at block ${block.number}.`,
    asOf: asOfBlock(block, chain.rpcs),
    source: {
      chainId: CHAIN_ID,
      marketClock: CONTRACTS.marketClock,
      reads: "regime(), primaryCapNow(), isInMultiplierBlackout(), blackoutUntil(), secondsToNextTransition(); stateOf() for observedAt only",
    },
    assets: answers,
  };
}
