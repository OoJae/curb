/**
 * Scorecard, read back from storage: every committed row and its settlement, at one pinned block.
 *
 * Why storage and not logs. ClosureCommitted does not carry the baselines -- lastPrint and closingVwap
 * live only in calldata and in storage -- and reading ClosureSettled would mean a paged log scan from the
 * deploy block before the first answer. The contract's public getters answer everything at any block:
 * closureCount(), closureIds(i), commitments(id), settlements(id) and skill(). They are read through
 * Multicall3 pinned by block hash (sources/chain.ts), so every number in a snapshot comes from a single
 * chain state, and asOfBlock / asOfBlockHash let a buyer re-run the exact reads and get the same bytes.
 *
 * Incremental, because the record is append-only and grading is final:
 *   - closureIds is push-only;
 *   - commitments[id] is written once, by commit() (a second commit reverts ClosureExists);
 *   - settlements[id] is written once, by settle() (a second settle reverts AlreadySettled).
 * So a row read at an earlier block is still true at a later one, and each refresh reads only what can
 * have changed: the count, the skill triple, the ids appended since, and the settlements still owed.
 * Those reads are all pinned to the new block, so the assembled snapshot IS the contract's state at
 * asOfBlock -- the cached part is identical there by the three rules above.
 *
 * What could make a cached row wrong is a reorg that drops a commit or a settle already read. Two tripwires
 * force a full re-read at the same block: closureCount going backwards, and skill() disagreeing with a
 * strict-win recount of the rows. The whole record is also re-read every FULL_REREAD_MS regardless, as
 * insurance against the case nobody thought of. A snapshot is all or nothing: one failed or undecodable
 * read keeps the previous snapshot and records why, rather than serving a record with a hole in it.
 *
 * Refreshed on the tick, never inside a request: a request reads the last snapshot and is told its age.
 */
import { getAddress } from "ethers";
import { multicallAt, pinLatest } from "../sources/chain.ts";
import type { Call, CallResult, MulticallSnapshot, PinnedBlock } from "../sources/chain.ts";
import { scorecardAbi } from "../sources/scorecard.ts";

/** Calls per aggregate3. 120 cold storage-heavy getters stay far below any public RPC's eth_call gas cap. */
const BATCH = 120;
const FULL_REREAD_MS = 3_600_000;

export interface ScorecardSettlement {
  settledAt: number;
  settledBlock: number;
  reopenPrintE18: string;
  curbErrorBps: number;
  lastPrintErrorBps: number;
  closingVwapErrorBps: number;
  /** type(uint32).max when the row carried no stale-oracle baseline (the keeper commits 0 for it). */
  staleOracleErrorBps: number;
  source: number;
}

export interface ScorecardRow {
  /** Position in closureIds: commit order. */
  index: number;
  id: string;
  wrapper: string;
  committedAt: number;
  committedBlock: number;
  settleAfter: number;
  markE18: string;
  bandBps: number;
  inputRoot: string;
  methodDigest: string;
  lastPrintE18: string;
  closingVwapE18: string;
  staleOracleE18: string;
  settlement: ScorecardSettlement | null;
}

export interface ScorecardSnapshot {
  scorecard: string;
  block: { number: number; hash: string; timestamp: number };
  readAtMs: number;
  closureCount: number;
  /** skill() as the contract returns it: its own running tallies, incremented inside settle(). */
  skill: { settled: number; beatLast: number; beatVwap: number };
  rows: ScorecardRow[];
}

/**
 * One settled row against its baselines, exactly as Scorecard.settle() counts it:
 *     if (e0 < e1) ++curbBeatLastPrint;  if (e0 < e2) ++curbBeatClosingVwap;
 * Strict. Equal errors are a tie, and a tie is not a win -- the record would be worthless if a mark that
 * merely copied the last print could be counted as beating it.
 */
export function grade(s: ScorecardSettlement): { beatLastPrint: boolean; beatClosingVwap: boolean; tie: boolean; tieClosingVwap: boolean } {
  return {
    beatLastPrint: s.curbErrorBps < s.lastPrintErrorBps,
    beatClosingVwap: s.curbErrorBps < s.closingVwapErrorBps,
    tie: s.curbErrorBps === s.lastPrintErrorBps,
    tieClosingVwap: s.curbErrorBps === s.closingVwapErrorBps,
  };
}

