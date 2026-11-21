/**
 * What curb-mcp will answer about, and nothing else: the twelve wrappers MarketClock tracks, and the Curb
 * contracts on X Layer mainnet. Addresses are the ones in README.md and docs/DEPLOYMENTS.md.
 *
 * Input validation is a lookup, not a pattern. A tool accepts the wrapper symbol (wTCENTx), the issuer's
 * ticker (TCENTx) or the wrapper address, in any case, and refuses everything else with the list of what it
 * does accept. So no caller-supplied string ever reaches an RPC, the issuer API or the asp: only an entry
 * from this table does.
 *
 * The cohort is fixed here rather than read from MarketClock's `registered` list because it is the input
 * whitelist; a new registration needs a code change to be served, which is the point. The six US wrappers
 * Morpho lends against were registered on 21 Nov 2026 (wSPYx on NYSE Arca, wCRCLx on the NYSE, the rest on Nasdaq).
 */
import { getAddress } from "ethers";

export const CHAIN_ID = 196;

export const CONTRACTS = {
  marketClock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",
  scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f",
  curbCredit: "0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339",
  depthCert: "0x702b1a988765f85162F4829175EF4232197e9C6D",
} as const;

export interface Asset {
  /** The ERC-4626 wrapper that trades on X Layer: MarketClock's key. */
  symbol: string;
  /** The issuer's ticker for the rebasing xStock underneath, and its key at api.xstocks.fi. */
  ticker: string;
  wrapper: string;
  /** The venue MarketClock registered it under. */
  mic: "XHKG" | "XNAS" | "XNYS" | "ARCX";
  name: string;
}

export const ASSETS: readonly Asset[] = [
  { symbol: "wTCENTx", ticker: "TCENTx", wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", mic: "XHKG", name: "Tencent" },
  { symbol: "wXIAOx", ticker: "XIAOx", wrapper: "0x076CF393E701839FC7a5832D2c68AaFA235682AE", mic: "XHKG", name: "Xiaomi" },
  { symbol: "wMEITx", ticker: "MEITx", wrapper: "0xad1b65C8556957cf23d1B5e9accdc449b415fA97", mic: "XHKG", name: "Meituan" },
  { symbol: "wSHEINx", ticker: "SHEINx", wrapper: "0xff637d2d435D6745Df3faf61272B1216e7e8b727", mic: "XHKG", name: "SHEIN" },
  { symbol: "wNVDAx", ticker: "NVDAx", wrapper: "0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5", mic: "XNAS", name: "NVIDIA" },
  { symbol: "wAAPLx", ticker: "AAPLx", wrapper: "0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f", mic: "XNAS", name: "Apple" },
  { symbol: "wSPYx", ticker: "SPYx", wrapper: "0xe7e553cd128f0011777323a0b44a7b96ea1cb540", mic: "ARCX", name: "S&P 500 (SPY)" },
  { symbol: "wQQQx", ticker: "QQQx", wrapper: "0x4c1ae29c159838fc1b224636e28e086eb69101f7", mic: "XNAS", name: "Nasdaq-100 (QQQ)" },
  { symbol: "wGOOGLx", ticker: "GOOGLx", wrapper: "0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f", mic: "XNAS", name: "Alphabet" },
  { symbol: "wCRCLx", ticker: "CRCLx", wrapper: "0xb11134f14d5b94db60d4599dfdc3bf1bba2150e8", mic: "XNYS", name: "Circle" },
  { symbol: "wSPCXx", ticker: "SPCXx", wrapper: "0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072", mic: "XNAS", name: "SpaceX" },
  { symbol: "wTSLAx", ticker: "TSLAx", wrapper: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171", mic: "XNAS", name: "Tesla" },
].map((a) => ({ ...a, wrapper: getAddress(a.wrapper) }) as Asset);

/** The accepted spellings, for a refusal an agent can act on. */
export const ACCEPTED = ASSETS.map((a) => `${a.symbol} (${a.ticker}, ${a.wrapper})`);

/** One cohort asset by wrapper symbol, issuer ticker or wrapper address, case-insensitive; undefined otherwise. */
export function resolveAsset(input: string): Asset | undefined {
  const k = input.trim().toLowerCase();
  if (k === "" || k.length > 64) return undefined;
  return ASSETS.find((a) => a.symbol.toLowerCase() === k || a.ticker.toLowerCase() === k || a.wrapper.toLowerCase() === k);
}

export class UnknownSymbol extends Error {
  readonly input: string;
  constructor(input: string) {
    // Echo at most 64 characters: a refusal is useful to an agent without reflecting arbitrary input at length.
    super(`unknown symbol ${JSON.stringify(input.slice(0, 64))}. Curb tracks: ${ACCEPTED.join("; ")}`);
    this.name = "UnknownSymbol";
    this.input = input.slice(0, 64);
  }
}

export function requireAsset(input: string): Asset {
  const a = resolveAsset(input);
  if (!a) throw new UnknownSymbol(input);
  return a;
}
