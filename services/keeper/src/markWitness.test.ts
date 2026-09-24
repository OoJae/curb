import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction, Wallet } from "ethers";
import { buildMarkRound } from "./markRound.ts";
import type { MarkInputs } from "./markRound.ts";
import { checkMarkRound } from "./markWitness.ts";
import { closureId, decodeCommitCalldata, methodDigestOf, scorecardAbi } from "./sources/scorecard.ts";
import type { CommittedRow } from "./sources/scorecard.ts";
import type { TxInfo } from "./sources/chain.ts";
import { Sender } from "./tx/sender.ts";
import type { RpcFn } from "./tx/sender.ts";

const E18 = 10n ** 18n;
const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const POOL = "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f";
const SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
const CLOCK = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
const METHOD = "curb.scorecard.mark/1";

const CUT_MS = new Date("2026-09-22T11:56:00+08:00").getTime();
const REOPEN_S = Math.floor(new Date("2026-09-22T13:00:00+08:00").getTime() / 1000);
const EVAL_MS = new Date("2026-09-22T12:50:00+08:00").getTime();
const COMMIT_BLOCK = 71_300_000;
const COMMIT_AT_S = Math.floor(EVAL_MS / 1000) + 20;

const HKEX_SCHEDULE = {
  timezone: "Asia/Hong_Kong",
  sessions: [
    { kind: "Extended", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:00", close: "09:30" },
    { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "09:30", close: "12:00" },
    { kind: "Regular", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "13:00", close: "16:00" },
    { kind: "Extended", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "16:00", close: "16:10" },
  ],
  holidays: [],
};
const HK_LIMITS = {
  market: { maxOrderFiatValue: 2_000_000 }, extended: { maxOrderFiatValue: 0 },
  overnight: { maxOrderFiatValue: 0 }, closed: { maxOrderFiatValue: 0 },
};

function inputs(): MarkInputs {
  return {
    chainId: 196, clock: CLOCK, scorecard: SCORECARD,
    evaluatedAtMs: EVAL_MS, codeDigest: "sha256:test",
    specs: [{ wrapper: W, symbol: "wTCENTx", pool: POOL, equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 }],
    chain: {
      block: { number: COMMIT_BLOCK - 30, hash: "0x" + "11".repeat(32), timestamp: COMMIT_AT_S - 30, rpc: "https://rpc.xlayer.tech" },
      results: [{ label: `slot0:${POOL}`, target: POOL, callData: "0x3850c7bd", success: true, returnData: "0x" }],
    },
    closures: [{
      wrapper: W, symbol: "wTCENTx", cutAtMs: CUT_MS, cutBlock: COMMIT_BLOCK - 3800, settleAfterS: REOPEN_S,
      input: {
        wrapper: W, symbol: "wTCENTx",
        lastPrintE18: 54n * E18, midAtCutE18: 54n * E18, midNowE18: 5508n * E18 / 100n,
        closingVwapE18: 545n * E18 / 10n, swapsDuringClosure: 4,
      },
      closingSwaps: [{ blockNumber: COMMIT_BLOCK - 3900, logIndex: 3, equityAbs: E18, priceE18: 545n * E18 / 10n }],
      closureSwaps: [{ blockNumber: COMMIT_BLOCK - 2000, logIndex: 1, equityAbs: 2n * E18, priceE18: 5508n * E18 / 100n }],
      venue: {
        mic: "XHKG",
        assetUrl: "https://api.xstocks.fi/api/v2/public/assets/TCENTx?network=XLayer", assetBodyHash: "0x" + "ab".repeat(32),
        exchangeUrl: "https://api.xstocks.fi/api/v2/public/exchanges/XHKG", exchangeBodyHash: "0x" + "cd".repeat(32),
        cutAtMs: CUT_MS, limitsPerPeriod: HK_LIMITS, schedule: HKEX_SCHEDULE, predictedReopenMs: REOPEN_S * 1000,
      },
    }],
  };
}

function build() {
  const round = buildMarkRound(inputs());
  const m = round.marks[0];
  const row: CommittedRow = {
    id: closureId(W, REOPEN_S, round.root),
    wrapper: W, settleAfter: REOPEN_S, committedBlock: COMMIT_BLOCK,
    mark: m.mark.markE18.toString(), bandBps: m.mark.bandBps,
    inputRoot: round.root, methodDigest: methodDigestOf(METHOD),
    lastPrint: m.mark.lastPrintE18.toString(), closingVwap: m.mark.closingVwapE18.toString(), staleOracle: "0",
    txHash: "0x" + "ee".repeat(32),
  };
  const tx: TxInfo = {
    hash: row.txHash, from: "0xd3D9Bf9Ff2A80Aa13D9C0299fadc9775343a1AF6", to: SCORECARD,
    blockNumber: COMMIT_BLOCK,
    input: scorecardAbi.encodeFunctionData("commit", [{
      wrapper: W, committedAt: 0, committedBlock: 0, settleAfter: REOPEN_S,
      mark: m.mark.markE18, bandBps: m.mark.bandBps,
      inputRoot: round.root, methodDigest: methodDigestOf(METHOD),
      lastPrint: m.mark.lastPrintE18, closingVwap: m.mark.closingVwapE18, staleOracle: 0n,
    }]),
  };
  return { bundle: JSON.parse(JSON.stringify(round.bundle)), row, tx };
}

const check = (b: unknown, row: CommittedRow, tx: TxInfo | null, at = COMMIT_AT_S, settlement?: Parameters<typeof checkMarkRound>[6]) =>
  checkMarkRound(b, row, tx, 196, SCORECARD, at, settlement);

test("a well-formed row reproduces, with its baselines cross-checked against the calldata", () => {
  const { bundle, row, tx } = build();
  const c = check(bundle, row, tx);
  assert.deepEqual(c.failures, []);
  assert.equal(c.reproduced, true);
  assert.equal(c.labelsConsistent, true);
  assert.equal(c.baselinesChecked, true);
  assert.equal(c.method, METHOD);
  assert.equal(c.closureId.toLowerCase(), row.id.toLowerCase());
});

test("without the transaction the baselines are not checked, and it says so rather than passing quietly", () => {
  const { bundle, row } = build();
  const c = check(bundle, row, null);
  assert.equal(c.reproduced, true);
  assert.equal(c.baselinesChecked, false);
  assert.ok(c.warnings.some((w) => w.includes("baselines could not be cross-checked")));
});

test("a keeper that commits a different mark than it published is caught", () => {
  const { bundle, row, tx } = build();
  const c = check(bundle, { ...row, mark: (99n * E18).toString() }, tx);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => /calldata disagrees|claim mark/.test(f)), c.failures.join("; "));
});

