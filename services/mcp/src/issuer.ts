/**
 * The issuer's two inputs to every reopen time: the asset's per-period caps and the venue's published
 * schedule, from the xStocks public API (no key). `readVenue` follows services/asp/src/venue.ts, with the
 * exact bodies hashed (keccak256) so an answer can name the bytes it was computed from, and those hashes are
 * directly comparable with the ones the paid calendar and the keeper's mark bundles publish.
 *
 * `IssuerCache` keeps one read per asset. The issuer's caps and schedules change on the order of days and
 * it sits behind Cloudflare with a 30 s edge TTL, so REFRESH_MS matches the asp's 600 s. A failed refresh
 * serves the last good bytes until OUTAGE_MS (the asp's 30 min) and says how old they are; after that the
 * tool answers without a schedule rather than from a guess. Reads are single-flight per asset, so a burst of
 * calls costs the issuer two requests, not two per call, and after a failure the issuer is not asked again for
 * RETRY_AFTER_FAIL_MS, so an outage costs it one attempt per asset every 30 s whatever the call rate.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import type { ExchangeSchedule, Period, TradingObject } from "./regime.ts";
import type { PeriodLimits } from "./reopen.ts";

export const API_BASE = "https://api.xstocks.fi/api/v2/public";
const USER_AGENT = "Mozilla/5.0 (compatible; curb-mcp/1.0; +https://curb.markets)";
/** The asp's figure: on 24 Sep 2026 the issuer was taking ~4 s per response. */
export const ISSUER_TIMEOUT_MS = 8_000;
export const REFRESH_MS = 600_000;
export const OUTAGE_MS = 1_800_000;

export interface Venue {
  mic: string;
  limits: PeriodLimits;
  sched: ExchangeSchedule;
  atMs: number;
  reportedPeriod: Period | null;
  halted: boolean;
  assetUrl: string;
  assetBodyHash: string;
  exchangeUrl: string;
  exchangeBodyHash: string;
  /** What the timeline is computed FROM: the limits and the schedule, not the per-boundary fields around them. */
  inputsKey: string;
}

export type VenueRead = { ok: true; venue: Venue } | { ok: false; error: string };

export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

async function getBytes(fetchImpl: Fetch, url: string): Promise<{ ok: true; body: Uint8Array } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ISSUER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/json", "accept-encoding": "identity" },
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    return { ok: true, body: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export async function readVenue(fetchImpl: Fetch, ticker: string, now: () => number = Date.now): Promise<VenueRead> {
  const assetUrl = `${API_BASE}/assets/${encodeURIComponent(ticker)}?network=XLayer`;
  const a = await getBytes(fetchImpl, assetUrl);
  if (!a.ok) return { ok: false, error: `asset ${ticker}: ${a.error}` };
  let asset: { trading?: TradingObject; isTradingHalted?: boolean };
  try { asset = JSON.parse(new TextDecoder().decode(a.body)); } catch { return { ok: false, error: `asset ${ticker}: body is not JSON` }; }
  const trading = asset.trading;
  const mic = trading?.exchange?.mic;
  if (!trading || !mic || !/^[A-Z0-9]{4}$/.test(mic)) return { ok: false, error: `asset ${ticker}: no trading object or exchange` };

  const exchangeUrl = `${API_BASE}/exchanges/${encodeURIComponent(mic)}`;
  const x = await getBytes(fetchImpl, exchangeUrl);
  if (!x.ok) return { ok: false, error: `exchange ${mic}: ${x.error}` };
  let sched: ExchangeSchedule;
  try { sched = JSON.parse(new TextDecoder().decode(x.body)); } catch { return { ok: false, error: `exchange ${mic}: body is not JSON` }; }
  if (!sched?.schedule?.sessions?.length || !sched.schedule.timezone) return { ok: false, error: `exchange ${mic}: no published sessions` };

  const limits = (trading.limitsPerPeriod ?? {}) as PeriodLimits;
  return {
    ok: true,
    venue: {
      mic, limits, sched, atMs: now(),
      reportedPeriod: trading.currentPeriod ?? null,
      halted: Boolean(trading.isTradingHalted || asset.isTradingHalted),
      assetUrl, assetBodyHash: keccak256(a.body),
      exchangeUrl, exchangeBodyHash: keccak256(x.body),
      // Not canonical JSON (the asp uses JCS), but stable for identical issuer output; a mismatch costs a rebuild, never a wrong answer.
      inputsKey: keccak256(toUtf8Bytes(JSON.stringify({ limits, schedule: sched.schedule }))),
    },
  };
}

export interface VenueStatus {
  venue: Venue | null;
  ageMs: number | null;
  /** The last refresh failed: serve, but disclose the age. */
  stale: boolean;
  lastError: string | null;
}

interface Entry {
  venue: Venue | null;
  lastError: string | null;
  lastFailMs: number;
  inFlight: Promise<void> | null;
}

/** After a failed read, calls wait this long before asking the issuer again, so an outage is not hammered. */
export const RETRY_AFTER_FAIL_MS = 30_000;

export class IssuerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  private readonly onError: (ticker: string, error: string) => void;

  constructor(fetchImpl: Fetch, now: () => number = Date.now, onError: (ticker: string, error: string) => void = () => {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onError = onError;
  }

  /** The venue for a ticker, refreshed if older than REFRESH_MS. Never throws; an outage returns venue null. */
  async get(ticker: string): Promise<VenueStatus> {
    let e = this.entries.get(ticker);
    if (!e) { e = { venue: null, lastError: null, lastFailMs: Number.NEGATIVE_INFINITY, inFlight: null }; this.entries.set(ticker, e); }
    const entry = e;
    const due = !entry.venue || this.now() - entry.venue.atMs >= REFRESH_MS;
    if (due && (entry.inFlight || this.now() - entry.lastFailMs >= RETRY_AFTER_FAIL_MS)) {
      entry.inFlight ??= (async () => {
        let r: VenueRead;
        try { r = await readVenue(this.fetchImpl, ticker, this.now); } catch (err) { r = { ok: false, error: String(err).slice(0, 200) }; }
        if (r.ok) { entry.venue = r.venue; entry.lastError = null; }
        else { entry.lastError = r.error; entry.lastFailMs = this.now(); this.onError(ticker, r.error); }
      })().finally(() => { entry.inFlight = null; });
      await entry.inFlight;
    }
    const t = this.now();
    const ageMs = entry.venue ? Math.max(0, t - entry.venue.atMs) : null;
    if (ageMs !== null && ageMs > OUTAGE_MS) return { venue: null, ageMs, stale: true, lastError: entry.lastError };
    return { venue: entry.venue, ageMs, stale: entry.lastError !== null && entry.venue !== null, lastError: entry.lastError };
  }
}
