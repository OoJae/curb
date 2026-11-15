import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { assembleSwapEvidence } from "./evidence.ts";
import type { AssemblyInput, AssemblyResult } from "./evidence.ts";
import { buildMarkRound, verifyMarkBundleOffline } from "./markRound.ts";
import { computeMark, MARK2 } from "./mark.ts";
import { LeafKind, subjectOf } from "./tree.ts";
import type { SwapRow } from "./sources/pools.ts";
import { SWAP_TOPIC0 } from "./sources/pools.ts";
import { RECESS, RECESS_ROOT_OF, inputsFromBundle, leafValue, loadBundle, recessRows, slot0Of, specOf } from "./fixtures/markFixtures.test.ts";
import type { RecessSymbol } from "./fixtures/markFixtures.test.ts";

// F2: every Swap log of the three HK pools over the 13 Nov 2026 recess (closing window and closure), decoded with
// decodeSwapLog against the REGISTRY specs; the mids, the old pre-cut reading and the signal from each archived
// bundle's markinput leaf; expected values from recess-20261113-expected.json (designer recess_fixture.py,
// cross-checked against keeper-map 2.2).
const EXPECTED = JSON.parse(readFileSync(new URL("./sources/fixtures/recess-20261113-expected.json", import.meta.url), "utf8"));
const FULL: Array<[number, number]> = [[RECESS.closingFrom, RECESS.pinnedBlock]];

function markinput(sym: RecessSymbol) {
  const b = loadBundle(RECESS_ROOT_OF[sym]);
  return leafValue(b, LeafKind.CA_SNAPSHOT, subjectOf(`markinput:${leafValue(b, LeafKind.CLAIM).wrapper.toLowerCase()}`));
}

function input(sym: RecessSymbol, over: Partial<AssemblyInput> = {}): AssemblyInput {
  const b = loadBundle(RECESS_ROOT_OF[sym]);
  const mi = markinput(sym);
  return {
    symbol: sym, pool: getAddress(specOf(b, sym).pool), cutBlock: RECESS.cutBlock, cutBlockHash: null, cutRead: null,
    pinnedBlock: RECESS.pinnedBlock, closingWindowMs: 900_000, rows: recessRows(sym), ranges: FULL,
    midAtCutE18: BigInt(mi.midAtCutE18), midNowE18: BigInt(mi.midNowE18), preCutMidE18: BigInt(mi.lastPrintE18),
    mustCommit: false, ...over,
  };
}

type Commit = Extract<AssemblyResult, { kind: "commit" }>;
function commit(r: AssemblyResult): Commit {
  if (r.kind !== "commit") assert.fail(`expected a commit, got ${r.kind}: ${r.kind === "defer" ? r.reason : r.message}`);
  return r;
}

/** The mark computeMark gives for an assembled input, with the mids and signal the archived bundle committed. */
function markOf(sym: RecessSymbol, ev: Commit) {
  const mi = markinput(sym);
  return computeMark({
    wrapper: mi.wrapper, symbol: sym, midAtCutE18: BigInt(mi.midAtCutE18), midNowE18: BigInt(mi.midNowE18), signal: mi.signal,
    lastPrintE18: ev.input.lastPrintE18, closingVwapE18: ev.input.closingVwapE18, swapsDuringClosure: ev.input.swapsDuringClosure,
  }, MARK2)!;
}

/** The archived round of `sym` rebuilt with assembled evidence: what buildPlan would publish. */
function roundOf(sym: RecessSymbol, ev: Commit) {
  const i = inputsFromBundle(loadBundle(RECESS_ROOT_OF[sym]));
  const c = i.closures[0];
  c.input = { ...c.input, ...ev.input };
  c.closingSwaps = ev.closingSwaps;
  c.closureSwaps = ev.closureSwaps;
  c.swapEvidence = ev.swapEvidence;
  return buildMarkRound(i);
}

