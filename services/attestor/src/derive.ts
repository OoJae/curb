/**
 * derive(): committed inputs -> exactly what is written to MarketClock.
 *
 * This is the one function both sides of the trust boundary run. The attestor calls it to build a
 * round; the public verifier calls it on the published bundle and must get byte-identical claims.
 * So it is pure: no clock, no network, no randomness, no host timezone. Time enters only as the
 * committed `evaluatedAtMs`, and every HTTP body enters as the exact bytes that were hashed.
 *
 * Degraded policy (decided before the 14-day VERIFY window, per the W1 red team):
 *   - A missing or stale asset body never produces UNKNOWN and never skips the write. It produces
 *     CLOSED with cap 0 and a `degraded` flag, because the conservative reading of "we cannot see
 *     the issuer" is "do not assume anyone can create or redeem".
 *   - A body older than LAST_KNOWN_GOOD_MS relative to evaluatedAt counts as missing.
 */
import { resolve, Regime, RULES_V2 } from "./regime.ts";
import type { TradingObject, ExchangeSchedule, ResolveRules } from "./regime.ts";
import { nextBoundaryAfter, boundaries } from "./calendar.ts";

/**
 * Derivation methods. The method id is committed in every round's PARAMS leaf, and a verifier re-derives
 * a round with exactly the method that produced it. Rules are therefore versioned, never edited in place.
 *
 * derive/1  Rounds from 14 Sep 2026 11:46Z until the derive/2 deploy.
 *           Wrote the issuer's raw maxOrderFiatValue into MarketClock's whole-USD cap field. The issuer's
 *           API spec defines that field in fiat CENTS, so these rounds overstate primary capacity 100x.
 *           Only `market` with a zero cap became CLOSED. A body with no period could yield UNKNOWN.
 * derive/2  Cap converted cents -> whole USD (floor). Any open-labelled period with a zero cap is CLOSED,
 *           including a positive cap that rounds to $0. UNKNOWN is never written.
 * derive/3  Two rules added after six days of live evidence (DECISIONS D-9), both in the conservative
 *           direction, because a CDN serves each issuer object independently:
 *             - cohort coherence: assets that share a venue AND an hours mode trade on the same primary
 *               schedule, so when one says the primary is shut and another says it is open inside the same
 *               fetch batch, one of the two objects is stale. The open ones are closed. (Observed 17 Sep:
 *               one edge served AAPLx closed and NVDAx extended 475ms apart, leaving wNVDAx at $1,000,000
 *               for ~20s after its cap had actually gone to zero.)
 *             - confirm before open: a wrapper only reopens when the PREVIOUS tick's raw observation also
 *               saw it open. One stale cached body can therefore no longer reopen an asset mid-closure;
 *               it costs one tick (5s in a dense window) at a real reopen. The prior observation is
 *               committed as a PRIOR leaf, so a verifier re-derives the hold exactly.
 */
export interface DeriveMethod {
  rules: ResolveRules;
  capCentsPerUsd: number;
  neverWriteUnknown: boolean;
  /** Close an asset whose same-venue, same-hours-mode peers say the primary is shut. */
  venueCoherence: boolean;
  /** Require the previous tick's observation to agree before writing an open regime. */
  confirmBeforeOpen: boolean;
}

export const METHODS: Record<string, DeriveMethod> = {
  "curb.marketclock.derive/1": { rules: { zeroCapClosesAllPeriods: false }, capCentsPerUsd: 1, neverWriteUnknown: false, venueCoherence: false, confirmBeforeOpen: false },
  "curb.marketclock.derive/2": { rules: RULES_V2, capCentsPerUsd: 100, neverWriteUnknown: true, venueCoherence: false, confirmBeforeOpen: false },
  "curb.marketclock.derive/3": { rules: RULES_V2, capCentsPerUsd: 100, neverWriteUnknown: true, venueCoherence: true, confirmBeforeOpen: true },
};

