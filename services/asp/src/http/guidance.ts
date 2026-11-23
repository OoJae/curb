/**
 * What an error body tells the caller to do.
 *
 * Every refusal this service sends carries a stable machine code in `error` (unknown-symbol, bad-horizon,
 * broker-unavailable, ...) plus its own fields. OKX.AI's listing review of 23 Nov 2026 asked that a failed call
 * guide the caller, so every JSON error body also gets, unless it already has one:
 *   message   one or two plain sentences: what was wrong, what to change, and whether anything was charged
 *   docs      the page that lists every route and its parameters
 * and a priced route's own parameter refusals (4xx before any payment) also get:
 *   parameters  the route's accepted query parameters, as listed with the route
 *   example     a request that works
 *
 * "Nothing was charged" is said only for codes that are sent before settlement can have started: verify, the
 * ledger claim, the build and the free checks all run before the Broker is asked to settle (pay/flow.ts).
 * Codes that can follow a settlement attempt say what is true there instead. The codes and the existing
 * fields are unchanged, so a client that reads `error` keeps working.
 */

export const DOCS_URL = "https://api.curb.markets/";

const RETRY_NOT_CHARGED = "Nothing was charged; retry shortly.";

const MESSAGES: Record<string, string> = {
  "unknown-symbol":
    "symbol is not an asset this route covers. Use one of the symbols in `valid` (or `graded`); the wrapper symbol " +
    "(wTCENTx), the issuer ticker (TCENTx) and the wrapper address all work, in any case. Omit symbol for the default.",
  "no-graded-record":
    "This asset has no graded record: Scorecard has no price source for it, so no mark was ever committed. Use one of " +
    "the symbols in `graded`, or omit symbol for every graded asset.",
  "repeated-parameter":
    "A parameter was sent more than once with different values. Send each parameter once.",
  "bad-request":
    "The request could not be read. Send parameters in the query string, or as a flat JSON or form body on POST.",
  "body-too-large":
    "The request body is too large. Send only the route's parameters.",
  "method-not-allowed":
    "Use GET on this route (paid routes also accept POST with the same parameters). See `docs` for every route.",
  "not-found":
    "No such path. Paid routes: /v1/closure-calendar, /v1/accuracy-record, /v1/discount-curve. Free: /v1/assets, " +
    "/v1/corporate-actions, /healthz.",
  "unsupported-payment":
    "The payment is not one this service accepts: x402 `exact` on X Layer, an EIP-3009 transferWithAuthorization of " +
    "USD₮0. Sign the offer in this route's 402 challenge (the PAYMENT-REQUIRED header) and send it as PAYMENT-SIGNATURE.",
  "payment-in-use":
    "Another request is using this same payment right now. Each payment buys one answer: wait a few seconds and retry " +
    "with it, or sign a new payment for a new request.",
  "settlement-failed":
    "The payment was not settled and will not be: sign a new payment from a fresh 402 challenge and send the request again.",
  "settlement-unconfirmed":
    "Settlement could not be confirmed yet. Send the same request again with the SAME PAYMENT-SIGNATURE: it is never " +
    "charged twice, and once the chain shows the payment you get the answer it paid for.",
  "broker-unavailable":
    "OKX's payment Broker did not answer the verification, so the payment was not used. " + RETRY_NOT_CHARGED,
  "ledger-unavailable":
    "The service could not record the payment before using it, so it was not used. " + RETRY_NOT_CHARGED,
  "facilitator-error":
    "The payment service returned an unexpected error before the payment was used. " + RETRY_NOT_CHARGED,
  "payments-unavailable": "Paid calls are briefly unavailable while the service reconnects to its payment Broker. " + RETRY_NOT_CHARGED,
  "payments-not-configured": "Paid calls are not available on this server. Nothing was charged.",
  "not-yet-available": "This route is starting up. " + RETRY_NOT_CHARGED,
  "issuer-unavailable":
    "The issuer's schedule could not be read just now, so the answer cannot be built. " + RETRY_NOT_CHARGED,
  "asset-unavailable": "This asset's data is briefly unavailable. " + RETRY_NOT_CHARGED,
  "cohort-unavailable": "The list of assets could not be read from MarketClock just now. " + RETRY_NOT_CHARGED,
  "record-unavailable": "The Scorecard record could not be read from the chain just now. " + RETRY_NOT_CHARGED,
  "corporate-actions-not-configured": "Corporate actions are not available on this server.",
  "route-not-priced": "Unexpected server error. Retry shortly; a payment is charged at most once.",
  "internal": "Unexpected server error. Retry shortly; a payment is charged at most once.",
};

/** `<name> must be a whole number from min to max` for the integer parameters, read from the refusal itself. */
function boundsMessage(body: Record<string, unknown>): string | null {
  if (typeof body.min !== "number" || typeof body.max !== "number") return null;
  const name = Object.keys(body).find((k) => !["error", "min", "max"].includes(k));
  if (!name) return null;
  return `${name} must be a whole number from ${body.min} to ${body.max}. Omit it for the default.`;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The body with `message` and `docs` added, when it is a JSON error body that does not already have them. */
export function withGuidance(status: number, body: unknown): unknown {
  if (status < 400 || !isPlainObject(body) || typeof body.error !== "string" || "message" in body) return body;
  const message = MESSAGES[body.error] ?? boundsMessage(body) ?? "The request failed. See `docs` for every route and its parameters.";
  return { ...body, message, docs: DOCS_URL };
}

/** A priced route's own 4xx refusal, plus its parameters and a request that works. */
export function withRouteHelp(status: number, body: Record<string, unknown>, route: { query: string; example: string }): Record<string, unknown> {
  if (status < 400 || status >= 500) return body;
  return { ...body, parameters: route.query, example: route.example };
}

/** An error body without the guidance fields, for comparing a body with what a route itself refused. */
export function core(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const { message: _m, docs: _d, parameters: _p, example: _e, ...rest } = body;
  return rest;
}