/** Every committed result must pass the keeper's own strict self-check, degraded or not. */
function selfCheck(sym: RecessSymbol, ev: Commit) {
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(roundOf(sym, ev).bundle)), { era: "swap-evidence" });
  assert.deepEqual(v.failures, [], `${sym}: ${v.failures.join(" | ")}`);
  return v;
}

const at = (r: SwapRow | undefined) => (r ? [r.blockNumber, r.logIndex] : null);

test("wXIAOx recess: the evidence implies the mark keeper-map computed", () => {
  const X = EXPECTED.wXIAOx;
  const ev = commit(assembleSwapEvidence(input("wXIAOx")));
  assert.deepEqual(ev.degraded, []);
  assert.equal(ev.input.lastPrintE18, 3705883235022724078n);
  assert.equal(ev.input.closingVwapE18, 3708098822676793257n);
  assert.equal(ev.input.swapsDuringClosure, 14);
  assert.equal(ev.closingSwaps.length, 9);
  assert.deepEqual(at(ev.closingSwaps.at(-1)), [75773077, 68]);
  assert.deepEqual(at(ev.closureSwaps.at(-1)), [75776054, 74]);
  assert.deepEqual(ev.swapEvidence.closingRange, { fromBlock: 75772220, toBlock: 75773120 });
  assert.deepEqual(ev.swapEvidence.closureRange, { fromBlock: 75773121, toBlock: 75776392 });
  assert.equal(ev.complete, true);
  assert.equal(ev.closingComplete, true);
  assert.equal(ev.swapEvidence.complete, true);
  assert.equal(ev.swapEvidence.closingComplete, true);
  assert.deepEqual(ev.swapEvidence.counts, { closingLogs: 9, closureLogs: 14 });
  assert.equal(ev.swapEvidence.closureDigest, "0x1e178005413bae90d6a16606d5d19c0237229066fbe160e74efe6eacc1ec4578");
  assert.equal(ev.swapEvidence.topic0, SWAP_TOPIC0);
  assert.equal(ev.swapEvidence.pool, "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417");
  assert.equal(ev.swapEvidence.closureOmitted, null);
  const m = markOf("wXIAOx", ev);
  assert.equal(m.markE18, 3701436175140696810n);
  assert.equal(m.bandBps, 37);
  assert.equal(m.driftBps, -24);
  assert.deepEqual(m.flags, ["recess-no-edge"]);
  // The expected file agrees, field for field.
  assert.equal(String(ev.input.lastPrintE18), X.lastPrintE18);
  assert.equal(String(ev.input.closingVwapE18), X.closingVwapE18);
  assert.equal(ev.closingSwaps.length, X.closingCount);
  assert.equal(ev.input.swapsDuringClosure, X.closureCount);
  assert.deepEqual(at(ev.closureSwaps.at(-1)), X.closureLast);
  assert.equal(String(m.markE18), X.markE18);
  // I1 holds on the real data: the last closure swap leaves the pool exactly at the committed midNow.
  assert.equal(ev.closureSwaps.at(-1)!.priceE18, BigInt(X.midNowE18));
  selfCheck("wXIAOx", ev);
});

test("wTCENTx: a swap in the cut block is closing evidence only", () => {
  const ev = commit(assembleSwapEvidence(input("wTCENTx")));
  assert.equal(ev.closingSwaps.length, 2);
  assert.deepEqual(at(ev.closingSwaps.at(-1)), [75773120, 35]);
  assert.equal(ev.input.swapsDuringClosure, 0);
  assert.equal(ev.input.lastPrintE18, 49931913585409677182n);
  assert.notEqual(ev.input.lastPrintE18, BigInt(markinput("wTCENTx").lastPrintE18), "the old pre-cut reading, BT T8");
  assert.equal(String(BigInt(markinput("wTCENTx").lastPrintE18)), "49931913576968873057");
  assert.equal(ev.input.closingVwapE18, 49931922021995547562n);
  const m = markOf("wTCENTx", ev);
  assert.equal(m.markE18, ev.input.lastPrintE18);
  assert.equal(m.bandBps, 25);
  assert.ok(m.flags.includes("no-drift") && m.flags.includes("recess-no-edge"), m.flags.join(","));
  assert.equal(String(m.markE18), EXPECTED.wTCENTx.markE18);
  selfCheck("wTCENTx", ev);
});

