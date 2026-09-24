/**
 * The payment layer: an x402HTTPResourceServer settling through the OKX Broker, and the priced route table.
 *
 * Three states, and the service must be honest in each:
 *   not configured  OKX credentials or PAY_TO absent. The free routes serve; every priced route answers
 *                   503 payments-not-configured. It never issues a challenge it could not settle, and it
 *                   never serves a priced answer without a verified payment.
 *   not ready       configured, but the Broker's /supported has not been read yet (or failed). The SDK
 *                   cannot build a challenge without it, so priced routes answer 503 payments-unavailable
 *                   and the tick retries.
 *   ready           challenges are built by the real SDK, verified and settled by the Broker.
 *
 * The facilitator is injectable so the tests run the REAL resource server -- its challenge encoding,
 * requirement matching and settlement handling -- against a stub Broker, offline.
 *
 * Every Broker call goes through withDeadlines (broker.ts): /supported, verify and settle each have a
 * deadline, and a Broker that stops answering can hold neither the tick nor a paid request.
 *
 * Settlement is synchronous by default (OKX_SYNC_SETTLE): the Broker waits for the transfer to mine
 * before it answers, so the transaction in a receipt is a mined one rather than a promise. If that wait
 * times out, the SDK polls the Broker's status endpoint for five seconds and then asks
 * `onSettlementTimeout`, which we answer from the chain itself (makeChainConfirm) -- for THIS payment's
 * authorization, not for any transfer that happens to reach PAY_TO.
 */
import { x402ResourceServer, x402HTTPResourceServer } from "@okxweb3/x402-core/server";
import type {
  FacilitatorClient, HTTPAdapter, HTTPRequestContext, RouteConfig, RoutesConfig,
} from "@okxweb3/x402-core/server";
import type { OnSettlementTimeoutHook } from "@okxweb3/x402-core/http";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import type { Network } from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { PRICED_ROUTES, SCHEME, MAX_TIMEOUT_SECONDS, USDT0 } from "./routes.ts";
import { DEFAULT_BROKER_DEADLINES, withDeadlines } from "./broker.ts";
import type { BrokerDeadlines } from "./broker.ts";
import { receiptPays, settlementScope } from "./authorization.ts";
import type { RpcCall, TxReceipt } from "./authorization.ts";
import type { PricedRoute } from "./routes.ts";
import type { Log } from "../log.ts";

export type BilledQuery = Record<string, string | number>;
export type Refusal = { ok: false; status: number; body: Record<string, unknown> };

/**
 * One priced endpoint's logic, in the order the flow calls it:
 *   accept   free, before the payment layer is consulted: 4xx for a malformed request, 503 when no
 *            answer could be built right now. Refusing here costs the caller nothing.
 *   preview  the body of the unpaid 402: a truthful sample of the answer.
 *   build    the paid answer, built BEFORE settlement. A refusal here returns 503 and the payment is
 *            never settled -- the buyer is not billed for an answer that does not exist.
 */
export interface PricedHandler {
  accept(adapter: HTTPAdapter, nowMs: number): { ok: true; query: BilledQuery } | Refusal;
  preview(query: BilledQuery, nowMs: number): unknown;
  build(query: BilledQuery, nowMs: number): { ok: true; body: unknown } | Refusal;
}

export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface PaymentsOptions {
  network: Network;
  /** Checksummed recipient, or null when PAY_TO is unset or invalid. */
  payTo: string | null;
  /** Null when any of the three OKX variables is unset. */
  okx: OkxCredentials | null;
  syncSettle: boolean;
  publicUrl: string;
  handlers: ReadonlyMap<string, PricedHandler>;
  /** Tests inject a stub Broker here; production builds OKXFacilitatorClient from `okx`. Either way it is bounded. */
  facilitator?: FacilitatorClient;
  /** Per-call Broker deadlines; DEFAULT_BROKER_DEADLINES for any left out. */
  brokerDeadlines?: Partial<BrokerDeadlines>;
  confirmSettlementTx?: OnSettlementTimeoutHook;
  now: () => number;
  log: Log;
  /** Minimum gap between attempts to read the Broker's /supported. */
  initRetryMs?: number;
}

