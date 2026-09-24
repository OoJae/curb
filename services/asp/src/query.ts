/**
 * Query parsing shared by the three priced routes, so they refuse malformed input the same way.
 *
 * Every refusal here happens in `accept`, before the payment layer: a caller never signs anything for a
 * request that could not have been answered. Echoed values are truncated, and the valid alternatives are
 * listed, so a refusal is useful to an agent without reflecting arbitrary input back at length.
 */
import type { HTTPAdapter } from "@okxweb3/x402-core/server";
import type { Refusal } from "./pay/server.ts";
import type { Asset } from "./cohort.ts";

export const refuse = (status: number, body: Record<string, unknown>): Refusal => ({ ok: false, status, body });

/** One value or a refusal: `?symbol=a&symbol=b` is ambiguous about what is being bought. */
export function single(adapter: HTTPAdapter, name: string): { v: string | undefined } | Refusal {
  const v = adapter.getQueryParam?.(name);
  if (Array.isArray(v)) return refuse(400, { error: "repeated-parameter", parameter: name });
  return { v };
}

/** A cohort asset by wrapper symbol (wTCENTx), issuer symbol (TCENTx) or wrapper address, any case. */
export function findAsset(cohort: readonly Asset[], s: string): Asset | undefined {
  const k = s.trim().toLowerCase();
  return cohort.find((a) => a.symbol.toLowerCase() === k || a.rawSymbol.toLowerCase() === k || a.wrapper.toLowerCase() === k);
}

/**
 * An optional integer in [min, max]. Absent or empty means the default; anything else that is not a plain
 * decimal integer in range is a 400 naming the bounds.
 */
export function intParam(adapter: HTTPAdapter, name: string, def: number, min: number, max: number, error: string): { v: number } | Refusal {
  const s = single(adapter, name);
  if ("ok" in s) return s;
  if (s.v === undefined || s.v.trim() === "") return { v: def };
  const n = /^\d{1,6}$/.test(s.v.trim()) ? Number(s.v.trim()) : NaN;
  if (!(n >= min && n <= max)) return refuse(400, { error, [name]: s.v.slice(0, 16), min, max });
  return { v: n };
}

/**
 * The optional `symbol` of the two Scorecard routes. Absent or empty means every graded asset. A symbol
 * MarketClock does not track is a 400 listing the ones it does; one it tracks but Scorecard cannot grade
 * (no price source, e.g. wSHEINx) is a 400 too, because its record is empty by construction -- Scorecard
 * refuses to commit a row it could not settle -- and selling an empty answer would be selling nothing.
 */
export function gradedSymbol(adapter: HTTPAdapter, cohort: readonly Asset[]): { asset: Asset | null } | Refusal {
  const s = single(adapter, "symbol");
  if ("ok" in s) return s;
  if (s.v === undefined || s.v.trim() === "") return { asset: null };
  const asset = findAsset(cohort, s.v);
  if (!asset) return refuse(400, { error: "unknown-symbol", symbol: s.v.slice(0, 64), valid: cohort.map((a) => a.symbol) });
  if (asset.pool === null) {
    return refuse(400, {
      error: "no-graded-record", symbol: asset.symbol,
      reason: "Scorecard has no price source for this asset, so no mark for it can be committed or graded",
      graded: cohort.filter((a) => a.pool !== null).map((a) => a.symbol),
    });
  }
  return { asset };
}
