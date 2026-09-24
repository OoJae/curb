/**
 * The payment ledger: every EIP-3009 authorization this service has tried to settle, on disk, so that one
 * payment buys exactly one answer and a payment that was made is never left without the answer it bought.
 *
 * The flow (flow.ts) verifies, builds the answer's exact bytes, then settles through the Broker. What can
 * go wrong around that settle, and what here closes each gap:
 *
 *   one payment, two requests   A payment is an EIP-3009 authorization, keyed by (payer, nonce)
 *                               (authorization.ts). A request carrying one that is in flight, unconfirmed
 *                               or already settled is answered from this ledger BEFORE verify: nothing is
 *                               built, and the Broker is never asked to settle it again. Whether the Broker
 *                               would have refused a duplicate settle no longer matters.
 *   an outcome nobody knows     settle timed out, or the Broker errored after it may have submitted the
 *                               transfer. The chain decides: if USD₮0 says the authorization is used by a
 *                               transaction that pays PAY_TO the price, the payment happened, and the bytes
 *                               built for it are receipted and delivered. If not, the record waits here and
 *                               the reconciler keeps asking until the chain's clock is past validBefore,
 *                               when the authorization can never be used and the record is dropped: nobody
 *                               was charged.
 *   a crash in the middle       the record is written and fsynced BEFORE settle is called, carrying the
 *                               exact bytes that were built. A restart loads pending/ and reconciles each
 *                               record the same way, so a kill between settle and receipt (a deploy, an
 *                               OOM) no longer leaves a mined payment with no receipt and no answer.
 *   a buyer who left            the flow does not settle for a closed socket. If the socket closes during
 *                               settle, or the payment is only confirmed after the response went out, the
 *                               bytes are kept with the settled record.
 *
 * Recovery is by presenting the SAME PAYMENT-SIGNATURE again: it is never charged twice, and when the
 * payment was made and its answer never reached the buyer, those exact bytes come back with their receipt
 * (on the route they were bought for). A payment whose answer was delivered gets 409 and its receipt id.
 * The key is not a secret -- once mined, (payer, nonce) and the signature are in the transaction's
 * calldata -- so kept bytes are, in effect, readable by anyone who rebuilds the header from the chain. That
 * is the price of never keeping a buyer's money for nothing, and it is paid only for answers that were paid
 * for and not delivered; a normal delivery keeps no bytes.
 *
 * Layout under `dir`: pending/<key>.json, replaced as it changes and removed once resolved; settled/<key>.json,
 * write-once like a receipt. Neither is served. Neither holds the payment signature, only its digest.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodePaymentResponseHeader } from "@okxweb3/x402-core/http";
import type { Network, PaymentRequirements } from "@okxweb3/x402-core/types";
import { persistOnce, persistReplace } from "../persist.ts";
import { buildReceipt, writeReceipt } from "./receipt.ts";
import type { Receipt, ReceiptInput } from "./receipt.ts";
import type { AuthorizationChain } from "./authorization.ts";
import { LOG_RANGE } from "../sources/chain.ts";
import type { Log } from "../log.ts";
import { silentLog } from "../log.ts";

export const PENDING_SCHEMA = "curb.asp.pending-settlement/1";
export const SETTLED_SCHEMA = "curb.asp.settled-authorization/1";
const KEY_RE = /^0x[0-9a-f]{40}-0x[0-9a-f]{64}$/;

/** How far before the settle call a use of the authorization is still credited to it (clock skew, a fast Broker). */
const SEARCH_MARGIN_S = 120;
/** The most blocks one check searches for the transaction that used an authorization: 100 eth_getLogs. */
const MAX_SEARCH_BLOCKS = 10_000;
/** Chain seconds past validBefore before "unused" is final. X Layer has one sequencer, but a tip can still move. */
const FINALITY_S = 60;
/** Chain seconds past validBefore after which a use no transaction in our window explains is given up on. */
const GIVE_UP_AFTER_S = 600;
/** A record whose validBefore lies absurdly far out stops being chased after this long, loudly. */
const MAX_TRACK_MS = 24 * 3_600_000;

export interface PendingSettlement {
  schema: typeof PENDING_SCHEMA;
  key: string;
  payer: string;
  nonce: string;
  /** Unix seconds, from the signed authorization. */
  validBefore: number;
  route: string;
  query: Record<string, string | number>;
  requirements: PaymentRequirements;
  payloadDigest: string;
  /** The exact bytes built for this payment, base64: what the receipt digests and a redelivery sends. */
  body: string;
  contentType: string;
  /** When settle was called: a use earlier than this (less a margin) is not credited to this record. */
  startedMs: number;
  /** The transaction the Broker named before failing, if it named one: the first place to look. */
  transaction: string | null;
  /**
   * The Broker's reason when it refused the settle outright; null while settling, or when the outcome is
   * unknown. A refused payment is never settled again, but is still watched until validBefore in case it
   * turns out to have been used after all.
   */
  refused: string | null;
}

