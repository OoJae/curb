/**
 * One priced request, start to finish. The ORDER is the product:
 *
 *   1. free checks      payments configured, a handler for the route. A "no" here is a plain 503.
 *   2. the payment      PAYMENT-SIGNATURE is decoded here, once. An undecodable header is an unpaid call
 *                       (402 and the preview): the SDK never sees it, because it prints a multi-line stack
 *                       trace for every header it cannot decode, and a junk header costs a caller nothing.
 *                       A payment that is not an EIP-3009 authorization is refused (400): nothing below
 *                       could account for it. One the ledger has already seen -- in flight, unconfirmed or
 *                       settled -- is answered from the ledger (ledger.ts) and never reaches the Broker again.
 *   3. free checks      request well-formed, answer buildable right now: a 4xx/503 with no challenge, so
 *                       nobody signs anything for a request that cannot succeed.
 *   4. challenge/verify the SDK answers 402 (challenge in PAYMENT-REQUIRED, truthful preview in the body),
 *                       or the Broker confirms the signed payment is valid. Verifying moves no money; a
 *                       Broker that errors or stalls here is a 503, and nothing was charged. A payment the
 *                       local pre-check can already see is unusable (precheck.ts) is a 402 naming why,
 *                       before the Broker is asked.
 *   5. build            the paid answer, serialised to its exact bytes, BEFORE any money moves. If it
 *                       cannot be built -- the issuer went dark while the payment was being verified --
 *                       the answer is 503 and the payment is simply never settled.
 *   6. still there?     if the buyer's socket closed while we verified and built, stop: the authorization
 *                       expires unused, and nobody is charged for an answer nobody is waiting for.
 *   7. record, settle   the ledger records the payment and those bytes, fsynced, and only then does the
 *                       Broker settle.
 *   8. deliver          receipt written, then the same bytes with its id in x-curb-receipt.
 *
 * When settle does not come back a success, the flow does not guess. It asks the chain whether this
 * authorization was used by a transaction that pays PAY_TO the price (authorization.ts): if so, the
 * payment happened, and step 8 runs as normal. If not -- or not yet -- the record stays in the ledger, the
 * reconciler keeps asking until validBefore has passed, and the buyer is told which case it is: 503
 * settlement-unconfirmed when the outcome is unknown (the Broker timed out or errored, possibly after
 * submitting the transfer), the SDK's 402 when the Broker refused outright. Either way, presenting the SAME
 * header again is safe: it is never charged twice, and once the chain shows the payment, that request gets
 * the bytes that were built for it.
 *
 * What is left: the socket can close after step 6 and before the bytes land. The payment then still has a
 * receipt (it is written before the bytes go out); when the socket is already gone by then, the bytes are
 * kept for redelivery; if it dies a moment after, presenting the same header returns the receipt (409).
 */
