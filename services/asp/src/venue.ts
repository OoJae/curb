/**
 * The issuer's two inputs to every closure calendar: the asset's per-period caps and the venue's
 * published schedule, kept as the exact bytes they arrived as.
 *
 * `readVenue` is extracted from services/keeper/src/main.ts. It returns a reason on failure instead of
 * null, because this service has to tell a buyer WHY it cannot answer, not just that it cannot.
 *
 * VenueStore is the cache in front of it, with three thresholds that mean different things:
 *   refreshMs (600s)   how old the bytes may get before the tick fetches them again. Caps and schedules
 *                      change on the order of days; the issuer sits behind Cloudflare with a 30s edge TTL
 *                      and there is no reason to lean on it harder than the keeper does.
 *   staleAfterMs       older than a refresh plus a tick means a refresh was due and FAILED. The answer is
 *                      still correct unless the issuer changed its schedule in the meantime, so it is
 *                      served, and the age is disclosed in `warnings`.
 *   outageMs (30 min)  the issuer has been unreachable for three refresh cycles. A calendar built from
 *                      bytes that old is a guess about the issuer's current state, so paid routes refuse
 *                      with 503 -- and, because the refusal happens before settlement, nobody is billed.
 */
import { hashJson } from "./hash.ts";
import type { XStocksClient } from "./sources/xstocks.ts";
import type { ExchangeSchedule, Period, TradingObject } from "./regime.ts";
import type { PeriodLimits } from "./reopen.ts";
import type { Asset } from "./cohort.ts";

export interface Venue {
  mic: string;
  assetUrl: string;
  assetBodyHash: string;
  exchangeUrl: string;
  exchangeBodyHash: string;
  limits: PeriodLimits;
  sched: ExchangeSchedule;
  /** When both bodies had been received. */
  atMs: number;
  /** The issuer's own `currentPeriod` at fetch time, kept to cross-check the schedule-derived period. */
  reportedPeriod: Period | null;
  halted: boolean;
  /**
   * keccak of the canonical (limits, schedule) pair: everything the calendar is computed FROM. The raw
   * bodies also carry `openNow`, `currentSession` and `nextChangeAt`, which change at every boundary; keying
   * the calendar cache on the body hashes would rebuild it several times a day for no reason.
   */
  inputsKey: string;
  assetBody: Uint8Array;
  exchangeBody: Uint8Array;
}

export type VenueRead = { ok: true; venue: Venue } | { ok: false; error: string };

/**
 * Twice the keeper's 4s. The keeper's tick is on a clock; this fetch is not on any request's path, and
 * measured on 24 Sep 2026 the issuer was taking ~4s per response, so 4s aborted healthy-but-slow reads.
 */
export const ISSUER_TIMEOUT_MS = 8_000;

export async function readVenue(client: XStocksClient, rawSymbol: string, now: () => number = Date.now): Promise<VenueRead> {
  const assetUrl = client.assetUrl(rawSymbol);
  const assetRes = await client.getWithRetry(assetUrl, ISSUER_TIMEOUT_MS);
  if (!assetRes.ok || !assetRes.body) return { ok: false, error: `asset ${rawSymbol}: ${assetRes.error ?? `http ${assetRes.status}`}` };
  let asset: { trading?: TradingObject; isTradingHalted?: boolean };
  try { asset = JSON.parse(new TextDecoder().decode(assetRes.body)); } catch { return { ok: false, error: `asset ${rawSymbol}: body is not JSON` }; }
  const trading = asset.trading;
  const mic = trading?.exchange?.mic;
  if (!trading || !mic) return { ok: false, error: `asset ${rawSymbol}: no trading object or exchange` };

  const exchangeUrl = client.exchangeUrl(mic);
  const exRes = await client.getWithRetry(exchangeUrl, ISSUER_TIMEOUT_MS);
  if (!exRes.ok || !exRes.body) return { ok: false, error: `exchange ${mic}: ${exRes.error ?? `http ${exRes.status}`}` };
  let sched: ExchangeSchedule;
  try { sched = JSON.parse(new TextDecoder().decode(exRes.body)); } catch { return { ok: false, error: `exchange ${mic}: body is not JSON` }; }
  if (!sched?.schedule?.sessions?.length || !sched.schedule.timezone) return { ok: false, error: `exchange ${mic}: no published sessions` };

  const limits = (trading.limitsPerPeriod ?? {}) as PeriodLimits;
  return {
    ok: true,
    venue: {
      mic, assetUrl, exchangeUrl,
      assetBodyHash: assetRes.bodyHash!, exchangeBodyHash: exRes.bodyHash!,
      limits, sched, atMs: now(),
      reportedPeriod: trading.currentPeriod ?? null,
      halted: Boolean(trading.isTradingHalted || asset.isTradingHalted),
      inputsKey: hashJson({ limits, schedule: sched.schedule }),
      assetBody: assetRes.body, exchangeBody: exRes.body,
    },
  };
}

