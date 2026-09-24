/**
 * View models for every page. Frozen for the parallel build: page lanes code against these, and
 * `?mock=1` serves them verbatim from `fixtures/*.json`.
 *
 * Conventions
 * - Times are unix MILLISECONDS and end in `Ms`. Chain seconds are converted on read.
 * - Raw on-chain integers travel as decimal strings (`…Raw`, `…E18`), so JSON fixtures can carry them.
 *   The float next to each one is for display only; never do money arithmetic on it.
 * - Every live value carries its provenance: `block` and/or `readAtMs`, and `source`.
 * - `specimen: true` means the contract address is unset in addresses.ts; the page labels it
 *   "Specimen" and "in build" and must not present its numbers as live.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// ---------------------------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------------------------

/** Mirrors IMarketClock.Regime. Index = the on-chain enum value. */
export type RegimeName = "UNKNOWN" | "CLOSED" | "OVERNIGHT" | "EXTENDED" | "MARKET";
export const REGIME_NAMES: readonly RegimeName[] = ["UNKNOWN", "CLOSED", "OVERNIGHT", "EXTENDED", "MARKET"];

/**
 * The only icons on the site.
 * open    closed ring O          primary capacity > 0
 * shut    C + amber arc          capacity zero, pools still trading
 * unknown dotted ring            never attested, or attestation older than 30 min
 */
export type Glyph = "open" | "shut" | "unknown";

export type Mic = "XHKG" | "XNAS";

/** chain = read from X Layer; api = api.curb.markets; fixture = ?mock=1; override = ?regime=open|shut. */
export type DataSource = "chain" | "api" | "fixture" | "override";

/** How a closure is labelled (schedule.ts, same rule as services/asp closureCalendar.classify). */
export type ClosureKind = "recess" | "overnight" | "weekend" | "holiday" | "handover" | "multi-day" | "open-ended";

export interface ClosureWindow {
  /** Cut to zero: 300 s before the published boundary (the issuer's measured early cut). */
  startMs: number | null;
  /** Capacity returns (the reopen). */
  endMs: number | null;
  durationS: number | null;
  kind: ClosureKind;
}

// ---------------------------------------------------------------------------------------------
// regime: global chip, home hero, favicon, paper/ink theme (rpc-lite, no viem)
// ---------------------------------------------------------------------------------------------

export interface RegimeState {
  symbol: string;
  wrapper: Address;
  /** Effective regime: UNKNOWN when stale, exactly as MarketClock.regime() reports it. */
  regime: RegimeName;
  /** What the last attestation wrote, before the staleness rule. */
  attestedRegime: RegimeName;
  /** Effective primaryCapNow, whole USD. 0 when stale. */
  cap: number;
  /** When the attestor read the issuer (stateOf.observedAt × 1000). "attested N min ago" counts from here. */
  asOfMs: number;
  /** When this client read the chain. */
  readAtMs: number;
  /** Block the read was answered at (null if the RPC did not report one). */
  block: number | null;
  /** No attestation, or the last one is older than 30 minutes (MarketClock.MAX_ATTESTATION_AGE). */
  stale: boolean;
  attestedAgoMin: number | null;
  /**
   * stateOf.nextTransitionAt × 1000: the next SCHEDULE boundary, which is NOT the reopen
   * (e.g. 01:00Z extended-session start with the cap still zero). Countdowns use schedule.ts.
   */
  nextTransitionAtMs: number | null;
  halted: boolean;
  multiplierNonce: number;
  /** Paper (ivory) theme: regime == MARKET && cap > 0 (and therefore not stale). */
  paper: boolean;
  glyph: Glyph;
  source: DataSource;
}

// ---------------------------------------------------------------------------------------------
// /clock
// ---------------------------------------------------------------------------------------------

export interface NextChange {
  atMs: number;
  /** cut = capacity goes to zero; reopen = capacity returns. */
  kind: "cut" | "reopen";
}

export interface AssetBoardRow {
  symbol: string;
  wrapper: Address;
  mic: Mic;
  /** Scorecard's pinned price pool; null for wSHEINx (no price source). */
  pool: Address | null;
  hasPriceSource: boolean;
  regime: RegimeName;
  attestedRegime: RegimeName;
  cap: number;
  glyph: Glyph;
  stale: boolean;
  halted: boolean;
  /** isInMultiplierBlackout(wrapper). */
  blackout: boolean;
  multiplierNonce: number;
  observedAtMs: number;
  attestedAgoMin: number | null;
  /** Raw chain field; see RegimeState.nextTransitionAtMs. */
  nextTransitionAtMs: number | null;
  /** The honest next change, from the venue's published schedule + the 300 s early cut (schedule.ts). */
  nextChange: NextChange | null;
  /** The closure in progress (schedule view), when the schedule says shut. */
  closure: ClosureWindow | null;
}