export interface SettledAuthorization {
  schema: typeof SETTLED_SCHEMA;
  key: string;
  payer: string;
  nonce: string;
  route: string;
  /** Only a header carrying this exact payload is told the receipt or handed the bytes: (payer, nonce) is public once mined. */
  payloadDigest: string;
  receiptId: string;
  transaction: string;
  tsMs: number;
  /** The bytes and headers again, kept only when it is not known that they reached the buyer. */
  redeliver: { body: string; contentType: string; headers: Record<string, string> } | null;
}

export type LedgerState =
  | { state: "free" }
  | { state: "in-flight" }
  | { state: "unconfirmed"; pending: PendingSettlement }
  | { state: "settled"; settled: SettledAuthorization };

/**
 * paid         a mined transaction uses this authorization and pays PAY_TO at least the price.
 * unused       authorizationState says unused; `final` once the chain's clock is past validBefore.
 * unmatched    used, but no transaction in the window pays this sale: a lagging log index (retry), or a
 *              use that predates the request, which is not credited to it. `final` after GIVE_UP_AFTER_S.
 */
export type ChainVerdict =
  | { kind: "paid"; transaction: string }
  | { kind: "unused"; final: boolean }
  | { kind: "unmatched"; final: boolean };

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

/**
 * Is this parsed file a pending settlement this code can reconcile? A record that is not -- hand-edited, torn
 * by something other than persistReplace, or from a future schema -- is left on disk for a human rather than
 * chased every 15 s with an error, or dropped along with a payment it may describe.
 */
function isPendingSettlement(p: unknown, key: string): p is PendingSettlement {
  const r = p as Partial<PendingSettlement> | null;
  return !!r && r.schema === PENDING_SCHEMA && r.key === key &&
    typeof r.payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.payer) &&
    typeof r.nonce === "string" && /^0x[0-9a-f]{64}$/.test(r.nonce) &&
    Number.isSafeInteger(r.validBefore) && Number.isFinite(r.startedMs) &&
    typeof r.route === "string" && typeof r.body === "string" && typeof r.contentType === "string" &&
    typeof r.payloadDigest === "string" && typeof r.query === "object" && r.query !== null &&
    typeof r.requirements?.amount === "string" && /^\d+$/.test(r.requirements.amount) && typeof r.requirements.network === "string" &&
    (r.transaction === null || typeof r.transaction === "string") && (r.refused === null || typeof r.refused === "string");
}

/** The chain's answer for one pending settlement. Throws only when the chain cannot be read at all. */
export async function askChain(chain: AuthorizationChain, p: PendingSettlement): Promise<ChainVerdict> {
  const st = await chain.state(p.payer, p.nonce);
  if (!st.used) return { kind: "unused", final: st.timestamp >= p.validBefore + FINALITY_S };
  const e = { payer: p.payer, nonce: p.nonce, minAmount: BigInt(p.requirements.amount) };
  if (p.transaction && await chain.txPays(p.transaction, e)) return { kind: "paid", transaction: p.transaction.toLowerCase() };
  // The use lies between the settle call and now. X Layer makes one block a second; half as much again, plus
  // the margin, covers a slower stretch without trusting the block rate exactly.
  const fromS = Math.floor(p.startedMs / 1000) - SEARCH_MARGIN_S;
  const span = Math.min(MAX_SEARCH_BLOCKS, Math.max(LOG_RANGE, Math.ceil(Math.max(0, st.timestamp - fromS) * 1.5)));
  const tx = await chain.findUse(p.payer, p.nonce, Math.max(0, st.block - span + 1), st.block);
  if (tx && await chain.txPays(tx, e)) return { kind: "paid", transaction: tx };
  return { kind: "unmatched", final: st.timestamp >= p.validBefore + GIVE_UP_AFTER_S };
}

/** The PAYMENT-RESPONSE header the SDK would have written, for a settlement the chain confirmed instead. */
export function chainSettlementHeaders(transaction: string, network: string, payer: string): Record<string, string> {
  return { "payment-response": encodePaymentResponseHeader({ success: true, status: "success", transaction, network: network as Network, payer }) };
}

export interface LedgerOptions {
  dir: string;
  receiptsDir: string;
  now: () => number;
  log?: Log;
  /** Minimum real-time gap between two chain checks of the same record. */
  minAskGapMs?: number;
}

export class AuthorizationLedger {
  readonly dir: string;
  readonly receiptsDir: string;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly minAskGapMs: number;
  private readonly inFlight = new Set<string>();
  private readonly pending = new Map<string, PendingSettlement>();
  private readonly resolving = new Map<string, Promise<void>>();
  private readonly lastAskedMs = new Map<string, number>();

