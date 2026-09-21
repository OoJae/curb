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
 */

export interface MarkMethod {
  /** How much of the pool's unarbitraged move to keep, in basis points of the drift. */
  lambdaBps: number;
  /** The published band never claims more precision than this. */
  bandFloorBps: number;
  bandCapBps: number;
  /** How long before the cut the closing VWAP is measured over. */
  closingVwapWindowMs: number;
}

export const MARK_METHODS: Record<string, MarkMethod> = {
  "curb.scorecard.mark/1": { lambdaBps: 5_000, bandFloorBps: 25, bandCapBps: 2_000, closingVwapWindowMs: 15 * 60_000 },
};

export const MARK_METHOD_VERSION = "curb.scorecard.mark/1";

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
}

const abs = (x: bigint) => (x < 0n ? -x : x);

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

  // mark = lastPrint x (1 + lambda x drift), in integer arithmetic throughout.
  const adjNum = BigInt(m.lambdaBps) * BigInt(driftBps); // bps x bps
  const markE18 = input.lastPrintE18 + (input.lastPrintE18 * adjNum) / 100_000_000n;
  if (markE18 <= 0n) return null;

  let closingVwapE18 = input.closingVwapE18 ?? 0n;
  if (closingVwapE18 <= 0n) {
    // The baseline still has to be recorded, and the honest stand-in for "the VWAP at the bell" when
    // nothing traded at the bell is the last print itself.
    closingVwapE18 = input.lastPrintE18;
    flags.push("no-closing-vwap");
  }

  const bandBps = Math.min(m.bandCapBps, Math.max(m.bandFloorBps, m.bandFloorBps + Math.floor(Math.abs(driftBps) / 2)));

  const reason =
    `lastPrint=${input.lastPrintE18} midAtCut=${input.midAtCutE18} midNow=${input.midNowE18} ` +
    `swaps=${input.swapsDuringClosure} driftBps=${driftBps} lambdaBps=${m.lambdaBps}`;

  return { markE18, bandBps, lastPrintE18: input.lastPrintE18, closingVwapE18, driftBps, flags, reason };
}

/** The damped move, expressed as the basis points actually applied. Used in logs and the bundle. */
export function appliedBps(driftBps: number, methodId: string = MARK_METHOD_VERSION): number {
  return Math.trunc((driftBps * MARK_METHODS[methodId].lambdaBps) / 10_000);
}

export { abs as absBigint };