export interface AttestationRound {
  txHash: Hex;
  block: number;
  inputRoot: Hex;
  /** Wrappers attested in the same transaction (from its StateAttested logs in that block). */
  wrappers: Address[];
  /** Host A's evidence bundle for this round. */
  bundleUrl: string;
  oklinkTxUrl: string;
}

export interface AssetBoard {
  rows: AssetBoardRow[];
  registeredCount: number;
  block: number;
  blockTimeMs: number;
  readAtMs: number;
  /** Latest StateAttested, found by scanning back ≤ 4 × 100 blocks; null if not found in that range. */
  latestRound: AttestationRound | null;
  source: DataSource;
}

// ---------------------------------------------------------------------------------------------
// /scorecard
// ---------------------------------------------------------------------------------------------

/** Strict, as Scorecard.settle counts it: equal errors are a tie, and a tie is not a win. */
export type Outcome = "win" | "tie" | "loss";

export interface ScorecardRow {
  /** Position in closureIds (commit order). */
  index: number;
  id: Hex;
  wrapper: Address;
  symbol: string;
  status: "committed" | "settled";

  /** Curb's mark, USD per wrapper share. */
  mark: number;
  markE18: string;
  bandBps: number;
  /** Baseline: last verified print before the closure. */
  lastPrint: number;
  lastPrintE18: string;
  /** Baseline: wrapper-pool VWAP at the moment of closure. */
  closingVwap: number;
  closingVwapE18: string;
  /** Baseline: stale banded oracle; null when the row carried none (committed as 0). */
  staleOracle: number | null;
  /** The price Scorecard read from the pool at settlement; null until settled. */
  reopenPrint: number | null;
  reopenPrintE18: string | null;

  /** |estimate − reopen| / reopen in bps, computed on chain. null until settled / when no baseline. */
  curbErrorBps: number | null;
  lastPrintErrorBps: number | null;
  closingVwapErrorBps: number | null;
  staleOracleErrorBps: number | null;
  vsLastPrint: Outcome | null;
  vsClosingVwap: Outcome | null;

  committedAtMs: number;
  committedBlock: number;
  /** From one single-block getLogs at committedBlock, cached forever. null if not yet resolved. */
  commitTx: Hex | null;
  /** The scheduled reopen the row is graded at (settleAfter). */
  settleAfterMs: number;
  settledAtMs: number | null;
  settledBlock: number | null;
  settleTx: Hex | null;

  inputRoot: Hex;
  methodDigest: Hex;
  /** "curb.scorecard.mark/1" etc.; null when the digest is not a known method. */
  method: string | null;
  /** "mark/1" for display. */
  methodShort: string | null;
  /** Schedule label of the closure the row marks (HKEX rows only; null for others). */
  closureKind: ClosureKind | null;
}

export interface SkillTally {
  /** Scorecard.skill(): the contract's own running tallies. */
  settled: number;
  beatLastPrint: number;
  beatClosingVwap: number;
  /** Derived from the rows (strict comparison, as the contract counts). */
  tiesLastPrint: number;
  tiesClosingVwap: number;
  lossesLastPrint: number;
  lossesClosingVwap: number;
  closureCount: number;
  block: number;
  readAtMs: number;
}

/** The home page's record line: Scorecard.skill() + closureCount(), without viem. */
export interface RecordLine {
  settled: number;
  beatLastPrint: number;
  beatClosingVwap: number;
  /** null when served from the API fallback's preview (it carries rowCount, used here). */
  closureCount: number | null;
  block: number | null;
  readAtMs: number;
  source: DataSource;
}

export interface PriceNow {
  symbol: string;
  wrapper: Address;
  /** Scorecard.priceNow(wrapper), USD per share; null when it reverts (e.g. NoPriceSource, PriceDeviates). */
  price: number | null;
  priceE18: string | null;
  error: string | null;
}

export interface ScorecardView {
  rows: ScorecardRow[];
  skill: SkillTally;
  prices: PriceNow[];
  block: number;
  readAtMs: number;
  source: DataSource;
}

// ---------------------------------------------------------------------------------------------
// /api
// ---------------------------------------------------------------------------------------------

export interface PaymentAccept {
  scheme: string;
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string } & Record<string, unknown>;
}