  constructor(o: LedgerOptions) {
    this.dir = o.dir;
    this.receiptsDir = o.receiptsDir;
    this.now = o.now;
    this.log = o.log ?? silentLog;
    this.minAskGapMs = o.minAskGapMs ?? 5_000;
  }

  private pendingPath(key: string): string { return join(this.dir, "pending", `${key}.json`); }
  private settledPath(key: string): string { return join(this.dir, "settled", `${key}.json`); }

  get inFlightCount(): number { return this.inFlight.size; }
  get pendingCount(): number { return this.pending.size; }

  /** Pick up what a previous process left mid-settle. An unreadable record is logged and left on disk for a human. */
  load(): number {
    const dir = join(this.dir, "pending");
    if (!existsSync(dir)) return 0;
    for (const f of readdirSync(dir)) {
      // persistReplace's temp files end in .tmp; a torn one is exactly what the rename protects us from.
      if (!f.endsWith(".json") || !KEY_RE.test(f.slice(0, -5))) continue;
      try {
        const p: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (!isPendingSettlement(p, f.slice(0, -5))) throw new Error("not a pending-settlement record this version can reconcile");
        this.pending.set(p.key, p);
      } catch (e) {
        this.log("ledger-unreadable", { file: f, error: describe(e) });
      }
    }
    if (this.pending.size) this.log("ledger-pending-on-boot", { pending: this.pending.size });
    return this.pending.size;
  }

  lookup(key: string): LedgerState {
    if (this.inFlight.has(key)) return { state: "in-flight" };
    const p = this.pending.get(key);
    if (p) return { state: "unconfirmed", pending: p };
    const path = this.settledPath(key);
    if (!existsSync(path)) return { state: "free" };
    try {
      return { state: "settled", settled: JSON.parse(readFileSync(path, "utf8")) as SettledAuthorization };
    } catch (e) {
      // Fail closed: the payment is recorded as used even if its record cannot be read back.
      this.log("ledger-unreadable", { key, error: describe(e) });
      return { state: "settled", settled: { schema: SETTLED_SCHEMA, key, payer: "", nonce: "", route: "", payloadDigest: "", receiptId: "", transaction: "", tsMs: 0, redeliver: null } };
    }
  }

  /**
   * Take a free key for one request. Synchronous, so a lookup() and a claim() with no await between them
   * cannot interleave with another request carrying the same payment.
   */
  claim(key: string): boolean {
    if (this.inFlight.has(key) || this.pending.has(key) || existsSync(this.settledPath(key))) return false;
    this.inFlight.add(key);
    return true;
  }

  /** The request is done with the key. Whatever the ledger learned (pending, settled) stays. */
  release(key: string): void {
    this.inFlight.delete(key);
  }

  /** Durable BEFORE settle is called. Throws if it cannot be written, and then the flow does not settle. */
  begin(p: PendingSettlement): void {
    mkdirSync(join(this.dir, "pending"), { recursive: true });
    persistReplace(this.pendingPath(p.key), JSON.stringify(p));
    this.pending.set(p.key, p);
  }

  /**
   * What the Broker said when it did not confirm: the transaction it named, if any (the first place the chain
   * check looks), and its reason if it refused outright.
   */
  noteFailure(key: string, transaction: string | null, refused: string | null): void {
    const p = this.pending.get(key);
    if (!p) return;
    p.transaction = transaction || p.transaction;
    p.refused = refused;
    try { persistReplace(this.pendingPath(key), JSON.stringify(p)); } catch (e) { this.log("ledger-write-failed", { key, error: describe(e) }); }
  }

