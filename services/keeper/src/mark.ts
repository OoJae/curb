/**
 * The mark: what Curb says an asset is worth while its primary market is shut.
 *
 * This is the one function the Scorecard grades, so it is pure and versioned exactly like the
 * attestor's derive(): same inputs in, same mark out, method id committed in every row and pinned
 * on chain in `Commitment.methodDigest`. A row stays re-derivable forever, under the rules that
 * produced it, even after the rules change.
 *
 * curb.scorecard.mark/1
 * ---------------------
 * The baselines it is graded against -- the last print before the closure, and the pool VWAP at the
 * bell -- both answer "what was it worth when trading stopped". Neither uses anything that happened
 * afterwards. But the AMM keeps trading through the closure, because nothing stops it: that is the
 * whole thesis. So the mark starts from the last print and moves it by what the pool did during the
 * closure, DAMPED, because a price nobody can arbitrage overshoots: with creation and redemption
 * switched off, there is no mechanism pulling the pool back to the underlying, so its move is
 * evidence about direction and only partial evidence about size.
 *
 *     mark = lastPrint x (1 + LAMBDA x drift),  LAMBDA = 0.5
 *
 * When the pool does not trade at all through a closure -- the likely case for a thin Hong Kong
 * book at 3am -- there is no drift, the mark equals the last print, and the row says so. It then
 * ties the baseline rather than beating it. That is the honest outcome, and `skill()` counts strict
 * wins only, so a tie is not a win. A method that pretended to information it did not have is
 * exactly what the Scorecard exists to expose.
 *
 * curb.scorecard.mark/2 (D-11: fifteen rows, fifteen ties)
 * --------------------------------------------------------
 * The pools did not trade in a single closure, so mark/1 could only ever tie. mark/2 adds a signal
 * from markets that DO trade while HKEX is shut, and moves the last print by it:
 *
 *     mark = lastPrint x (1 + BETA x r),   r = mean of the legs that exist,   BETA = 0.79
 *
 *   perp leg   Binance USD-M perpetual on the same share (HK0700USDT, HK1810USDT, MEITUANUSDT), close
 *              of the last closed minute before the commit over the close of the minute that closed at
 *              the cut. 24/7, keyless, and a closed minute's bytes are identical on refetch, so anyone
 *              can fetch the same minute and check the committed hash.
 *   ADR leg    the US ADR (TCEHY 1 share, XIACY 5, MPNGY 2) at the close of the last US regular session
 *              that ended inside the closure, times USD/HKD, over the primary's own close for the session
 *              the cut ended. There is no ADR print AT the cut (the US is shut at 07:55Z), and the ADR's
 *              previous close predates the Hong Kong session the last print already contains, so the base
 *              is the primary close. Yahoo serves these bytes; they are committed as fetched, but Yahoo
 *              does not return identical bytes twice, so this leg is checkable against the committed bytes
 *              and not by a refetch.
 *
 * Returns only, so the perp's quote unit (HKD for HK0700USDT, USD for MEITUANUSDT) and the wrapper's
 * multiplier both cancel. BETA was fitted, not chosen: 118 overnight closures, 22 Jul - 22 Sep 2026
 * (every night the perps existed, stopping BEFORE the six overnight rows D-11 reports), HK open over HK
 * close regressed through the origin on r: fit 0.983 (se 0.093), R^2 (uncentred) 0.49; published damped
 * as round(0.8 x fit, 2) = 0.79, because a fit on two months of one regime overstates its own precision.
 *
 * Where the signal is NOT applied, and why. A closure shorter than MIN_SIGNAL_CLOSURE_S (the 65-minute
 * Hong Kong lunch recess) has no US session inside it, and the perp's recess move was measured and LOST
 * to the last print on all three names over 23 recesses (even at half weight). So a recess gets weight
 * zero: the perp's move is still fetched and committed as evidence, flagged `recess-no-edge`, and the mark
 * is exactly what mark/1 would have said. Likewise when both legs are missing (`no-signal`) or the asset
 * has no proxy (`no-proxy`: the US names, whose only long closures are weekends when their underlying does
 * not trade either). mark/2 never invents a move, and without a cross-market term it IS mark/1.
 *
 * When the signal is applied, the pool's own drift is not added to it: an arbitrageur trading the pool
 * toward the ADR would otherwise be counted twice. The drift is still recorded (`drift-superseded`).
 */