export interface VenueStatus {
  venue: Venue | null;
  ageMs: number | null;
  /** A refresh was due and has not succeeded: serve, but disclose. */
  stale: boolean;
  /** No usable bytes, or none for longer than outageMs: refuse paid answers. */
  outage: boolean;
  lastError: string | null;
}

interface Entry {
  venue: Venue | null;
  lastError: string | null;
  lastAttemptMs: number;
}

export interface VenueStoreOptions {
  refreshMs: number;
  staleAfterMs: number;
  outageMs: number;
}

export class VenueStore {
  private readonly entries = new Map<string, Entry>();
  readonly refreshMs: number;
  readonly staleAfterMs: number;
  readonly outageMs: number;

  constructor(opts: VenueStoreOptions) {
    this.refreshMs = opts.refreshMs;
    this.staleAfterMs = opts.staleAfterMs;
    this.outageMs = opts.outageMs;
  }

  /**
   * Refetch every asset whose bytes are older than refreshMs. Assets are fetched concurrently (each one's
   * two GETs stay in order): with the issuer at ~4s a response and up to one retry per GET, doing six
   * assets one after another could stretch a tick past the /healthz threshold. The issuer's limit is
   * 1000 requests per window; a dozen at once is nowhere near it. A failure keeps the last good bytes --
   * the whole point of the stale/outage split is that one bad fetch must not take the calendar down.
   */
  async refresh(
    assets: Asset[], client: XStocksClient, now: () => number,
    onFresh?: (a: Asset, v: Venue) => void,
    onError?: (a: Asset, error: string) => void,
  ): Promise<void> {
    await Promise.all(assets.map(async (a) => {
      const e = this.entries.get(a.wrapper) ?? { venue: null, lastError: null, lastAttemptMs: 0 };
      this.entries.set(a.wrapper, e);
      if (e.venue && now() - e.venue.atMs < this.refreshMs) return;
      e.lastAttemptMs = now();
      let r: VenueRead;
      try { r = await readVenue(client, a.rawSymbol, now); } catch (err) { r = { ok: false, error: String(err).slice(0, 200) }; }
      if (r.ok) {
        e.venue = r.venue;
        e.lastError = null;
        onFresh?.(a, r.venue);
      } else {
        e.lastError = r.error;
        onError?.(a, r.error);
      }
    }));
  }

  status(wrapper: string, nowMs: number): VenueStatus {
    const e = this.entries.get(wrapper);
    const venue = e?.venue ?? null;
    const ageMs = venue ? Math.max(0, nowMs - venue.atMs) : null;
    return {
      venue, ageMs,
      stale: ageMs !== null && ageMs > this.staleAfterMs,
      outage: ageMs === null || ageMs > this.outageMs,
      lastError: e?.lastError ?? null,
    };
  }
}