import type { ServerResponse } from "node:http";
import { decodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import type { HTTPAdapter, HTTPProcessResult, HTTPRequestContext, ProcessSettleResultResponse } from "@okxweb3/x402-core/server";
import type { PaymentPayload } from "@okxweb3/x402-core/types";
import type { BilledQuery, Payments, PricedHandler } from "./server.ts";
import type { PricedRoute } from "./routes.ts";
import { payloadDigestOf } from "./receipt.ts";
import { authorizationKey, authorizationOf, settlementScope } from "./authorization.ts";
import type { AuthorizationChain, Eip3009Authorization } from "./authorization.ts";
import { askChain, chainSettlementHeaders, PENDING_SCHEMA } from "./ledger.ts";
import type { AuthorizationLedger, ChainVerdict, PendingSettlement } from "./ledger.ts";
import { BrokerError } from "./broker.ts";
import { precheckScope } from "./precheck.ts";
import type { PrecheckRefusal } from "./precheck.ts";
import type { NodeHttpAdapter } from "../http/adapter.ts";
import { applyInstructions, send, sendJson } from "../http/respond.ts";
import type { Log } from "../log.ts";

export interface PricedDeps {
  payments: Payments;
  handler: PricedHandler | undefined;
  route: PricedRoute;
  ledger: AuthorizationLedger;
  /** The chain reads that settle an unknown outcome. Null means the outcome stays pending in the ledger. */
  chain: AuthorizationChain | null;
  /** Real time to keep asking the chain after an unknown settle before answering 503 settlement-unconfirmed. */
  inlineReconcileMs: number;
  /** Throttled by the caller: an undecodable header is free to send, so it may cost at most a line a minute. */
  noteUndecodable: (fields: Record<string, unknown>) => void;
  now: () => number;
  log: Log;
}

const CONTENT_TYPE = "application/json; charset=utf-8";
/** Between two chain checks while a request waits on an unknown settle. X Layer makes a block a second. */
const RECHECK_MS = 1_500;

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

/** The buyer's socket is gone: nothing written now will arrive. */
export function clientGone(res: ServerResponse): boolean {
  const s = res.socket;
  return res.destroyed || !s || s.destroyed || !s.writable;
}

/** The request as the SDK should see it when its payment header is junk: an unpaid call. */
function withoutPayment(a: HTTPAdapter): HTTPAdapter {
  return {
    getHeader: (name) => (name.toLowerCase() === "payment-signature" ? undefined : a.getHeader(name)),
    getMethod: () => a.getMethod(),
    getPath: () => a.getPath(),
    getUrl: () => a.getUrl(),
    getAcceptHeader: () => a.getAcceptHeader(),
    getUserAgent: () => a.getUserAgent(),
    getQueryParams: () => a.getQueryParams?.() ?? {},
    getQueryParam: (name) => a.getQueryParam?.(name),
    getBody: () => a.getBody?.(),
  };
}

interface Presented {
  auth: Eip3009Authorization;
  key: string;
  /** keccak256 of the canonical payload: a ledger record only answers a header whose payload matches its own. */
  digest: string;
}

export async function servePriced(res: ServerResponse, adapter: NodeHttpAdapter, d: PricedDeps): Promise<void> {
  const { payments: p, handler: h, route } = d;

  // 1. Free checks.
  if (!p.configured || !p.http) return sendJson(res, 503, { error: "payments-not-configured" });
  if (!h) return sendJson(res, 503, { error: "not-yet-available", route: route.path });

  // 2. The payment, decoded once, here.
  let sdkAdapter: HTTPAdapter = adapter;
  let presented: Presented | null = null;
  const header = adapter.getHeader("payment-signature");
  if (header) {
    let decoded: unknown = null;
    try {
      decoded = decodePaymentSignatureHeader(header);
    } catch (e) {
      d.noteUndecodable({ route: route.key, headerBytes: header.length, reason: e instanceof SyntaxError ? "not-json" : "not-base64" });
      sdkAdapter = withoutPayment(adapter);
    }
    // A header that decodes to nothing (`null`) is what the SDK itself treats as unpaid; so do we.
    if (decoded) {
      const auth = authorizationOf(decoded);
      if (!auth) {
        return sendJson(res, 400, {
          error: "unsupported-payment",
          detail: "this service settles x402 `exact` on X Layer as an EIP-3009 transferWithAuthorization of USD₮0: the payload must carry " +
            "payload.authorization {from, to, value, validAfter, validBefore, nonce} and payload.signature, with no other assetTransferMethod",
        });
      }
      presented = { auth, key: authorizationKey(auth), digest: payloadDigestOf(decoded as PaymentPayload) };
      if (await answeredFromLedger(res, d, presented)) return;
    }
  }

  // 3. Free checks on the request itself.
  const accepted = h.accept(adapter, d.now());
  if (!accepted.ok) return sendJson(res, accepted.status, accepted.body);
  if (!p.ready) return sendJson(res, 503, { error: "payments-unavailable" });

  if (!presented) return challenge(res, sdkAdapter, d);
  // claim() re-checks everything synchronously, so it is the real guard against a second request carrying
  // the same payment; answeredFromLedger() above only chose the reply.
  if (!d.ledger.claim(presented.key)) return inUse(res);
  try {
    await verifyBuildSettle(res, sdkAdapter, accepted.query, presented, d);
  } finally {
    d.ledger.release(presented.key);
  }
}

/** An unpaid call: the SDK's 402, with the challenge and the preview. */
async function challenge(res: ServerResponse, adapter: HTTPAdapter, d: PricedDeps): Promise<void> {
  let processed: HTTPProcessResult;
  try {
    processed = await d.payments.http!.processHTTPRequest({ adapter, path: adapter.getPath(), method: adapter.getMethod() });
  } catch (e) {
    d.log("challenge-error", { route: d.route.key, error: describe(e) });
    return sendJson(res, 502, { error: "facilitator-error" });
  }
  if (processed.type === "payment-error") return applyInstructions(res, processed.response);
  // No payment can have been verified without one being presented; anything else means the SDK and our
  // table disagree about the route. Fail closed.
  d.log("priced-route-unmatched", { route: d.route.key, result: processed.type });
  return sendJson(res, 500, { error: "route-not-priced" });
}

function inUse(res: ServerResponse): void {
  sendJson(res, 409, {
    error: "payment-in-use",
    detail: "another request is using this payment authorization right now; each payment buys one answer",
  }, { "retry-after": "5" });
}

function unconfirmed(res: ServerResponse, pending: PendingSettlement): void {
  if (pending.refused !== null) {
    sendJson(res, 402, {
      error: "settlement-failed",
      reason: pending.refused,
      detail: "the Broker refused to settle this payment, and it will not be settled again: sign a new one. If the chain ever " +
        "shows this authorization used before validBefore, presenting it again returns the answer it paid for.",
      transaction: pending.transaction,
    });
    return;
  }
  sendJson(res, 503, {
    error: "settlement-unconfirmed",
    detail: "the Broker could not confirm this payment and the chain does not show it (yet). Nothing is charged unless the chain " +
      "shows this authorization used before validBefore. Send this same request again with the SAME PAYMENT-SIGNATURE, not a new " +
      "one: it is never charged twice, and once the chain shows the payment it returns the answer that was built for it.",
    transaction: pending.transaction,
    validBefore: pending.validBefore,
  }, { "retry-after": "15" });
}

/** A payment the ledger has seen. Returns true when it answered the request. */
async function answeredFromLedger(res: ServerResponse, d: PricedDeps, x: Presented): Promise<boolean> {
  let seen = d.ledger.lookup(x.key);
  // An unconfirmed payment presented again, by its own buyer: ask the chain now rather than make them wait
  // for the reconciler (the ledger caps how often it asks).
  if (seen.state === "unconfirmed" && seen.pending.payloadDigest === x.digest && d.chain) {
    await d.ledger.reconcile(x.key, d.chain);
    seen = d.ledger.lookup(x.key);
  }
  switch (seen.state) {
    case "free":
      return false;
    case "in-flight":
      inUse(res);
      return true;
    case "unconfirmed":
      if (seen.pending.payloadDigest === x.digest) unconfirmed(res, seen.pending);
      else inUse(res);
      return true;
    case "settled": {
      const s = seen.settled;
      // Details only for the exact payload that bought it: (payer, nonce) alone is public once mined.
      const own = s.payloadDigest === x.digest;
      if (own && s.redeliver && s.route === d.route.key) {
        d.log("redelivered", { route: s.route, receipt: s.receiptId, transaction: s.transaction, payer: s.payer });
        send(res, 200, Buffer.from(s.redeliver.body, "base64"), s.redeliver.headers);
        return true;
      }
      sendJson(res, 409, {
        error: "payment-already-used",
        detail: "this payment authorization has already bought an answer; each payment buys one",
        ...(own ? { route: s.route, receiptId: s.receiptId || null, receipt: s.receiptId ? `/receipts/${s.receiptId}.json` : null } : {}),
      });
      return true;
    }
  }
}

async function verifyBuildSettle(res: ServerResponse, adapter: HTTPAdapter, query: BilledQuery, x: Presented, d: PricedDeps): Promise<void> {
  const { route, handler: h } = d;
  const http = d.payments.http!;

  // 4. Verify: the local pre-check (precheck.ts, run by the SDK's onBeforeVerify hook), then the Broker.
  const ctx: HTTPRequestContext = { adapter, path: adapter.getPath(), method: adapter.getMethod(), paymentHeader: adapter.getHeader("payment-signature") };
  const precheck: { refusal: PrecheckRefusal | null } = { refusal: null };
  let processed: HTTPProcessResult;
  try {
    processed = await precheckScope.run(precheck, () => http.processHTTPRequest(ctx));
  } catch (e) {
    d.log("verify-error", { route: route.key, error: describe(e) });
    if (e instanceof BrokerError) {
      return sendJson(res, 503, { error: "broker-unavailable", stage: e.call, timedOut: e.timedOut, detail: "the payment was not charged; retry" }, { "retry-after": "10" });
    }
    return sendJson(res, 502, { error: "facilitator-error" });
  }
  if (processed.type === "payment-error") {
    // Refused here, not by the Broker: the SDK's 402 and challenge, with the reason and detail in the body.
    const r = precheck.refusal;
    if (r) return applyInstructions(res, { ...processed.response, body: { error: "payment-invalid", reason: r.reason, detail: r.detail } }, { "content-type": CONTENT_TYPE });
    return applyInstructions(res, processed.response);
  }
  if (processed.type !== "payment-verified") {
    // The SDK thinks this path is free. It is in our priced table, so something disagrees about the
    // route: fail closed rather than serve a priced answer for nothing.
    d.log("priced-route-unmatched", { route: route.key, path: ctx.path });
    return sendJson(res, 500, { error: "route-not-priced" });
  }

  // 5. Build the answer before any money moves.
  let built: ReturnType<PricedHandler["build"]>;
  try {
    built = h!.build(query, d.now());
  } catch (e) {
    d.log("build-error", { route: route.key, error: describe(e) });
    built = { ok: false, status: 500, body: { error: "internal" } };
  }
  if (!built.ok) {
    d.log("answer-refused-not-settled", { route: route.key, status: built.status, error: built.body.error });
    return sendJson(res, built.status, built.body);
  }
  const bytes = Buffer.from(JSON.stringify(built.body));

  // 6. Is anyone still waiting for it?
  if (clientGone(res)) {
    d.log("client-gone-not-settled", { route: route.key, payer: x.auth.payer });
    return;
  }

  // 7. Record, then settle.
  const pending: PendingSettlement = {
    schema: PENDING_SCHEMA, key: x.key, payer: x.auth.payer, nonce: x.auth.nonce, validBefore: x.auth.validBefore,
    route: route.key, query, requirements: processed.paymentRequirements, payloadDigest: x.digest,
    body: bytes.toString("base64"), contentType: CONTENT_TYPE, startedMs: d.now(), transaction: null, refused: null,
  };
  try {
    d.ledger.begin(pending);
  } catch (e) {
    // Never settle a payment we could not reconcile after a crash.
    d.log("ledger-write-failed", { route: route.key, error: describe(e) });
    return sendJson(res, 503, { error: "ledger-unavailable", detail: "the payment was not charged; retry" }, { "retry-after": "30" });
  }
  let settled: ProcessSettleResultResponse | null = null;
  let brokerError: string | null = null;
  try {
    const verified = processed;
    settled = await settlementScope.run(
      { payer: x.auth.payer, nonce: x.auth.nonce, minAmount: BigInt(verified.paymentRequirements.amount) },
      () => http.processSettlement(
        verified.paymentPayload, verified.paymentRequirements, verified.declaredExtensions,
        { request: ctx, responseBody: bytes, responseHeaders: { "content-type": CONTENT_TYPE } },
      ),
    );
  } catch (e) {
    // A BrokerError from settle (broker.ts): a timeout or an error after the transfer may have gone out.
    brokerError = describe(e);
  }
  if (settled?.success) {
    return deliver(res, d, pending, bytes, { transaction: settled.transaction, status: settled.status, payer: settled.payer, network: settled.network, headers: settled.headers });
  }

  // Not confirmed by the Broker. Ask the chain; never guess.
  const unknown = brokerError !== null || settled?.errorReason === "settlement_timeout";
  const brokerTx = settled?.transaction || null;
  d.ledger.noteFailure(x.key, brokerTx, unknown ? null : (settled?.errorReason ?? "settlement-failed"));
  d.log(unknown ? "settle-outcome-unknown" : "settle-failed", {
    route: route.key, reason: brokerError ?? settled?.errorReason ?? null, transaction: brokerTx,
  });
  const verdict = await askChainWhile(d, pending, unknown ? d.inlineReconcileMs : 0);
  if (verdict?.kind === "paid") {
    d.log("paid-confirmed-on-chain", { route: route.key, transaction: verdict.transaction });
    return deliver(res, d, pending, bytes, {
      transaction: verdict.transaction, status: "success", payer: x.auth.payer, network: pending.requirements.network,
      headers: chainSettlementHeaders(verdict.transaction, pending.requirements.network, x.auth.payer),
    });
  }
  if (verdict?.kind === "unused" && verdict.final) {
    // Past validBefore and never used: the authorization is dead, and nobody was charged.
    d.ledger.drop(x.key);
    if (settled) return applyInstructions(res, settled.response);
    return sendJson(res, 402, { error: "settlement-failed", reason: "authorization-expired-unused", transaction: null });
  }
  // Still open: the reconciler keeps asking the chain until validBefore has passed.
  if (!unknown && settled) return applyInstructions(res, settled.response);
  return unconfirmed(res, pending);
}

/** Ask the chain, and keep asking for up to `budgetMs` of real time while the answer can still change. */
async function askChainWhile(d: PricedDeps, pending: PendingSettlement, budgetMs: number): Promise<ChainVerdict | null> {
  if (!d.chain) return null;
  const until = Date.now() + budgetMs;
  let last: ChainVerdict | null = null;
  for (;;) {
    try { last = await askChain(d.chain, pending); } catch (e) { d.log("reconcile-error", { route: d.route.key, error: describe(e) }); }
    if (last && (last.kind === "paid" || last.final)) return last;
    const left = until - Date.now();
    if (left <= 0) return last;
    await new Promise((r) => setTimeout(r, Math.min(RECHECK_MS, left)));
  }
}

/** 8. Receipt (and the ledger's settled record), then the bytes that were paid for. */
function deliver(
  res: ServerResponse, d: PricedDeps, pending: PendingSettlement, bytes: Buffer,
  s: { transaction: string; status?: string; payer?: string; network?: string; headers: Record<string, string> },
): void {
  const gone = clientGone(res);
  const { receipt, receiptError, headers } = d.ledger.settle(pending, s, !gone);
  if (!receiptError) {
    d.log("paid", { route: d.route.key, receipt: receipt.receiptId, transaction: receipt.transaction, payer: receipt.payer, amount: receipt.amount, status: receipt.settleStatus });
  }
  if (gone) {
    d.log("paid-client-gone", { route: d.route.key, receipt: receipt.receiptId, detail: "bytes kept for redelivery" });
    return;
  }
  send(res, 200, bytes, headers);
}
