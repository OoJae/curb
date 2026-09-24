/**
 * The Scorecard reader against an in-memory Scorecard: every getter answers with real ABI-encoded bytes,
 * decoded by the same Multicall3 plumbing shape the service uses, and skill() is tallied inside settle()
 * exactly as the Solidity does it. Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";
import { ScorecardIndex, grade, recount } from "./scorecard.ts";
import type { ScorecardChain } from "./scorecard.ts";
import type { Call, CallResult, PinnedBlock } from "../sources/chain.ts";
import { scorecardAbi } from "../sources/scorecard.ts";
import { hex32, MARK1 } from "../fixtures/scorecard.ts";

const W1 = getAddress("0x41333df9e7639188bbfca5522dc4844398af9f9e");
const W2 = getAddress("0x076cf393e701839fc7a5832d2c68aafa235682ae");
const ADDR = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";

interface Commit { wrapper: string; committedAt: number; committedBlock: number; settleAfter: number; mark: bigint; lastPrint: bigint; closingVwap: bigint }

/** Scorecard v2's storage and getters, and nothing else. */
class FakeScorecard implements ScorecardChain {
  ids: string[] = [];
  commits = new Map<string, Commit>();
  settles = new Map<string, [number, number, bigint, number, number, number]>();
  settledCount = 0; beatLast = 0; beatVwap = 0;
  blockNo = 71_000_000;
  /** Every multicall's pinned block number, and its calls' function names. */
  batches: Array<{ block: number; fns: string[] }> = [];
  failGetter: string | null = null;

  async pin(): Promise<PinnedBlock> {
    this.blockNo += 7;
    return { number: this.blockNo, hash: hex32(this.blockNo), timestamp: 1_790_000_000 + this.blockNo, rpc: "stub" };
  }

  commit(c: Omit<Commit, "committedBlock"> & { committedBlock?: number }): string {
    const id = hex32(0x1d00 + this.ids.length);
    this.ids.push(id);
    this.commits.set(id, { committedBlock: this.blockNo, ...c });
    return id;
  }

  /** settle(), with the contract's tally: strict. */
  settle(id: string, reopen: bigint, e0: number, e1: number, e2: number): void {
    this.settles.set(id, [1_790_100_000, this.blockNo, reopen, e0, e1, e2]);
    this.settledCount++;
    if (e0 < e1) this.beatLast++;
    if (e0 < e2) this.beatVwap++;
  }

  async multicall(block: PinnedBlock, calls: Call[]) {
    const fns: string[] = [];
    const results: CallResult[] = calls.map((c) => {
      assert.equal(c.target, ADDR);
      const tx = scorecardAbi.parseTransaction({ data: c.callData })!;
      fns.push(tx.name);
      if (this.failGetter === tx.name) return { ...c, success: false, returnData: "0x" };
      let out: unknown[];
      switch (tx.name) {
        case "closureCount": out = [this.ids.length]; break;
        case "skill": out = [this.settledCount, this.beatLast, this.beatVwap]; break;
        case "closureIds": {
          const i = Number(tx.args[0]);
          if (i >= this.ids.length) return { ...c, success: false, returnData: "0x" };   // array out of bounds reverts
          out = [this.ids[i]];
          break;
        }
        case "commitments": {
          const k = this.commits.get(String(tx.args[0]));
          out = k
            ? [k.wrapper, k.committedAt, k.committedBlock, k.settleAfter, k.mark, 25, hex32(0xabc), MARK1, k.lastPrint, k.closingVwap, 0]
            : [getAddress("0x" + "00".repeat(20)), 0, 0, 0, 0, 0, hex32(0), hex32(0), 0, 0, 0];
          break;
        }
        case "settlements": {
          const s = this.settles.get(String(tx.args[0]));
          out = s ? [s[0], s[1], s[2], s[3], s[4], s[5], 4_294_967_295, 1, true] : [0, 0, 0, 0, 0, 0, 0, 0, false];
          break;
        }
        default: throw new Error(`unexpected getter ${tx.name}`);
      }
      return { ...c, success: true, returnData: scorecardAbi.encodeFunctionResult(tx.name, out) };
    });
    this.batches.push({ block: block.number, fns });
    return { block, results };
  }
}

const base = { committedAt: 1_790_052_618, settleAfter: 1_790_053_200 };

