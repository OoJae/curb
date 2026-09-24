/**
 * Single-flight transaction sender for one attestor key.
 *
 * Rules, each from a specific failure mode:
 * - ONE sender per key, serialised. Two services sharing a key collide on nonces; that is why each
 *   host has its own key and this class never runs two sends concurrently.
 * - Simulate before signing. A reverting round (e.g. the key is not yet an attestor) is refused
 *   locally with the decoded reason instead of burning gas and leaving a failed tx on the record.
 * - Gas limit is max(GAS_FLOOR, 2 x estimate). The first live round estimated 492,319, above the
 *   393,400 the fork test measured, so a fixed limit would have run out of gas on round one.
 *   X Layer bills gas used, not the limit, so generosity costs nothing.
 * - Prepare and broadcast are separate, so a schedule-determined close can be signed early and
 *   broadcast at T-0.5s to land in the block stamped T.
 * - Every state change is written to a write-ahead log before it happens, so a restart never
 *   reuses a nonce or loses track of a broadcast transaction.
 *
 * Nonce and replacement rules (from two adversarial reviews, 14 Sep 2026):
 * - A row's `raw`/`hash` is always a transaction some RPC ACCEPTED. A refused fee bump never becomes the
 *   base for the next replacement, which otherwise priced itself below the pooled transaction forever.
 * - A nonce is reserved only by a transaction that may really be in a mempool: broadcast and unresolved,
 *   or prepared within the last minute. A broadcast nobody accepted, a signature orphaned by a crash,
 *   or one the caller discards releases its nonce.
 * - Before signing anything new, unresolved transactions are reconciled against the chain. While one is
 *   still pending, sending another would double-write when both mine, so the caller waits
 *   (PendingUnresolved). After STUCK_MS the new round REPLACES it at the same nonce, outbidding the pooled
 *   transaction on both fee cap and tip. The stuck row stays tracked until the replacement is accepted,
 *   and replaced rows stay tracked until their nonce is confirmed, so whichever one mines is recorded.
 *
 * Attribution (ERC-8021, the X Layer Builder Code; 24 Sep 2026):
 * - An optional `dataSuffix` is appended to the calldata of every transaction this key signs. Solidity's
 *   ABI decoder reads only the arguments and ignores trailing bytes, so the contract executes exactly as
 *   before; the suffix exists only so OKX can attribute the transaction to Curb. It is off unless set.
 * - It is applied ONCE, on the first line of prepare(), before the simulation. The eth_call, the gas
 *   estimate and the signature therefore all see the bytes that are actually sent (the suffix costs
 *   ~536 gas on a real attestBatch, so an estimate without it would be short), and every later path --
 *   the 12s fee bump, a stuck-row replacement -- re-signs Prepared.data, which already carries it.
 * - The caller's calldata is never rewritten. The keeper freezes CommitPlan.data WITHOUT the suffix and
 *   reuses it on every retry, and closure ids and input roots are computed from arguments, never from
 *   bytes, so switching attribution on or off can never change a row's id or split one closure into two.
 * - A malformed suffix is refused when the Sender is built, before the outbox is opened: a typo must stop
 *   the service at boot, not append garbage to every transaction or quietly attribute them to nobody.
 *   "Malformed" is everything but schema 0 carrying printable Builder Codes (review, 24 Sep 2026: a one-
 *   character slip in the schema byte, or a code of NUL bytes, used to pass). A well-formed code that is
 *   simply the WRONG one cannot be caught here; builderCodes() prints it in plain text for the boot log
 *   and /healthz, and a test pins every DATA_SUFFIX committed to a deploy config to Curb's own code.
 */
import { DatabaseSync } from "node:sqlite";
import { Transaction, Interface } from "ethers";
import type { Wallet, HDNodeWallet } from "ethers";

export const GAS_FLOOR = 600_000n;
export const MIN_MAX_FEE = 40_000_000n;        // 0.04 gwei: 2x the observed flat 0.02 gwei base fee
export const MAX_MAX_FEE = 1_000_000_000n;     // 1 gwei hard ceiling
export const PRIORITY_FEE = 1_000_000n;        // 0.001 gwei; the sequencer is uncongested
/** A prepared-but-unbroadcast signature older than this no longer reserves its nonce. */
export const PREPARED_RESERVATION_MS = 60_000;
/** An unresolved broadcast younger than this blocks new sends; older, it is replaced at its nonce. */
export const STUCK_MS = 120_000;