test("wMEITx: nothing traded, the row is unchanged", () => {
  const ev = commit(assembleSwapEvidence(input("wMEITx")));
  assert.equal(ev.closingSwaps.length, 0);
  assert.equal(ev.closureSwaps.length, 0);
  assert.equal(ev.input.closingVwapE18, null);
  assert.equal(ev.input.lastPrintE18, 9101334608495175937n);
  assert.equal(ev.input.lastPrintE18, BigInt(markinput("wMEITx").midAtCutE18));
  assert.equal(String(markOf("wMEITx", ev).markE18), "9101334608495175937");
  assert.equal(ev.swapEvidence.closureDigest, "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  selfCheck("wMEITx", ev);
});

test("cutRead is carried into the leaf", () => {
  const cutRead = { blockNumber: 75773120, blockHash: "0x" + "ab".repeat(32), blockTimestamp: 1794542157, slot0: slot0Of(loadBundle(RECESS_ROOT_OF.wMEITx), "wMEITx") };
  const ev = commit(assembleSwapEvidence(input("wMEITx", { cutRead, cutBlockHash: cutRead.blockHash })));
  assert.deepEqual(ev.swapEvidence.cutRead, cutRead);
  assert.equal(ev.swapEvidence.cutBlockHash, cutRead.blockHash);
  assert.deepEqual(ev.degraded, []);
  assert.deepEqual(selfCheck("wMEITx", ev).notes, [], "a bound cut mid needs no note");
});

test("a cut read that is not this cut's is dropped, not committed", () => {
  const cutRead = { blockNumber: 75773119, blockHash: "0x" + "ab".repeat(32), blockTimestamp: 1, slot0: "0x" };
  const ev = commit(assembleSwapEvidence(input("wMEITx", { cutRead, cutBlockHash: cutRead.blockHash })));
  assert.equal(ev.swapEvidence.cutRead, null);
  assert.deepEqual(ev.degraded, ["cut-read-dropped"]);
  const noHash = commit(assembleSwapEvidence(input("wMEITx", { cutRead: { ...cutRead, blockNumber: 75773120 }, cutBlockHash: null })));
  assert.equal(noHash.swapEvidence.cutRead, null);
  const badHash = commit(assembleSwapEvidence(input("wMEITx", { cutBlockHash: "0x1234" })));
  assert.equal(badHash.swapEvidence.cutBlockHash, null);
  assert.deepEqual(badHash.degraded, ["cut-block-hash-dropped"]);
  selfCheck("wMEITx", ev);
});

test("the round built from real evidence passes the strict self-check", () => {
  const ev = commit(assembleSwapEvidence(input("wXIAOx")));
  const r = roundOf("wXIAOx", ev);
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(r.bundle)), { era: "swap-evidence" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.failures, []);
  assert.deepEqual(v.notes, ["the cut mid is not bound to a committed pool read (closure opened before this keeper build)"]);
  // Under the default era (the placeholder constant: every row is pre-fix) the same bundle is ok, with E0'.
  const d = verifyMarkBundleOffline(JSON.parse(JSON.stringify(r.bundle)));
  assert.equal(d.ok, true);
  assert.equal(d.era, "pre-swap-fix");
  assert.ok(d.notes[0].startsWith("pre-fix row") && d.notes[0].endsWith("swap lists present but not checked."), d.notes[0]);
  // The swaps leaf carries the v2 keys and the lists.
  const leaf = leafValue(r.bundle, LeafKind.FETCH_LOG, subjectOf(`swaps:${r.marks[0].wrapper.toLowerCase()}`));
  assert.equal(leaf.evidence, "curb.scorecard.swaps/2");
  assert.equal(leaf.closingSwaps.length, 9);
  assert.equal(leaf.closureSwaps.length, 14);
});