/** The base64-decoded PAYMENT-REQUIRED header (x402 v2). */
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: PaymentAccept[];
}

export interface ApiRoute {
  method: string;
  path: string;
  url: string;
  summary: string;
  description: string;
  query: string;
  /** "$0.01" */
  price: string;
  /** Base units of the payment asset (USDT0, 6 dp): "10000" = $0.01. */
  amount: string;
  asset: Address;
  network: string;
  payTo: Address;
  scheme: string;
  maxTimeoutSeconds: number;
  available: boolean;
}

export interface X402Discovery {
  x402Version: number;
  service: string;
  description: string;
  resources: string[];
  routes: ApiRoute[];
}

export interface CalendarPreview {
  schema: "curb.asp.calendar.preview/1";
  symbol: string;
  mic: string;
  marketOpen: boolean;
  nowPeriod: string;
  nextClosure: (ClosureWindow & { startIso: string | null; endIso: string | null }) | null;
}

export interface RecordPreview {
  schema: "curb.asp.record.preview/1";
  skill: { settled: number; beatLastPrint: number; beatClosingVwap: number };
  rowCount: number;
}

export interface DiscountPreview {
  schema: "curb.asp.discount.preview/1";
  n: number;
  nUsable: number;
  buckets: { label: string; n: number; status: string }[];
}

export type ApiPreview = CalendarPreview | RecordPreview | DiscountPreview | Record<string, unknown>;

/** An unpaid call to a priced route: the 402 challenge and the free preview in its body. */
export interface UnpaidCall<P = ApiPreview> {
  url: string;
  status: number;
  paymentRequired: PaymentRequired | null;
  preview: P | null;
  readAtMs: number;
  source: DataSource;
}

export interface ApiAsset {
  symbol: string;
  wrapper: Address;
  pool: Address | null;
  mic: Mic;
  hasPriceSource: boolean;
  venueAsOfMs: number;
}

export interface AssetsListing {
  schema: string;
  asOfMs: number;
  cohortAsOfMs: number;
  chainId: number;
  marketClock: Address;
  scorecard: Address;
  assets: ApiAsset[];
}

export interface ApiHealth {
  ok: boolean;
  bootMs: number;
  ticks: number;
  lastTickOkMs: number;
  payments: { configured: boolean; ready: boolean; missing: string[]; lastInitError: string | null; inFlight: number; unconfirmed: number };
  cohort: { size: number; asOfMs: number; error: string | null };
  scorecard: { asOfBlock: number; readAtMs: number; ageS: number; rows: number; settled: number; stale: boolean; outage: boolean; lastError: string | null };
  regimeIndex: Record<string, unknown>;
  venues: { symbol: string; mic: string; asOfMs: number; ageS: number; stale: boolean; outage: boolean; lastError: string | null }[];
}

// ---------------------------------------------------------------------------------------------
// /notes  (ReopenNote, ClosedAuction, ReopenPointer)
// ---------------------------------------------------------------------------------------------

export interface NoteView {
  /** ERC-1155 id, decimal string. */
  id: string;
  wrapper: Address;
  symbol: string;
  issuer: Address;
  /** Units minted = wrapper-share wei (1 unit = 1 wei of share). */
  wrapperSharesRaw: string;
  shares: number;
  underlyingAtMintRaw: string;
  multiplierNonce: number;
  epochAtMint: number;
  mintedAtMs: number;
  mintedBlock: number;
  outstandingRaw: string;
  /** The connected holder's balance of this id; null when no wallet. */
  balanceRaw: string | null;
  redeemable: boolean;
  /** ReopenPointer.epochOf(wrapper) now. Redeem unlocks when epochNow > epochAtMint … */
  epochNow: number;
  reopened: boolean;
  /** … or at mintedAt + 10 days (FALLBACK_AFTER). */
  fallbackAtMs: number;
  /** Expected reopen from schedule.ts (display only; the pointer's epoch is the authority). */
  expectedReopenMs: number | null;
  /** ReopenPointer print for epochAtMint + 1, once recorded. */
  print: { price: number; priceE18: string; printedAtMs: number } | null;
  /** shares × Scorecard.priceNow, USD; null when unpriced. */
  valueNowUsd: number | null;
  specimen: boolean;
  block: number | null;
  source: DataSource;
}

export type LotStatus = "NONE" | "LIVE" | "SOLD" | "WITHDRAWN";

