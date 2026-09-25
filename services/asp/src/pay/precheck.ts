/**
 * A local look at a presented payment before the OKX Broker is asked to verify it.
 *
 * Why: every decodable payment header whose `accepted` echoes our terms went straight to the Broker's /verify
 * on Curb's API credentials. A caller who pays nothing could spend that key's rate limit with made-up
 * authorizations, a fresh nonce each, and real buyers would then meet 503 broker-unavailable. Much of what
 * makes an authorization unusable can be seen here, for free.
 *
 * The rule is to refuse only what cannot pay Curb its price. Every check below is one that x402-evm's
 * reference facilitator (verifyEIP3009, shipped in the same OKX SDK) makes at least as strictly, or that
 * USD₮0 itself enforces on chain, and any doubt sends the payment on to the Broker as before. In order:
 *
 *   terms       the payload's network and asset are the requirement's, and those are ours (X Layer, USD₮0).
 *               The SDK has already matched `accepted` to our terms field by field; this guards the hook.
 *   well-formed validAfter is an unsigned integer and the signature is a string. (authorizationOf, in the
 *               flow, has already required from, nonce, value and validBefore.)
 *   recipient   authorization.to is PAY_TO. `accepted.payTo` is only an echo of our terms; `to` is signed.
 *   value       at least the price. The reference requires it equal; a larger value is left to the Broker.
 *   window      validBefore is still ahead of this clock (the reference wants 6 s of margin), and validAfter
 *               is at most 60 s ahead of it (the reference allows none; the margin absorbs clock skew
 *               between this host, the buyer and the Broker).
 *   signature   refused only when all of these hold: it is a plain 65-byte ECDSA signature (v 27/28 or 0/1),
 *               it recovers to an address other than `from`, and the chain says `from` has no code. A payer
 *               with code -- a smart account, or an EIP-7702 account such as the OKX Agentic Wallet
 *               0x055b…7105, which had 0xef0100… code on 25 Sep 2026 -- may validate by ERC-1271, which only
 *               the Broker can check, and so may any longer signature (ERC-6492); those always pass on. The
 *               digest is EIP-712 over the domain the challenge gives the buyer (extra.name, extra.version,
 *               the network's chain id, the asset), exactly as the SDK's client signs it; for USD₮0 on X Layer
 *               that domain hashes to 0xd591d9ba…599d, which is the token's own DOMAIN_SEPARATOR() (read
 *               25 Sep 2026). The code lookup is one eth_getCode, at most CODE_LOOKUPS_PER_MINUTE of them:
 *               past that, on an RPC error, or after CODE_LOOKUP_MS, the payment goes on to the Broker.
 *
 * What this does not stop: a caller who signs a well-formed authorization with a fresh key of their own
 * passes every check here, and the Broker then refuses it (no balance). Only the Broker can see that.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getAddress, verifyTypedData } from "ethers";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";

/** Reasons in x402-evm's own vocabulary where it has one, so an x402 client already knows what each means. */
export const PRECHECK_REASONS = {
  network: "invalid_exact_evm_network_mismatch",
  asset: "invalid_exact_evm_asset_mismatch",
  malformed: "invalid_payload",
  recipient: "invalid_exact_evm_recipient_mismatch",
  value: "invalid_exact_evm_authorization_value",
  validBefore: "invalid_exact_evm_payload_authorization_valid_before",
  validAfter: "invalid_exact_evm_payload_authorization_valid_after",
  signature: "invalid_exact_evm_signature",
} as const;

export interface PrecheckRefusal {
  reason: string;
  detail: string;
}

/**
 * Where the hook (server.ts) leaves its refusal for the flow. The SDK turns an aborted verify into a 402
 * whose PAYMENT-REQUIRED header carries the reason but not the detail, and an empty body; flow.ts runs
 * verify inside this scope so it can put both in the body. Async context, as with settlementScope, because
 * the SDK calls the hook with nothing that identifies the request.
 */
export const precheckScope = new AsyncLocalStorage<{ refusal: PrecheckRefusal | null }>();

/** Does this address have code at the latest block? Throws when the chain cannot say. */
export type PayerHasCode = (address: string) => Promise<boolean>;

