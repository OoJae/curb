/**
 * curb-asp: Curb's x402-paid API, listed on the OKX AI marketplace as an agent service provider.
 *
 * It sells what the rest of Curb already produces, and nothing it would have to take on trust:
 *   - the closure calendar, computed from the issuer's published schedule and limits with the same
 *     reopen rule the keeper commits Scorecard rows under (closureCalendar.ts);
 *   - the accuracy record, Scorecard's own rows and skill() read at one pinned block (accuracyRecord.ts);
 *   - the closure-discount observations, those rows joined to MarketClock's RegimeChanged log for how long
 *     each closure lasted (discountCurve.ts). Order statistics only; nothing is fitted.
 *
 * It holds no key and sends no transaction. Payment is x402 `exact` on X Layer, verified and settled
 * by the OKX Broker; the only thing this process signs is its HMAC request to that Broker, with
 * credentials that live in the environment and are never logged or served. Every Broker call has a
 * deadline (pay/broker.ts), and a settle whose outcome the Broker cannot report is settled by the chain
 * instead (pay/ledger.ts).
 *
 * Three loops, one server:
 *   tick (30s)  refresh the cohort from MarketClock (every 10 min), the issuer bytes per asset (every
 *               600s, see venue.ts), the Scorecard snapshot (index/scorecard.ts), and warm each asset's
 *               calendar timeline so no request pays for a rebuild. It also fires the Broker's /supported
 *               until payments are ready -- fired, not awaited: a slow Broker must not stall the tick,
 *               and with it /healthz and a first deploy's healthcheck.
 *   index       the RegimeChanged scan (index/closures.ts): ~40-70 min of backfill on a fresh volume, then
 *               one chunk every 30s. Its own loop, so neither the tick nor a request ever waits on it.
 *   reconcile   every 15s, each payment the Broker could not confirm is checked against USD₮0's
 *               authorizationState until it is paid (receipted, its bytes kept for the buyer) or dead
 *               (past validBefore, nobody charged). Records a previous process left mid-settle are loaded
 *               at boot and reconciled the same way.
 *   http        app.ts. A dropped client never takes the process down; a port clash does, loudly. SIGTERM
 *               stops new connections and lets paid requests already in flight finish before exiting.
 *
 * Configuration is collected, never thrown from at import time, so tests can import this file.
 * Missing payment settings are NOT fatal: the free routes are useful without them, and every priced
 * route then refuses with 503 rather than serving anything unpaid.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import type { Network } from "@okxweb3/x402-core/types";

import { createApp } from "./app.ts";
import type { AppState } from "./app.ts";
import { calendarHandler } from "./calendarRoute.ts";
import { recordHandler, curveHandler } from "./scorecardRoutes.ts";
import { ScorecardIndex, rpcChain } from "./index/scorecard.ts";
import { ClosureIndex, MARKETCLOCK_FIRST_BLOCK } from "./index/closures.ts";
import { TimelineCache } from "./closureCalendar.ts";
import { readCohort, ZERO } from "./cohort.ts";
import type { Asset } from "./cohort.ts";
import { VenueStore } from "./venue.ts";
import type { Venue } from "./venue.ts";
import { makeLog } from "./log.ts";
import type { Log } from "./log.ts";
import { persistOnce } from "./persist.ts";
import { Payments, makeChainConfirm } from "./pay/server.ts";
import type { OkxCredentials, PricedHandler } from "./pay/server.ts";
import { USDT0 } from "./pay/routes.ts";
import { AuthorizationLedger } from "./pay/ledger.ts";
import { rpcAuthorizationChain } from "./pay/authorization.ts";
import { DEFAULT_RPCS, rpcAny } from "./sources/chain.ts";
import { XStocksClient } from "./sources/xstocks.ts";

export const DEFAULT_CLOCK = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
export const DEFAULT_SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";

// ---------------------------------------------------------------------------------------------
// configuration: collected, never thrown from at import time
// ---------------------------------------------------------------------------------------------

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const get = (k: string, d = "") => (env[k] ?? d).trim();
  /** Fatal: the service cannot run correctly with these wrong. */
  const errors: string[] = [];
  /** Not fatal: payments stay off and priced routes refuse, the free routes still serve. */
  const paymentIssues: string[] = [];
  const addr = (name: string, v: string, sink: string[]) => {
    if (v === "") return ZERO;
    try { return getAddress(v); } catch { sink.push(`${name} is not an address: ${JSON.stringify(v.slice(0, 64))}`); return ZERO; }
  };
  const num = (name: string, v: string, min: number, max: number) => {
    const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < min || n > max) { errors.push(`${name} must be in [${min},${max}], got ${JSON.stringify(v)}`); return min; }
    return n;
  };

  const payToRaw = addr("PAY_TO", get("PAY_TO"), paymentIssues);
  if (get("PAY_TO") === "") paymentIssues.push("PAY_TO is unset");
  const okxVars = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"] as const;
  const absent = okxVars.filter((k) => get(k) === "");
  if (absent.length) paymentIssues.push(`${absent.join(", ")} unset`);
  const syncRaw = get("OKX_SYNC_SETTLE", "true").toLowerCase();
  if (!["true", "false"].includes(syncRaw)) errors.push(`OKX_SYNC_SETTLE must be true or false, got ${JSON.stringify(syncRaw)}`);

  const publicUrl = get("PUBLIC_URL", "https://api.curb.markets").replace(/\/+$/, "");
  try { new URL(publicUrl); } catch { errors.push(`PUBLIC_URL is not a URL: ${JSON.stringify(publicUrl)}`); }

  const chainId = num("CHAIN_ID", get("CHAIN_ID", "196"), 1, 2 ** 31);
  const cfg = {
    port: num("PORT", get("PORT", "8080"), 1, 65535),
    dataDir: get("DATA_DIR", "/data"),
    rpcs: get("RPCS", DEFAULT_RPCS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    clock: addr("CLOCK", get("CLOCK", DEFAULT_CLOCK), errors),
    scorecard: addr("SCORECARD", get("SCORECARD", DEFAULT_SCORECARD), errors),
    chainId,
    network: `eip155:${chainId}` as Network,
    payTo: payToRaw === ZERO ? null : payToRaw,
    okx: absent.length === 0
      ? { apiKey: get("OKX_API_KEY"), secretKey: get("OKX_SECRET_KEY"), passphrase: get("OKX_PASSPHRASE") } as OkxCredentials
      : null,
    syncSettle: syncRaw !== "false",
    /**
     * How long a settle may take before its outcome is treated as unknown and the chain is asked instead. A sync
     * settle waits for the transfer to mine (X Layer: about a second), so this only bites when the Broker is in trouble.
     */
    okxSettleTimeoutMs: num("OKX_SETTLE_TIMEOUT_MS", get("OKX_SETTLE_TIMEOUT_MS", "30000"), 5_000, 120_000),
    publicUrl,
    hostId: get("HOST_ID", "asp"),
    tickMs: num("TICK_MS", get("TICK_MS", "30000"), 5_000, 300_000),
    venueRefreshMs: num("VENUE_REFRESH_MS", get("VENUE_REFRESH_MS", "600000"), 60_000, 3_600_000),
    issuerOutageMs: num("ISSUER_OUTAGE_MS", get("ISSUER_OUTAGE_MS", "1800000"), 300_000, 86_400_000),
    cohortRefreshMs: num("COHORT_REFRESH_MS", get("COHORT_REFRESH_MS", "600000"), 60_000, 86_400_000),
    /** Where the RegimeChanged scan starts: MarketClock's first attestation. Changing it rebuilds the index. */
    regimeIndexFromBlock: num("REGIME_INDEX_FROM_BLOCK", get("REGIME_INDEX_FROM_BLOCK", String(MARKETCLOCK_FIRST_BLOCK)), 0, 2 ** 48),
    /** eth_getLogs in flight during the backfill. rpc.xlayer.tech refused past ~6 concurrent on 24 Sep 2026. */
    regimeIndexConcurrency: num("REGIME_INDEX_CONCURRENCY", get("REGIME_INDEX_CONCURRENCY", "4"), 1, 8),
  };
  if (cfg.rpcs.length === 0) errors.push("RPCS is empty");
  if (get("CLOCK", DEFAULT_CLOCK) === "") errors.push("CLOCK is required");
  if (cfg.issuerOutageMs <= cfg.venueRefreshMs) errors.push("ISSUER_OUTAGE_MS must exceed VENUE_REFRESH_MS");
  return { cfg, errors, paymentIssues };
}