const GAP: [number, number] = [75774000, 75774999];
const WITHOUT_GAP: Array<[number, number]> = [[RECESS.closingFrom, GAP[0] - 1], [GAP[1] + 1, RECESS.pinnedBlock]];

test("defer while gaps remain", () => {
  const r = assembleSwapEvidence(input("wXIAOx", { ranges: WITHOUT_GAP }));
  assert.equal(r.kind, "defer");
  if (r.kind === "defer") assert.ok(r.reason.includes("gaps remain") && r.reason.includes("closure 1000 blocks"), r.reason);
});

test("must-commit with a closure gap and a recorded swap", () => {
  const full = commit(assembleSwapEvidence(input("wXIAOx")));
  const ev = commit(assembleSwapEvidence(input("wXIAOx", { ranges: WITHOUT_GAP, mustCommit: true })));
  assert.equal(ev.complete, false);
  assert.deepEqual(ev.gaps, [GAP]);
  assert.deepEqual(ev.swapEvidence.gaps, [GAP]);
  const outside = recessRows("wXIAOx").filter((r) => r.blockNumber > RECESS.cutBlock && (r.blockNumber < GAP[0] || r.blockNumber > GAP[1]));
  assert.equal(ev.swapEvidence.closureCount, outside.length);
  assert.equal(ev.input.swapsDuringClosure, outside.length);
  assert.ok(ev.closureSwaps.every((r) => r.blockNumber < GAP[0] || r.blockNumber > GAP[1]));
  const m = markOf("wXIAOx", ev);
  const m0 = markOf("wXIAOx", full);
  assert.equal(m.markE18, m0.markE18);
  assert.equal(m.bandBps, m0.bandBps);
  const v = selfCheck("wXIAOx", ev);
  assert.ok(v.notes.some((n) => n.startsWith("closure scan incomplete: gaps 75774000..75774999")), v.notes.join(" | "));

  // A gap that holds two real swaps (75775309:38 and :41): they are left out of the list and the count, and the
  // mark is still the complete case's (the gate is open either way; the drift comes from the two mids).
  const gap2: [number, number] = [75775000, 75775999];
  const ev2 = commit(assembleSwapEvidence(input("wXIAOx", {
    ranges: [[RECESS.closingFrom, gap2[0] - 1], [gap2[1] + 1, RECESS.pinnedBlock]], mustCommit: true,
  })));
  assert.equal(ev2.input.swapsDuringClosure, 12);
  assert.ok(ev2.closureSwaps.every((r) => r.blockNumber < gap2[0] || r.blockNumber > gap2[1]));
  assert.equal(markOf("wXIAOx", ev2).markE18, m0.markE18);
  assert.equal(markOf("wXIAOx", ev2).bandBps, m0.bandBps);
  selfCheck("wXIAOx", ev2);
});

test("must-commit with a closing gap", () => {
  const ev = commit(assembleSwapEvidence(input("wXIAOx", { ranges: [[75772300, RECESS.pinnedBlock]], mustCommit: true })));
  assert.equal(ev.closingComplete, false);
  assert.deepEqual(ev.closingSwaps, []);
  assert.equal(ev.input.closingVwapE18, null);
  assert.equal(ev.input.lastPrintE18, BigInt(markinput("wXIAOx").midAtCutE18));
  assert.equal(ev.complete, true);
  assert.deepEqual(ev.degraded, [], "a gap is not an inconsistency");
  const v = selfCheck("wXIAOx", ev);
  assert.ok(v.notes.some((n) => n.startsWith("closing window not committed")), v.notes.join(" | "));
});

