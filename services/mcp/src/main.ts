/**
 * curb-mcp: a Model Context Protocol server, so any AI agent can ask Curb whether a tokenized stock's home
 * market is open before it trades, lends or liquidates.
 *
 * Six read-only, free tools (tools.ts) over MCP Streamable HTTP in stateless mode (app.ts): MarketClock's live
 * regime, the expected reopen, Scorecard's graded record, CurbCredit's LTV and bonded depth, the issuer's
 * corporate actions, and how to pay curb-asp's three x402 routes. It holds no key, sends no transaction and
 * pays for nothing; it needs no secret to run. Its only state is in memory: short answer caches, the issuer
 * bytes per asset, and the rate-limit buckets. A restart loses nothing.
 *
 * It is deliberately a separate service from curb-asp: an MCP bug or a flood of free calls must never be able
 * to restart the paid API, its payment ledger or the attestor. Deploy it on its own (see the README).
 *
 * Configuration is collected, never thrown from at import time, so tests can import this file.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createApp } from "./app.ts";
import type { AppState } from "./app.ts";
import { makeCaches } from "./tools.ts";
import { TimelineCache } from "./closureCalendar.ts";
import { IssuerCache } from "./issuer.ts";
import { RateLimiter } from "./rateLimit.ts";
import { DEFAULT_RPCS, rpcChain } from "./sources/chain.ts";
import { makeLog } from "./log.ts";
import type { Log } from "./log.ts";

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const get = (k: string, d = "") => (env[k] ?? d).trim();
  const errors: string[] = [];
  const num = (name: string, v: string, min: number, max: number) => {
    const n = Number(v);
    if (v === "" || !Number.isInteger(n) || n < min || n > max) { errors.push(`${name} must be an integer in [${min},${max}], got ${JSON.stringify(v)}`); return min; }
    return n;
  };
  const publicUrl = get("PUBLIC_URL", "https://mcp.curb.markets").replace(/\/+$/, "");
  try {
    const u = new URL(publicUrl);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") errors.push(`PUBLIC_URL must be https: ${JSON.stringify(publicUrl)}`);
  } catch { errors.push(`PUBLIC_URL is not a URL: ${JSON.stringify(publicUrl)}`); }
  const rpcs = get("RPCS", DEFAULT_RPCS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of rpcs) {
    try { if (new URL(r).protocol !== "https:") errors.push("every RPCS entry must be https"); } catch { errors.push("RPCS holds an entry that is not a URL"); }
  }
  if (rpcs.length === 0) errors.push("RPCS is empty");
  const cfg = {
    port: num("PORT", get("PORT", "8080"), 1, 65535),
    publicUrl,
    rpcs,
    hostId: get("HOST_ID", "mcp"),
    /** 1 behind Railway's edge (X-Forwarded-For's last entry is the client); 0 when nothing trusted sits in front. */
    trustProxyHops: num("TRUST_PROXY_HOPS", get("TRUST_PROXY_HOPS", "0"), 0, 4),
    rateBurst: num("RATE_BURST", get("RATE_BURST", "60"), 1, 10_000),
    ratePerMinute: num("RATE_PER_MIN", get("RATE_PER_MIN", "120"), 1, 100_000),
    toolTimeoutMs: num("TOOL_TIMEOUT_MS", get("TOOL_TIMEOUT_MS", "20000"), 2_000, 60_000),
  };
  return { cfg, errors };
}

export type Config = ReturnType<typeof loadConfig>["cfg"];

/**
 * Node's own limits on a slow client: the whole request (headers and body) within 10 s, an idle socket closed
 * after 30 s. A tool call is bounded separately by TOOL_TIMEOUT_MS (tools.ts), well inside the socket limit.
 */
export function startHttp(handler: ReturnType<typeof createApp>, port: number, log: Log, host?: string): Server {
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, handler);
  server.setTimeout(30_000, (socket) => socket.destroy());
  // A dropped client must never take the service down with it; a port clash must fail loudly.
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("error", (e: NodeJS.ErrnoException) => {
    log("http-error", { error: `${e.code ?? e.name}: ${e.message}` });
    if (e.code === "EADDRINUSE" || e.code === "EACCES") process.exit(1);
  });
  server.listen(port, host, () => log("http", { port }));
  return server;
}

export function buildApp(cfg: Config, log: Log, now: () => number = Date.now) {
  const chain = rpcChain(cfg.rpcs, now);
  const tools = {
    chain, issuer: new IssuerCache(fetch, now, (ticker, error) => log("issuer-error", { ticker, error })), timelines: new TimelineCache(), fetchJson: fetch, commitTxs: new Map<string, string>(),
    now, log, toolTimeoutMs: cfg.toolTimeoutMs,
  };
  const state: AppState = { bootMs: now(), requests: 0, mcpRequests: 0, rateLimited: 0 };
  const handler = createApp({
    tools, caches: makeCaches(now), limiter: new RateLimiter({ burst: cfg.rateBurst, perMinute: cfg.ratePerMinute, now }),
    trustProxyHops: cfg.trustProxyHops, publicUrl: cfg.publicUrl, state, now, log,
    lastHead: () => {
      const b = chain.last?.();
      return b ? { block: b.number, timestamp: b.timestamp } : null;
    },
  });
  return { handler, state };
}

function main() {
  const { cfg, errors } = loadConfig();
  const log = makeLog(cfg.hostId);
  if (errors.length) throw new Error(`invalid configuration: ${errors.join("; ")}`);
  const { handler } = buildApp(cfg, log);
  const server = startHttp(handler, cfg.port, log);
  log("boot", { publicUrl: cfg.publicUrl, rpcs: cfg.rpcs.map((u) => new URL(u).origin), trustProxyHops: cfg.trustProxyHops, rateBurst: cfg.rateBurst, ratePerMinute: cfg.ratePerMinute });
  // Nothing in flight is worth waiting long for: every request is a free read, and a client retries.
  const stop = (signal: string) => {
    log("shutdown", { signal });
    server.close();
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

if (import.meta.main) {
  try { main(); } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), host: "mcp", event: "fatal", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
    // Sleep before exiting so a restart loop cannot hammer anything.
    setTimeout(() => process.exit(1), 60_000);
  }
}