export type RpcFn = (url: string, method: string, params: unknown[]) => Promise<unknown>;

/** Every ERC-8021 suffix ends with these 16 bytes. A parser reads from the end, so they must be last. */
export const ERC8021_MARKER = "80218021802180218021802180218021";

/**
 * Validate an ERC-8021 data suffix. Returns it lower-cased, or "" (attribution off) for undefined or "".
 *
 * Strict, because it is a hand-set config value appended to every transaction, and almost every way it can
 * be wrong is SILENT: the transaction still mines and is credited to nobody, or to someone else. So:
 * - 0x-prefixed hex of whole bytes, ending in the marker, long enough to carry the codes-length and
 *   schema-id bytes that sit in front of it.
 * - Schema 0 (plain Builder Codes) and nothing else. It is the only kind Curb sends, and no other schema
 *   can be checked beyond the marker, so accepting them let a one-character slip in the schema byte
 *   (00 -> 01) turn Curb's code into a schema-1 payload that nobody reads as Curb's.
 * - The declared codes length matches what is there: that catches a byte dropped or pasted twice.
 * - The codes are what a Builder Code is: printable ASCII (0x21-0x7e), comma-delimited, none empty. That
 *   refuses NULs, whitespace, stray bytes and doubled commas, none of which any registry would credit.
 * What it cannot catch is a well-formed code that is the wrong one (dd7u50nckt5e729g); see builderCodes().
 */
export function normalizeDataSuffix(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "";
  if (!/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error(`dataSuffix must be 0x-prefixed hex, got ${JSON.stringify(raw)}`);
  if (raw.length % 2 !== 0) throw new Error(`dataSuffix must be whole bytes (even-length hex), got ${JSON.stringify(raw)}`);
  const hex = raw.slice(2).toLowerCase();
  if (!hex.endsWith(ERC8021_MARKER)) throw new Error(`dataSuffix ${raw} does not end with the ERC-8021 marker 0x${ERC8021_MARKER}`);
  const bytes = hex.length / 2;
  if (bytes < 18) throw new Error(`dataSuffix ${raw} is too short to carry a codes length and a schema id before the marker`);
  const schemaId = parseInt(hex.slice(-34, -32), 16);
  const codesLength = parseInt(hex.slice(-36, -34), 16);
  if (schemaId !== 0) throw new Error(`dataSuffix ${raw} declares ERC-8021 schema ${schemaId}; Curb sends only schema 0 (plain Builder Codes)`);
  if (codesLength === 0) throw new Error(`dataSuffix ${raw} is schema 0 with no Builder Code in it`);
  if (bytes !== codesLength + 18) {
    throw new Error(`dataSuffix ${raw} declares ${codesLength} bytes of schema-0 codes but carries ${bytes - 18}`);
  }
  const codes = Buffer.from(hex.slice(0, -36), "hex");
  for (const [i, b] of codes.entries()) {
    if (b < 0x21 || b > 0x7e) {
      throw new Error(`dataSuffix ${raw} has byte 0x${b.toString(16).padStart(2, "0")} at position ${i} of its codes; a Builder Code is printable ASCII`);
    }
  }
  if (codes.toString("ascii").split(",").includes("")) {
    throw new Error(`dataSuffix ${raw} has an empty Builder Code (a leading, trailing or doubled comma)`);
  }
  return "0x" + hex;
}

/**
 * The Builder Codes a data suffix carries, in plain text; [] when attribution is off. Throws exactly when
 * normalizeDataSuffix does.
 *
 * This is the answer to the one mistake the validator cannot see, a well-formed but wrong code: 34 bytes of
 * hex are unreadable, so the boot log and /healthz print this instead, where a person sees
 * "dd7u50nckt5e729g" at a glance, and the deploy configs' literals are pinned to Curb's code by a test.
 */
export function builderCodes(dataSuffix: string | undefined): string[] {
  const hex = normalizeDataSuffix(dataSuffix);
  return hex === "" ? [] : Buffer.from(hex.slice(2, -36), "hex").toString("ascii").split(",");
}

export interface SenderOptions {
  wallet: Wallet | HDNodeWallet;
  rpcs: string[];
  chainId: number;
  dbPath: string;
  rpc: RpcFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  errorInterface?: Interface;
  /** ERC-8021 attribution suffix appended to every transaction's calldata; undefined or "" is off. */
  dataSuffix?: string;
}

export interface Prepared {
  id: string;
  nonce: number;
  raw: string;
  hash: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  to: string;
  /** The calldata as signed: the caller's plus any attribution suffix. A fee bump re-signs exactly this. */
  data: string;
  /** The stuck row this transaction replaces, if any; its hash may still mine instead. */
  replaces?: { id: string; hash: string };
}

export interface Receipt {
  hash: string;
  status: number;
  blockNumber: number;
  gasUsed: bigint;
  replacements: number;
}

export class RevertedInSimulation extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`refusing to send: simulation reverted (${reason})`);
    this.reason = reason;
  }
}

