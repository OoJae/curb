/**
 * The cohort: every wrapper MarketClock has registered, and whether Scorecard can grade it.
 *
 * Extracted from `readCohort` in services/keeper/src/main.ts, with one deliberate difference. The keeper
 * drops a wrapper that has no Scorecard price source, because it must never commit a row the contract
 * could not settle. This service describes the market rather than acting on it, so it keeps such a
 * wrapper and says so (`pool: null`): wSHEINx has a closure calendar like any Hong Kong name, it just
 * has no graded record, and hiding it would make /v1/assets quietly disagree with MarketClock.
 *
 * Everything is read in pinned Multicall3 batches from one block, as the keeper does, so the list is a
 * single chain state rather than a mix of heads.
 */
import { getAddress, Interface } from "ethers";
import { pinLatest, multicallAt, clockAbi } from "./sources/chain.ts";
import { scorecardAbi } from "./sources/scorecard.ts";

export const ZERO = "0x0000000000000000000000000000000000000000";
const erc20 = new Interface(["function symbol() view returns (string)"]);

export interface Asset {
  /** The ERC-4626 wrapper that trades on X Layer, checksummed. This is MarketClock's key. */
  wrapper: string;
  /** The wrapper's own ERC-20 symbol, e.g. wTCENTx. */
  symbol: string;
  /** The issuer's key, e.g. TCENTx: the wrapper symbol without its leading `w`. */
  rawSymbol: string;
  /** The rebasing xStock underneath the wrapper. */
  raw: string;
  /** The MIC MarketClock registered the wrapper under (bytes4, decoded). Empty if unreadable. */
  micOnChain: string;
  /** Scorecard's pinned pool for the wrapper, or null when none is registered (no graded record). */
  pool: string | null;
  equityIsToken0: boolean | null;
  equityDecimals: number | null;
  stableDecimals: number | null;
}

export interface CohortSource {
  rpcs: string[];
  clock: string;
  /** ZERO when unset: every wrapper is then reported without a price source. */
  scorecard: string;
}

/** MarketClock stores the venue as bytes4 ("XHKG"); anything that is not four printable characters reads as unknown. */
export function decodeMic(bytes4: string): string {
  const hex = bytes4.startsWith("0x") ? bytes4.slice(2) : bytes4;
  const s = Buffer.from(hex, "hex").toString("latin1").replace(/\0+$/, "");
  return /^[A-Z0-9]{4}$/.test(s) ? s : "";
}

export async function readCohort(src: CohortSource): Promise<Asset[]> {
  const block = await pinLatest(src.rpcs);
  const countSnap = await multicallAt(block, [{ label: "count", target: src.clock, callData: clockAbi.encodeFunctionData("registeredCount") }], src.rpcs);
  if (!countSnap.results[0].success) throw new Error("registeredCount reverted");
  const count = Number(clockAbi.decodeFunctionResult("registeredCount", countSnap.results[0].returnData)[0]);
  if (count === 0) return [];

  const idx = await multicallAt(block, Array.from({ length: count }, (_, i) => ({
    label: `reg:${i}`, target: src.clock, callData: clockAbi.encodeFunctionData("registered", [i]),
  })), src.rpcs);
  const wrappers = idx.results
    .filter((r) => r.success)
    .map((r) => getAddress(String(clockAbi.decodeFunctionResult("registered", r.returnData)[0])));

  const withScorecard = src.scorecard !== ZERO;
  const meta = await multicallAt(block, [
    ...(withScorecard
      ? wrappers.map((w) => ({ label: `src:${w}`, target: src.scorecard, callData: scorecardAbi.encodeFunctionData("priceSources", [w]) }))
      : []),
    ...wrappers.map((w) => ({ label: `asset:${w}`, target: src.clock, callData: clockAbi.encodeFunctionData("assets", [w]) })),
    ...wrappers.map((w) => ({ label: `sym:${w}`, target: w, callData: erc20.encodeFunctionData("symbol") })),
  ], src.rpcs);
  const at = (label: string) => meta.results.find((r) => r.label === label);

  const out: Asset[] = [];
  for (const w of wrappers) {
    const a = at(`asset:${w}`);
    if (!a?.success) continue;
    let raw: string, micOnChain: string, registered: boolean;
    try {
      const d = clockAbi.decodeFunctionResult("assets", a.returnData);
      raw = getAddress(String(d[0]));
      micOnChain = decodeMic(String(d[1]));
      registered = Boolean(d[3]);
    } catch { continue; }
    if (!registered) continue;

    let symbol = w;
    const sym = at(`sym:${w}`);
    try { if (sym?.success) symbol = String(erc20.decodeFunctionResult("symbol", sym.returnData)[0]); } catch { /* keep the address */ }

    // Multicall3 reports success for a call to an address with no code, so an empty or undecodable
    // return reads as "no price source", never as a crash that loses the whole cohort.
    let pool: string | null = null;
    let equityIsToken0: boolean | null = null, equityDecimals: number | null = null, stableDecimals: number | null = null;
    const s = at(`src:${w}`);
    if (s?.success && s.returnData && s.returnData !== "0x") {
      try {
        const d = scorecardAbi.decodeFunctionResult("priceSources", s.returnData);
        const p = getAddress(String(d[0]));
        if (p !== ZERO) {
          pool = p;
          equityIsToken0 = Boolean(d[1]);
          equityDecimals = Number(d[3]);
          stableDecimals = Number(d[4]);
        }
      } catch { /* no price source */ }
    }

    out.push({
      wrapper: w, symbol, rawSymbol: symbol.replace(/^w/, ""), raw, micOnChain,
      pool, equityIsToken0, equityDecimals, stableDecimals,
    });
  }
  return out;
}
