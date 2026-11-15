import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSURE_COMMIT_CAP, SWAP_EVIDENCE_FROM_BLOCK, closingRangeFor, commitList, cutReadOf, eraOf, formatBps, groupDigits,
  swapLine, swapListDigest,
} from "./swapEvidence.ts";
import { poolAbi } from "./sources/pools.ts";
import type { MulticallSnapshot } from "./sources/chain.ts";

const EMPTY_DIGEST = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

test("era by read block", () => {
  assert.equal(eraOf(99, 100, []), "pre-swap-fix");
  assert.equal(eraOf(100, 100, []), "swap-evidence");
  assert.equal(eraOf(150, 100, [[140, 160]]), "pre-swap-fix");
  assert.equal(eraOf(161, 100, [[140, 160]]), "swap-evidence");
  // Fails closed: nothing that is not a safe integer can select the lenient path.
  assert.equal(eraOf(NaN, 100, []), "swap-evidence");
  assert.equal(eraOf(1.5, 100, []), "swap-evidence");
  assert.equal(eraOf(Number("75776392x"), 100, []), "swap-evidence");
  assert.equal(eraOf(Number.POSITIVE_INFINITY, 100, []), "swap-evidence");
  assert.equal(eraOf("99" as unknown as number, 100, []), "swap-evidence");
});

test("the constant is the placeholder or a real block", () => {
  // 75,776,412 is the last block read by a pre-fix build before 14 Nov; 12.4b replaces the placeholder.
  assert.ok(SWAP_EVIDENCE_FROM_BLOCK === Number.MAX_SAFE_INTEGER || SWAP_EVIDENCE_FROM_BLOCK >= 75_776_413);
});

test("closingRangeFor is mark/2's 900 blocks and the cut block", () => {
  assert.deepEqual(closingRangeFor(75_773_120, 900_000), { fromBlock: 75_772_220, toBlock: 75_773_120 });
  assert.deepEqual(closingRangeFor(100, 900_000), { fromBlock: 0, toBlock: 100 });
  assert.deepEqual(closingRangeFor(10_000, 900_001), { fromBlock: 9_099, toBlock: 10_000 }, "ceil, not floor");
});

const rows = (n: number) => Array.from({ length: n }, (_, k) => ({ blockNumber: 1_000 + k, logIndex: k % 7, equityAbs: BigInt(k + 1), priceE18: 10n ** 18n + BigInt(k) }));

test("commitList keeps everything up to the cap", () => {
  const r = commitList(rows(CLOSURE_COMMIT_CAP));
  assert.equal(r.committed.length, 10_000);
  assert.equal(r.omitted, null);
});

test("commitList keeps head and tail above the cap", () => {
  const all = rows(15_000);
  const r = commitList(all);
  assert.equal(r.committed.length, 10_000);
  assert.equal(r.committed[4999], all[4999]);
  assert.equal(r.committed[5000], all[10_000]);
  assert.equal(r.committed[9999], all[14_999]);
  assert.deepEqual(r.omitted, { fromIndex: 5000, toIndex: 9999 });
});

test("swapListDigest: decimal lines, newline-joined; bigint and string rows agree", () => {
  assert.equal(swapListDigest([]), EMPTY_DIGEST);
  const r = { blockNumber: 75_776_054, logIndex: 74, equityAbs: 8_200_000_000_000_000_000n, priceE18: 3_696_914_780_433_983_591n };
  assert.equal(swapLine(r), "75776054:74:8200000000000000000:3696914780433983591");
  const asJson = { blockNumber: r.blockNumber, logIndex: r.logIndex, equityAbs: r.equityAbs.toString(), priceE18: r.priceE18.toString() };
  assert.equal(swapListDigest([r, r]), swapListDigest([asJson, asJson]));
  assert.notEqual(swapListDigest([r]), swapListDigest([r, r]));
});

test("formatBps rounds half away from zero", () => {
  assert.equal(formatBps(10_005n, 10_000n), "+5.0");
  assert.equal(formatBps(1_000_005n, 1_000_000n), "+0.1", "exactly +0.05 bp");
  assert.equal(formatBps(999_996n, 1_000_000n), "0.0", "-0.04 bp");
  assert.equal(formatBps(999_995n, 1_000_000n), "-0.1", "exactly -0.05 bp");
  assert.equal(formatBps(5n, 5n), "0.0");
  assert.equal(formatBps(9_626_143n, 10_000_000n), "-373.9", "exact -373.857");
});

test("groupDigits is locale-independent", () => {
  assert.equal(groupDigits(5000), "5,000");
  assert.equal(groupDigits(15_000), "15,000");
  assert.equal(groupDigits(999), "999");
  assert.equal(groupDigits(1_234_567), "1,234,567");
});

test("cutReadOf picks the pool's slot0 with the block", () => {
  const A = "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417";
  const B = "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f";
  const slot = (sqrt: bigint) => poolAbi.encodeFunctionResult("slot0", [sqrt, 1, 0, 1, 1, 0, true]);
  const snap: MulticallSnapshot = {
    block: { number: 75_773_120, hash: "0x" + "ab".repeat(32), timestamp: 1_794_542_157, rpc: "https://rpc.xlayer.tech" },
    results: [
      { label: `slot0:${A}`, target: A, callData: "0x3850c7bd", success: true, returnData: slot(1n << 96n) },
      { label: `slot0:${B}`, target: B, callData: "0x3850c7bd", success: true, returnData: slot(2n << 96n) },
    ],
  };
  assert.deepEqual(cutReadOf(snap, B.toLowerCase()), {
    blockNumber: 75_773_120, blockHash: "0x" + "ab".repeat(32), blockTimestamp: 1_794_542_157, slot0: slot(2n << 96n),
  });
  assert.equal(cutReadOf(snap, A)!.slot0, slot(1n << 96n));
  // A failed read, an undecodable one, a missing pool or a bad address: no cut read.
  assert.equal(cutReadOf({ ...snap, results: [{ ...snap.results[1], success: false }] }, B), null);
  assert.equal(cutReadOf({ ...snap, results: [{ ...snap.results[1], returnData: "0x" }] }, B), null);
  assert.equal(cutReadOf({ ...snap, results: [snap.results[0]] }, B), null);
  assert.equal(cutReadOf(snap, "not an address"), null);
  assert.equal(cutReadOf(null, B), null);
});
