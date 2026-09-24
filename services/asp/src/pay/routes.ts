/**
 * The three priced routes, as data: what each costs and what it promises.
 *
 * The OKX marketplace sample-calls every listed endpoint during review and rejects a listing whose live
 * response does not match its description, so each description here says only what the endpoint
 * returns, in the terms the response itself uses. One table feeds the x402 route config, the
 * /.well-known/x402 document and the landing page, so the three cannot drift apart.
 *
 * Settlement is the `exact` scheme on X Layer: one EIP-3009 transfer of USD₮0 per call. That is what the
 * live OKX Broker supports today; it lists no subscription (`period`) scheme on eip155:196, so nothing
 * here pretends to offer one. `atomic` is the price in USD₮0's 6-decimal units; the SDK computes the
 * same figure from `$price` when it builds a challenge, and the test suite holds the two equal.
 */

/** USD₮0 on X Layer mainnet: the SDK's default stablecoin for eip155:196 (EIP-3009, 6 decimals). */
export const USDT0 = { address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6, symbol: "USD₮0" } as const;
export const SCHEME = "exact";
export const MAX_TIMEOUT_SECONDS = 300;

export interface PricedRoute {
  /** The x402 route key: the verb is part of it, so a POST can never match a GET price. */
  key: string;
  method: "GET";
  path: string;
  priceUsd: string;
  atomic: string;
  summary: string;
  description: string;
  query: string;
}

export const PRICED_ROUTES: readonly PricedRoute[] = [
  {
    key: "GET /v1/closure-calendar",
    method: "GET",
    path: "/v1/closure-calendar",
    priceUsd: "0.01",
    atomic: "10000",
    summary: "When a tokenized equity's primary market is shut, and when it reopens",
    description:
      "Closure calendar for one tokenized equity on X Layer: every window in the next 1-14 days (default 7) in which " +
      "the issuer's primary order cap is zero, and the instant it returns, computed from the issuer's published " +
      "schedule and limits. Includes the current period and cap, and the hashes of the exact issuer responses used.",
    query: "symbol (required, e.g. wTCENTx; see /v1/assets), horizonDays (1-14, default 7)",
  },
  {
    key: "GET /v1/accuracy-record",
    method: "GET",
    path: "/v1/accuracy-record",
    priceUsd: "0.05",
    atomic: "50000",
    summary: "Curb's graded record: every mark committed on chain before a reopen, and how Scorecard settled it",
    description:
      "Curb's accuracy record, read from the Scorecard contract on X Layer at one pinned block: the contract's own " +
      "skill() tally (settled rows, and strict wins against the last print and against the closing VWAP; a tie is not " +
      "a win), per-asset counts, ties and median errors, and each row newest first with its mark, both baselines, the " +
      "reopen price the contract read from the pool, and the three errors in basis points.",
    query: "symbol (optional, e.g. wTCENTx; omit for every graded asset; see /v1/assets), limit (1-200, default 50)",
  },
  {
    key: "GET /v1/discount-curve",
    method: "GET",
    path: "/v1/discount-curve",
    priceUsd: "0.10",
    atomic: "100000",
    summary: "How far the reopen price lands from the closing VWAP, by how long the primary market was shut",
    description:
      "Closure-discount observations for tokenized equities on X Layer, one per settled Scorecard row: how long the " +
      "primary market was shut (from MarketClock's RegimeChanged into CLOSED to the predicted reopen), the discount " +
      "from the closing VWAP to the reopen price, and the discount Curb's mark implied, in basis points. Grouped into " +
      "five duration buckets with counts, and order statistics only once a bucket holds enough closures. No fitted " +
      "curve: fit is always null.",
    query: "symbol (optional, e.g. wTCENTx; omit for every graded asset), minMinutes (30-10080, default 30)",
  },
];

export function routeByKey(key: string): PricedRoute | undefined {
  return PRICED_ROUTES.find((r) => r.key === key);
}