export const METHOD_VERSION = "curb.marketclock.derive/3";
export const LAST_KNOWN_GOOD_MS = 60_000;
/** A prior observation older than this cannot confirm a reopen; the round then opens unconfirmed. */
export const PRIOR_MAX_AGE_MS = 90_000;
/**
 * Cohort coherence is suspended for this long after a published session STARTS. Right after a start the
 * objects that lag are the ones still reading `closed`, and treating a laggard as the venue's witness would
 * invert the rule: one stale object would shut its healthy peers at exactly the reopen the demo turns on.
 */
export const COHERENCE_QUIET_AFTER_START_MS = 120_000;

/**
 * The previous tick's RAW observation: what the evidence said before any hold was applied. Holding the
 * published claim here instead would make a hold self-perpetuating.
 */
export interface PriorObservation {
  evaluatedAtMs: number;
  /** lowercase wrapper -> what that tick observed. */
  claims: Record<string, { regime: number; capUsd: string }>;
}

export interface AssetInput {
  wrapper: string;
  symbol: string;
  mic: string;
  /** Exact response body bytes from GET /assets/{symbol}?network=XLayer, or null if unavailable. */
  body: Uint8Array | null;
  fetchedAtMs: number | null;
}

export interface DeriveInput {
  evaluatedAtMs: number;
  assets: AssetInput[];
  /** Exact response body bytes from GET /exchanges/{mic}, keyed by MIC. */
  schedules: Record<string, Uint8Array | null>;
  /** Required by derive/3 to confirm a reopen; committed as the round's PRIOR leaf. */
  prior?: PriorObservation | null;
}

export interface Claim {
  wrapper: string;
  symbol: string;
  regime: Regime;
  capUsd: bigint;
  /** Unix seconds; 0 when unknown. */
  nextAt: number;
  halted: boolean;
  disagreement: boolean;
  degraded: string[];
  reason: string;
}

const decoder = new TextDecoder();

function parse<T>(bytes: Uint8Array | null): T | null {
  if (!bytes) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** The asset endpoint wraps the trading object; accept either shape defensively. */
function tradingOf(parsed: unknown): TradingObject | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { trading?: TradingObject };
  return p.trading ?? (parsed as TradingObject);
}

function scheduleNextAt(sched: ExchangeSchedule | null, evaluatedAtMs: number): number {
  if (!sched) return 0;
  const b = nextBoundaryAfter(sched, evaluatedAtMs);
  return b ? Math.floor(b.t / 1000) : 0;
}

/** Issuer cap (fiat cents under derive/2) -> MarketClock's whole-USD unit, flooring. */
function toCap(value: number, degraded: string[], centsPerUsd: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  if (!Number.isInteger(value)) degraded.push("non-integer-cap");
  return BigInt(Math.floor(value / centsPerUsd));
}

export interface DeriveResult {
  /** What the round writes. */
  claims: Claim[];
  /**
   * What this tick's evidence said, before confirm-before-open held anything back. This is what the NEXT
   * round commits as its PRIOR leaf; committing the held claim instead would hold the asset shut forever.
   */
  observed: PriorObservation;
}

