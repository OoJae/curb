/**
 * Last-known-good carry: one asset's issuer fetch failing must not write that asset shut (DECISIONS D-18).
 *
 * What happened without it. The issuer's API sometimes takes longer than the 3 s request limit for ONE object.
 * The tick then had no body for that asset, derive() read "no body" as CLOSED with cap 0 (source-unavailable),
 * host A wrote the asset shut, and two ticks later wrote it open again. In the week to 26 Nov 2026 that was 74
 * false closures of an open asset, every one from a single failed tick: 80 of 80 failed fetches were the request
 * limit, twice in a row, with every other asset in the same tick answered normally.
 *
 * The rule. derive/3 has always treated a body as usable while it is at most LAST_KNOWN_GOOD_MS (60 s) older than
 * the round's evaluatedAtMs, and every round commits that window in its PARAMS leaf (`lastKnownGoodMs`). Nothing
 * ever handed it such a body: a failed tick passed none. This module does. When this tick's fetch of an asset
 * fails in transport (no answer, 429 or 5xx), and the most recent answer the issuer gave for it was a good one,
 * that answer is used again, with its own fetch time, while it is inside the window. The derivation does not
 * change, so no method version changes: the round re-derives under derive/3 with every published verifier.
 *
 * What a verifier sees. The bundle carries the reused body under the asset's URL, and the FETCH_LOG leaf holds
 * the reused fetch's own log entry (ok, with its original sequence number and times) followed by this tick's
 * failed attempts. The offline verifier takes the latest successful fetch of each URL, which is that entry.
 *
 * What it will not do:
 *   - reuse an answer older than the window: derive() would read it as missing anyway;
 *   - reuse anything near a scheduled change. From 7 minutes before to 3 minutes after a boundary of the asset's
 *     own venue (the same window the attestor polls densely in), or when the body's own nextChangeAt is within
 *     7 minutes or already past, a failed fetch closes the asset exactly as before. The issuer cuts capacity
 *     5 minutes before a session ends, and that is when an old answer is most likely to be wrong;
 *   - reuse an answer after the issuer has since given an unusable one (a 4xx, or a body the shape check
 *     withheld): only a transport failure is "no news".
 *
 * The cost, stated plainly: a change the issuer makes away from any scheduled boundary (a halt) during a tick
 * whose fetch fails is seen one tick later than it would have been, at most 60 s after the answer that was
 * reused. Before, the same failed tick wrote a closure that was false 74 times out of 74.
 */
import { LAST_KNOWN_GOOD_MS } from "./derive.ts";
import { boundaries } from "./calendar.ts";
import type { ExchangeSchedule } from "./regime.ts";
import type { Exchange, FetchLogEntry } from "./sources/xstocks.ts";

/** No carry from this long before a scheduled boundary (the issuer's cut is 5 minutes before a session ends)... */
export const CARRY_GUARD_BEFORE_MS = 7 * 60_000;
/** ...until this long after it. The same window as main.ts inDenseWindow. */
export const CARRY_GUARD_AFTER_MS = 3 * 60_000;

/** A successful, shape-checked fetch and the log entry that recorded it. */
export interface GoodFetch {
  ex: Exchange;
  entry: FetchLogEntry;
}

export interface Carried {
  symbol: string;
  /** evaluatedAtMs minus the reused answer's fetch time. */
  ageMs: number;
  /** Why this tick's own fetch failed. */
  error: string | null;
}

/** A failure that says nothing about the asset: no answer at all, a rate limit, or a server error. */
export function transportFailure(ex: Exchange): boolean {
  return !ex.ok && (ex.status === 0 || ex.status === 429 || ex.status >= 500);
}

const decoder = new TextDecoder();

/**
 * True when a change may be due: a boundary of the venue's schedule is near, the body's own announced next
 * change is near or past, or neither can be read. Then nothing is carried.
 */
