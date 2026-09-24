/**
 * GET /v1/closure-calendar?symbol=wTCENTx&horizonDays=7 -- the priced handler. Both parameters are
 * optional: the symbol defaults to wTCENTx, the horizon to 7 days.
 *
 * Validation and availability are checked in `accept`, before any payment: an unknown symbol is a free
 * 400 that lists the valid ones, and an issuer that has been dark for 30 minutes is a free 503. `build`
 * checks availability AGAIN, because the verify round trip to the Broker takes real time and the issuer
 * can go dark inside it; that second refusal is the one that saves a buyer from being billed.
 *
 * The preview is cut from the same answer the buyer would pay for, so it cannot drift from it.
 */
import { buildCalendar, previewOf, DEFAULT_HORIZON_DAYS, DEFAULT_SYMBOL, MAX_HORIZON_DAYS } from "./closureCalendar.ts";
import type { TimelineCache } from "./closureCalendar.ts";
import type { VenueStore } from "./venue.ts";
import type { Asset } from "./cohort.ts";
import type { BilledQuery, PricedHandler, Refusal } from "./pay/server.ts";
import { findAsset, refuse, single } from "./query.ts";

export interface CalendarRouteDeps {
  cohort: () => Asset[];
  venues: VenueStore;
  timelines: TimelineCache;
}

export function calendarHandler(d: CalendarRouteDeps): PricedHandler {
  function build(q: BilledQuery, nowMs: number): { ok: true; body: ReturnType<typeof buildCalendar> } | Refusal {
    const asset = findAsset(d.cohort(), String(q.symbol));
    if (!asset) return refuse(503, { error: "asset-unavailable", symbol: q.symbol });
    const st = d.venues.status(asset.wrapper, nowMs);
    if (st.outage || !st.venue) return refuse(503, { error: "issuer-unavailable", lastGoodAsOfMs: st.venue?.atMs ?? null });
    const v = st.venue;

    const warnings: string[] = [];
    if (st.stale) {
      warnings.push(
        `issuer bytes are ${Math.round(st.ageMs! / 1000)}s old: they are refreshed every ${Math.round(d.venues.refreshMs / 1000)}s ` +
        `and the latest refresh failed${st.lastError ? ` (${st.lastError})` : ""}; the calendar is correct unless the issuer changed its schedule or limits since`,
      );
    }
    if (asset.micOnChain && asset.micOnChain !== v.mic) {
      warnings.push(`MarketClock registered ${asset.symbol} under ${asset.micOnChain}, but the issuer now reports ${v.mic}`);
    }
    return {
      ok: true,
      body: buildCalendar({
        symbol: asset.symbol, wrapper: asset.wrapper, venue: v,
        timeline: d.timelines.get(asset.wrapper, v, nowMs),
        nowMs, horizonDays: Number(q.horizonDays), warnings,
      }),
    };
  }

  return {
    accept(adapter, nowMs) {
      const cohort = d.cohort();
      if (cohort.length === 0) return refuse(503, { error: "cohort-unavailable" });
      const valid = cohort.map((a) => a.symbol);

      // No symbol means DEFAULT_SYMBOL, not an error: OKX's marketplace probes an endpoint with no
      // parameters and expects the challenge for the priced answer, and the listing documents the default.
      const s = single(adapter, "symbol");
      if ("ok" in s) return s;
      const symbol = s.v && s.v.trim() ? s.v : DEFAULT_SYMBOL;
      const asset = findAsset(cohort, symbol);
      if (!asset) return refuse(400, { error: "unknown-symbol", symbol: symbol.slice(0, 64), valid });

      // Absent or empty is the default, as in intParam.
      const h = single(adapter, "horizonDays");
      if ("ok" in h) return h;
      let horizonDays = DEFAULT_HORIZON_DAYS;
      if (h.v !== undefined && h.v.trim() !== "") {
        const n = /^\d{1,2}$/.test(h.v) ? Number(h.v) : NaN;
        if (!(n >= 1 && n <= MAX_HORIZON_DAYS)) {
          return refuse(400, { error: "bad-horizon", horizonDays: h.v.slice(0, 16), min: 1, max: MAX_HORIZON_DAYS });
        }
        horizonDays = n;
      }

      const st = d.venues.status(asset.wrapper, nowMs);
      if (st.outage) return refuse(503, { error: "issuer-unavailable", lastGoodAsOfMs: st.venue?.atMs ?? null });
      return { ok: true, query: { symbol: asset.symbol, horizonDays } };
    },

    preview(q, nowMs) {
      const r = build(q, nowMs);
      return r.ok ? previewOf(r.body) : r.body;
    },

    build,
  };
}
