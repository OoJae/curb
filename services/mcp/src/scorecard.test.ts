import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes, parseUnits } from "ethers";
import { readScorecard, limitScorecard, findCommitTxs, statusAt, MAX_ROWS, SETTLE_DELAY_S, SETTLE_WINDOW_S } from "./scorecard.ts";
import { CONTRACTS, requireAsset } from "./assets.ts";
import { BLOCK, fakeChain } from "./fixtures/fakeChain.ts";
import type { LogFilter } from "./sources/chain.ts";

const MARK1 = keccak256(toUtf8Bytes("curb.scorecard.mark/1"));
const MARK2 = keccak256(toUtf8Bytes("curb.scorecard.mark/2"));
const e18 = (s: string) => parseUnits(s, 18);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const TCENT = requireAsset("wTCENTx").wrapper;
const XIAO = requireAsset("wXIAOx").wrapper;

interface Row { wrapper: string; committedAt: number; settleAfter: number; digest: string; mark: bigint; last: bigint; vwap: bigint; settle?: [number, number, number, bigint] }

/** Three rows: a tie (mark/1), a win against the last print only (mark/2), and one still awaiting its reopen. */
const ROWS: Row[] = [
  { wrapper: XIAO, committedAt: 1_790_200_000, settleAfter: 1_790_200_600, digest: MARK1, mark: e18("3.348"), last: e18("3.348"), vwap: e18("3.348"), settle: [104, 104, 104, e18("3.383")] },
  { wrapper: TCENT, committedAt: 1_790_250_000, settleAfter: 1_790_250_600, digest: MARK2, mark: e18("56.2"), last: e18("56.0"), vwap: e18("56.1"), settle: [10, 40, 10, e18("56.25")] },
  { wrapper: TCENT, committedAt: BLOCK.timestamp - 60, settleAfter: BLOCK.timestamp + 540, digest: MARK2, mark: e18("56.3"), last: e18("56.15"), vwap: e18("56.15") },
];

function scorecardChain(rows: Row[], skill: [number, number, number], logs?: (f: LogFilter) => { transactionHash: string; blockNumber: string; topics: string[]; data: string }[]) {
  return fakeChain((target, fn, args) => {
    if (target !== CONTRACTS.scorecard) return undefined;
    switch (fn) {
      case "closureCount": return [rows.length];
      case "skill": return skill;
      case "closureIds": return [id(Number(args[0]) + 1)];
      case "commitments": {
        const r = rows[Number(BigInt(String(args[0]))) - 1];
        return [r.wrapper, r.committedAt, 71_000_000 + r.committedAt % 1000, r.settleAfter, r.mark, 25, "0x" + "11".repeat(32), r.digest, r.last, r.vwap, 0];
      }
      case "settlements": {
        const r = rows[Number(BigInt(String(args[0]))) - 1];
        if (!r.settle) return [0, 0, 0, 0, 0, 0, 0, 0, false];
        const [c, l, v, p] = r.settle;
        return [r.settleAfter + 330, 71_100_000, p, c, l, v, 2 ** 32 - 1, 1, true];
      }
    }
    return undefined;
  }, { logs });
}

test("statusAt follows Scorecard's own window: settle opens SETTLE_DELAY after the reopen, for SETTLE_WINDOW", () => {
  const s = 1_000_000;
  assert.equal(statusAt(s, true, s + 99_999), "settled");
  assert.equal(statusAt(s, false, s + SETTLE_DELAY_S - 1), "awaiting-reopen");
  assert.equal(statusAt(s, false, s + SETTLE_DELAY_S), "in-settlement-window");
  assert.equal(statusAt(s, false, s + SETTLE_DELAY_S + SETTLE_WINDOW_S), "in-settlement-window");
  assert.equal(statusAt(s, false, s + SETTLE_DELAY_S + SETTLE_WINDOW_S + 1), "expired-unsettled");
});

