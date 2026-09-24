/**
 * Fetching mark/2's cross-market evidence at commit time, keeping the exact bytes.
 *
 * Never throws and never blocks the commit for long: every request has its own timeout, and a leg that
 * cannot be fetched is simply absent -- mark.ts then falls back to the no-signal path and flags it. Every
 * attempt, including failures, is returned for the round's FETCH_LOG leaf, so a gap is visible in the
 * published bundle rather than silent.
 *
 * Binance geo-blocks US addresses (HTTP 451) and the keeper runs in the US, so the perp klines come
 * through curb-asp's byte-exact relay (`GET /v1/relay/binance/klines`, run from Singapore). The relay adds
 * `x-curb-upstream-url` and `x-curb-upstream-sha256`; both are checked here against the canonical URL and
 * the bytes actually received, and the bundle commits the UPSTREAM url, not the relay's. A third party
 * verifies by fetching that url from anywhere Binance serves and comparing hashes: a closed minute's
 * bytes do not change. A direct fetch is the fallback, for hosts Binance does serve.
 *
 * Yahoo is not geo-blocked and is fetched directly. It needs a User-Agent (429 without one) and no cookie
 * or crumb. Its bytes are NOT stable across requests (the same URL hashed differently twice in testing),
 * so the ADR leg is verifiable against the committed bytes, not by refetching; PARAMS says so.
 */
import { sha256 } from "ethers";
import { hashBytes } from "../tree.ts";
import {
  binanceKlinesUrl, yahooChartUrl, cutMinuteMs, commitMinuteMs, closureSOf, deriveSignal, evidenceBytes, proxyFor, wantsAdr,
} from "./signal.ts";
import type { SignalContext, SignalKey } from "./signal.ts";
import type { SignalInput } from "../mark.ts";

const USER_AGENT = "Mozilla/5.0 (compatible; curb-keeper/1.0; +https://curb.markets)";
export const DEFAULT_RELAY_BASE = "https://api.curb.markets";
export const RELAY_PATH = "/v1/relay/binance/klines";
const YAHOO_FALLBACK_HOST = "https://query2.finance.yahoo.com";

