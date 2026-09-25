/**
 * The two tools that read curb-asp (api.curb.markets) rather than the chain. Neither pays for anything.
 *
 * curb_corporate_actions proxies the asp's FREE feed, GET /v1/corporate-actions?symbol=: every version of the
 * issuer's corporate actions kept for a symbol, Cancelled and Corrected included, newest first
 * (services/asp/src/corporateActions.ts). The symbol sent is always the issuer ticker from assets.ts, never
 * the caller's string. The asp's own answer is returned as it came, with `versions` cut to `limit` so one
 * call cannot flood an agent's context; `versionsTotal` says how many there were.
 *
 * curb_paid_services describes the three x402 routes and how to pay and check them. It reads the asp's live
 * discovery document (/.well-known/x402) for the prices and terms, so a price change there shows up here
 * without a redeploy, and falls back to the terms as listed on 24 Sep 2026 (script/asp/services.json) when
 * the asp cannot be reached, saying which it used.
 */
import { CONTRACTS } from "./assets.ts";
import type { Asset } from "./assets.ts";

export const ASP_BASE = "https://api.curb.markets";
const ASP_TIMEOUT_MS = 8_000;
export const DEFAULT_VERSIONS = 20;
export const MAX_VERSIONS = 100;

export type JsonFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function getJson(fetchImpl: JsonFetch, url: string): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ASP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "curb-mcp/1.0" } });
    let body: unknown;
    try { body = await res.json(); } catch { return { ok: false, error: `http ${res.status}, body is not JSON` }; }
    if (!res.ok) return { ok: false, error: `http ${res.status}: ${JSON.stringify(body).slice(0, 200)}` };
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// corporate actions
// ---------------------------------------------------------------------------------------------

export interface CorporateActionsResult {
  summary: string;
  source: { url: string; fetchedAt: string; upstream: string | null };
  asOf: string | null;
  versionsTotal: number;
  versionsShown: number;
  feed: Record<string, unknown>;
}

export async function readCorporateActions(fetchImpl: JsonFetch, a: Asset, limit = DEFAULT_VERSIONS, now: () => number = Date.now): Promise<CorporateActionsResult> {
  const url = `${ASP_BASE}/v1/corporate-actions?symbol=${encodeURIComponent(a.ticker)}`;
  const r = await getJson(fetchImpl, url);
  if (!r.ok) throw new Error(`curb-asp corporate-actions feed unavailable: ${r.error}`);
  const body = (r.body ?? {}) as Record<string, unknown>;
  const versions = Array.isArray(body.versions) ? body.versions : [];
  const shown = versions.slice(0, limit);
  const asOfMs = typeof body.asOfMs === "number" ? body.asOfMs : null;
  const events = typeof body.events === "number" ? body.events : null;
  const latest = shown[0] as Record<string, unknown> | undefined;
  return {
    summary:
      `${a.symbol} (${a.ticker}): ${events ?? "?"} corporate-action events, ${versions.length} versions kept by curb-asp` +
      (latest ? `; newest: ${String(latest.caType)} effective ${String(latest.effectiveTimeUtc)} (status ${String(latest.status)})` : "") +
      `${body.stale === true ? "; the asp reports its copy stale" : ""}.`,
    source: { url, fetchedAt: new Date(now()).toISOString(), upstream: typeof body.source === "string" ? body.source : null },
    asOf: asOfMs ? new Date(asOfMs).toISOString() : null,
    versionsTotal: versions.length,
    versionsShown: shown.length,
    feed: { ...body, versions: shown },
  };
}

/** The newest `limit` versions of an answer read with a larger limit. The summary does not depend on it. Never mutates `r`. */
export function limitVersions(r: CorporateActionsResult, limit: number): CorporateActionsResult {
  const versions = Array.isArray(r.feed.versions) ? r.feed.versions.slice(0, limit) : [];
  return { ...r, versionsShown: versions.length, feed: { ...r.feed, versions } };
}

// ---------------------------------------------------------------------------------------------
// paid services
// ---------------------------------------------------------------------------------------------

/** The terms as listed on the OKX AI marketplace on 24 Sep 2026 (script/asp/services.json, services/asp/src/pay/routes.ts). */
export const LISTED_ROUTES = [
  { name: "Closure Calendar", path: "/v1/closure-calendar", price: "$0.01", amount: "10000", params: "symbol (optional, default wTCENTx), horizonDays (1-14, default 7)", example: "?symbol=wTCENTx&horizonDays=7" },
  { name: "Reopen Price Accuracy Record", path: "/v1/accuracy-record", price: "$0.05", amount: "50000", params: "symbol (optional; omit for every graded asset), limit (1-200, default 50)", example: "?symbol=wTCENTx&limit=20" },
  { name: "Closure Discount by Duration", path: "/v1/discount-curve", price: "$0.10", amount: "100000", params: "symbol (optional; omit for every graded asset), minMinutes (30-10080, default 30)", example: "?symbol=wTCENTx&minMinutes=30" },
] as const;