export class PendingUnresolved extends Error {
  readonly nonce: number;
  constructor(nonce: number, hash: string, why = "is still pending") {
    super(`transaction ${hash} at nonce ${nonce} ${why}; not sending another on top of it`);
    this.nonce = nonce;
  }
}

interface Row {
  id: string;
  nonce: number;
  hash: string;
  raw: string;
  state: string;
  updated_ms: number;
}

type RawReceipt = { status: string; blockNumber: string; gasUsed: string } | null;

/** geth and most pools require a replacement to beat the pooled transaction by 10% on BOTH fee fields. */
const outbids = (next: bigint, pooled: bigint) => next * 10n >= pooled * 11n;

export class Sender {
  private readonly o: SenderOptions;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  /** The ERC-8021 suffix every transaction carries, lower-cased; "" when attribution is off. */
  readonly dataSuffix: string;

  constructor(o: SenderOptions) {
    // First, before the outbox is touched: a Sender with a bad suffix must not exist at all.
    this.dataSuffix = normalizeDataSuffix(o.dataSuffix);
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.db = new DatabaseSync(o.dbPath);
    this.db.exec(`
      create table if not exists outbox (
        id text primary key, nonce integer not null, hash text not null, raw text not null,
        state text not null, kind text, target_ms integer, created_ms integer not null,
        updated_ms integer not null, block_number integer, gas_used text, replacements integer default 0
      );
      create index if not exists outbox_nonce on outbox(nonce);
    `);
    const cols = (this.db.prepare("pragma table_info(outbox)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("replaces")) this.db.exec("alter table outbox add column replaces text");
    // A crash mid-broadcast may have reached a pool: keep tracking it (it is replaced, never rebroadcast).
    this.db.prepare("update outbox set state='timeout', updated_ms=? where state='sending'").run(this.now());
    // A signature left 'prepared' by a crash was never broadcast by this process. It must not reserve a
    // nonce, and it must never be broadcast later: its claims would be stamped with a new timestamp.
    this.db.prepare("update outbox set state='unsent', updated_ms=? where state='prepared'").run(this.now());
  }

  get address(): string {
    return this.o.wallet.address;
  }

  /** Serialise every operation on this key. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (const url of this.o.rpcs) {
      try {
        return (await this.o.rpc(url, method, params)) as T;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private setState(id: string, state: string) {
    this.db.prepare("update outbox set state=?, updated_ms=? where id=?").run(state, this.now(), id);
  }

  private recordReceipt(id: string, hash: string, rc: NonNullable<RawReceipt>, replacements?: number) {
    this.db
      .prepare("update outbox set state=?, hash=?, block_number=?, gas_used=?, replacements=coalesce(?, replacements), updated_ms=? where id=?")
      .run(Number(BigInt(rc.status)) === 1 ? "mined" : "reverted", hash, Number(BigInt(rc.blockNumber)), BigInt(rc.gasUsed).toString(), replacements ?? null, this.now(), id);
  }

  /**
   * Settle every row whose nonce the chain has confirmed, and return the lowest one still pending.
   * 'replaced' rows are settled too (a replaced transaction can mine instead of its replacement) but are
   * never returned as pending: their replacement row carries the nonce.
   */
  private async reconcile(): Promise<Row | null> {
    const rows = this.db.prepare("select id, nonce, hash, raw, state, updated_ms from outbox where state in ('broadcast','timeout','replaced') order by nonce").all() as unknown as Row[];
    if (rows.length === 0) return null;
    const latest = Number(BigInt(await this.call<string>("eth_getTransactionCount", [this.address, "latest"])));
    let stillPending: Row | null = null;
    for (const r of rows) {
      if (r.nonce < latest) {
        const rc = await this.call<RawReceipt>("eth_getTransactionReceipt", [r.hash]).catch(() => null);
        if (rc) this.recordReceipt(r.id, r.hash, rc);
        else this.setState(r.id, r.state === "replaced" ? "replaced-dropped" : "superseded");
      } else if (r.state !== "replaced" && !stillPending) {
        stillPending = r;
      }
    }
    return stillPending;
  }

  private async nextNonce(): Promise<number> {
    const pending = Number(BigInt(await this.call<string>("eth_getTransactionCount", [this.address, "pending"])));
    const row = this.db
      .prepare("select max(nonce) as n from outbox where state in ('sending','broadcast','timeout') or (state='prepared' and created_ms >= ?)")
      .get(this.now() - PREPARED_RESERVATION_MS) as { n: number | null };
    const local = row.n === null ? -1 : row.n;
    return Math.max(pending, local + 1);
  }

  private async fees(): Promise<bigint> {
    const block = await this.call<{ baseFeePerGas?: string }>("eth_getBlockByNumber", ["latest", false]);
    const base = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : MIN_MAX_FEE / 2n;
    let max = base * 2n;
    if (max < MIN_MAX_FEE) max = MIN_MAX_FEE;
    if (max > MAX_MAX_FEE) max = MAX_MAX_FEE;
    return max;
  }

  private decodeRevert(err: unknown): string {
    const data = (err as { data?: string })?.data;
    if (data && this.o.errorInterface) {
      try {
        const parsed = this.o.errorInterface.parseError(data);
        if (parsed) return `${parsed.name}(${parsed.args.join(",")})`;
      } catch { /* fall through */ }
    }
    return data ?? (err instanceof Error ? err.message : String(err));
  }

  /**
   * The calldata actually sent: the caller's with the attribution suffix appended.
   *
   * Never twice: calldata that already ends with the exact configured suffix is returned as it is, so a
   * caller that hands back a Prepared.data, or attributed its own calldata, cannot stack a second copy.
   * Anything else -- including calldata ending in some OTHER ERC-8021 suffix -- is treated as ordinary
   * calldata and gets ours appended, because a parser reads attribution from the end and only the last
   * suffix counts. (ABI calldata ending in these 34 exact bytes by accident is not a practical concern,
   * and would lose nothing: the arguments are untouched and the tail still reads as our attribution.)
   */
  private attributed(callData: string): string {
    if (!this.dataSuffix) return callData;
    const tail = this.dataSuffix.slice(2);
    return callData.toLowerCase().endsWith(tail) ? callData : callData + tail;
  }

  /**
   * Simulate, size gas, sign. Does not broadcast. `callData` is the caller's and is never modified; the
   * returned Prepared.data is what was simulated, estimated and signed, attribution included.
   */
  prepare(to: string, callData: string, meta: { id: string; kind: string; targetMs: number }): Promise<Prepared> {
    // Attribution is applied here and nowhere else, so every step below sees the bytes that are sent.
    const data = this.attributed(callData);
    return this.exclusive(async () => {
      const existing = this.db.prepare("select * from outbox where id = ?").get(meta.id);
      if (existing) throw new Error(`round ${meta.id} was already prepared`);

      try {
        await this.call("eth_call", [{ from: this.address, to, data }, "latest"]);
      } catch (e) {
        throw new RevertedInSimulation(this.decodeRevert(e));
      }
      const estimate = BigInt(await this.call<string>("eth_estimateGas", [{ from: this.address, to, data }, "latest"]));
      const gasLimit = estimate * 2n > GAS_FLOOR ? estimate * 2n : GAS_FLOOR;
      let maxFeePerGas = await this.fees();
      let priority = PRIORITY_FEE;
      let nonce: number;
      let replaces: Prepared["replaces"];

      const stuck = await this.reconcile();
      if (stuck && this.now() - stuck.updated_ms < STUCK_MS) {
        throw new PendingUnresolved(stuck.nonce, stuck.hash);
      } else if (stuck) {
        // Replace the stuck transaction with this fresh round at its nonce, outbidding what is pooled.
        const pooled = Transaction.from(stuck.raw);
        const pooledFee = pooled.maxFeePerGas ?? MIN_MAX_FEE;
        const pooledTip = pooled.maxPriorityFeePerGas ?? PRIORITY_FEE;
        maxFeePerGas = pooledFee * 2n > maxFeePerGas ? pooledFee * 2n : maxFeePerGas;
        priority = pooledTip * 2n > priority ? pooledTip * 2n : priority;
        if (maxFeePerGas > MAX_MAX_FEE) maxFeePerGas = MAX_MAX_FEE;
        if (priority > maxFeePerGas) priority = maxFeePerGas;
        if (!outbids(maxFeePerGas, pooledFee) || !outbids(priority, pooledTip)) {
          // At the ceiling we cannot outbid. If the pool still holds it, wait; if every node has dropped it,
          // there is nothing to outbid, so this fresh round takes the nonce at the ceiling price.
          const seen = await this.call<unknown>("eth_getTransactionByHash", [stuck.hash]).catch(() => "unknown");
          if (seen !== null) throw new PendingUnresolved(stuck.nonce, stuck.hash, "cannot be outbid under the fee ceiling");
        }
        nonce = stuck.nonce;
        replaces = { id: stuck.id, hash: stuck.hash };
      } else {
        nonce = await this.nextNonce();
      }

      const tx = Transaction.from({
        type: 2, chainId: this.o.chainId, nonce, to, data, value: 0n,
        gasLimit, maxFeePerGas, maxPriorityFeePerGas: priority,
      });
      const raw = await this.o.wallet.signTransaction(tx);
      const hash = Transaction.from(raw).hash!;
      const t = this.now();
      this.db
        .prepare("insert into outbox (id, nonce, hash, raw, state, kind, target_ms, created_ms, updated_ms, replaces) values (?,?,?,?,?,?,?,?,?,?)")
        .run(meta.id, nonce, hash, raw, "prepared", meta.kind, meta.targetMs, t, t, replaces?.id ?? null);
      return { id: meta.id, nonce, raw, hash, gasLimit, maxFeePerGas, maxPriorityFeePerGas: priority, to, data, replaces };
    });
  }

  /** Release a prepared signature the caller will not broadcast, so it stops reserving its nonce. */
  discard(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.db.prepare("update outbox set state='unsent', updated_ms=? where id=? and state='prepared'").run(this.now(), id);
    });
  }