test("grade() is Scorecard.settle()'s own comparison: strict, so an exact tie wins nothing", () => {
  const s = (e0: number, e1: number, e2: number) => grade({ settledAt: 0, settledBlock: 0, reopenPrintE18: "1", curbErrorBps: e0, lastPrintErrorBps: e1, closingVwapErrorBps: e2, staleOracleErrorBps: 0, source: 1 });
  assert.deepEqual(s(5, 10, 10), { beatLastPrint: true, beatClosingVwap: true, tie: false, tieClosingVwap: false });
  assert.deepEqual(s(7, 7, 7), { beatLastPrint: false, beatClosingVwap: false, tie: true, tieClosingVwap: true }, "a tie is not a win");
  assert.deepEqual(s(0, 0, 0), { beatLastPrint: false, beatClosingVwap: false, tie: true, tieClosingVwap: true });
  assert.deepEqual(s(20, 10, 30), { beatLastPrint: false, beatClosingVwap: true, tie: false, tieClosingVwap: false });
  assert.deepEqual(s(10, 9, 11), { beatLastPrint: false, beatClosingVwap: true, tie: false, tieClosingVwap: false }, "one bp worse is a loss");
});

test("every row read at one pinned block, decoded from real ABI bytes, and the strict recount equals skill()", async () => {
  const sc = new FakeScorecard();
  const win = sc.commit({ wrapper: W1, ...base, mark: 100n, lastPrint: 90n, closingVwap: 90n });
  const tie = sc.commit({ wrapper: W2, ...base, mark: 58243189692637603411n, lastPrint: 58243189692637603411n, closingVwap: 58243189692637603411n });
  const mixed = sc.commit({ wrapper: W1, ...base, mark: 120n, lastPrint: 110n, closingVwap: 90n });
  sc.commit({ wrapper: W2, ...base, mark: 5n, lastPrint: 5n, closingVwap: 5n });   // committed, not yet settled
  sc.settle(win, 101n, 5, 10, 10);
  sc.settle(tie, 58237918997832996539n, 0, 0, 0);
  sc.settle(mixed, 100n, 20, 10, 30);

  let t = 1_000;
  const idx = new ScorecardIndex({ scorecard: ADDR.toLowerCase(), chain: sc, now: () => t });
  assert.equal(idx.status(t).outage, true, "no snapshot yet is an outage, never an empty record");
  const snap = await idx.refresh();

  assert.equal(snap.scorecard, ADDR, "checksummed");
  assert.equal(new Set(sc.batches.map((b) => b.block)).size, 1, "every getter pinned to the same block");
  assert.equal(snap.block.number, sc.batches[0].block);
  assert.equal(snap.closureCount, 4);
  assert.deepEqual(snap.skill, { settled: 3, beatLast: 1, beatVwap: 2 });
  assert.deepEqual(recount(snap.rows), snap.skill, "the strict per-row rule reproduces the contract's own tally");
  assert.deepEqual(snap.rows.map((r) => r.index), [0, 1, 2, 3]);

  const [r0, r1, , r3] = snap.rows;
  assert.equal(r0.wrapper, W1);
  assert.equal(r0.markE18, "100");
  assert.equal(r0.methodDigest, MARK1);
  assert.equal(r1.markE18, "58243189692637603411", "uint128 survives as a decimal string");
  assert.equal(r1.settlement!.reopenPrintE18, "58237918997832996539");
  assert.equal(r1.settlement!.staleOracleErrorBps, 4_294_967_295);
  assert.deepEqual(grade(r1.settlement!), { beatLastPrint: false, beatClosingVwap: false, tie: true, tieClosingVwap: true });
  assert.equal(r3.settlement, null, "an unsettled row is a row with no settlement, not a row of zeroes");
});

