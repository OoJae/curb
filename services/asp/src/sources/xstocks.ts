/**
 * COPIED from services/keeper/src/sources/xstocks.ts. Each service is built standalone from its own directory,
 * so shared pure code is copied rather than imported across packages; keep the copies in step.
 *
 * xStocks issuer API client that keeps the exact bytes.
 *
 * Every round commits to the keccak256 of each HTTP body, so the body must be captured exactly as
 * received: no JSON round-trip, no re-serialisation, no decompression differences. We ask for
 * `Accept-Encoding: identity` and hash the raw ArrayBuffer.
 *
 * The API sits behind Cloudflare with `s-maxage=30, stale-while-revalidate=60`, so two fetches a
 * few seconds apart can legitimately return different bytes. That is why each round records the
 * response headers (date, age, etag, cf-cache-status, rate-limit state) alongside the body, and why
 * the fetch log records every attempt, including failures.
 */
import { hashBytes } from "../hash.ts";

export const API_BASE = "https://api.xstocks.fi/api/v2/public";

// Python's urllib default UA is rejected with 403 by the issuer's Cloudflare zone. Node's default
// is accepted, but an explicit, honest UA makes our traffic identifiable to the issuer.
const USER_AGENT = "Mozilla/5.0 (compatible; curb-asp/1.0; +https://github.com/curb)";

const KEPT_HEADERS = [
  "date", "age", "etag", "cache-control", "cf-ray", "cf-cache-status",
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "content-type",
];

export interface Exchange {
  url: string;
  status: number;
  ok: boolean;
  body: Uint8Array | null;
  bodyHash: string | null;
  bytes: number;
  reqStartMs: number;
  respEndMs: number;
  headers: Record<string, string>;
  error: string | null;
}

export interface FetchLogEntry {
  seq: number;
  url: string;
  status: number;
  ok: boolean;
  bodyHash: string | null;
  reqStartMs: number;
  respEndMs: number;
  error: string | null;
}

export class XStocksClient {
  private seq = 0;
  readonly log: FetchLogEntry[] = [];
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  // Explicit fields rather than constructor parameter properties: Node's type stripping only
  // accepts erasable TypeScript syntax.
  constructor(base: string = API_BASE, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  assetUrl(symbol: string): string {
    return `${this.base}/assets/${encodeURIComponent(symbol)}?network=XLayer`;
  }

  exchangeUrl(mic: string): string {
    return `${this.base}/exchanges/${encodeURIComponent(mic)}`;
  }

  async get(url: string, timeoutMs = 3000): Promise<Exchange> {
    const reqStartMs = this.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let ex: Exchange;
    try {
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { "user-agent": USER_AGENT, "accept": "application/json", "accept-encoding": "identity" },
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      for (const h of KEPT_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) headers[h] = v;
      }
      ex = {
        url, status: res.status, ok: res.ok,
        body: res.ok ? buf : null,
        bodyHash: res.ok ? hashBytes(buf) : null,
        bytes: buf.byteLength,
        reqStartMs, respEndMs: this.now(), headers,
        error: res.ok ? null : `http ${res.status}`,
      };
    } catch (e) {
      ex = {
        url, status: 0, ok: false, body: null, bodyHash: null, bytes: 0,
        reqStartMs, respEndMs: this.now(), headers: {},
        error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200),
      };
    } finally {
      clearTimeout(timer);
    }
    this.log.push({
      seq: ++this.seq, url: ex.url, status: ex.status, ok: ex.ok, bodyHash: ex.bodyHash,
      reqStartMs: ex.reqStartMs, respEndMs: ex.respEndMs, error: ex.error,
    });
    return ex;
  }

  /** One retry with a short jittered backoff; the round builder decides what a failure means. */
  async getWithRetry(url: string, timeoutMs = 3000): Promise<Exchange> {
    const first = await this.get(url, timeoutMs);
    if (first.ok || (first.status >= 400 && first.status < 500 && first.status !== 429)) return first;
    await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
    return this.get(url, timeoutMs);
  }

  /** Drain the fetch log for a round's FETCH_LOG leaf. */
  takeLog(): FetchLogEntry[] {
    return this.log.splice(0, this.log.length);
  }
}