export interface PrecheckOptions {
  /** Our network, e.g. eip155:196. */
  network: string;
  /** The settlement asset (USD₮0). */
  asset: string;
  /** PAY_TO. */
  payTo: string;
  now: () => number;
  /** Absent or null: the signature rule is skipped and every signature goes on to the Broker. */
  payerHasCode?: PayerHasCode | null;
  /** Default CODE_LOOKUPS_PER_MINUTE. */
  maxCodeLookupsPerMinute?: number;
  /** Default CODE_LOOKUP_MS. */
  codeLookupMs?: number;
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;
const ECDSA_65 = /^0x[0-9a-fA-F]{128}(1b|1c|00|01)$/i;
const MINUTE_MS = 60_000;
export const VALID_AFTER_SKEW_S = 60;
export const CODE_LOOKUPS_PER_MINUTE = 60;
export const CODE_LOOKUP_MS = 4_000;

const sameAddress = (a: unknown, b: string) => typeof a === "string" && ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();
const uintOf = (v: unknown): bigint | null => {
  const s = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  return typeof s === "string" && UINT.test(s) ? BigInt(s) : null;
};

/**
 * The pre-check, bound to our terms. The returned function never throws: an unexpected error is a pass,
 * and the Broker decides.
 */
export function createPaymentPrecheck(o: PrecheckOptions): (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<PrecheckRefusal | null> {
  const maxLookups = o.maxCodeLookupsPerMinute ?? CODE_LOOKUPS_PER_MINUTE;
  const lookupMs = o.codeLookupMs ?? CODE_LOOKUP_MS;
  const lookups: number[] = [];

  /** One code lookup from the per-minute cap, or false when it is spent. */
  function takeLookup(nowMs: number): boolean {
    while (lookups.length > 0 && lookups[0] <= nowMs - MINUTE_MS) lookups.shift();
    if (lookups.length >= maxLookups) return false;
    lookups.push(nowMs);
    return true;
  }

  /** True only when the chain answers, in time, that `address` has no code. */
  async function surelyNoCode(address: string): Promise<boolean> {
    if (!o.payerHasCode || !takeLookup(o.now())) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<null>((r) => { timer = setTimeout(() => r(null), lookupMs); });
      const hasCode = await Promise.race([o.payerHasCode(address), deadline]);
      return hasCode === false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function check(payload: PaymentPayload, req: PaymentRequirements): Promise<PrecheckRefusal | null> {
    const refuse = (reason: string, detail: string): PrecheckRefusal => ({ reason, detail });
    if (payload.accepted?.network !== req.network || req.network !== o.network) {
      return refuse(PRECHECK_REASONS.network, `this service settles on ${o.network} only`);
    }
    if (!sameAddress(payload.accepted?.asset, req.asset) || !sameAddress(req.asset, o.asset)) {
      return refuse(PRECHECK_REASONS.asset, `the asset is ${o.asset}`);
    }
    const inner = payload.payload as { authorization?: Record<string, unknown>; signature?: unknown } | undefined;
    const a = inner?.authorization;
    if (typeof a !== "object" || a === null) return refuse(PRECHECK_REASONS.malformed, "payload.authorization is missing");
    if (!sameAddress(a.to, o.payTo)) {
      return refuse(PRECHECK_REASONS.recipient, `payload.authorization.to must be this service's payTo, ${o.payTo}`);
    }
    const value = uintOf(a.value);
    const price = uintOf(req.amount);
    if (price !== null && (value === null || value < price)) {
      return refuse(PRECHECK_REASONS.value, `payload.authorization.value must be at least the price, ${req.amount} atomic units`);
    }
    const validAfter = uintOf(a.validAfter);
    const validBefore = uintOf(a.validBefore);
    if (validAfter === null || validBefore === null) {
      return refuse(PRECHECK_REASONS.malformed, "payload.authorization.validAfter and validBefore must be unsigned integers (unix seconds)");
    }
    const nowS = BigInt(Math.floor(o.now() / 1000));
    if (validBefore <= nowS) {
      return refuse(PRECHECK_REASONS.validBefore, `payload.authorization.validBefore (${validBefore}) has passed; this server's clock reads ${nowS}`);
    }
    if (validAfter > nowS + BigInt(VALID_AFTER_SKEW_S)) {
      return refuse(PRECHECK_REASONS.validAfter, `payload.authorization.validAfter (${validAfter}) is more than ${VALID_AFTER_SKEW_S} s ahead of this server's clock, ${nowS}`);
    }
    if (typeof inner?.signature !== "string") return refuse(PRECHECK_REASONS.malformed, "payload.signature is missing");
    if (await signedBySomeoneElse(a, inner.signature, req)) {
      return refuse(PRECHECK_REASONS.signature, "payload.signature does not recover to payload.authorization.from, which has no code on chain");
    }
    return null;
  }

  /** The signature rule above: true only when the payment certainly cannot validate. */
  async function signedBySomeoneElse(a: Record<string, unknown>, signature: string, req: PaymentRequirements): Promise<boolean> {
    if (!ECDSA_65.test(signature)) return false;
    const name = req.extra?.name;
    const version = req.extra?.version;
    const chain = /^eip155:(\d+)$/.exec(req.network);
    if (typeof name !== "string" || typeof version !== "string" || !chain || typeof a.from !== "string" || typeof a.nonce !== "string") return false;
    let recovered: string;
    try {
      recovered = verifyTypedData(
        { name, version, chainId: Number(chain[1]), verifyingContract: getAddress(req.asset) },
        EIP3009_TYPES,
        { from: a.from, to: a.to, value: uintOf(a.value), validAfter: uintOf(a.validAfter), validBefore: uintOf(a.validBefore), nonce: a.nonce },
        signature,
      );
    } catch {
      return false;
    }
    if (recovered.toLowerCase() === a.from.toLowerCase()) return false;
    return surelyNoCode(getAddress(a.from));
  }

  return async (payload, requirements) => {
    try {
      return await check(payload, requirements);
    } catch {
      return null;
    }
  };
}