export interface AuctionLot {
  lotId: string;
  seller: Address;
  wrapper: Address;
  symbol: string;
  noteId: string;
  amountRaw: string;
  shares: number;
  /** USDG for the whole lot (6 dp → float for display; …Raw is exact). */
  startPrice: number;
  startPriceRaw: string;
  floorPrice: number;
  floorPriceRaw: string;
  /** valueUsdg(amount, priceNow) at listing; 0 when the price was unreadable. */
  refPrice: number;
  refPriceRaw: string;
  startAtMs: number;
  endAtMs: number;
  decaySeconds: number;
  epochAtMint: number;
  status: LotStatus;
  buyer: Address | null;
  clearedPrice: number | null;
  clearedAtMs: number | null;
  /** currentPrice(lotId) now; null unless LIVE. */
  currentPrice: number | null;
  /** (ref − current) / ref in bps, floored at 0. */
  discountBpsVsRef: number | null;
  /** realisedDiscountBps(lotId) after the print; null when NotPrinted / not sold. */
  realisedDiscountBps: number | null;
  specimen: boolean;
  block: number | null;
  source: DataSource;
}

export interface PointerEpoch {
  wrapper: Address;
  symbol: string;
  epoch: number;
  open: boolean;
  shutSeenAtMs: number | null;
  openedAtMs: number | null;
  openedBlock: number | null;
  print: number | null;
  printE18: string | null;
  printedAtMs: number | null;
}

// ---------------------------------------------------------------------------------------------
// /depth  (DepthCert, CurbCredit)
// ---------------------------------------------------------------------------------------------

export type CertStatus = "NONE" | "LIVE" | "FADED" | "CLOSED";

export interface CertView {
  id: string;
  maker: Address;
  wrapper: Address;
  symbol: string;
  /** 0x0 = anyone may take. */
  beneficiary: Address;
  sizeSharesRaw: string;
  sizeShares: number;
  remainingSharesRaw: string;
  remainingShares: number;
  /** USDG per whole share. */
  bidPx: number;
  bidPxRaw: string;
  bond: number;
  bondRaw: string;
  /** notional(remaining, bidPx), USDG. */
  notional: number;
  postedAtMs: number;
  expiryMs: number;
  status: CertStatus;
  /** DepthCert.isHonourable(maker): balance and allowance cover every live commitment. */
  makerHonourable: boolean | null;
  specimen: boolean;
  block: number | null;
  source: DataSource;
}

export interface CureView {
  active: boolean;
  lastOpen: boolean;
  openedAtMs: number | null;
  lastTickAtMs: number | null;
  openSecondsUsed: number;
  /** CURE_OPEN_SECONDS = 1800. */
  requiredSeconds: number;
  priceAtBreach: number | null;
}

export interface CreditPosition {
  borrower: Address;
  wrapper: Address;
  symbol: string;
  collateralRaw: string;
  collateral: number;
  /** debtOf(b, a), USDG (principal + accrued + interest to now). */
  debt: number;
  debtRaw: string;
  /** limitOf(b, a), USDG. */
  limit: number;
  limitRaw: string;
  ltvBps: number;
  breach: { known: boolean; breached: boolean };
  cure: CureView | null;
  specimen: boolean;
  block: number | null;
  source: DataSource;
}

/** One point on the published LTV function: depth (shares) → LTV (bps). */
export interface LtvPoint {
  depthShares: number;
  ltvBps: number;
}

export interface LtvCurve {
  wrapper: Address;
  symbol: string;
  regime: RegimeName;
  /** 6000 when primary cap > 0, 3000 when CLOSED, 0 when UNKNOWN. */
  regimeCapBps: number;
  priceNow: number | null;
  /** Lowest bid among counted certs (USDG per share). */
  minBidPx: number | null;
  totalCollateral: number;
  points: LtvPoint[];
  /** ltvFor(wrapper) today, at today's honoured depth ("you are here"). */
  here: LtvPoint | null;
  specimen: boolean;
  block: number | null;
  source: DataSource;
}

export interface DepthView {
  wrapper: Address;
  symbol: string;
  /** honouredDepth(wrapper, CurbCredit, now + 1h). */
  honouredShares: number;
  honouredNotional: number;
  minBidPx: number | null;
  soonestExpiryMs: number | null;
  ltvBps: number;
  realisable: number;
  certs: CertView[];
  curve: LtvCurve;
  specimen: boolean;
  block: number | null;
  source: DataSource;
}

// ---------------------------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------------------------

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface WriteResult {
  hash: Hex;
  block: number;
  status: "success" | "reverted";
  oklinkTxUrl: string;
}
