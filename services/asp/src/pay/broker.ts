/**
 * The OKX Broker, with deadlines.
 *
 * OKXFacilitatorClient reaches the Broker with a bare fetch and no AbortSignal, so the only limit on a
 * Broker that accepts the connection and then says nothing is undici's 300-second headers timeout. Every
 * await on it inherited that: the tick stalled on /supported (no timeline warm, no `ticks++`, and on a
 * first boot a failed Railway healthcheck), and every paid request sat on verify or settle for five
 * minutes. So every call goes through here, raced against a deadline, and every way a call can fail comes
 * out as one error type the flow can reason about.
 *
 * What a missed deadline MEANS differs by call, and that difference is the whole point:
 *   supported, verify   nothing has moved. It is a plain failure: payments stay unready and the tick
 *                       retries, or the request is refused with a 503 before anything is built or settled.
 *   settle              the transfer may already have been submitted, and a gateway 504 in the middle of
 *                       a sync settle looks exactly the same from here. So a timeout OR any error is
 *                       "outcome unknown", never "failed": the flow then asks the chain whether this
 *                       authorization was used (ledger.ts), and never guesses.
 *   status              the SDK's own poll after the Broker reports that its sync wait timed out. A missed
 *                       deadline there is one more "still pending", which the SDK already tolerates.
 *
 * Settle gets the longest deadline because a sync settle waits for the transfer to mine; hitting it costs
 * nothing but a trip to the chain. The race does not cancel the underlying fetch -- the SDK takes no
 * signal -- so a hung call keeps its socket until undici gives up. It no longer holds anything of ours.
 *
 * Failures are BrokerError, a FacilitatorResponseError. x402-core rethrows that class from both
 * processHTTPRequest and processSettlement instead of folding it into a 402, which is how a Broker outage
 * reaches the flow as an outage rather than as "your payment is invalid" or "settlement failed".
 */
import { FacilitatorResponseError } from "@okxweb3/x402-core/server";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";

export type BrokerCall = "supported" | "verify" | "settle" | "status";

export interface BrokerDeadlines {
  supportedMs: number;
  verifyMs: number;
  settleMs: number;
  statusMs: number;
}

export const DEFAULT_BROKER_DEADLINES: BrokerDeadlines = { supportedMs: 10_000, verifyMs: 10_000, settleMs: 30_000, statusMs: 4_000 };

export class BrokerError extends FacilitatorResponseError {
  readonly call: BrokerCall;
  /** True when the Broker gave no answer in time; false when it answered with an error, or the call threw. */
  readonly timedOut: boolean;

  // Explicit fields rather than constructor parameter properties: Node's type stripping only accepts
  // erasable TypeScript syntax.
  constructor(call: BrokerCall, timedOut: boolean, message: string, cause?: unknown) {
    super(message);
    this.name = "BrokerError";
    this.call = call;
    this.timedOut = timedOut;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function asBrokerError(call: BrokerCall, e: unknown): BrokerError {
  if (e instanceof BrokerError) return e;
  // OKXFacilitatorClient's own messages carry only the HTTP status ("OKX settle failed: 504"), and a fetch
  // failure only its cause code, so nothing here can echo a credential.
  return new BrokerError(call, false, `Broker ${call} failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), e);
}

function withDeadline<T>(call: BrokerCall, ms: number, start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrokerError(call, true, `Broker ${call} gave no answer within ${ms} ms`)), ms);
    let pending: Promise<T>;
    try { pending = start(); } catch (e) { clearTimeout(timer); reject(asBrokerError(call, e)); return; }
    pending.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(asBrokerError(call, e)); },
    );
  });
}

/**
 * The same Broker, bounded. Methods are looked up on `inner` at call time, so a test that swaps one on its
 * stub after construction is still honoured.
 */
export function withDeadlines(inner: FacilitatorClient, d: BrokerDeadlines): FacilitatorClient {
  const bounded: FacilitatorClient = {
    getSupported: () => withDeadline("supported", d.supportedMs, () => inner.getSupported()),
    verify: (payload, requirements) => withDeadline("verify", d.verifyMs, () => inner.verify(payload, requirements)),
    settle: (payload, requirements) => withDeadline("settle", d.settleMs, () => inner.settle(payload, requirements)),
  };
  // Only when the Broker has one: the SDK skips its status poll entirely for a client without it.
  if (typeof inner.getSettleStatus === "function") {
    bounded.getSettleStatus = (tx) => withDeadline("status", d.statusMs, () => inner.getSettleStatus!(tx));
  }
  return bounded;
}