/** A static page for browsers. The SDK's default embeds request data unescaped and says "USDC"; this says neither. */
function paywallHtml(r: PricedRoute): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curb API: payment required</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}code{font-size:.9em}</style>
</head><body><h1>Payment required</h1>
<p><code>${r.method} ${r.path}</code> costs <strong>$${r.priceUsd}</strong> per call, paid in ${USDT0.symbol} on X Layer (x402, scheme <code>${SCHEME}</code>).</p>
<p>${r.description}</p>
<p>Call it from an x402 client. Without payment, an API client receives HTTP 402 with the challenge in the <code>PAYMENT-REQUIRED</code> header and a free preview in the body.</p>
<p><a href="/">Curb API</a></p></body></html>`;
}

export function buildRoutesConfig(o: PaymentsOptions, payTo: string): RoutesConfig {
  const routes: Record<string, RouteConfig> = {};
  for (const r of PRICED_ROUTES) {
    const h = o.handlers.get(r.key);
    routes[r.key] = {
      accepts: { scheme: SCHEME, network: o.network, payTo, price: `$${r.priceUsd}`, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS },
      // Fixed, never the request URL: the challenge must not echo anything a caller can inject.
      resource: `${o.publicUrl}${r.path}`,
      description: r.description,
      mimeType: "application/json",
      customPaywallHtml: paywallHtml(r),
      unpaidResponseBody: async (ctx: HTTPRequestContext) => ({ contentType: "application/json", body: unpaidBody(h, ctx.adapter, o.now()) }),
      settlementFailedResponseBody: async (_ctx, f) => ({
        contentType: "application/json",
        body: { error: "settlement-failed", reason: f.errorReason, message: f.errorMessage ?? null, transaction: f.transaction || null },
      }),
    };
  }
  return routes;
}

function unpaidBody(h: PricedHandler | undefined, adapter: HTTPAdapter, nowMs: number): unknown {
  if (!h) return { error: "not-yet-available" };
  const a = h.accept(adapter, nowMs);
  if (!a.ok) return a.body;
  try { return h.preview(a.query, nowMs); } catch { return { error: "preview-unavailable" }; }
}

export class Payments {
  readonly configured: boolean;
  /** Names (never values) of the settings that are absent, for /healthz. */
  readonly missing: string[];
  readonly http: x402HTTPResourceServer | null;
  readonly network: Network;
  readonly payTo: string | null;
  ready = false;
  lastInitError: string | null = null;
  private lastInitAttemptMs = Number.NEGATIVE_INFINITY;
  private initInFlight: Promise<boolean> | null = null;
  private readonly initRetryMs: number;
  private readonly now: () => number;
  private readonly log: Log;

  constructor(o: PaymentsOptions) {
    this.network = o.network;
    this.payTo = o.payTo;
    this.now = o.now;
    this.log = o.log;
    this.initRetryMs = o.initRetryMs ?? 60_000;
    const broker = o.facilitator ?? (o.okx ? new OKXFacilitatorClient({ ...o.okx, syncSettle: o.syncSettle }) : null);
    const facilitator = broker ? withDeadlines(broker, { ...DEFAULT_BROKER_DEADLINES, ...o.brokerDeadlines }) : null;
    this.missing = [];
    if (!facilitator) this.missing.push("OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE");
    if (!o.payTo) this.missing.push("PAY_TO");
    this.configured = facilitator !== null && o.payTo !== null;
    if (!this.configured || !facilitator || !o.payTo) { this.http = null; return; }

    // Only the one network we settle on. A wildcard registration would let a route typo'd onto another
    // chain build a challenge the Broker then refuses.
    const core = new x402ResourceServer(facilitator).register(o.network, new ExactEvmScheme());
    this.http = new x402HTTPResourceServer(core, buildRoutesConfig(o, o.payTo));
    if (o.confirmSettlementTx) this.http.onSettlementTimeout(o.confirmSettlementTx);
  }

  /**
   * Read the Broker's /supported and validate every route against it. Retried by the tick until it works.
   *
   * Single-flight: while one attempt is out, every caller gets that attempt's promise, so the tick can fire
   * this without awaiting it (main.ts) and never stacks a second request on a Broker that is already slow.
   * It never rejects, and the /supported deadline bounds how long an attempt can be out.
   */
  ensureReady(): Promise<boolean> {
    if (!this.http || this.ready) return Promise.resolve(this.ready);
    if (this.initInFlight) return this.initInFlight;
    const now = this.now();
    if (now - this.lastInitAttemptMs < this.initRetryMs) return Promise.resolve(false);
    this.lastInitAttemptMs = now;
    const http = this.http;
    this.initInFlight = (async () => {
      try {
        await http.initialize();
        this.ready = true;
        this.lastInitError = null;
        this.log("payments-ready", { network: this.network, payTo: this.payTo });
      } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        this.lastInitError = `${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause instanceof Error ? cause.message : String(cause)})` : ""}`.slice(0, 300);
        this.log("payments-init-failed", { error: this.lastInitError });
      } finally {
        this.initInFlight = null;
      }
      return this.ready;
    })();
    return this.initInFlight;
  }
}

export type { RpcCall };

/**
 * The chain's own answer to "did this settlement land?", for when the Broker's synchronous settle and its
 * status endpoint both time out and the Broker has named a transaction.
 *
 * The transaction hash comes from the Broker, so this is the check that holds when the Broker is wrong.
 * It confirms only what flow.ts put in scope for the settlement in progress (authorization.ts
 * settlementScope): the transaction must be mined and successful, USD₮0 must mark THIS payment's
 * (payer, nonce) used, and USD₮0 must move at least the price from that payer to PAY_TO -- all in that one
 * transaction. A transfer from a stranger, of one atomic unit, for another authorization, or a call with
 * nothing in scope is "not confirmed", and the SDK then returns a settlement failure with no content;
 * flow.ts goes on to ask the chain about the authorization itself (ledger.ts), so erring this way costs a
 * few seconds, never a delivery the buyer paid for.
 */
export function makeChainConfirm(rpc: RpcCall, asset: string, payTo: string): OnSettlementTimeoutHook {
  return async (txHash: string) => {
    const expected = settlementScope.getStore();
    if (!expected) return { confirmed: false };
    try {
      return { confirmed: receiptPays(await rpc("eth_getTransactionReceipt", [txHash]) as TxReceipt | null, asset, payTo, expected) };
    } catch {
      return { confirmed: false };
    }
  };
}