test("a row whose method digest does not match its published method is caught", () => {
  const { bundle, row, tx } = build();
  const wrong = methodDigestOf("curb.scorecard.mark/99");
  const c = check(bundle, { ...row, methodDigest: wrong }, { ...tx, input: tx.input });
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("methodDigest")), c.failures.join("; "));
});

test("a mismatched closure id is caught, because the id is recomputed not trusted", () => {
  const { bundle, row, tx } = build();
  const c = check(bundle, { ...row, id: "0x" + "99".repeat(32) }, tx);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("closure id")), c.failures.join("; "));
});

test("a method used outside its committed block range is refused", () => {
  const { bundle, row, tx } = build();
  // Before Scorecard v2 existed at all.
  const c = check(bundle, { ...row, committedBlock: 70_000_000 }, tx);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("not valid at block")), c.failures.join("; "));
});

test("a bundle built against the retired Scorecard v1 cannot validate a v2 row", () => {
  const i = inputs();
  i.scorecard = "0x0527930187a879B3D8704a92734641679567EddD";
  const round = buildMarkRound(i);
  const m = round.marks[0];
  const row: CommittedRow = {
    id: closureId(W, REOPEN_S, round.root), wrapper: W, settleAfter: REOPEN_S, committedBlock: COMMIT_BLOCK,
    mark: m.mark.markE18.toString(), bandBps: m.mark.bandBps, inputRoot: round.root,
    methodDigest: methodDigestOf(METHOD), lastPrint: null, closingVwap: null, staleOracle: null,
    txHash: "0x" + "ee".repeat(32),
  };
  const c = check(JSON.parse(JSON.stringify(round.bundle)), row, null);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("committed scorecard")), c.failures.join("; "));
});

test("THE anti-backfill invariant: a mark committed at or after its own settleAfter is caught", () => {
  // Scorecard.commit does not enforce this -- it only requires primaryCapNow == 0 -- so a row whose
  // claimed grading instant had already passed would be accepted on chain. This is the only place
  // anywhere that catches it.
  const { bundle, row, tx } = build();
  const c = check(bundle, row, tx, REOPEN_S + 1);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("did not precede the reopen")), c.failures.join("; "));
});

test("a chain read taken after the commit is caught", () => {
  const { bundle, row, tx } = build();
  const c = check(bundle, { ...row, committedBlock: COMMIT_BLOCK - 100 }, tx);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("AFTER the commit")), c.failures.join("; "));
});

test("evidence replayed from long before the commit is caught", () => {
  const { bundle, row, tx } = build();
  const c = check(bundle, row, tx, COMMIT_AT_S + 7200);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("replay of stale evidence")), c.failures.join("; "));
});