  /**
   * The payment is made. Receipt, then the settled record, then the pending one removed -- in that order, so
   * a crash between any two leaves a state the next reconcile finishes identically: the receipt and the
   * settled record are write-once and named by what they contain, so writing them again writes nothing.
   */
  settle(
    p: PendingSettlement,
    s: { transaction: string; status?: string; payer?: string; network?: string; headers: Record<string, string> },
    delivered: boolean,
  ): { receipt: Receipt; receiptError: string | null; headers: Record<string, string> } {
    const input: ReceiptInput = {
      route: p.route, query: p.query, requirements: p.requirements, payloadDigest: p.payloadDigest,
      settlement: { transaction: s.transaction, payer: s.payer || p.payer, status: s.status, network: s.network || p.requirements.network },
      responseBody: Buffer.from(p.body, "base64"), contentType: p.contentType, tsMs: this.now(),
    };
    let receipt: Receipt;
    let receiptError: string | null = null;
    try {
      receipt = writeReceipt(this.receiptsDir, input);
    } catch (e) {
      // The buyer has paid; withholding the answer now would be the worse failure. Say what is missing.
      receiptError = describe(e);
      receipt = buildReceipt(input);
      this.log("receipt-write-failed", { route: p.route, transaction: s.transaction, error: receiptError });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers)) headers[k.toLowerCase()] = v;
    Object.assign(headers, { "content-type": p.contentType, "cache-control": "no-store" });
    if (receiptError) headers["x-curb-receipt-error"] = "write-failed";
    else headers["x-curb-receipt"] = receipt.receiptId;
    const rec: SettledAuthorization = {
      schema: SETTLED_SCHEMA, key: p.key, payer: p.payer, nonce: p.nonce, route: p.route, payloadDigest: p.payloadDigest,
      receiptId: receipt.receiptId, transaction: s.transaction, tsMs: this.now(),
      redeliver: delivered ? null : { body: p.body, contentType: p.contentType, headers },
    };
    try {
      mkdirSync(join(this.dir, "settled"), { recursive: true });
      persistOnce(this.settledPath(p.key), JSON.stringify(rec));
      rmSync(this.pendingPath(p.key), { force: true });
      this.pending.delete(p.key);
      this.lastAskedMs.delete(p.key);
    } catch (e) {
      // Left pending: the next reconcile asks the chain again and finishes this, idempotently.
      this.log("ledger-write-failed", { key: p.key, error: describe(e) });
    }
    return { receipt, receiptError, headers };
  }

  /** The authorization is dead (or given up on): nothing can be charged for it any more, so forget the bytes. */
  drop(key: string): void {
    try { rmSync(this.pendingPath(key), { force: true }); } catch (e) { this.log("ledger-write-failed", { key, error: describe(e) }); return; }
    this.pending.delete(key);
    this.lastAskedMs.delete(key);
  }

  /**
   * Ask the chain about one unconfirmed payment and act on the answer: paid, it is receipted and its bytes
   * kept for redelivery; final and unpaid, it is dropped. Never while a request holds the key, never twice
   * at once (a second caller waits on the first), and at most once per minAskGapMs however often a buyer
   * re-presents the header.
   */
  reconcile(key: string, chain: AuthorizationChain): Promise<void> {
    if (this.inFlight.has(key) || !this.pending.has(key)) return Promise.resolve();
    const running = this.resolving.get(key);
    if (running) return running;
    const last = this.lastAskedMs.get(key);
    if (last !== undefined && Date.now() - last < this.minAskGapMs) return Promise.resolve();
    this.lastAskedMs.set(key, Date.now());
    const p = this.pending.get(key)!;
    const run = (async () => {
      try {
        const v = await askChain(chain, p);
        if (this.inFlight.has(key) || this.pending.get(key) !== p) return;
        if (v.kind === "paid") {
          const { receipt } = this.settle(p, { transaction: v.transaction, status: "success", payer: p.payer, network: p.requirements.network, headers: chainSettlementHeaders(v.transaction, p.requirements.network, p.payer) }, false);
          this.log("reconciled-paid", { route: p.route, receipt: receipt.receiptId, transaction: v.transaction, payer: p.payer, amount: p.requirements.amount });
        } else if (v.final || this.now() - p.startedMs > MAX_TRACK_MS) {
          this.drop(key);
          // `unmatched` is the one that needs a human: the chain says used, but no transaction we can find pays this sale.
          this.log(v.kind === "unused" ? "reconciled-unpaid" : "reconcile-abandoned", {
            route: p.route, payer: p.payer, nonce: p.nonce, validBefore: p.validBefore, amount: p.requirements.amount, verdict: v.kind,
          });
        }
      } catch (e) {
        this.log("reconcile-error", { key, error: describe(e) });
      } finally {
        this.resolving.delete(key);
      }
    })();
    this.resolving.set(key, run);
    return run;
  }

  async reconcileAll(chain: AuthorizationChain): Promise<void> {
    // One at a time: this is a background chore, and the public RPC rate-limits bursts.
    for (const key of [...this.pending.keys()]) await this.reconcile(key, chain);
  }

  /** The background loop. Nothing awaits it; requests only read lookup() and, for their own key, reconcile(). */
  async run(chain: AuthorizationChain, o: { signal?: AbortSignal; everyMs?: number } = {}): Promise<void> {
    const everyMs = o.everyMs ?? 15_000;
    while (!o.signal?.aborted) {
      try { await this.reconcileAll(chain); } catch (e) { this.log("reconcile-error", { error: describe(e) }); }
      await new Promise<void>((resolve) => {
        if (o.signal?.aborted) return resolve();
        const t = setTimeout(() => { o.signal?.removeEventListener("abort", done); resolve(); }, everyMs);
        const done = () => { clearTimeout(t); resolve(); };
        o.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}
