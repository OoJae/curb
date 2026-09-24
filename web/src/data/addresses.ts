/**
 * Every address the site reads or writes. X Layer mainnet, chain 196.
 *
 * LEAD: after a deploy, paste the address over the `null` below. A `null` makes the page render an
 * honest "Specimen" label with "in build" instead of live numbers; nothing else needs to change.
 */
import type { Address, Mic } from "./types.ts";

export const CHAIN_ID = 196;
export const CHAIN_ID_HEX = "0xc4";

export const RPC_URLS = ["https://rpc.xlayer.tech", "https://xlayer.drpc.org"] as const;
export const API_BASE = "https://api.curb.markets";
export const OKLINK = "https://www.oklink.com/xlayer";
export const HOST_A = "https://attestor-a-production.up.railway.app";

// --- live contracts --------------------------------------------------------------------------

export const MARKET_CLOCK: Address = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
export const SCORECARD: Address = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Scorecard v2 deploy block. Nothing the site reads predates it; never scan from here. */
export const SCORECARD_DEPLOY_BLOCK = 71_231_806;
export const MARKET_CLOCK_DEPLOY_BLOCK = 70_545_887;

// --- tokens ----------------------------------------------------------------------------------

/** USDG: 6 dp, EIP-1967 proxy. W3/W4 settle in it. */
export const USDG: Address = "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8";
/** USD₮0: 6 dp. x402 payments to the API settle in it. */
export const USDT0: Address = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

// --- W3 / W4 (null until deployed → "Specimen") -----------------------------------------------

export const ELIGIBILITY_REGISTRY: Address | null = "0xd7251b562eD07374ccD2436a7EfC0bA3A28ce938";
export const REOPEN_POINTER: Address | null = "0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471";
export const REOPEN_NOTE: Address | null = "0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B";
export const CLOSED_AUCTION: Address | null = "0xAc74864d69DdB940ADfDB39E69751759a32bb80D";
export const DEPTH_CERT: Address | null = null;
export const CURB_CREDIT: Address | null = null;

/**
 * Ids the demo created (the browser never scans history, so it cannot discover them). LEAD: paste the
 * note / lot / cert ids and the borrower from the live demo here; ids a visitor creates on the site are
 * remembered in their own localStorage and merged in.
 */
export const DEMO_IDS: { notes: number[]; lots: number[]; certs: number[]; borrowers: Address[] } = {
  notes: [],
  lots: [],
  certs: [],
  borrowers: [],
};

// --- people / services -----------------------------------------------------------------------

/** Receive-only `curb-revenue`: x402 payTo. */
export const REVENUE_WALLET: Address = "0x277cA91276A3801667B76C97Da3872Ccb6E96068";
export const DEPLOYER: Address = "0x78a5955b433988198bccA2E8bdC671444798f809";
export const ATTESTOR_A: Address = "0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4";
export const KEEPER: Address = "0xd3D9Bf9Ff2A80Aa13D9C0299fadc9775343a1AF6";
/** Team wallets used in the live demos (disclosed in docs/WALLETS.md; never presented as third-party usage). */
export const AGENTIC_WALLET: Address = "0x055ba8acd60a2287b2d01cb3bf237e4424357105";
export const CURB_DESK: Address = "0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E";
export const BUILDER_CODE_REGISTRY: Address = "0xd6c426f9c077358735622ae5a83468dc0510823b";
export const MARKETPLACE_AGENT_ID = 13869;

// --- the cohort (from GET /v1/assets and docs/DEPLOYMENTS.md) ----------------------------------

export interface CohortAsset {
  symbol: string;
  wrapper: Address;
  /** Scorecard's pinned, write-once price pool; null = no price source (wSHEINx). */
  pool: Address | null;
  mic: Mic;
  /** ReopenNote open-interest cap in whole shares (D-3); 0 = not note-eligible. */
  noteCapShares: number;
}

export const ASSETS: readonly CohortAsset[] = [
  { symbol: "wTCENTx", wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", pool: "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f", mic: "XHKG", noteCapShares: 175 },
  { symbol: "wSHEINx", wrapper: "0xff637d2d435D6745Df3faf61272B1216e7e8b727", pool: null, mic: "XHKG", noteCapShares: 0 },
  { symbol: "wXIAOx", wrapper: "0x076CF393E701839FC7a5832D2c68AaFA235682AE", pool: "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", mic: "XHKG", noteCapShares: 0 },
  { symbol: "wMEITx", wrapper: "0xad1b65C8556957cf23d1B5e9accdc449b415fA97", pool: "0x54E89e9acaFb073e7fd8471312E753A661b470C7", mic: "XHKG", noteCapShares: 0 },
  { symbol: "wNVDAx", wrapper: "0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5", pool: "0x2a2B11730C2b6d99a58034A869dd810D7300a7b2", mic: "XNAS", noteCapShares: 220 },
  { symbol: "wAAPLx", wrapper: "0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f", pool: "0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2", mic: "XNAS", noteCapShares: 14 },
];

/** The asset the global chip, the hero and the theme follow. */
export const HERO_WRAPPER: Address = ASSETS[0].wrapper;

export function assetBySymbol(symbol: string): CohortAsset | undefined {
  return ASSETS.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
}

export function assetByWrapper(wrapper: string): CohortAsset | undefined {
  const w = wrapper.toLowerCase();
  return ASSETS.find((a) => a.wrapper.toLowerCase() === w);
}

export function symbolOf(wrapper: string): string {
  return assetByWrapper(wrapper)?.symbol ?? `${wrapper.slice(0, 6)}…${wrapper.slice(-4)}`;
}

// --- links -----------------------------------------------------------------------------------

export const oklinkTx = (hash: string) => `${OKLINK}/tx/${hash}`;
export const oklinkAddress = (addr: string) => `${OKLINK}/address/${addr}`;
export const oklinkBlock = (n: number) => `${OKLINK}/block/${n}`;
export const roundBundleUrl = (inputRoot: string) => `${HOST_A}/rounds/${inputRoot}.json`;

/** The paid-call proof on /api. */
export const PAID_CALL_SETTLEMENT_TX = "0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7";
export const PAID_CALL_RECEIPT = "0xcee1ee75f7323746b96afa5f4056640507a96d02316ba40f9010ac2d58a9817c";
