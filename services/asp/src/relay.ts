/**
 * A read-only relay for Binance USDⓈ-M perpetual 1-minute klines that serves the upstream bytes verbatim.
 *
 * Why it exists: the keeper runs on a US VPS and reads Binance's perpetual klines for the HK names as a
 * price signal, but Binance answers US IPs with HTTP 451. This service runs in Singapore, so it fetches for
 * the keeper. The keeper hashes what it receives into a published evidence bundle, and a third party checks
 * that evidence by fetching the SAME canonical URL (the x-curb-upstream-url header, which binanceKlinesUrl
 * builds) from Binance directly and comparing sha256. So the relay never parses and re-serialises: the body is
 * the upstream body byte for byte, and x-curb-upstream-sha256 is the plain lowercase hex sha256 of it (what
 * `sha256sum` prints).
 *
 * Byte stability only holds for closed minutes, so only closed minutes are relayed, and only a complete answer
 * is cached (for the life of the process; a closed kline does not change). A complete answer has exactly
 * `limit` rows, one per requested minute, each closed at least CACHE_AFTER_CLOSE_MS ago. The margin covers a
 * kline read at the instant it closes, before its last trades have been counted. Anything else (a short or
 * empty array, an upstream error, a timeout) is passed on or reported, and fetched again next time.
 *
 * The query is narrow on purpose: four symbols, interval 1m, limit 1 or 2, a minute-aligned startTime, no
 * other parameter. That keeps the upstream URL canonical (one request, one URL a verifier can rebuild), and
 * keeps this from being an open proxy onto Binance. A global budget of upstream fetches per rolling minute
 * (cache hits are free) keeps a flood of distinct requests from spending this IP's Binance rate limit.
 *
 * Inside that budget, each client (http/client.ts: Railway's X-Real-IP, IPv6 by /64) gets its own, smaller
 * one. Without it, one caller asking for distinct past minutes at ~5 a second spends the whole global budget,
 * and the keeper's single, unretried fetch at its commit minute gets the 503. The keeper asks for two
 * minutes per closure it marks (services/keeper/src/sources/signalFetch.ts: the cut minute and the commit
 * minute, limit=1), and only three names have a perp proxy (mark.ts SIGNAL_PROXIES), so at most six in one
 * round: a per-client budget of 30 never touches it, and draining the global 300 now takes ten separate
 * addresses rather than one. A refusal names the per-client limit and when a slot frees. Requests with no
 * client key are held by the global budget alone.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { send } from "./http/respond.ts";
import { silentLog, throttledLog } from "./log.ts";
import type { Log } from "./log.ts";

export const BINANCE_KLINES_PATH = "/v1/relay/binance/klines";
export const BINANCE_FAPI_BASE = "https://fapi.binance.com";
export const BINANCE_KLINE_SYMBOLS: readonly string[] = ["HK0700USDT", "HK1810USDT", "MEITUANUSDT", "TENCENTUSDT"];

const MINUTE_MS = 60_000;
const PARAMS: readonly string[] = ["symbol", "interval", "startTime", "limit"];
const USER_AGENT = "Mozilla/5.0 (compatible; curb-asp-relay/1.0)";
const IMMUTABLE = "public, max-age=31536000, immutable";
/** A browser verifier must be able to read the evidence headers. */
const EXPOSE = "x-curb-upstream-url, x-curb-upstream-sha256, x-curb-upstream-status, x-curb-relay-cache, retry-after";
const CACHE_AFTER_CLOSE_MS = 5_000;

/**
 * The one upstream URL for a request, byte for byte what the relay fetches. The keeper and any verifier
 * build the same string, so the URL itself is part of the evidence.
 */
export function binanceKlinesUrl(symbol: string, startTime: number, limit: number, base: string = BINANCE_FAPI_BASE): string {
  return `${base}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=${limit}`;
}

export interface BinanceRelayOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Covers the whole upstream exchange, headers and body. Default 4000 ms. */
  timeoutMs?: number;
  /** Default BINANCE_FAPI_BASE. */
  upstreamBase?: string;
  /** Cached answers kept; the oldest goes first. Default 2000. */
  maxCache?: number;
  /** Upstream fetches allowed per rolling 60 s; cache hits do not count. Default 300. */
  maxPerMinute?: number;
  /** Upstream fetches one client may cause per rolling 60 s, inside maxPerMinute; 0 turns it off. Default 30. */
  maxPerClientPerMinute?: number;
  /** A row is cacheable once its closeTime is this far in the past. Default 5000 ms. */
  cacheAfterCloseMs?: number;
  log?: Log;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export interface BinanceRelay {
  /**
   * Never rejects: every outcome, including an unexpected error, is a response. `client` is the caller's
   * key (http/client.ts); null or absent, only the global budget applies.
   */
  handle(query: URLSearchParams, client?: string | null): Promise<RelayResponse>;
}

type KlinesQuery = { ok: true; symbol: string; startTime: number; limit: number };
type Refused = { ok: false; body: Record<string, unknown> };