  /**
   * Send to every RPC at once; succeed on the FIRST acceptance so one hanging endpoint cannot stall us.
   * "nonce too low" means the nonce is already used. For a first broadcast that is a failure (this
   * transaction can never mine); for a rebroadcast it usually means our own earlier copy mined.
   */
  private async broadcastRaw(raw: string, first: boolean): Promise<void> {
    const accepted = (e: unknown) => /already known|known transaction/i.test(String(e)) || (!first && /nonce too low/i.test(String(e)));
    // A node's explicit refusal proves this transaction is not pooled THERE. A timeout or transport error
    // proves nothing: the node may have accepted it and lost the response.
    const definitive = (e: unknown) => /underpriced|nonce too low|insufficient funds|invalid|intrinsic gas|fee cap|exceeds|already exists|rejected/i.test(String(e));
    const attempts = this.o.rpcs.map((u) =>
      this.o.rpc(u, "eth_sendRawTransaction", [raw]).then(
        () => true,
        (e) => {
          if (accepted(e)) return true;
          throw e;
        },
      ),
    );
    try {
      await Promise.any(attempts);
    } catch (e) {
      const errs = e instanceof AggregateError ? e.errors : [e];
      throw Object.assign(new Error(`no RPC accepted the transaction: ${errs.map(String).join(" | ")}`), {
        ambiguous: errs.some((x) => !definitive(x)),
      });
    }
  }