export interface SignalFetchConfig {
  /** False (SIGNAL=off) fetches nothing: every mark/2 row takes the no-signal path. */
  enabled: boolean;
  /** Base URL of the curb-asp relay; empty skips it. */
  relayBase: string;
  /** Try fapi.binance.com directly when the relay fails (useless from a US host, harmless). */
  binanceDirect: boolean;
  /** Per-request timeout. A leg costs at most two requests (relay, then direct). */
  perFetchMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** One successful response, exactly as committed: `body` is the UTF-8 text of the exact bytes. */
export interface SignalExchange {
  key: SignalKey;
  /** The canonical upstream URL the bytes are from. */
  url: string;
  /** Where they were actually fetched: the relay URL, or the upstream itself. */
  via: string;
  status: number;
  fetchedAtMs: number;
  bytes: number;
  /** keccak256 of the bytes, 0x-prefixed. */
  bodyHash: string;
  /** sha256 of the bytes, lower-case hex without 0x (what `shasum -a 256` prints). */
  sha256: string;
  /** Reproducible by refetching the url? True for closed Binance minutes, false for Yahoo. */
  reproducible: boolean;
  body: string;
}

export interface SignalAttempt {
  key: SignalKey | "*";
  url: string;
  via: string;
  status: number;
  ok: boolean;
  reqStartMs: number;
  respEndMs: number;
  bodyHash: string | null;
  error: string | null;
}

export interface GatheredSignal {
  exchanges: SignalExchange[];
  attempts: SignalAttempt[];
  input: SignalInput;
}

export const sha256Hex = (b: Uint8Array): string => sha256(b).slice(2).toLowerCase();

/** Exact bytes to text, refusing anything that would not survive the round trip. */
function utf8Exact(b: Uint8Array): string | null {
  try {
    const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
    const back = new TextEncoder().encode(s);
    if (back.length !== b.length) return null;
    for (let i = 0; i < b.length; i++) if (back[i] !== b[i]) return null;
    return s;
  } catch { return null; }
}

interface Got { status: number; bytes: Uint8Array | null; headers: Headers | null; error: string | null; reqStartMs: number; respEndMs: number }

async function get(url: string, cfg: SignalFetchConfig, headers: Record<string, string>): Promise<Got> {
  const now = cfg.now ?? Date.now;
  const f = cfg.fetchImpl ?? fetch;
  const reqStartMs = now();
  try {
    const res = await f(url, {
      headers: { "user-agent": USER_AGENT, "accept-encoding": "identity", ...headers },
      signal: AbortSignal.timeout(cfg.perFetchMs),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes, headers: res.headers, error: res.ok ? null : `http ${res.status}`, reqStartMs, respEndMs: now() };
  } catch (e) {
    return {
      status: 0, bytes: null, headers: null, reqStartMs, respEndMs: now(),
      error: (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200),
    };
  }
}

async function fetchKline(
  key: SignalKey, symbol: string, minuteMs: number, cfg: SignalFetchConfig, attempts: SignalAttempt[],
): Promise<SignalExchange | null> {
  const url = binanceKlinesUrl(symbol, minuteMs);
  const routes: string[] = [];
  if (cfg.relayBase) routes.push(`${cfg.relayBase.replace(/\/+$/, "")}${RELAY_PATH}?symbol=${symbol}&startTime=${minuteMs}&limit=1`);
  if (cfg.binanceDirect) routes.push(url);
  for (const via of routes) {
    const g = await get(via, cfg, { accept: "application/json" });
    let error = g.error;
    let ex: SignalExchange | null = null;
    if (!error && g.bytes) {
      const body = utf8Exact(g.bytes);
      const sha = sha256Hex(g.bytes);
      if (body === null) error = "body is not exact UTF-8";
      else if (via !== url && g.headers?.get("x-curb-upstream-url") !== url) error = `relay upstream url ${g.headers?.get("x-curb-upstream-url")} is not ${url}`;
      else if (via !== url && (g.headers?.get("x-curb-upstream-sha256") ?? "").toLowerCase() !== sha) error = "relay sha256 header does not match the bytes received";
      else ex = { key, url, via, status: g.status, fetchedAtMs: g.respEndMs, bytes: g.bytes.length, bodyHash: hashBytes(g.bytes), sha256: sha, reproducible: true, body };
    }
    attempts.push({ key, url, via, status: g.status, ok: ex !== null, reqStartMs: g.reqStartMs, respEndMs: g.respEndMs, bodyHash: g.bytes ? hashBytes(g.bytes) : null, error });
    if (ex) return ex;
  }
  if (routes.length === 0) attempts.push({ key, url, via: "", status: 0, ok: false, reqStartMs: 0, respEndMs: 0, bodyHash: null, error: "no route: relay and direct fetch both disabled" });
  return null;
}

async function fetchChart(key: SignalKey, ticker: string, cfg: SignalFetchConfig, attempts: SignalAttempt[]): Promise<SignalExchange | null> {
  const url = yahooChartUrl(ticker);
  for (const via of [url, url.replace("https://query1.finance.yahoo.com", YAHOO_FALLBACK_HOST)]) {
    const g = await get(via, cfg, { accept: "application/json" });
    let error = g.error;
    let ex: SignalExchange | null = null;
    if (!error && g.bytes) {
      const body = utf8Exact(g.bytes);
      if (body === null) error = "body is not exact UTF-8";
      else ex = { key, url, via, status: g.status, fetchedAtMs: g.respEndMs, bytes: g.bytes.length, bodyHash: hashBytes(g.bytes), sha256: sha256Hex(g.bytes), reproducible: false, body };
    }
    attempts.push({ key, url, via, status: g.status, ok: ex !== null, reqStartMs: g.reqStartMs, respEndMs: g.respEndMs, bodyHash: g.bytes ? hashBytes(g.bytes) : null, error });
    if (ex) return ex;
  }
  return null;
}

/**
 * Fetch everything this closure's signal needs, in parallel, and derive the signal from the bytes with
 * the same pure function a verifier will use. Never throws.
 */
export async function gatherSignal(ctx: SignalContext, minSignalClosureS: number, cfg: SignalFetchConfig): Promise<GatheredSignal> {
  const attempts: SignalAttempt[] = [];
  const exchanges: SignalExchange[] = [];
  try {
    const p = proxyFor(ctx.symbol);
    if (p && !cfg.enabled) {
      attempts.push({ key: "*", url: "", via: "", status: 0, ok: false, reqStartMs: 0, respEndMs: 0, bodyHash: null, error: "signal fetching disabled (SIGNAL=off)" });
    } else if (p) {
      const jobs: Array<Promise<SignalExchange | null>> = [
        fetchKline("perp:cut", p.perp, cutMinuteMs(ctx.cutAtMs), cfg, attempts),
        fetchKline("perp:commit", p.perp, commitMinuteMs(ctx.commitAtMs), cfg, attempts),
      ];
      if (wantsAdr(closureSOf(ctx), minSignalClosureS)) {
        jobs.push(fetchChart("yahoo:adr", p.adr, cfg, attempts));
        jobs.push(fetchChart("yahoo:primary", p.primary, cfg, attempts));
        jobs.push(fetchChart("yahoo:fx", p.fx, cfg, attempts));
      }
      for (const ex of await Promise.all(jobs)) if (ex) exchanges.push(ex);
    }
  } catch (e) {
    attempts.push({ key: "*", url: "", via: "", status: 0, ok: false, reqStartMs: 0, respEndMs: 0, bodyHash: null, error: `gather threw: ${String(e).slice(0, 200)}` });
  }
  exchanges.sort((a, b) => a.key.localeCompare(b.key));
  attempts.sort((a, b) => a.key.localeCompare(b.key) || a.reqStartMs - b.reqStartMs);
  return { exchanges, attempts, input: deriveSignal(ctx, evidenceBytes(exchanges), minSignalClosureS) };
}