/** skill(), recomputed from the rows. Equal to the contract's own triple unless something is wrong. */
export function recount(rows: readonly ScorecardRow[]): { settled: number; beatLast: number; beatVwap: number } {
  let settled = 0, beatLast = 0, beatVwap = 0;
  for (const r of rows) {
    if (!r.settlement) continue;
    settled++;
    const g = grade(r.settlement);
    if (g.beatLastPrint) beatLast++;
    if (g.beatClosingVwap) beatVwap++;
  }
  return { settled, beatLast, beatVwap };
}

/** The two chain operations this needs; tests answer them from an in-memory contract. */
export interface ScorecardChain {
  pin(): Promise<PinnedBlock>;
  multicall(block: PinnedBlock, calls: Call[]): Promise<MulticallSnapshot>;
}

export function rpcChain(rpcs: string[]): ScorecardChain {
  return { pin: () => pinLatest(rpcs), multicall: (block, calls) => multicallAt(block, calls, rpcs) };
}

export interface ScorecardStatus {
  snapshot: ScorecardSnapshot | null;
  ageMs: number | null;
  /** The last refresh failed and the snapshot is older than staleAfterMs: serve, and disclose the age. */
  stale: boolean;
  /** No snapshot, or none for longer than outageMs: refuse paid answers before any payment. */
  outage: boolean;
  lastError: string | null;
}