export type Config = ReturnType<typeof loadConfig>["cfg"];

// ---------------------------------------------------------------------------------------------
// the tick
// ---------------------------------------------------------------------------------------------

export interface TickDeps {
  state: AppState;
  venues: VenueStore;
  timelines: TimelineCache;
  payments: Payments;
  client: XStocksClient;
  readCohort: () => Promise<Asset[]>;
  cohortRefreshMs: number;
  /** The Scorecard snapshot behind the record and the curve; absent when SCORECARD is unset. */
  scorecard?: { refresh(): Promise<unknown> } | null;
  onFreshVenue?: (a: Asset, v: Venue) => void;
  now: () => number;
  log: Log;
}

/** One pass. Each step fails on its own: a dead RPC must not stop the issuer refresh, or the reverse. */
export async function tick(t: TickDeps): Promise<void> {
  const s = t.state;
  if (s.cohort.length === 0 || t.now() - s.cohortAsOfMs >= t.cohortRefreshMs) {
    try {
      const cohort = await t.readCohort();
      if (cohort.length === 0 && s.cohort.length > 0) throw new Error("MarketClock returned an empty cohort; keeping the previous one");
      s.cohort = cohort;
      s.cohortAsOfMs = t.now();
      s.cohortError = null;
    } catch (e) {
      s.cohortError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      t.log("cohort-error", { error: s.cohortError });
    }
  }
  await t.venues.refresh(s.cohort, t.client, t.now, t.onFreshVenue, (a, error) => {
    const st = t.venues.status(a.wrapper, t.now());
    t.log("venue-error", { symbol: a.symbol, error, lastGoodAgeS: st.ageMs === null ? null : Math.round(st.ageMs / 1000) });
  });
  t.client.takeLog();
  if (t.scorecard) {
    // A failed read keeps the previous snapshot (and its age decides stale vs refused), so one dead RPC
    // round costs nothing but a log line.
    try { await t.scorecard.refresh(); } catch (e) {
      t.log("scorecard-error", { error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    }
  }
  // Fired, not awaited: ensureReady is single-flight and bounded by the /supported deadline, and a Broker that
  // takes its time must not hold up the timeline warm below, or `ticks`, which /healthz reads.
  void t.payments.ensureReady();
  // Warm every timeline here, so the ~75 ms build happens on the tick and never inside a request.
  for (const a of s.cohort) {
    const st = t.venues.status(a.wrapper, t.now());
    if (!st.venue || st.outage) continue;
    try { t.timelines.get(a.wrapper, st.venue, t.now()); } catch (e) {
      t.log("timeline-error", { symbol: a.symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---------------------------------------------------------------------------------------------

export function startHttp(handler: ReturnType<typeof createApp>, port: number, log: Log): Server {
  const server = createServer(handler);
  // A dropped client must never take the service down with it; a port clash must fail loudly.
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("error", (e: NodeJS.ErrnoException) => {
    log("http-error", { error: `${e.code ?? e.name}: ${e.message}` });
    if (e.code === "EADDRINUSE" || e.code === "EACCES") process.exit(1);
  });
  server.listen(port, () => log("http", { port }));
  return server;
}

/**
 * On SIGTERM (a deploy, a restart), stop taking connections and give paid requests already in flight up to
 * DRAIN_MS to finish, so a deploy does not cut a buyer off between settle and delivery. Anything still in
 * flight after that is in the ledger's pending/ and is reconciled by the next process. Railway's
 * drainingSeconds must exceed DRAIN_MS for the wait to be honoured. As PID 1 in the container, Node would
 * otherwise ignore SIGTERM altogether and be SIGKILLed mid-request.
 */
const DRAIN_MS = 45_000;

function drainOnSignal(server: Server, ledger: AuthorizationLedger, log: Log): void {
  let draining = false;
  const drain = async (signal: string) => {
    if (draining) return;
    draining = true;
    log("shutdown", { signal, inFlight: ledger.inFlightCount, unconfirmed: ledger.pendingCount });
    server.close();
    server.closeIdleConnections();
    const until = Date.now() + DRAIN_MS;
    while (ledger.inFlightCount > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    log("shutdown-drained", { inFlight: ledger.inFlightCount, unconfirmed: ledger.pendingCount });
    process.exit(0);
  };
  process.once("SIGTERM", () => void drain("SIGTERM"));
  process.once("SIGINT", () => void drain("SIGINT"));
}

async function main() {
  const { cfg, errors, paymentIssues } = loadConfig();
  const log = makeLog(cfg.hostId);
  if (errors.length) throw new Error(`invalid configuration: ${errors.join("; ")}`);
  for (const issue of paymentIssues) log("payments-not-configured", { issue });
  mkdirSync(join(cfg.dataDir, "receipts"), { recursive: true });
  mkdirSync(join(cfg.dataDir, "issuer"), { recursive: true });
  mkdirSync(join(cfg.dataDir, "index"), { recursive: true });
  mkdirSync(join(cfg.dataDir, "ledger"), { recursive: true });

  const now = Date.now;
  const state: AppState = { bootMs: now(), ticks: 0, lastTickOkMs: 0, cohort: [], cohortAsOfMs: 0, cohortError: null };
  const venues = new VenueStore({
    refreshMs: cfg.venueRefreshMs,
    staleAfterMs: cfg.venueRefreshMs + cfg.tickMs,
    outageMs: cfg.issuerOutageMs,
  });
  const timelines = new TimelineCache();
  const scorecard = cfg.scorecard !== ZERO ? new ScorecardIndex({ scorecard: cfg.scorecard, chain: rpcChain(cfg.rpcs), now }) : null;
  const closures = new ClosureIndex({
    path: join(cfg.dataDir, "index", "regime-changes.json"), clock: cfg.clock, rpcs: cfg.rpcs,
    startBlock: cfg.regimeIndexFromBlock, concurrency: cfg.regimeIndexConcurrency, now, log,
  });
  closures.load();
  const handlers = new Map<string, PricedHandler>([
    ["GET /v1/closure-calendar", calendarHandler({ cohort: () => state.cohort, venues, timelines })],
  ]);
  // Without a Scorecard there is no record to sell: the two routes stay listed, and answer 503
  // not-yet-available before any challenge, exactly like a route with no handler.
  if (scorecard) {
    const deps = { cohort: () => state.cohort, scorecard, closures, chainId: cfg.chainId };
    handlers.set("GET /v1/accuracy-record", recordHandler(deps));
    handlers.set("GET /v1/discount-curve", curveHandler(deps));
  }
  const payments = new Payments({
    network: cfg.network, payTo: cfg.payTo, okx: cfg.okx, syncSettle: cfg.syncSettle,
    publicUrl: cfg.publicUrl, handlers, now, log, brokerDeadlines: { settleMs: cfg.okxSettleTimeoutMs },
    confirmSettlementTx: cfg.payTo ? makeChainConfirm((m, p) => rpcAny(cfg.rpcs, m, p), USDT0.address, cfg.payTo) : undefined,
  });
  // The payment ledger, and what a previous process left mid-settle. Chain reads get a shorter per-endpoint
  // timeout than the tick's: a paid request may be waiting on them.
  const ledger = new AuthorizationLedger({ dir: join(cfg.dataDir, "ledger"), receiptsDir: join(cfg.dataDir, "receipts"), now, log });
  ledger.load();
  const authChain = cfg.payTo ? rpcAuthorizationChain((m, p) => rpcAny(cfg.rpcs, m, p, 4_000), USDT0.address, cfg.payTo) : null;
  const server = startHttp(createApp({
    state, venues, payments, handlers, dataDir: cfg.dataDir, publicUrl: cfg.publicUrl, tickMs: cfg.tickMs,
    contracts: { chainId: cfg.chainId, clock: cfg.clock, scorecard: cfg.scorecard }, now, log,
    scorecard, closures, ledger, authChain,
  }), cfg.port, log);
  log("boot", {
    clock: cfg.clock, scorecard: cfg.scorecard, network: cfg.network, publicUrl: cfg.publicUrl,
    paymentsConfigured: payments.configured, payTo: cfg.payTo, syncSettle: cfg.syncSettle,
    regimeIndex: closures.status(),
  });
  // Detached on purpose: the backfill takes the better part of an hour on a fresh volume, and nothing may wait on it.
  void closures.run();
  if (authChain) void ledger.run(authChain);
  drainOnSignal(server, ledger, log);

  const client = new XStocksClient();
  // Every issuer body a calendar can cite is kept, write-once, under its own hash: the issuer API is not
  // historical, so this is the only place a buyer can later fetch the bytes their answer came from.
  const onFreshVenue = (_a: Asset, v: Venue) => {
    try {
      persistOnce(join(cfg.dataDir, "issuer", `${v.assetBodyHash.toLowerCase()}.json`), v.assetBody);
      persistOnce(join(cfg.dataDir, "issuer", `${v.exchangeBodyHash.toLowerCase()}.json`), v.exchangeBody);
    } catch (e) { log("evidence-write-failed", { error: String(e) }); }
  };
  const deps: TickDeps = {
    state, venues, timelines, payments, client, now, log, onFreshVenue,
    readCohort: () => readCohort({ rpcs: cfg.rpcs, clock: cfg.clock, scorecard: cfg.scorecard }),
    cohortRefreshMs: cfg.cohortRefreshMs,
    scorecard,
  };

  for (;;) {
    const started = now();
    try {
      await tick(deps);
      state.ticks++;
      state.lastTickOkMs = now();
    } catch (e) {
      log("tick-error", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
    const wait = cfg.tickMs - (now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

if (import.meta.main) {
  main().catch(async (e) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), host: "asp", event: "fatal", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
    // Sleep before exiting so a restart loop cannot hammer the RPCs, the issuer or the Broker.
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(1);
  });
}