export interface MarkMethod {
  /** How much of the pool's unarbitraged move to keep, in basis points of the drift. */
  lambdaBps: number;
  /** The published band never claims more precision than this. */
  bandFloorBps: number;
  bandCapBps: number;
  /** How long before the cut the closing VWAP is measured over. */
  closingVwapWindowMs: number;
  /** mark/2: how much of the cross-market return r to apply, in basis points of r. */
  betaBps?: number;
  /** mark/2: closures shorter than this carry no cross-market term (the lunch recess). */
  minSignalClosureS?: number;
  /** mark/2: a leg whose return exceeds this in magnitude is treated as a bad print, not a move. */
  maxLegBps?: number;
}

export const MARK1 = "curb.scorecard.mark/1";
export const MARK2 = "curb.scorecard.mark/2";

export const MARK_METHODS: Record<string, MarkMethod> = {
  [MARK1]: { lambdaBps: 5_000, bandFloorBps: 25, bandCapBps: 2_000, closingVwapWindowMs: 15 * 60_000 },
  [MARK2]: {
    lambdaBps: 5_000, bandFloorBps: 25, bandCapBps: 2_000, closingVwapWindowMs: 15 * 60_000,
    betaBps: 7_900, minSignalClosureS: 4 * 3600, maxLegBps: 2_000,
  },
};

export const MARK_METHOD_VERSION = MARK2;

/** Does this method carry a cross-market term at all? */
export const hasSignal = (methodId: string): boolean => MARK_METHODS[methodId]?.betaBps !== undefined;

/**
 * The cross-market proxies, keyed by wrapper symbol. Part of the method: a row names the rules that made
 * it, and these are rules. Committed in every mark/2 PARAMS leaf.
 */
export interface SignalProxy {
  /** Binance USD-M perpetual on the same ordinary share. */
  perp: string;
  /** The US ADR on Yahoo, and how many ordinary shares one ADR represents. */
  adr: string;
  sharesPerAdr: number;
  /** The primary listing on Yahoo, whose close the ADR-implied price is compared against. */
  primary: string;
  primaryCurrency: string;
  /** Yahoo's USD -> primary-currency rate. */
  fx: string;
}

export const SIGNAL_PROXIES: Record<string, SignalProxy> = {
  wTCENTx: { perp: "HK0700USDT", adr: "TCEHY", sharesPerAdr: 1, primary: "0700.HK", primaryCurrency: "HKD", fx: "HKD=X" },
  wXIAOx: { perp: "HK1810USDT", adr: "XIACY", sharesPerAdr: 5, primary: "1810.HK", primaryCurrency: "HKD", fx: "HKD=X" },
  wMEITx: { perp: "MEITUANUSDT", adr: "MPNGY", sharesPerAdr: 2, primary: "3690.HK", primaryCurrency: "HKD", fx: "HKD=X" },
};

/** The perp leg, as read from two committed klines. Prices are decimal E18 strings. */
export interface PerpLeg {
  symbol: string;
  cutMinuteMs: number;
  commitMinuteMs: number;
  cutE18: string;
  commitE18: string;
}

/** The ADR leg, as read from three committed Yahoo charts. Prices are decimal E18 strings. */
export interface AdrLeg {
  adr: string;
  /** End of the US regular session whose close is used (unix s), and the close. */
  sessionEndS: number;
  adrCloseE18: string;
  /** USD -> primary currency, from the last FX bar at or before the session end. */
  fxE18: string;
  sharesPerAdr: number;
  /** adrClose x fx / sharesPerAdr: what the ADR says one primary share is worth. */
  impliedE18: string;
  primary: string;
  primarySessionEndS: number;
  primaryCloseE18: string;
}

/**
 * Everything mark/2 knows beyond the pool, re-derivable from the committed bytes by `deriveSignal`
 * (sources/signal.ts). A verifier never trusts these numbers: it re-reads them from the bytes and
 * requires the result to equal what was committed.
 */
