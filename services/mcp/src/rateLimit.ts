/**
 * Per-client limits. Every tool is free, and each one costs upstream reads (an RPC head and an aggregate3
 * call, or the issuer and the asp), so a single client must not be able to spend the service's share of
 * those public endpoints for everyone else.
 *
 * A token bucket per client IP: `burst` requests at once, refilled at `perMinute`. Memory is bounded: at most
 * `maxClients` buckets are kept, and the least recently seen is dropped first (a Map keeps insertion order,
 * and a bucket is re-inserted when used). A dropped client simply starts again with a full bucket.
 *
 * The client IP. Behind Railway's edge the socket peer is the proxy, so the address comes from
 * X-Forwarded-For: the entry `trustProxyHops` from the right, which is the one the trusted proxy appended and
 * the only one a client cannot forge. With trustProxyHops = 0 (a local run) the socket address is used and
 * the header is ignored, since anyone could send it.
 */
import type { IncomingMessage } from "node:http";

export interface RateLimitOptions {
  burst: number;
  perMinute: number;
  maxClients?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  atMs: number;
}

export class RateLimiter {
  readonly burst: number;
  readonly perMinute: number;
  private readonly maxClients: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(o: RateLimitOptions) {
    this.burst = o.burst;
    this.perMinute = o.perMinute;
    this.maxClients = o.maxClients ?? 50_000;
    this.now = o.now ?? Date.now;
  }

  /** Take one token for `key`. On refusal, `retryAfterS` is how long until one is available. */
  take(key: string): { ok: true; remaining: number } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const prev = this.buckets.get(key);
    let b: Bucket;
    if (prev) {
      const refill = ((t - prev.atMs) / 60_000) * this.perMinute;
      b = { tokens: Math.min(this.burst, prev.tokens + Math.max(0, refill)), atMs: t };
      this.buckets.delete(key);
    } else {
      b = { tokens: this.burst, atMs: t };
    }
    let out: { ok: true; remaining: number } | { ok: false; retryAfterS: number };
    if (b.tokens >= 1) {
      b.tokens -= 1;
      out = { ok: true, remaining: Math.floor(b.tokens) };
    } else {
      out = { ok: false, retryAfterS: Math.max(1, Math.ceil(((1 - b.tokens) / this.perMinute) * 60)) };
    }
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxClients) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return out;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** The client address to rate-limit on. See the header comment for why the rightmost trusted hop. */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const raw = req.headers["x-forwarded-for"];
    const list = (Array.isArray(raw) ? raw.join(",") : raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length >= trustProxyHops) return list[list.length - trustProxyHops].slice(0, 64);
  }
  return (req.socket?.remoteAddress ?? "unknown").slice(0, 64);
}