export function nearChange(body: Uint8Array, sched: ExchangeSchedule | undefined, nowMs: number): boolean {
  let scheduleQuiet = false;
  if (sched) {
    try {
      if (boundaries(sched, nowMs - CARRY_GUARD_AFTER_MS, nowMs + CARRY_GUARD_BEFORE_MS).length > 0) return true;
      scheduleQuiet = true;
    } catch {
      return true;
    }
  }
  let next: number | null = null;
  try {
    const parsed = JSON.parse(decoder.decode(body)) as { trading?: { nextChangeAt?: unknown }; nextChangeAt?: unknown };
    const raw = (parsed.trading ?? parsed).nextChangeAt;
    if (typeof raw === "string") {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) next = ms;
    }
  } catch {
    return true;
  }
  if (next !== null && next - nowMs <= CARRY_GUARD_BEFORE_MS) return true;
  // With no schedule and no announced change there is nothing to say a boundary is NOT near.
  return !scheduleQuiet && next === null;
}

/**
 * This tick's asset fetches with each transport failure replaced by that asset's last good answer, where the
 * rule allows it, and the fetch log to commit: the reused entries first (they are older), then this tick's own.
 * Pure: the caller keeps `lastGood` (see rememberGood).
 */
export function carryLastGood(a: {
  cohort: readonly { symbol: string; mic: string }[];
  /** This tick's fetches, in cohort order, after the shape check. */
  assetEx: readonly Exchange[];
  tickLog: readonly FetchLogEntry[];
  lastGood: ReadonlyMap<string, GoodFetch>;
  /** The last good schedule per MIC. */
  schedules: ReadonlyMap<string, ExchangeSchedule>;
  evaluatedAtMs: number;
}): { assetEx: Exchange[]; fetchLog: FetchLogEntry[]; carried: Carried[] } {
  const assetEx = [...a.assetEx];
  const reused: FetchLogEntry[] = [];
  const carried: Carried[] = [];
  for (const [i, c] of a.cohort.entries()) {
    const ex = assetEx[i];
    if (!ex || !transportFailure(ex)) continue;
    const g = a.lastGood.get(c.symbol);
    if (!g || !g.ex.ok || !g.ex.body || g.ex.url !== ex.url) continue;
    const ageMs = a.evaluatedAtMs - g.ex.respEndMs;
    if (!(ageMs >= 0 && ageMs <= LAST_KNOWN_GOOD_MS)) continue;
    // The verifier pairs the body with the latest ok log entry for its URL, so this tick must hold none.
    if (a.tickLog.some((e) => e.ok && e.url === ex.url)) continue;
    if (nearChange(g.ex.body, a.schedules.get(c.mic), a.evaluatedAtMs)) continue;
    assetEx[i] = g.ex;
    reused.push(g.entry);
    carried.push({ symbol: c.symbol, ageMs, error: ex.error });
  }
  reused.sort((x, y) => x.seq - y.seq);
  return { assetEx, fetchLog: [...reused, ...a.tickLog], carried };
}

/**
 * Keep each asset's newest good answer for the next tick. A transport failure leaves the previous one in
 * place; any other unusable answer (a 4xx, or a body the shape check withheld) forgets it, because the issuer
 * has spoken since and what it said could not be used.
 */
export function rememberGood(
  lastGood: Map<string, GoodFetch>,
  cohort: readonly { symbol: string }[],
  /** This tick's own fetches, in cohort order, after the shape check and BEFORE any carry. */
  assetEx: readonly Exchange[],
  tickLog: readonly FetchLogEntry[],
): void {
  for (const [i, c] of cohort.entries()) {
    const ex = assetEx[i];
    if (!ex) continue;
    if (ex.ok && ex.body) {
      const entry = [...tickLog].reverse().find((e) => e.ok && e.url === ex.url && e.respEndMs === ex.respEndMs && e.bodyHash === ex.bodyHash);
      if (entry) lastGood.set(c.symbol, { ex, entry });
      else lastGood.delete(c.symbol);
    } else if (!transportFailure(ex)) {
      lastGood.delete(c.symbol);
    }
  }
  // An asset that left the cohort is not kept.
  const live = new Set(cohort.map((c) => c.symbol));
  for (const k of [...lastGood.keys()]) if (!live.has(k)) lastGood.delete(k);
}