export interface SignalInput {
  /** settleAfter minus the observed cut, in whole seconds. */
  closureS: number;
  /** The wrapper symbol the proxy was looked up by, or null when the asset has none. */
  proxy: string | null;
  perp: PerpLeg | null;
  adr: AdrLeg | null;
  /** Why each absent leg is absent, in the order checked. */
  missing: string[];
}

export interface ClosureInput {
  wrapper: string;
  symbol: string;
  /** Last pool mid observed while the primary market still had capacity. */
  lastPrintE18: bigint;
  /** Pool mid at the first observation after capacity went to zero. */
  midAtCutE18: bigint;
  /** Pool mid now. */
  midNowE18: bigint;
  /** Volume-weighted price over the window before the cut; null when nothing traded. */
  closingVwapE18: bigint | null;
  /** How many swaps the pool saw between the cut and now. */
  swapsDuringClosure: number;
  /** mark/2 only: the cross-market evidence. Absent (or null legs) means no cross-market term. */
  signal?: SignalInput;
}

/** What the cross-market term did, recorded in every mark/2 row whether or not it was applied. */
export interface MarkSignal {
  betaBps: number;
  /** Each leg's return in basis points, undamped; null when the leg is absent or implausible. */
  perpBps: number | null;
  adrBps: number | null;
  /** The combined return (mean of the legs that exist), undamped; null when there are none. */
  rBps: number | null;
  /** The move actually applied to the last print, in basis points. Zero whenever `applied` is false. */
  appliedBps: number;
  applied: boolean;
  missing: string[];
}