test("skill() is reported as the contract returns it, and the rows come newest first at the same block", async () => {
  const chain = scorecardChain(ROWS, [2, 1, 0]);
  const r = await readScorecard(chain, 10);
  assert.equal(r.asOf.block, BLOCK.number);
  assert.deepEqual({ settled: r.skill.settled, beatLastPrint: r.skill.beatLastPrint, beatClosingVwap: r.skill.beatClosingVwap }, { settled: 2, beatLastPrint: 1, beatClosingVwap: 0 });
  assert.equal(r.closureCount, 3);
  assert.deepEqual(r.rows.map((x) => x.index), [2, 1, 0]);
  assert.equal(r.summary, `Scorecard v2 at block ${BLOCK.number}: 3 marks committed, 2 settled. Curb's mark beat the last print in 1 and the pre-close price (closingVwap) in 0 (strict wins; 1 of the settled rows did not beat the last print). Newest 3 rows below.`);

  const [pending, win, tie] = r.rows;
  assert.equal(pending.status, "awaiting-reopen");
  assert.equal(pending.settlement, null);
  assert.equal(pending.symbol, "wTCENTx");
  assert.equal(pending.method, "curb.scorecard.mark/2");
  assert.equal(win.settlement?.result, "win");
  assert.equal(win.settlement?.resultVsClosingVwap, "tie", "equal error against the closing VWAP is a tie, not a win");
  assert.equal(win.markUsd, "56.2");
  assert.equal(win.settlement?.reopenPrintUsd, "56.25");
  assert.equal(tie.symbol, "wXIAOx");
  assert.equal(tie.method, "curb.scorecard.mark/1");
  assert.equal(tie.settlement?.result, "tie");
  assert.equal(tie.bandBps, 25);
});

test("limit keeps the newest rows only, and an empty record says so", async () => {
  const r = await readScorecard(scorecardChain(ROWS, [2, 1, 0]), 1);
  assert.deepEqual(r.rows.map((x) => x.index), [2]);
  const empty = await readScorecard(scorecardChain([], [0, 0, 0]), 10);
  assert.equal(empty.rows.length, 0);
  assert.match(empty.summary, /No rows yet\.$/);
});

test("limitScorecard cuts a larger read to exactly what a read at that limit returns, without touching the original", async () => {
  const full = await readScorecard(scorecardChain(ROWS, [2, 1, 0]), MAX_ROWS);
  for (const n of [1, 2, 3, 10]) {
    assert.deepEqual(limitScorecard(full, n), await readScorecard(scorecardChain(ROWS, [2, 1, 0]), n), `limit ${n}`);
  }
  assert.equal(full.rows.length, 3);
  assert.match(limitScorecard(full, 1).summary, /Newest 1 rows below\.$/);
});

test("each row's commit transaction is found once from ClosureCommitted in its own block, then remembered", async () => {
  const lookups: LogFilter[] = [];
  const chain = scorecardChain(ROWS, [2, 1, 0], (f) => {
    lookups.push(f);
    return [{ transactionHash: "0x" + "cd".repeat(32), blockNumber: "0x1", topics: [String(f.topics[0]), String(f.topics[1])], data: "0x" }];
  });
  const known = new Map<string, string>();
  const r = await readScorecard(chain, 10, known);
  assert.equal(lookups.length, 3);
  for (const f of lookups) assert.equal(f.fromBlock, f.toBlock, "one block per lookup");
  assert.ok(r.rows.every((x) => x.commitTx === "0x" + "cd".repeat(32)));
  await readScorecard(chain, 10, known);
  assert.equal(lookups.length, 3, "a commit is final, so it is never looked up twice");
});

test("commit lookups stop starting once the time budget is spent, and the rest are found on a later call", async () => {
  let lookups = 0;
  const slow = scorecardChain(ROWS, [2, 1, 0], (f) => {
    lookups++;
    const until = Date.now() + 40;
    while (Date.now() < until) { /* a slow RPC */ }
    return [{ transactionHash: "0x" + "cd".repeat(32), blockNumber: "0x1", topics: [String(f.topics[0]), String(f.topics[1])], data: "0x" }];
  });
  const { rows } = await readScorecard(slow, 10);
  const known = new Map<string, string>();
  await findCommitTxs(slow, rows, known, 20);
  assert.ok(known.size >= 1 && known.size < rows.length, `some but not all found within the budget, got ${known.size}`);
  await findCommitTxs(slow, rows, known, 10_000);
  assert.equal(known.size, rows.length);
  assert.equal(lookups, rows.length, "no row is looked up twice");
});

test("a failed getter fails the answer instead of inventing a row", async () => {
  const chain = fakeChain((target, fn) => (fn === "skill" ? undefined : fn === "closureCount" ? [1] : undefined));
  await assert.rejects(readScorecard(chain, 5), /Scorecard getter failed: skill/);
});