test("a settlement that did not follow its own commit is caught", () => {
  const { bundle, row, tx } = build();
  const c = check(bundle, row, tx, COMMIT_AT_S, { settledAt: REOPEN_S + 300, settledBlock: COMMIT_BLOCK - 1, reopenPrint: "1", settled: true });
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("not after the commit block")), c.failures.join("; "));
});

test("malformed input is reported, never thrown", () => {
  const { row, tx } = build();
  for (const bad of [null, undefined, 42, "x", {}, { schema: "curb.scorecard.markbundle/1" }]) {
    const c = check(bad, row, tx);
    assert.equal(c.reproduced, false);
    assert.ok(c.failures.length > 0);
  }
});

// Attribution (ERC-8021, 24 Sep 2026). With DATA_SUFFIX set, every commit and settle carries the X Layer
// Builder Code AFTER the ABI-encoded arguments. It is not part of the row: the id, the baselines and the
// check must come out exactly as they do for a bare commit.

const BUILDER_SUFFIX = "0x6464377535306e636b74356537323966100080218021802180218021802180218021";

test("a commit carrying the Builder Code suffix decodes to the same row and still reproduces", () => {
  const { bundle, row, tx } = build();
  const tagged: TxInfo = { ...tx, input: tx.input + BUILDER_SUFFIX.slice(2) };
  const bare = decodeCommitCalldata(tx.input);
  assert.ok(bare);
  assert.deepEqual(decodeCommitCalldata(tagged.input), bare, "the decoder stops at the arguments");
  const c = check(bundle, row, tagged);
  assert.deepEqual(c.failures, []);
  assert.equal(c.reproduced, true);
  assert.equal(c.baselinesChecked, true, "the baselines were read out of the suffixed calldata");
  assert.equal(c.closureId.toLowerCase(), row.id.toLowerCase());
  assert.deepEqual(c, check(bundle, row, tx), "the suffix changes nothing the check reports");
});

test("the suffix cannot launder a wrong commit: a mark that disagrees with the event is still caught", () => {
  const { bundle, row, tx } = build();
  const tagged: TxInfo = { ...tx, input: tx.input + BUILDER_SUFFIX.slice(2) };
  const c = check(bundle, { ...row, mark: (99n * E18).toString() }, tagged);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => /calldata disagrees|claim mark/.test(f)), c.failures.join("; "));
});

test("end to end: the frozen plan is never rewritten, every attempt is signed with one suffix, and the id is unchanged", async () => {
  const { bundle, row, tx } = build();
  // What buildPlan freezes and commitPass hands to prepare() on every attempt.
  const plan = { root: row.inputRoot, id: row.id, data: tx.input, attempts: 0 };
  const frozen = JSON.stringify(plan);
  const dir = mkdtempSync(join(tmpdir(), "curb-keeper-suffix-"));
  const clock = { t: 1_000_000 };
  const rpc: RpcFn = async (_url, method) => {
    switch (method) {
      case "eth_call": return "0x";
      case "eth_estimateGas": return "0x" + (180_000).toString(16);
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": return "0x3";
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const sender = new Sender({
    wallet: Wallet.createRandom(), rpcs: ["https://a"], chainId: 196, dbPath: join(dir, "keeper-outbox.sqlite"), rpc,
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, dataSuffix: BUILDER_SUFFIX,
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = await sender.prepare(SCORECARD, plan.data, { id: `commit:${plan.root}:${attempt}`, kind: "commit", targetMs: 0 });
    const signed = Transaction.from(p.raw);
    assert.equal(signed.data, tx.input + BUILDER_SUFFIX.slice(2), `attempt ${attempt} carries the suffix exactly once`);
    const decoded = decodeCommitCalldata(signed.data)!;
    assert.equal(closureId(decoded.wrapper, decoded.settleAfter, decoded.inputRoot), row.id, "the id Scorecard will compute");
    const written: TxInfo = { hash: signed.hash!, from: signed.from!, to: signed.to, blockNumber: COMMIT_BLOCK, input: signed.data };
    const c = check(bundle, row, written);
    assert.deepEqual(c.failures, []);
    assert.equal(c.reproduced, true);
  }
  assert.equal(JSON.stringify(plan), frozen, "CommitPlan.data (and the rest of the plan) is never touched by attribution");

  // settle(id): the id argument is read out of the suffixed calldata unchanged.
  const settleData = scorecardAbi.encodeFunctionData("settle", [row.id]);
  const s = await sender.prepare(SCORECARD, settleData, { id: `settle:${plan.root}:1`, kind: "settle", targetMs: 0 });
  const settleSigned = Transaction.from(s.raw);
  assert.equal(settleSigned.data, settleData + BUILDER_SUFFIX.slice(2));
  assert.equal(String(scorecardAbi.decodeFunctionData("settle", settleSigned.data)[0]).toLowerCase(), row.id.toLowerCase());
  rmSync(dir, { recursive: true, force: true });
});