export interface Mark {
  markE18: bigint;
  bandBps: number;
  lastPrintE18: bigint;
  closingVwapE18: bigint;
  /** Signed, in basis points: what the pool did during the closure before damping. */
  driftBps: number;
  flags: string[];
  reason: string;
  /** mark/2 only. */
  signal?: MarkSignal;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/** (a - b) / b in whole basis points, truncated toward zero. Null when the base is not positive. */
export function retBps(aE18: bigint, bE18: bigint): number | null {
  if (bE18 <= 0n || aE18 <= 0n) return null;
  return Number(((aE18 - bE18) * 10_000n) / bE18);
}

/** The ADR-implied primary price: adrClose x fx / sharesPerAdr, in integer E18 arithmetic. */
export function impliedE18(adrCloseE18: bigint, fxE18: bigint, sharesPerAdr: number): bigint {
  return (adrCloseE18 * fxE18) / 10n ** 18n / BigInt(sharesPerAdr);
}

/** The two legs' returns, with implausible ones set aside. Exported so logs and tests read the same numbers. */
export function signalLegs(s: SignalInput, m: MarkMethod): { perpBps: number | null; adrBps: number | null; flags: string[] } {
  const flags: string[] = [];
  const cap = m.maxLegBps ?? Number.MAX_SAFE_INTEGER;
  let perpBps = s.perp ? retBps(BigInt(s.perp.commitE18), BigInt(s.perp.cutE18)) : null;
  if (perpBps !== null && Math.abs(perpBps) > cap) { flags.push("perp-implausible"); perpBps = null; }
  let adrBps = s.adr ? retBps(BigInt(s.adr.impliedE18), BigInt(s.adr.primaryCloseE18)) : null;
  if (adrBps !== null && Math.abs(adrBps) > cap) { flags.push("adr-implausible"); adrBps = null; }
  return { perpBps, adrBps, flags };
}

/**
 * @returns the mark, or null when there is not enough evidence to assert one at all. Returning null
 *          is a real answer: a row that cannot be honestly marked should never be committed, because
 *          the contract has no revision path and a wrong row is permanent.
 */
export function computeMark(input: ClosureInput, methodId: string = MARK_METHOD_VERSION): Mark | null {
  const m = MARK_METHODS[methodId];
  if (!m) throw new Error(`unknown mark method ${methodId}`);

  const flags: string[] = [];
  if (input.lastPrintE18 <= 0n) return null;
  if (input.midAtCutE18 <= 0n) return null;

  // Drift, signed, in basis points of the price at the cut.
  let driftBps = 0;
  if (input.swapsDuringClosure === 0) {
    flags.push("no-drift");
  } else if (input.midNowE18 <= 0n) {
    flags.push("no-current-mid");
  } else {
    const delta = input.midNowE18 - input.midAtCutE18;
    driftBps = Number((delta * 10_000n) / input.midAtCutE18);
  }

  // mark/2: the cross-market term, when there is one to apply.
  let signal: MarkSignal | undefined;
  if (m.betaBps !== undefined) {
    const s = input.signal;
    const legs = s ? signalLegs(s, m) : { perpBps: null, adrBps: null, flags: [] as string[] };
    flags.push(...legs.flags);
    const have = [legs.perpBps, legs.adrBps].filter((x): x is number => x !== null);
    const rBps = have.length === 0 ? null : have.length === 1 ? have[0] : Math.trunc((have[0] + have[1]) / 2);
    let applied = false;
    if (!s) {
      flags.push("no-signal");
    } else if (s.proxy === null) {
      flags.push("no-proxy", "no-signal");
    } else if (s.closureS < (m.minSignalClosureS ?? 0)) {
      // Measured, and it lost: the recess move is evidence only.
      flags.push("recess-no-edge");
    } else if (rBps === null) {
      flags.push("no-signal");
    } else {
      applied = true;
      if (legs.perpBps === null) flags.push("perp-missing");
      if (legs.adrBps === null) flags.push("adr-missing");
      if (driftBps !== 0) flags.push("drift-superseded");
    }
    const appliedBps = applied ? Math.trunc((m.betaBps * (rBps as number)) / 10_000) : 0;
    signal = {
      betaBps: m.betaBps, perpBps: legs.perpBps, adrBps: legs.adrBps, rBps, appliedBps, applied,
      missing: s ? [...s.missing] : ["no-signal-input"],
    };
  }

  // mark = lastPrint x (1 + weight x move), in integer arithmetic throughout. Without an applied signal
  // this is exactly mark/1.
  const adjNum = signal?.applied
    ? BigInt(m.betaBps!) * BigInt(signal.rBps!)          // bps x bps
    : BigInt(m.lambdaBps) * BigInt(driftBps);            // bps x bps
  const markE18 = input.lastPrintE18 + (input.lastPrintE18 * adjNum) / 100_000_000n;
  if (markE18 <= 0n) return null;

  let closingVwapE18 = input.closingVwapE18 ?? 0n;
  if (closingVwapE18 <= 0n) {
    // The baseline still has to be recorded, and the honest stand-in for "the VWAP at the bell" when
    // nothing traded at the bell is the last print itself.
    closingVwapE18 = input.lastPrintE18;
    flags.push("no-closing-vwap");
  }

  const moveBps = signal?.applied ? signal.rBps! : driftBps;
  const bandBps = Math.min(m.bandCapBps, Math.max(m.bandFloorBps, m.bandFloorBps + Math.floor(Math.abs(moveBps) / 2)));

  let reason =
    `lastPrint=${input.lastPrintE18} midAtCut=${input.midAtCutE18} midNow=${input.midNowE18} ` +
    `swaps=${input.swapsDuringClosure} driftBps=${driftBps} lambdaBps=${m.lambdaBps}`;
  if (signal) {
    reason += ` perpBps=${signal.perpBps} adrBps=${signal.adrBps} rBps=${signal.rBps} betaBps=${signal.betaBps}` +
      ` appliedBps=${signal.appliedBps} closureS=${input.signal?.closureS ?? null}`;
  }

  const out: Mark = { markE18, bandBps, lastPrintE18: input.lastPrintE18, closingVwapE18, driftBps, flags, reason };
  if (signal) out.signal = signal;
  return out;
}

/** The damped move, expressed as the basis points actually applied. Used in logs and the bundle. */
export function appliedBps(driftBps: number, methodId: string = MARK_METHOD_VERSION): number {
  return Math.trunc((driftBps * MARK_METHODS[methodId].lambdaBps) / 10_000);
}

export { abs as absBigint };