test("incremental: later refreshes read only the count, skill() and the settlements still owed", async () => {
  const sc = new FakeScorecard();
  const a = sc.commit({ wrapper: W1, ...base, mark: 1n, lastPrint: 1n, closingVwap: 1n });
  const b = sc.commit({ wrapper: W1, ...base, mark: 1n, lastPrint: 1n, closingVwap: 1n });
  sc.settle(a, 1n, 0, 0, 0);
  const idx = new ScorecardIndex({ scorecard: ADDR, chain: sc, now: () => 0 });
  await idx.refresh();

  sc.batches = [];
  const same = await idx.refresh();
  assert.deepEqual(sc.batches.map((x) => x.fns), [["closureCount", "skill", "settlements"]], "one settlement owed, nothing else re-read");
  assert.equal(same.rows[1].settlement, null);

  // b settles and a new row lands: both appear, read at the new block.
  sc.settle(b, 2n, 3, 4, 2);
  const c = sc.commit({ wrapper: W2, ...base, mark: 9n, lastPrint: 9n, closingVwap: 9n });
  sc.batches = [];
  const next = await idx.refresh();
  assert.deepEqual(sc.batches.map((x) => x.fns), [["closureCount", "skill", "settlements"], ["closureIds"], ["commitments", "settlements"]]);
  assert.equal(new Set(sc.batches.map((x) => x.block)).size, 1, "the increment is pinned to one block too");
  assert.equal(next.block.number, sc.batches[0].block);
  assert.equal(next.rows.length, 3);
  assert.equal(next.rows[1].settlement!.curbErrorBps, 3);
  assert.equal(next.rows[2].id, c);
  assert.deepEqual(next.skill, { settled: 2, beatLast: 1, beatVwap: 0 });
  assert.equal(idx.fullRereads, 0);
});

test("a dropped row (reorg) or a skill() the cached rows cannot reproduce forces a full re-read", async () => {
  const sc = new FakeScorecard();
  const a = sc.commit({ wrapper: W1, ...base, mark: 1n, lastPrint: 1n, closingVwap: 1n });
  sc.commit({ wrapper: W1, ...base, mark: 1n, lastPrint: 1n, closingVwap: 1n });
  const idx = new ScorecardIndex({ scorecard: ADDR, chain: sc, now: () => 0 });
  await idx.refresh();

  // The second commit is reorged out.
  const dropped = sc.ids.pop()!;
  sc.commits.delete(dropped);
  const after = await idx.refresh();
  assert.equal(idx.fullRereads, 1);
  assert.equal(after.rows.length, 1);

  // A settle we never saw is reflected in skill() but, say, our cached view of `a` were wrong: the recount
  // disagrees, so everything is read again rather than served from cache.
  sc.settle(a, 1n, 1, 2, 2);
  sc.beatLast += 1;   // skill() now claims a win no row can account for
  const again = await idx.refresh();
  assert.equal(idx.fullRereads, 2, "incremental recount disagreed, so a full read followed");
  assert.deepEqual(again.skill, { settled: 1, beatLast: 2, beatVwap: 1 }, "a full read that still disagrees is kept, as read");
  assert.deepEqual(recount(again.rows), { settled: 1, beatLast: 1, beatVwap: 1 });
});

test("a failed getter keeps the previous snapshot and records why; its age decides stale versus refused", async () => {
  const sc = new FakeScorecard();
  sc.commit({ wrapper: W1, ...base, mark: 1n, lastPrint: 1n, closingVwap: 1n });
  let t = 0;
  const idx = new ScorecardIndex({ scorecard: ADDR, chain: sc, now: () => t, staleAfterMs: 300_000, outageMs: 1_800_000 });
  const good = await idx.refresh();

  sc.failGetter = "skill";
  t = 400_000;
  await assert.rejects(idx.refresh(), /Scorecard getter failed: skill/);
  const st = idx.status(t);
  assert.equal(st.snapshot, good, "the last good snapshot is kept whole");
  assert.equal(st.stale, true);
  assert.equal(st.outage, false);
  assert.match(st.lastError!, /skill/);
  assert.equal(idx.status(1_900_001).outage, true);

  sc.failGetter = null;
  await idx.refresh();
  assert.equal(idx.status(t).lastError, null);
  assert.equal(idx.status(t).stale, false);
});

test("an id with no commitment behind it is an error, never a row invented from zeroes", async () => {
  const sc = new FakeScorecard();
  sc.ids.push(hex32(0xdead));   // listed in closureIds, absent from commitments
  const idx = new ScorecardIndex({ scorecard: ADDR, chain: sc, now: () => 0 });
  await assert.rejects(idx.refresh(), /commitments\(.*\) is empty/);
  assert.equal(idx.status(0).snapshot, null);
});