/** Full derivation, including the observation the next round needs. */
export function deriveDetailed(input: DeriveInput, methodId: string = METHOD_VERSION): DeriveResult {
  const method = METHODS[methodId];
  if (!method) throw new Error(`unknown derivation method ${methodId}`);
  const now = new Date(input.evaluatedAtMs);
  const schedules = new Map<string, ExchangeSchedule | null>();
  for (const [mic, bytes] of Object.entries(input.schedules)) {
    schedules.set(mic, parse<ExchangeSchedule>(bytes));
  }

  // Sorted by wrapper so the calldata order is a function of the inputs, not of fetch timing.
  const assets = [...input.assets].sort((a, b) => a.wrapper.toLowerCase().localeCompare(b.wrapper.toLowerCase()));

  /** Hours mode per claim index, for the cohort-coherence pass; null when the body was unusable. */
  const modes: (string | null)[] = [];
  /** The issuer's raw period LABEL per index: a zero cap under an OPEN label is per-asset, not venue-wide. */
  const periods: (string | null)[] = [];
  /** The body's own announced next transition (unix seconds, 0 when absent), to catch a body that has
   *  outlived its own statement: "closed, I change at 13:00" served at 13:00:05 is stale, not evidence. */
  const apiNextS: number[] = [];
  /** The venue schedule per index, so a forced close can restate the next boundary. */
  const scheds: (ExchangeSchedule | null)[] = [];

  const claims = assets.map((a, i): Claim => {
    const degraded: string[] = [];
    const sched = schedules.get(a.mic) ?? null;
    if (!sched) degraded.push("schedule-unavailable");

    const fresh = a.fetchedAtMs !== null && input.evaluatedAtMs - a.fetchedAtMs <= LAST_KNOWN_GOOD_MS;
    const trading = fresh ? tradingOf(parse(a.body)) : null;
    modes[i] = trading ? String(trading.tradingHoursMode ?? "") : null;
    periods[i] = trading ? String(trading.currentPeriod ?? "") : null;
    apiNextS[i] = 0;
    scheds[i] = sched;

    if (!trading) {
      degraded.push("source-unavailable");
      return {
        wrapper: a.wrapper,
        symbol: a.symbol,
        regime: Regime.CLOSED,
        capUsd: 0n,
        nextAt: scheduleNextAt(sched, input.evaluatedAtMs),
        halted: false,
        disagreement: false,
        degraded,
        reason: fresh ? "asset body unparseable" : "asset body missing or older than last-known-good window",
      };
    }

    const r = resolve(trading, sched, now, method.rules);
    const apiNext = r.nextTransitionAt;
    apiNextS[i] = apiNext;
    // The API's nextChangeAt is trusted only when it is in the future and the venue agrees with the
    // asset. When the calendar has forced a close, the API value is stale by definition, so the
    // next boundary comes from the published schedule instead.
    const nextAt =
      !r.disagreement && apiNext * 1000 > input.evaluatedAtMs ? apiNext : scheduleNextAt(sched, input.evaluatedAtMs);

    let regime = r.regime;
    if (method.neverWriteUnknown && regime === Regime.UNKNOWN) {
      // A body that parses but carries no period is treated like a missing body.
      regime = Regime.CLOSED;
      degraded.push("period-unknown");
    }

    let capUsd = regime === Regime.CLOSED ? 0n : toCap(r.primaryCapRaw, degraded, method.capCentsPerUsd);
    if (method.neverWriteUnknown && capUsd === 0n && regime !== Regime.CLOSED) {
      // Keeps the invariant "cap 0 <=> CLOSED" when a positive cent value floors to $0.
      regime = Regime.CLOSED;
      capUsd = 0n;
      degraded.push("cap-below-one-dollar");
    }

    return {
      wrapper: a.wrapper,
      symbol: a.symbol,
      regime,
      capUsd,
      nextAt,
      halted: r.halted,
      disagreement: r.disagreement,
      degraded,
      reason: r.reason,
    };
  });

  const shut = (c: Claim) => c.regime === Regime.CLOSED;
  const close = (c: Claim, i: number, flag: string, why: string) => {
    c.regime = Regime.CLOSED;
    c.capUsd = 0n;
    c.degraded = [...c.degraded, flag];
    c.reason = `${c.reason} | ${why}`;
    // The asset's own nextChangeAt described the period we are refusing to write, so restate the next
    // boundary from the venue's published schedule instead of leaving a stale open-period value.
    const fromSchedule = scheduleNextAt(scheds[i], input.evaluatedAtMs);
    if (fromSchedule) c.nextAt = fromSchedule;
  };

  /** Did a published session start within the quiet window before `at`? */
  const justStarted = (sched: ExchangeSchedule | null, at: number) => {
    if (!sched) return false;
    try {
      return boundaries(sched, at - COHERENCE_QUIET_AFTER_START_MS, at).some((b) => b.kind === "venue-open" || b.kind === "session-change");
    } catch {
      return true; // cannot tell: assume we are near a start and stay out of the way
    }
  };

  // Pass 1: cohort coherence. Assets sharing a venue and an hours mode run on the same primary schedule,
  // so a peer reporting the primary shut is evidence against an object that still reads open.
  //
  // A witness must be shut for a VENUE reason and must still be speaking for now:
  //   - not halted, not degraded: those are shut for their own reasons;
  //   - its own period label must not still be an open one. A zero cap under `market` is a per-asset
  //     suspension (D-1), not a venue closure, and must not close healthy peers;
  //   - it must not have outlived its own announced transition, which is exactly what a CDN serves at a
  //     reopen. Without this the rule inverts and one stale object shuts the cohort.
  // The whole pass also stands down for two minutes after a published session start, where laggards are
  // by construction the objects still reading shut.
  if (method.venueCoherence) {
    const OPEN_LABELS = new Set(["market", "extended", "overnight"]);
    const groups = new Map<string, number[]>();
    claims.forEach((c, i) => {
      if (modes[i] === null) return; // no usable body: it proves nothing about its peers
      const key = `${assets[i].mic}|${modes[i]}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    for (const [key, idx] of groups) {
      if (justStarted(scheds[idx[0]], input.evaluatedAtMs)) continue;
      const shutOnPrimary = idx.filter((i) =>
        shut(claims[i]) && !claims[i].halted && claims[i].degraded.length === 0
        && !OPEN_LABELS.has(periods[i] ?? "")
        && !(apiNextS[i] > 0 && apiNextS[i] * 1000 <= input.evaluatedAtMs));
      if (shutOnPrimary.length === 0) continue;
      const witness = claims[shutOnPrimary[0]].symbol;
      for (const i of idx) {
        if (shut(claims[i]) || claims[i].degraded.length > 0) continue;
        close(claims[i], i, "venue-cohort-shut", `COHORT-INCOHERENT ${key} shut per ${witness}`);
      }
    }
  }

  // The observation, taken after coherence (which is this round's own evidence) and before any hold.
  const observed: PriorObservation = {
    evaluatedAtMs: input.evaluatedAtMs,
    claims: Object.fromEntries(claims.map((c) => [c.wrapper.toLowerCase(), { regime: c.regime, capUsd: c.capUsd.toString() }])),
  };

  // Pass 2: confirm before open. Reopening is the one direction where being wrong lets a consumer act on
  // capacity that does not exist, so it takes two consecutive observations. Closing stays immediate.
  if (method.confirmBeforeOpen) {
    const prior = input.prior ?? null;
    const usable = prior !== null && input.evaluatedAtMs - prior.evaluatedAtMs <= PRIOR_MAX_AGE_MS && input.evaluatedAtMs >= prior.evaluatedAtMs;
    for (const c of claims) {
      if (shut(c)) continue;
      const p = usable ? prior!.claims[c.wrapper.toLowerCase()] : undefined;
      if (p === undefined) {
        // Nothing to confirm against (first round after a restart, or a newly registered asset).
        c.degraded = [...c.degraded, "open-unconfirmed"];
        continue;
      }
      if (p.regime === Regime.CLOSED || p.regime === Regime.UNKNOWN) {
        close(c, claims.indexOf(c), "awaiting-reopen-confirmation", "HOLD the previous observation had it shut");
      }
    }
  }

  return { claims, observed };
}

export function derive(input: DeriveInput, methodId: string = METHOD_VERSION): Claim[] {
  return deriveDetailed(input, methodId).claims;
}

/** Positional arguments for MarketClock.attestBatch, in the contract's exact types. */
export function toAttestBatchArgs(claims: Claim[], inputRoot: string) {
  return [
    claims.map((c) => c.wrapper),
    claims.map((c) => c.regime),
    claims.map((c) => c.capUsd),
    claims.map((c) => BigInt(c.nextAt)),
    claims.map((c) => c.halted),
    inputRoot,
  ] as const;
}
