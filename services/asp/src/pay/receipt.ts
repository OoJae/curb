/**
 * Receipts: what a buyer's money bought, written once and served forever.
 *
 * A paid call leaves two artifacts that nobody controls alone: the settlement transaction on X Layer,
 * and the bytes this service returned. A receipt binds them. Its id is keccak256(transaction ++
 * responseDigest), so it is derivable by the buyer from the PAYMENT-RESPONSE header and the body they
 * received, and a receipt claiming different bytes for the same payment would have a different name.
 *
 * What is deliberately NOT in it: the payment signature. The receipt is public (GET /receipts/<id>.json)
 * and the signed EIP-3009 authorization is the buyer's; only its digest is kept, which is enough to
 * match it against the buyer's own copy and useless to anyone else.
 *
 * Receipts are unsigned for now: they are only as trustworthy as this host's disk. Signing them with a
 * service key (and publishing that key's address) is an open item, not an oversight.
 */
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { concat, getBytes, isHexString, keccak256, toUtf8Bytes } from "ethers";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { hashJson, sha256Hex } from "../hash.ts";
import { persistOnce } from "../persist.ts";

export const RECEIPT_SCHEMA = "curb.asp.receipt/1";
export const RECEIPT_ID_RE = /^0x[0-9a-f]{64}$/;

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  receiptId: string;
  /** The x402 route key, verb included: "GET /v1/closure-calendar". */
  route: string;
  /** The parameters the answer was built for, after validation and defaults: what was billed. */
  query: Record<string, string | number>;
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  payTo: string;
  payer: string | null;
  /** The settlement transaction hash, as the facilitator reported it. */
  transaction: string;
  /** The facilitator's settle status ("success" once mined when settling synchronously). */
  settleStatus: string | null;
  /** keccak256 of the RFC 8785 canonical JSON of the requirements the payment was verified against. */
  requirementsDigest: string;
  /** keccak256 of the canonical payment payload. The payload itself (and its signature) is never stored. */
  payloadDigest: string;
  /** sha256 of the exact response bytes delivered, 0x-prefixed. */
  responseDigest: string;
  responseBytes: number;
  contentType: string;
  tsMs: number;
}

export interface ReceiptInput {
  route: string;
  query: Record<string, string | number>;
  requirements: PaymentRequirements;
  /**
   * The verified payment payload, or only its digest. The ledger (ledger.ts) keeps the digest and never the
   * payload, so a receipt it writes for a payment the chain confirmed later is built from that.
   */
  payload?: PaymentPayload;
  payloadDigest?: string;
  settlement: { transaction: string; payer?: string; status?: string; network?: string };
  responseBody: Uint8Array;
  contentType: string;
  tsMs: number;
}

/** A 0x hex transaction hash contributes its bytes; anything else (a facilitator oddity) its UTF-8. */
function txBytes(transaction: string): Uint8Array {
  return isHexString(transaction) && transaction.length % 2 === 0 ? getBytes(transaction) : toUtf8Bytes(transaction);
}

export function receiptIdOf(transaction: string, responseDigest: string): string {
  return keccak256(concat([txBytes(transaction), getBytes(responseDigest)]));
}

/** EIP-3009 `exact` payloads name the payer in the signed authorization; the facilitator usually does too. */
function payerOf(i: ReceiptInput): string | null {
  if (i.settlement.payer) return i.settlement.payer;
  const auth = (i.payload?.payload as { authorization?: { from?: unknown } } | undefined)?.authorization;
  return typeof auth?.from === "string" ? auth.from : null;
}

/** keccak256 of the canonical payment payload: what a receipt keeps in place of the signed payload itself. */
export function payloadDigestOf(payload: PaymentPayload): string {
  return hashJson(payload);
}

export function buildReceipt(i: ReceiptInput): Receipt {
  const responseDigest = sha256Hex(i.responseBody);
  const payloadDigest = i.payloadDigest ?? (i.payload ? payloadDigestOf(i.payload) : null);
  if (payloadDigest === null) throw new Error("a receipt needs the payment payload or its digest");
  return {
    schema: RECEIPT_SCHEMA,
    receiptId: receiptIdOf(i.settlement.transaction, responseDigest),
    route: i.route,
    query: i.query,
    network: i.requirements.network,
    scheme: i.requirements.scheme,
    asset: i.requirements.asset,
    amount: i.requirements.amount,
    payTo: i.requirements.payTo,
    payer: payerOf(i),
    transaction: i.settlement.transaction,
    settleStatus: i.settlement.status ?? null,
    requirementsDigest: hashJson(i.requirements),
    payloadDigest,
    responseDigest,
    responseBytes: i.responseBody.byteLength,
    contentType: i.contentType,
    tsMs: i.tsMs,
  };
}

export function receiptPath(dir: string, id: string): string {
  return join(dir, `${id.toLowerCase()}.json`);
}

/** Durable before the response leaves: a buyer is never handed a receipt id that does not resolve. */
export function writeReceipt(dir: string, i: ReceiptInput): Receipt {
  const r = buildReceipt(i);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  persistOnce(receiptPath(dir, r.receiptId), JSON.stringify(r));
  return r;
}