export const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
export const CURB_REVENUE = "0x277cA91276A3801667B76C97Da3872Ccb6E96068";

interface WellKnownRoute {
  path?: string;
  url?: string;
  summary?: string;
  query?: string;
  price?: string;
  available?: boolean;
  accepts?: { scheme?: string; network?: string; asset?: string; amount?: string; payTo?: string; maxTimeoutSeconds?: number }[];
}

export async function readPaidServices(fetchImpl: JsonFetch, now: () => number = Date.now) {
  const url = `${ASP_BASE}/.well-known/x402`;
  const r = await getJson(fetchImpl, url);
  const live = r.ok && Array.isArray((r.body as { routes?: unknown }).routes) ? ((r.body as { routes: WellKnownRoute[] }).routes) : null;

  const services = LISTED_ROUTES.map((l) => {
    const w = live?.find((x) => x.path === l.path);
    const acc = w?.accepts?.[0];
    const full = `${ASP_BASE}${l.path}${l.example}`;
    return {
      name: l.name,
      route: `GET ${ASP_BASE}${l.path}`,
      summary: w?.summary ?? null,
      params: w?.query ?? l.params,
      price: w?.price ?? l.price,
      terms: {
        scheme: acc?.scheme ?? "exact",
        network: acc?.network ?? "eip155:196",
        asset: acc?.asset ?? USDT0,
        assetSymbol: "USD₮0",
        amountAtomic: acc?.amount ?? l.amount,
        payTo: acc?.payTo ?? CURB_REVENUE,
        maxTimeoutSeconds: acc?.maxTimeoutSeconds ?? 300,
      },
      available: w?.available ?? null,
      freePreview: `curl -si "${full}"  # HTTP 402: the challenge in the PAYMENT-REQUIRED header, a free preview in the body`,
      pay: [
        `onchainos payment quote "${full}"`,
        "onchainos payment pay --payment-id <paymentId printed by quote>",
      ],
    };
  });

  return {
    summary:
      "curb-asp sells three answers over x402, each paid per call in USD₮0 on X Layer (scheme exact, settled by the OKX Broker). " +
      "This tool never pays: it lists the terms and the onchainos commands a wallet holder runs.",
    termsSource: live
      ? { from: url, read: "live", fetchedAt: new Date(now()).toISOString() }
      : { from: "the listing as submitted on 24 Sep 2026 (script/asp/services.json)", read: "fallback", error: r.ok ? "no routes in the discovery document" : r.error },
    services,
    howToPay: [
      "1. quote: `onchainos payment quote \"<url with query>\"` probes the 402, checks the wallet can pay, and prints a paymentId. It never signs.",
      "2. pay: `onchainos payment pay --payment-id <paymentId>` answers with a confirmation prompt (exit 2); after the human who owns the wallet approves the amount, re-run it with `--yes`. The Agentic Wallet signs an EIP-3009 authorization in OKX's TEE, the CLI replays the request, and the paid answer comes back.",
      "Unpaid calls are free and return the 402 with a preview, so an agent can check the answer's shape and the price before anyone spends.",
    ],
    verifyReceipt: [
      "Every paid response carries an x-curb-receipt header: fetch https://api.curb.markets/receipts/<id>.json (immutable).",
      "The receipt id is keccak256(transaction ‖ responseDigest); responseDigest is the sha256 of the exact response bytes, so keep the raw body. `onchainos payment pay` prints the answer re-serialised with sorted keys, and hashing that output does not reproduce the digest.",
      "`onchainos payment decode-receipt` decodes the PAYMENT-RESPONSE header into {status, transaction, amount, payer, chainId}.",
      `The settlement is a USD₮0 transfer to curb-revenue ${CURB_REVENUE} on X Layer: https://www.oklink.com/xlayer/tx/<transaction>.`,
    ],
    verifyCurbData:
      `Paid answers are built from on-chain Curb data: MarketClock ${CONTRACTS.marketClock} and Scorecard ${CONTRACTS.scorecard}. ` +
      "Any MarketClock round or Scorecard mark transaction can be re-derived from its published evidence with `npx -y github:OoJae/curb tx <hash>`.",
    discovery: { x402: url, marketplace: "https://www.okx.ai/agents/13869 (agent #13869, listed 25 Sep 2026)" },
  };
}
