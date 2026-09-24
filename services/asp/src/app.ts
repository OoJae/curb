/**
 * The request router: free routes, and the dispatch into the priced flow.
 *
 * Free, and cheap by construction (every one reads state the tick already holds):
 *   GET /                      what Curb is, the three priced endpoints, links
 *   GET /healthz               liveness, tick progress, payments configured/ready, cohort, issuer freshness,
 *                              the Scorecard snapshot's block and age, and the RegimeChanged backfill's progress
 *   GET /v1/assets             the cohort MarketClock tracks, and which of it Scorecard can grade
 *   GET /.well-known/x402      the priced routes and their terms, for discovery
 *   GET /v1/relay/binance/klines  closed Binance 1m klines, the upstream bytes verbatim (relay.ts; the one that fetches)
 *   GET /receipts/<id>.json    a paid call's receipt, immutable
 *   GET /issuer/<hash>.json    the exact issuer bytes a calendar was computed from, immutable
 *
 * Priced (pay/flow.ts): /v1/closure-calendar, /v1/accuracy-record, /v1/discount-curve, by GET or by POST
 * with the same parameters as a body (NodeHttpAdapter.asGet); every other method is a 405. A priced route
 * without a handler (the two Scorecard routes when SCORECARD is unset) answers 503 not-yet-available
 * BEFORE the payment layer: it is listed with its price, but it never issues a challenge for an answer
 * that does not exist.
 *
 * /healthz's `ok` is about THIS process -- ticking, and holding a cohort -- not about the backfill: the
 * calendar serves while the index is most of an hour from done, and the curve says for itself which durations are
 * still pending. A Railway healthcheck that waited on the backfill would never let a fresh volume deploy.
 *
 * Nothing here is secret. /healthz names missing settings, never their values, and names RPC endpoints
 * only by position and origin (sources/chain.ts endpointLabel), never by a path that could carry a key.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeHttpAdapter, bufferBody, BodyTooLarge } from "./http/adapter.ts";
import { send, sendJson } from "./http/respond.ts";
import { BINANCE_KLINES_PATH, createBinanceRelay, serveRelay } from "./relay.ts";
import type { BinanceRelay } from "./relay.ts";
import { servePriced } from "./pay/flow.ts";
import { PRICED_ROUTES, SCHEME, MAX_TIMEOUT_SECONDS, USDT0 } from "./pay/routes.ts";
import type { Payments, PricedHandler } from "./pay/server.ts";
import { receiptPath, RECEIPT_ID_RE } from "./pay/receipt.ts";
import { AuthorizationLedger } from "./pay/ledger.ts";
import type { AuthorizationChain } from "./pay/authorization.ts";
import type { VenueStore } from "./venue.ts";
import type { ScorecardStatus } from "./index/scorecard.ts";
import type { ClosureIndexStatus } from "./index/closures.ts";
import type { Asset } from "./cohort.ts";
import type { Log } from "./log.ts";
import { throttledLog } from "./log.ts";

export interface AppState {
  bootMs: number;
  ticks: number;
  lastTickOkMs: number;
  cohort: Asset[];
  cohortAsOfMs: number;
  cohortError: string | null;
}

export interface AppDeps {
  state: AppState;
  venues: VenueStore;
  payments: Payments;
  handlers: ReadonlyMap<string, PricedHandler>;
  dataDir: string;
  publicUrl: string;
  tickMs: number;
  contracts: { chainId: number; clock: string; scorecard: string };
  now: () => number;
  log: Log;
  /** For /healthz only; null when SCORECARD is unset. */
  scorecard?: { status(nowMs: number): ScorecardStatus } | null;
  closures?: { status(): ClosureIndexStatus } | null;
  /** The Binance klines relay (relay.ts); left out, one is built over the real fetch and `now`. */
  relay?: BinanceRelay;
  /**
   * The payment ledger (pay/ledger.ts). main.ts builds it, loads what a previous process left pending and
   * runs its reconciler; left out (tests), one is built under dataDir/ledger.
   */
  ledger?: AuthorizationLedger;
  /** The chain reads that settle an unknown Broker outcome; null leaves such payments pending in the ledger. */
  authChain?: AuthorizationChain | null;
  /** Real time a paid request keeps asking the chain after an unknown settle. Default 15 s. */
  inlineReconcileMs?: number;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const HASH_FILE = /^\/(receipts|issuer)\/(0x[0-9a-fA-F]{64})\.json$/;