test("I1: the last closure swap is not midNow", () => {
  const all = recessRows("wXIAOx");
  const rows = all.slice(0, -1);   // the final closure row is missing (75776054:74)
  const d = assembleSwapEvidence(input("wXIAOx", { rows }));
  assert.equal(d.kind, "defer");
  if (d.kind === "defer") assert.ok(d.reason.includes("I1"), d.reason);
  const ev = commit(assembleSwapEvidence(input("wXIAOx", { rows, mustCommit: true })));
  assert.deepEqual(ev.degraded, ["closure-inconsistent"]);
  const x = rows.at(-1)!.blockNumber;
  assert.deepEqual(ev.gaps, [[x, RECESS.pinnedBlock]]);
  assert.equal(ev.complete, false);
  assert.ok(ev.closureSwaps.every((r) => r.blockNumber < x));
  assert.equal(ev.input.swapsDuringClosure, ev.closureSwaps.length);
  assert.equal(markOf("wXIAOx", ev).markE18, 3701436175140696810n, "the mark is unaffected: drift comes from the mids");
  selfCheck("wXIAOx", ev);
});

test("I1 that leaves no closure swap falls to D2 at must-commit", () => {
  const rows = recessRows("wXIAOx").filter((r) => r.blockNumber <= RECESS.cutBlock || r.blockNumber === 75773207);
  assert.equal(rows.filter((r) => r.blockNumber > RECESS.cutBlock).length, 1);
  const r = assembleSwapEvidence(input("wXIAOx", { rows, mustCommit: true }));
  assert.equal(r.kind, "refuse");
});

test("I2 with complete coverage", () => {
  const rows = recessRows("wXIAOx").filter((r) => r.blockNumber <= RECESS.cutBlock);
  const d = assembleSwapEvidence(input("wXIAOx", { rows }));
  assert.equal(d.kind, "defer");
  if (d.kind === "defer") assert.ok(d.reason.includes("price moved"), d.reason);
  const r = assembleSwapEvidence(input("wXIAOx", { rows, mustCommit: true }));
  assert.equal(r.kind, "refuse");
  if (r.kind === "refuse") {
    assert.equal(r.alarmKey, "keeper:swap-evidence-inconsistent:wXIAOx");
    assert.ok(r.message.includes("price moved implies swaps"), r.message);
  }
});

test("I2 with gaps at must-commit", () => {
  const rows = recessRows("wXIAOx").filter((r) => r.blockNumber <= RECESS.cutBlock);
  const r = assembleSwapEvidence(input("wXIAOx", { rows, ranges: [[RECESS.closingFrom, 75776000]], mustCommit: true }));
  assert.equal(r.kind, "refuse");
  if (r.kind === "refuse") assert.ok(r.message.includes("76001..75776392") || r.message.includes("75776001..75776392"), r.message);
});

test("gaps, no swap, price unchanged", () => {
  const ev = commit(assembleSwapEvidence(input("wMEITx", { ranges: [[RECESS.closingFrom, 75775000]], mustCommit: true })));
  assert.equal(ev.complete, false);
  assert.equal(ev.swapEvidence.closureCount, 0);
  assert.deepEqual(ev.gaps, [[75775001, RECESS.pinnedBlock]]);
  selfCheck("wMEITx", ev);
});

test("I3: a closing swap that is not the cut mid", () => {
  const rows = recessRows("wXIAOx");
  const k = rows.findIndex((r) => r.blockNumber === 75773077 && r.logIndex === 68);
  const bad = rows.map((r, j) => (j === k ? { ...r, priceE18: r.priceE18 + 1n } : r));
  const d = assembleSwapEvidence(input("wXIAOx", { rows: bad }));
  assert.equal(d.kind, "defer");
  if (d.kind === "defer") assert.ok(d.reason.includes("I3"), d.reason);
  const ev = commit(assembleSwapEvidence(input("wXIAOx", { rows: bad, mustCommit: true })));
  assert.equal(ev.closingComplete, false);
  assert.deepEqual(ev.degraded, ["closing-inconsistent"]);
  assert.deepEqual(ev.closingSwaps, []);
  assert.equal(ev.input.lastPrintE18, BigInt(markinput("wXIAOx").midAtCutE18));
  selfCheck("wXIAOx", ev);
});