/** The relay's query, strictly: anything that would not map to exactly one canonical upstream URL is refused. */
export function parseKlinesQuery(q: URLSearchParams): KlinesQuery | Refused {
  const refuse = (body: Record<string, unknown>): Refused => ({ ok: false, body });
  for (const name of new Set(q.keys())) {
    if (!PARAMS.includes(name)) return refuse({ error: "unknown-parameter", parameter: name.slice(0, 64), allowed: PARAMS });
    if (q.getAll(name).length > 1) return refuse({ error: "repeated-parameter", parameter: name });
  }
  const symbol = q.get("symbol");
  if (symbol === null || !BINANCE_KLINE_SYMBOLS.includes(symbol)) {
    return refuse({ error: "symbol-not-allowed", symbol: symbol === null ? null : symbol.slice(0, 64), allowed: BINANCE_KLINE_SYMBOLS });
  }
  const interval = q.get("interval");
  if (interval !== null && interval !== "1m") return refuse({ error: "bad-interval", interval: interval.slice(0, 16), allowed: ["1m"] });
  const l = q.get("limit");
  if (l !== null && l !== "1" && l !== "2") return refuse({ error: "bad-limit", limit: l.slice(0, 16), min: 1, max: 2 });
  const s = q.get("startTime");
  const startTime = s !== null && /^(0|[1-9][0-9]{0,15})$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(startTime) || startTime % MINUTE_MS !== 0) {
    return refuse({
      error: "bad-startTime", startTime: s === null ? null : s.slice(0, 32),
      detail: "startTime is required: a non-negative integer of milliseconds (no sign, no leading zeros), a multiple of 60000",
    });
  }
  return { ok: true, symbol, startTime, limit: l === "2" ? 2 : 1 };
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);

function jsonResponse(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): RelayResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-expose-headers": EXPOSE, ...extra },
    body: JSON.stringify(body),
  };
}

/**
 * True when the body is a JSON array of exactly `limit` klines, one per requested minute in order, each
 * closed at least `afterCloseMs` before `nowMs`. Only such a body is final, and only it is cached.
 */