export interface ScorecardIndexOptions {
  scorecard: string;
  chain: ScorecardChain;
  now: () => number;
  staleAfterMs?: number;
  outageMs?: number;
  fullRereadMs?: number;
  batch?: number;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class ScorecardIndex {
  readonly scorecard: string;
  readonly staleAfterMs: number;
  readonly outageMs: number;
  private readonly chain: ScorecardChain;
  private readonly now: () => number;
  private readonly fullRereadMs: number;
  private readonly batch: number;
  private snapshot: ScorecardSnapshot | null = null;
  private lastFullReadMs = Number.NEGATIVE_INFINITY;
  private lastError: string | null = null;
  /** Full re-reads forced by a tripwire, for the log and the tests. */
  fullRereads = 0;

  constructor(o: ScorecardIndexOptions) {
    this.scorecard = getAddress(o.scorecard);
    this.chain = o.chain;
    this.now = o.now;
    this.staleAfterMs = o.staleAfterMs ?? 5 * 60_000;
    this.outageMs = o.outageMs ?? 30 * 60_000;
    this.fullRereadMs = o.fullRereadMs ?? FULL_REREAD_MS;
    this.batch = o.batch ?? BATCH;
  }

  status(nowMs: number): ScorecardStatus {
    const s = this.snapshot;
    const ageMs = s ? Math.max(0, nowMs - s.readAtMs) : null;
    return {
      snapshot: s, ageMs,
      stale: ageMs !== null && ageMs > this.staleAfterMs,
      outage: ageMs === null || ageMs > this.outageMs,
      lastError: this.lastError,
    };
  }

  /** One refresh. Throws on failure, after recording why; the previous snapshot stays in place. */
  async refresh(): Promise<ScorecardSnapshot> {
    try {
      const block = await this.chain.pin();
      const due = this.now() - this.lastFullReadMs >= this.fullRereadMs;
      let snap = await this.read(block, due ? null : this.snapshot);
      if (snap === null) {
        this.fullRereads++;
        snap = (await this.read(block, null))!;
      }
      this.snapshot = snap;
      this.lastError = null;
      return snap;
    } catch (e) {
      this.lastError = describe(e);
      throw e;
    }
  }

  /** Aggregate3 in batches, all at the same pinned block. Any failed getter fails the whole snapshot. */
  private async calls(block: PinnedBlock, calls: Call[]): Promise<Map<string, CallResult>> {
    const out = new Map<string, CallResult>();
    for (let i = 0; i < calls.length; i += this.batch) {
      const snap = await this.chain.multicall(block, calls.slice(i, i + this.batch));
      if (snap.block.hash !== block.hash) throw new Error("multicall answered at a different block than the one pinned");
      for (const r of snap.results) {
        if (!r.success || !r.returnData || r.returnData === "0x") throw new Error(`Scorecard getter failed: ${r.label}`);
        out.set(r.label, r);
      }
    }
    return out;
  }

  private call(label: string, fn: string, args: unknown[] = []): Call {
    return { label, target: this.scorecard, callData: scorecardAbi.encodeFunctionData(fn, args) };
  }

  /**
   * The snapshot at `block`, reusing `base`'s immutable rows when given. Returns null when a tripwire
   * says the cached part cannot be trusted, and the caller then re-reads from scratch at the same block.
   */
  private async read(block: PinnedBlock, base: ScorecardSnapshot | null): Promise<ScorecardSnapshot | null> {
    const known = base?.rows ?? [];
    const owed = known.filter((r) => r.settlement === null);
    const head = await this.calls(block, [
      this.call("count", "closureCount"),
      this.call("skill", "skill"),
      ...owed.map((r) => this.call(`settlement:${r.id}`, "settlements", [r.id])),
    ]);
    const count = Number(scorecardAbi.decodeFunctionResult("closureCount", head.get("count")!.returnData)[0]);
    const sk = scorecardAbi.decodeFunctionResult("skill", head.get("skill")!.returnData);
    const skill = { settled: Number(sk[0]), beatLast: Number(sk[1]), beatVwap: Number(sk[2]) };
    if (base && count < known.length) return null;   // rows we cached are gone: a reorg, or a different contract

    const rows = known.map((r) => r.settlement !== null ? r : { ...r, settlement: decodeSettlement(head.get(`settlement:${r.id}`)!) });

    if (count > known.length) {
      const ids = await this.calls(block, Array.from({ length: count - known.length }, (_, k) =>
        this.call(`id:${known.length + k}`, "closureIds", [known.length + k])));
      const fresh = Array.from({ length: count - known.length }, (_, k) =>
        String(scorecardAbi.decodeFunctionResult("closureIds", ids.get(`id:${known.length + k}`)!.returnData)[0]).toLowerCase());
      const detail = await this.calls(block, fresh.flatMap((id) => [
        this.call(`commitment:${id}`, "commitments", [id]),
        this.call(`settlement:${id}`, "settlements", [id]),
      ]));
      fresh.forEach((id, k) => rows.push(decodeRow(known.length + k, id, detail.get(`commitment:${id}`)!, detail.get(`settlement:${id}`)!)));
    }

    // The contract's own tallies must equal a strict recount of its own rows. If a cached row disagrees,
    // re-read everything; if a fresh full read still disagrees, keep it -- the record then says so.
    const again = recount(rows);
    if (base && (again.settled !== skill.settled || again.beatLast !== skill.beatLast || again.beatVwap !== skill.beatVwap)) return null;

    if (!base) this.lastFullReadMs = this.now();
    return {
      scorecard: this.scorecard,
      block: { number: block.number, hash: block.hash, timestamp: block.timestamp },
      readAtMs: this.now(),
      closureCount: count,
      skill,
      rows,
    };
  }
}

function decodeSettlement(r: CallResult): ScorecardSettlement | null {
  const d = scorecardAbi.decodeFunctionResult("settlements", r.returnData);
  if (!d[8]) return null;
  return {
    settledAt: Number(d[0]),
    settledBlock: Number(d[1]),
    reopenPrintE18: String(d[2]),
    curbErrorBps: Number(d[3]),
    lastPrintErrorBps: Number(d[4]),
    closingVwapErrorBps: Number(d[5]),
    staleOracleErrorBps: Number(d[6]),
    source: Number(d[7]),
  };
}

function decodeRow(index: number, id: string, c: CallResult, s: CallResult): ScorecardRow {
  const d = scorecardAbi.decodeFunctionResult("commitments", c.returnData);
  // An id from closureIds with no commitment behind it would be a contract bug or a misread; never
  // invent a row from zeroes.
  if (Number(d[1]) === 0) throw new Error(`closureIds lists ${id} but commitments(${id}) is empty`);
  return {
    index, id,
    wrapper: getAddress(String(d[0])),
    committedAt: Number(d[1]),
    committedBlock: Number(d[2]),
    settleAfter: Number(d[3]),
    markE18: String(d[4]),
    bandBps: Number(d[5]),
    inputRoot: String(d[6]).toLowerCase(),
    methodDigest: String(d[7]).toLowerCase(),
    lastPrintE18: String(d[8]),
    closingVwapE18: String(d[9]),
    staleOracleE18: String(d[10]),
    settlement: decodeSettlement(s),
  };
}