test("I8: a pre-cut mid that moved with no closing swap", () => {
  const midAt = BigInt(markinput("wMEITx").midAtCutE18);
  const d = assembleSwapEvidence(input("wMEITx", { preCutMidE18: midAt + 1n }));
  assert.equal(d.kind, "defer");
  if (d.kind === "defer") assert.ok(d.reason.includes("I8"), d.reason);
  const ev = commit(assembleSwapEvidence(input("wMEITx", { preCutMidE18: midAt + 1n, mustCommit: true })));
  assert.equal(ev.closingComplete, false);
  assert.deepEqual(ev.degraded, ["closing-inconsistent"]);
  // After a recut preCutMid is null: nothing to compare.
  assert.equal(commit(assembleSwapEvidence(input("wMEITx", { preCutMidE18: null }))).closingComplete, true);
});

test("rows out of order or repeated are sorted and counted once", () => {
  const rows = recessRows("wXIAOx");
  const messy = [...rows].reverse().concat(rows.slice(10, 13));
  const ev = commit(assembleSwapEvidence(input("wXIAOx", { rows: messy })));
  assert.equal(ev.input.swapsDuringClosure, 14);
  assert.equal(ev.swapEvidence.closureDigest, "0x1e178005413bae90d6a16606d5d19c0237229066fbe160e74efe6eacc1ec4578");
  selfCheck("wXIAOx", ev);
});

/** 15,000 closure rows (5 per block from the cut), the last priced at midNow, plus the real closing window. */
function bigInput(): AssemblyInput {
  const base = input("wXIAOx");
  const closing = recessRows("wXIAOx").filter((r) => r.blockNumber <= RECESS.cutBlock);
  const K: SwapRow[] = Array.from({ length: 15_000 }, (_, k) => ({
    blockNumber: RECESS.cutBlock + 1 + Math.floor(k / 5), logIndex: k % 5,
    equityAbs: 10n ** 18n + BigInt(k), priceE18: k === 14_999 ? base.midNowE18 : base.midNowE18 + BigInt(k + 1),
  }));
  const pinned = K.at(-1)!.blockNumber + 2;
  return { ...base, rows: [...closing, ...K], pinnedBlock: pinned, ranges: [[RECESS.closingFrom, pinned]] };
}

test("truncation", () => {
  const ev = commit(assembleSwapEvidence(bigInput()));
  assert.equal(ev.closureSwaps.length, 10_000);
  assert.deepEqual(ev.swapEvidence.closureOmitted, { fromIndex: 5000, toIndex: 9999 });
  assert.equal(ev.swapEvidence.closureCount, 15_000);
  assert.equal(ev.input.swapsDuringClosure, 15_000);
  assert.deepEqual(ev.swapEvidence.counts, { closingLogs: 9, closureLogs: 15_000 });
  assert.equal(ev.closureSwaps.at(-1)!.priceE18, bigInput().midNowE18);
});

test("memory (W3): a 15,000-row round assembles, builds and self-checks within bounds", () => {
  const before = process.memoryUsage().heapUsed;
  const inp = bigInput();
  const ev = commit(assembleSwapEvidence(inp));
  const i = inputsFromBundle(loadBundle(RECESS_ROOT_OF.wXIAOx));
  i.chain = { ...i.chain, block: { ...i.chain.block, number: inp.pinnedBlock } };
  const c = i.closures[0];
  c.input = { ...c.input, ...ev.input };
  c.closingSwaps = ev.closingSwaps;
  c.closureSwaps = ev.closureSwaps;
  c.swapEvidence = ev.swapEvidence;
  const json = JSON.stringify(buildMarkRound(i).bundle);
  const v = verifyMarkBundleOffline(JSON.parse(json), { era: "swap-evidence" });
  const delta = process.memoryUsage().heapUsed - before;
  assert.deepEqual(v.failures, []);
  assert.ok(v.notes.some((n) => n.startsWith("closure list truncated: the first 5,000 and last 5,000 of 15,000 are committed")), v.notes.join(" | "));
  assert.ok(json.length < 1_400_000, `bundle JSON ${json.length} bytes`);
  assert.ok(delta < 150 * 1024 * 1024, `heap delta ${Math.round(delta / 1048576)} MB`);
});