function isFinal(bytes: Uint8Array, startTime: number, limit: number, nowMs: number, afterCloseMs: number): boolean {
  let rows: unknown;
  try { rows = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")); } catch { return false; }
  if (!Array.isArray(rows) || rows.length !== limit) return false;
  return rows.every((r: unknown, i) =>
    Array.isArray(r) && r[0] === startTime + i * MINUTE_MS && typeof r[6] === "number" && r[6] + afterCloseMs < nowMs);
}

type Upstream = { ok: true; status: number; bytes: Uint8Array } | { ok: false; error: string };

export function createBinanceRelay(opts: BinanceRelayOptions = {}): BinanceRelay {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const base = opts.upstreamBase ?? BINANCE_FAPI_BASE;
  const maxCache = opts.maxCache ?? 2_000;
  const maxPerMinute = opts.maxPerMinute ?? 300;
  const maxPerClient = opts.maxPerClientPerMinute ?? 30;
  const afterCloseMs = opts.cacheAfterCloseMs ?? CACHE_AFTER_CLOSE_MS;
  const log = opts.log ?? silentLog;
  const noteUpstream = throttledLog(log, "relay-upstream-error", 60_000, now);
  const noteBusy = throttledLog(log, "relay-busy", 60_000, now);
  const noteClientBusy = throttledLog(log, "relay-client-busy", 60_000, now);
  const noteError = throttledLog(log, "relay-error", 60_000, now);

  const cache = new Map<string, { bytes: Uint8Array; sha256: string }>();
  const fetchedAt: number[] = [];
  /** Per client, the times of the upstream fetches it caused in the last minute, oldest first. */
  const byClient = new Map<string, number[]>();

  /** One upstream fetch from the rolling-minute budget, or false when it is spent. */
  function takeBudget(nowMs: number): boolean {
    while (fetchedAt.length > 0 && fetchedAt[0] <= nowMs - MINUTE_MS) fetchedAt.shift();
    if (fetchedAt.length >= maxPerMinute) return false;
    fetchedAt.push(nowMs);
    return true;
  }

  /** This client's fetches still inside the rolling minute (pruned in place). */
  function clientWindow(client: string, nowMs: number): number[] {
    const times = byClient.get(client) ?? [];
    while (times.length > 0 && times[0] <= nowMs - MINUTE_MS) times.shift();
    return times;
  }

  /**
   * Record a fetch this client caused. Only fetches the global budget granted are recorded, so live entries
   * never outnumber maxPerMinute; the sweep drops clients whose last fetch has aged out.
   */
  function noteClientFetch(client: string, times: number[], nowMs: number): void {
    times.push(nowMs);
    if (!byClient.has(client)) byClient.set(client, times);
    if (byClient.size > 4 * maxPerMinute) {
      for (const [k, t] of byClient) if (t.length === 0 || t[t.length - 1] <= nowMs - MINUTE_MS) byClient.delete(k);
    }
  }

  /** The raw exchange, bounded by timeoutMs even if the fetch implementation ignores its signal. */
  async function fetchUpstream(url: string): Promise<Upstream> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new DOMException(`no answer within ${timeoutMs} ms`, "TimeoutError");
        ctrl.abort(err);
        reject(err);
      }, timeoutMs);
    });
    const exchange = (async () => {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { "user-agent": USER_AGENT, "accept-encoding": "identity" },
      });
      return { ok: true as const, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    })();
    try {
      return await Promise.race([exchange, deadline]);
    } catch (e) {
      return { ok: false, error: describe(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(query: URLSearchParams, client: string | null = null): Promise<RelayResponse> {
    const r = await answer(query, client);
    // Which key the limit was applied to, so anyone can check from outside that it is their own address (a
    // refused query is a free way to see it). Never on a publicly cacheable answer: a shared cache must not
    // hand one caller's address to the next.
    if (client !== null && !/\bpublic\b/.test(r.headers["cache-control"] ?? "")) r.headers["x-curb-relay-client"] = client;
    return r;
  }

  async function answer(query: URLSearchParams, client: string | null): Promise<RelayResponse> {
    try {
      const q = parseKlinesQuery(query);
      if (!q.ok) return jsonResponse(400, q.body);
      const nowMs = now();
      const closesAtMs = q.startTime + q.limit * MINUTE_MS;
      if (closesAtMs > nowMs) {
        return jsonResponse(400, { error: "minute-not-closed", startTime: q.startTime, limit: q.limit, closesAtMs, nowMs });
      }
      const url = binanceKlinesUrl(q.symbol, q.startTime, q.limit, base);
      const evidence = (sha256: string, served: "hit" | "miss", cacheable: boolean) => ({
        "content-type": "application/json",
        "cache-control": cacheable ? IMMUTABLE : "no-store",
        "access-control-expose-headers": EXPOSE,
        "x-curb-upstream-url": url,
        "x-curb-upstream-sha256": sha256,
        "x-curb-upstream-status": "200",
        "x-curb-relay-cache": served,
      });

      const hit = cache.get(url);
      if (hit) return { status: 200, headers: evidence(hit.sha256, "hit", true), body: hit.bytes };

      // The client's own budget first, so a client over it never spends a global slot.
      const mine = client !== null && maxPerClient > 0 ? clientWindow(client, nowMs) : null;
      if (mine && mine.length >= maxPerClient) {
        const retryAfterS = Math.max(1, Math.ceil((mine[0] + MINUTE_MS - nowMs) / 1000));
        noteClientBusy({ client, maxPerClientPerMinute: maxPerClient });
        return jsonResponse(503, { error: "relay-client-busy", maxPerClientPerMinute: maxPerClient, retryAfterS },
          { "retry-after": String(retryAfterS) });
      }
      if (!takeBudget(nowMs)) {
        noteBusy({ maxPerMinute });
        return jsonResponse(503, { error: "relay-busy", maxPerMinute }, { "retry-after": "5" });
      }
      if (mine) noteClientFetch(client!, mine, nowMs);
      const up = await fetchUpstream(url);
      if (!up.ok) {
        noteUpstream({ upstreamUrl: url, upstreamStatus: 0, reason: up.error });
        return jsonResponse(502, { error: "upstream", upstreamStatus: 0, reason: up.error, upstreamUrl: url },
          { "x-curb-upstream-url": url, "x-curb-upstream-status": "0" });
      }
      if (up.status !== 200) {
        const reason = Buffer.from(up.bytes.buffer, up.bytes.byteOffset, up.bytes.byteLength).toString("utf8").slice(0, 200);
        noteUpstream({ upstreamUrl: url, upstreamStatus: up.status, reason });
        return jsonResponse(502, { error: "upstream", upstreamStatus: up.status, reason, upstreamUrl: url },
          { "x-curb-upstream-url": url, "x-curb-upstream-status": String(up.status) });
      }

      const entry = { bytes: up.bytes, sha256: sha256Hex(up.bytes) };
      const cacheable = isFinal(up.bytes, q.startTime, q.limit, now(), afterCloseMs);
      if (cacheable) {
        cache.set(url, entry);
        while (cache.size > maxCache) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return { status: 200, headers: evidence(entry.sha256, "miss", cacheable), body: entry.bytes };
    } catch (e) {
      try { noteError({ error: describe(e) }); } catch { /* logging must not turn a 502 into a throw */ }
      return jsonResponse(502, { error: "relay-error", reason: describe(e) });
    }
  }

  return { handle };
}

/** app.ts's dispatch: the relay's answer onto the socket, through the same `send` as every other route. */
export async function serveRelay(res: ServerResponse, relay: BinanceRelay, query: URLSearchParams, client: string | null = null): Promise<void> {
  const r = await relay.handle(query, client);
  send(res, r.status, r.body, r.headers);
}