export function createApp(d: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const wellKnown = JSON.stringify(wellKnownDoc(d));
  const home = homePage(d);
  const receiptsDir = join(d.dataDir, "receipts");
  const ledger = d.ledger ?? new AuthorizationLedger({ dir: join(d.dataDir, "ledger"), receiptsDir, now: d.now, log: d.log });
  const noteUndecodable = throttledLog(d.log, "payment-header-undecodable", 60_000);
  const relay = d.relay ?? createBinanceRelay({ now: d.now, log: d.log });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try { body = await bufferBody(req); } catch (e) {
      return sendJson(res, e instanceof BodyTooLarge ? 413 : 400, { error: e instanceof BodyTooLarge ? "body-too-large" : "bad-request" });
    }
    const request = new NodeHttpAdapter(req, body, d.publicUrl);
    const method = request.getMethod();
    if (method === "OPTIONS") return send(res, 204, "");

    const path = request.getPath().length > 1 ? request.getPath().replace(/\/+$/, "") : request.getPath();
    const priced = PRICED_ROUTES.find((r) => r.path === path);
    // A priced route also answers POST, as the GET it stands for (NodeHttpAdapter.asGet). Nothing else does.
    if (method !== "GET" && !(method === "POST" && priced)) {
      return sendJson(res, 405, { error: "method-not-allowed" }, { allow: priced ? "GET, POST, OPTIONS" : "GET, OPTIONS" });
    }
    const asGet = request.asGet();
    if (!asGet.ok) return sendJson(res, asGet.status, asGet.body);
    const adapter = asGet.adapter;

    switch (path) {
      case "/": return send(res, 200, home, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
      case "/healthz": return healthz(res);
      case "/v1/assets": return assets(res);
      case "/.well-known/x402": return send(res, 200, wellKnown, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" });
    }
    // Free and GET-only (the method gate above): the relay's own query rules and upstream budget apply.
    if (path === BINANCE_KLINES_PATH) return serveRelay(res, relay, adapter.url.searchParams);
    const file = path.match(HASH_FILE);
    if (file) {
      const dir = join(d.dataDir, file[1]);
      const p = file[1] === "receipts" ? receiptPath(dir, file[2]) : join(dir, `${file[2].toLowerCase()}.json`);
      if (file[1] === "receipts" && !RECEIPT_ID_RE.test(file[2].toLowerCase())) return sendJson(res, 404, { error: "not-found" });
      if (existsSync(p)) return send(res, 200, readFileSync(p), { "content-type": "application/json; charset=utf-8", "cache-control": IMMUTABLE });
      return sendJson(res, 404, { error: "not-found" });
    }
    if (priced) {
      return servePriced(res, adapter, {
        payments: d.payments, handler: d.handlers.get(priced.key), route: priced,
        ledger, chain: d.authChain ?? null, inlineReconcileMs: d.inlineReconcileMs ?? 15_000,
        noteUndecodable, now: d.now, log: d.log,
      });
    }
    return sendJson(res, 404, { error: "not-found" });
  }

  function healthz(res: ServerResponse): void {
    const now = d.now();
    const s = d.state;
    const ok = s.ticks > 0 && now - s.lastTickOkMs < 6 * d.tickMs && s.cohort.length > 0;
    sendJson(res, ok ? 200 : 503, {
      ok,
      bootMs: s.bootMs,
      ticks: s.ticks,
      lastTickOkMs: s.lastTickOkMs,
      payments: {
        configured: d.payments.configured,
        ready: d.payments.ready,
        missing: d.payments.missing,
        lastInitError: d.payments.lastInitError,
        // Counts only. A non-zero `unconfirmed` is a payment the Broker could not confirm and the chain has
        // not settled yet; the reconciler resolves each one by validBefore.
        inFlight: ledger.inFlightCount,
        unconfirmed: ledger.pendingCount,
      },
      cohort: { size: s.cohort.length, asOfMs: s.cohortAsOfMs || null, error: s.cohortError },
      scorecard: scorecardHealth(now),
      regimeIndex: d.closures ? d.closures.status() : null,
      venues: s.cohort.map((a) => {
        const v = d.venues.status(a.wrapper, now);
        return {
          symbol: a.symbol, mic: v.venue?.mic ?? (a.micOnChain || null),
          asOfMs: v.venue?.atMs ?? null, ageS: v.ageMs === null ? null : Math.round(v.ageMs / 1000),
          stale: v.stale, outage: v.outage, lastError: v.lastError,
        };
      }),
    });
  }

  function scorecardHealth(now: number) {
    if (!d.scorecard) return null;
    const st = d.scorecard.status(now);
    const snap = st.snapshot;
    return {
      asOfBlock: snap?.block.number ?? null,
      readAtMs: snap?.readAtMs ?? null,
      ageS: st.ageMs === null ? null : Math.round(st.ageMs / 1000),
      rows: snap?.rows.length ?? null,
      settled: snap?.skill.settled ?? null,
      stale: st.stale,
      outage: st.outage,
      lastError: st.lastError,
    };
  }

  function assets(res: ServerResponse): void {
    const s = d.state;
    if (s.cohort.length === 0) return sendJson(res, 503, { error: "cohort-unavailable", detail: s.cohortError });
    const now = d.now();
    sendJson(res, 200, {
      schema: "curb.asp.assets/1",
      asOfMs: now,
      cohortAsOfMs: s.cohortAsOfMs,
      chainId: d.contracts.chainId,
      marketClock: d.contracts.clock,
      scorecard: d.contracts.scorecard,
      assets: s.cohort.map((a) => {
        const v = d.venues.status(a.wrapper, now).venue;
        return {
          symbol: a.symbol,
          wrapper: a.wrapper,
          pool: a.pool,
          mic: v?.mic ?? (a.micOnChain || null),
          hasPriceSource: a.pool !== null,
          venueAsOfMs: v?.atMs ?? null,
        };
      }),
    }, { "cache-control": "public, max-age=30" });
  }

  return (req, res) => {
    handle(req, res).catch((e) => {
      d.log("http-handler-error", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.destroy();
    });
  };
}

/** Discovery: every priced route with its exact terms. Static for the life of the process. */
function wellKnownDoc(d: AppDeps) {
  return {
    x402Version: 2,
    service: "Curb",
    description: "Closure data for tokenized equities on X Layer: when the issuer's primary market is shut, and how Curb's marks held up.",
    resources: PRICED_ROUTES.map((r) => `${d.publicUrl}${r.path}`),
    routes: PRICED_ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      url: `${d.publicUrl}${r.path}`,
      summary: r.summary,
      description: r.description,
      query: r.query,
      mimeType: "application/json",
      price: `$${r.priceUsd}`,
      accepts: [{
        scheme: SCHEME, network: d.payments.network, asset: USDT0.address, amount: r.atomic,
        payTo: d.payments.payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      }],
      available: d.payments.configured && d.handlers.has(r.key),
    })),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function homePage(d: AppDeps): string {
  const explorer = (a: string) => `https://www.oklink.com/xlayer/address/${a}`;
  const rows = PRICED_ROUTES.map((r) => `<li><code>GET ${esc(r.path)}</code> <span class="price">$${esc(r.priceUsd)}</span>${d.handlers.has(r.key) ? "" : " <em>(coming soon)</em>"}<br>${esc(r.summary)}.<br><small>Query: ${esc(r.query)}</small></li>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curb API</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e4e1d8;--accent:#0f6b4f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a09e96;--line:#2c2b28;--accent:#5cc7a0}}
body{background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,sans-serif;max-width:42rem;margin:0 auto;padding:2.5rem 1rem}
h1{font-size:1.6rem;margin:0 0 .25rem}p.lede{color:var(--muted);margin-top:0}
ul{padding-left:1.1rem}li{margin:.9rem 0}code{font-size:.92em}.price{color:var(--accent);font-weight:600}
small{color:var(--muted)}a{color:var(--accent)}footer{border-top:1px solid var(--line);margin-top:2rem;padding-top:1rem;color:var(--muted);font-size:.9rem}
</style></head><body>
<h1>Curb API</h1>
<p class="lede">Tokenized equities on X Layer are only held to their underlying while the issuer's primary market is open. When the issuer's order cap goes to zero, creation and redemption stop, and the pools keep trading. Curb records when that happens (MarketClock), commits a price mark before each reopen, and has the chain grade it (Scorecard).</p>
<h2>Paid endpoints (x402)</h2>
<p>Paid per call in ${esc(USDT0.symbol)} on X Layer (<code>${esc(d.payments.network)}</code>, scheme <code>${SCHEME}</code>). Call without payment to get HTTP 402 with the challenge in the <code>PAYMENT-REQUIRED</code> header and a free preview in the body. Every paid response carries an <code>x-curb-receipt</code> id, served at <code>/receipts/&lt;id&gt;.json</code>.</p>
<ul>
${rows}
</ul>
<h2>Free</h2>
<ul>
<li><a href="/v1/assets"><code>/v1/assets</code></a>: the assets Curb tracks</li>
<li><a href="/.well-known/x402"><code>/.well-known/x402</code></a>: the paid routes and their terms</li>
<li><a href="/healthz"><code>/healthz</code></a>: service status</li>
</ul>
<footer>MarketClock <a href="${explorer(d.contracts.clock)}"><code>${esc(d.contracts.clock)}</code></a><br>Scorecard <a href="${explorer(d.contracts.scorecard)}"><code>${esc(d.contracts.scorecard)}</code></a></footer>
</body></html>`;
}