  /**
   * Broadcast a prepared transaction and wait for inclusion.
   * Rebroadcasts at 4s; replaces with a 25% bump on both fee fields at the same nonce at 12s; gives up
   * at 30s (the row stays 'timeout' and is reconciled before the next send).
   */
  broadcastAndWait(p: Prepared, timeoutMs = 30_000): Promise<Receipt> {
    return this.exclusive(async () => {
      let current = p;
      let replacements = 0;
      let rebroadcast = false;
      this.setState(p.id, "sending");
      try {
        await this.broadcastRaw(current.raw, true);
      } catch (e) {
        if (!(e as { ambiguous?: boolean }).ambiguous) {
          // Every node explicitly refused it, so it reserves nothing; any stuck row it meant to replace stays tracked.
          this.setState(p.id, "unsent");
          throw e;
        }
        // Outcome unknown: it may be pooled. Track it exactly as if accepted; the wait loop rebroadcasts, and if
        // it never landed the next round replaces it at the same nonce (no gap either way).
      }
      this.setState(p.id, "broadcast");
      if (p.replaces) this.setState(p.replaces.id, "replaced");
      const start = this.now();

      // Any accepted transaction at this nonce may be the one that mines, including the one we replaced.
      const hashes = new Set([current.hash, ...(p.replaces ? [p.replaces.hash] : [])]);
      while (this.now() - start < timeoutMs) {
        for (const h of hashes) {
          const r = await this.call<RawReceipt>("eth_getTransactionReceipt", [h]).catch(() => null);
          if (r) {
            if (p.replaces && h === p.replaces.hash) {
              // The older round mined instead of ours. Record it on its own row; ours is superseded.
              this.recordReceipt(p.replaces.id, h, r);
              this.setState(p.id, "superseded");
            } else {
              this.recordReceipt(p.id, h, r, replacements);
            }
            return { hash: h, status: Number(BigInt(r.status)), blockNumber: Number(BigInt(r.blockNumber)), gasUsed: BigInt(r.gasUsed), replacements };
          }
        }
        const elapsed = this.now() - start;
        if (elapsed >= 4_000 && !rebroadcast) {
          rebroadcast = true;
          await this.broadcastRaw(current.raw, false).catch(() => undefined);
        }
        if (elapsed >= 12_000 && replacements === 0) {
          replacements = 1; // one attempt per send, accepted or not
          const bump = (x: bigint) => (x * 125n) / 100n;
          let fee = bump(current.maxFeePerGas);
          let tip = bump(current.maxPriorityFeePerGas);
          if (fee > MAX_MAX_FEE) fee = MAX_MAX_FEE;
          if (tip > fee) tip = fee;
          if (outbids(fee, current.maxFeePerGas) && outbids(tip, current.maxPriorityFeePerGas)) {
            const tx = Transaction.from({
              type: 2, chainId: this.o.chainId, nonce: current.nonce, to: current.to, data: current.data, value: 0n,
              gasLimit: current.gasLimit, maxFeePerGas: fee, maxPriorityFeePerGas: tip,
            });
            const raw = await this.o.wallet.signTransaction(tx);
            try {
              await this.broadcastRaw(raw, false);
              // Only an ACCEPTED bump becomes the row's current transaction.
              current = { ...current, raw, hash: Transaction.from(raw).hash!, maxFeePerGas: fee, maxPriorityFeePerGas: tip };
              hashes.add(current.hash);
              this.db.prepare("update outbox set hash=?, raw=?, replacements=?, updated_ms=? where id=?").run(current.hash, raw, 1, this.now(), p.id);
            } catch { /* refused: keep tracking the transaction that is actually pooled */ }
          }
        }
        await this.sleep(250);
      }
      this.setState(p.id, "timeout");
      throw new Error(`round ${p.id} not mined within ${timeoutMs}ms (nonce ${p.nonce})`);
    });
  }
}
