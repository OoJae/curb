/**
 * GET /v1/accuracy-record?symbol=&limit=      ($0.05)
 * GET /v1/discount-curve?symbol=&minMinutes=  ($0.10)
 *
 * The two priced handlers over Scorecard, in the same shape as the calendar's (calendarRoute.ts):
 *   accept   validation and availability, free, before the payment layer: a malformed request, a symbol
 *            MarketClock does not track or Scorecard cannot grade, or a record nobody has been able to read
 *            for 30 minutes is refused here, and nobody is asked to sign anything.
 *   preview  the 402's body, cut from the very answer a buyer would pay for, so it cannot drift from it.
 *   build    checks availability AGAIN, because the Broker's verify round trip takes real time; a refusal
 *            here means the payment is never settled.
 *
 * Both read the Scorecard snapshot the tick keeps (index/scorecard.ts) and never touch the chain on a
 * request's path. A snapshot past the stale line (5 min) is still served, with its age in `warnings`:
 * rows change only when a closure is committed or settled, a few times a day, and asOfBlock says exactly
 * which chain state an answer describes. Past the outage line (30 min) it is refused.
 */
import { buildRecord, recordPreviewOf, DEFAULT_LIMIT, MAX_LIMIT } from "./accuracyRecord.ts";
import { buildCurve, curvePreviewOf, DEFAULT_MIN_MINUTES, MIN_MIN_MINUTES, MAX_MIN_MINUTES } from "./discountCurve.ts";
import type { ClosureView } from "./discountCurve.ts";
import type { ScorecardSnapshot, ScorecardStatus } from "./index/scorecard.ts";
import type { Asset } from "./cohort.ts";
import type { BilledQuery, PricedHandler, Refusal } from "./pay/server.ts";
import { findAsset, gradedSymbol, intParam, refuse } from "./query.ts";

export interface ScorecardRouteDeps {
  cohort: () => Asset[];
  scorecard: { status(nowMs: number): ScorecardStatus };
  closures: ClosureView;
  chainId: number;
}

type Ready = { ok: true; snapshot: ScorecardSnapshot; warnings: string[]; symbols: Map<string, string>; filter: { symbol: string; wrapper: string } | null };

/** No snapshot, or none younger than the outage line: nothing true can be sold. */
function unavailable(st: ScorecardStatus): Refusal | null {
  if (!st.outage && st.snapshot) return null;
  return refuse(503, { error: "record-unavailable", lastGoodAsOfBlock: st.snapshot?.block.number ?? null, lastGoodReadAtMs: st.snapshot?.readAtMs ?? null });
}

/** Everything both answers need at `nowMs`, or the refusal that stops the request before it is billed. */
function ready(d: ScorecardRouteDeps, q: BilledQuery, nowMs: number): Ready | Refusal {
  const st = d.scorecard.status(nowMs);
  const no = unavailable(st);
  if (no) return no;
  const snapshot = st.snapshot!;
  const cohort = d.cohort();
  let filter: Ready["filter"] = null;
  if (q.symbol !== undefined) {
    const a = findAsset(cohort, String(q.symbol));
    if (!a) return refuse(503, { error: "asset-unavailable", symbol: q.symbol });
    filter = { symbol: a.symbol, wrapper: a.wrapper };
  }
  const warnings: string[] = [];
  if (st.stale) {
    warnings.push(
      `the Scorecard snapshot is ${Math.round(st.ageMs! / 1000)}s old (block ${snapshot.block.number}) because the latest refresh failed; ` +
      "rows change only when a closure is committed or settled, so it is correct unless one was since",
    );
  }
  return {
    ok: true, snapshot, warnings, filter,
    symbols: new Map(cohort.map((a) => [a.wrapper.toLowerCase(), a.symbol])),
  };
}

export function recordHandler(d: ScorecardRouteDeps): PricedHandler {
  function build(q: BilledQuery, nowMs: number): { ok: true; body: ReturnType<typeof buildRecord> } | Refusal {
    const r = ready(d, q, nowMs);
    if (!r.ok) return r;
    return {
      ok: true,
      body: buildRecord({
        snapshot: r.snapshot, chainId: d.chainId, symbols: r.symbols, filter: r.filter,
        limit: Number(q.limit), nowMs, warnings: r.warnings,
      }),
    };
  }
  return {
    accept(adapter, nowMs) {
      const cohort = d.cohort();
      if (cohort.length === 0) return refuse(503, { error: "cohort-unavailable" });
      const s = gradedSymbol(adapter, cohort);
      if ("ok" in s) return s;
      const limit = intParam(adapter, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT, "bad-limit");
      if ("ok" in limit) return limit;
      const no = unavailable(d.scorecard.status(nowMs));
      if (no) return no;
      const query: BilledQuery = { limit: limit.v };
      if (s.asset) query.symbol = s.asset.symbol;
      return { ok: true, query };
    },
    preview(q, nowMs) {
      const r = build(q, nowMs);
      return r.ok ? recordPreviewOf(r.body) : r.body;
    },
    build,
  };
}

export function curveHandler(d: ScorecardRouteDeps): PricedHandler {
  function build(q: BilledQuery, nowMs: number): { ok: true; body: ReturnType<typeof buildCurve> } | Refusal {
    const r = ready(d, q, nowMs);
    if (!r.ok) return r;
    return {
      ok: true,
      body: buildCurve({
        snapshot: r.snapshot, closures: d.closures, chainId: d.chainId, symbols: r.symbols, filter: r.filter,
        minMinutes: Number(q.minMinutes), nowMs, warnings: r.warnings,
      }),
    };
  }
  return {
    accept(adapter, nowMs) {
      const cohort = d.cohort();
      if (cohort.length === 0) return refuse(503, { error: "cohort-unavailable" });
      const s = gradedSymbol(adapter, cohort);
      if ("ok" in s) return s;
      const m = intParam(adapter, "minMinutes", DEFAULT_MIN_MINUTES, MIN_MIN_MINUTES, MAX_MIN_MINUTES, "bad-min-minutes");
      if ("ok" in m) return m;
      const no = unavailable(d.scorecard.status(nowMs));
      if (no) return no;
      const query: BilledQuery = { minMinutes: m.v };
      if (s.asset) query.symbol = s.asset.symbol;
      return { ok: true, query };
    },
    preview(q, nowMs) {
      const r = build(q, nowMs);
      return r.ok ? curvePreviewOf(r.body) : r.body;
    },
    build,
  };
}
