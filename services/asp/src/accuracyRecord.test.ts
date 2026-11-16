import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";
import { buildRecord, recordPreviewOf, RECORD_SCHEMA, RECORD_PREVIEW_SCHEMA, EVIDENCE_BASE_URL } from "./accuracyRecord.ts";
import { row, settlement, snapshot, hex32, TCENT, MARK1 } from "./fixtures/scorecard.ts";
import { methodDigestOf } from "./sources/scorecard.ts";
import { SWAP_EVIDENCE_FROM_BLOCK, isPreFix, swapEvidenceSet } from "./swapEvidence.ts";

const OTHER = getAddress("0x076cf393e701839fc7a5832d2c68aafa235682ae");
const SYMBOLS = new Map([[TCENT.toLowerCase(), "wTCENTx"], [OTHER.toLowerCase(), "wHKTWOx"]]);
const NOW = Date.parse("2026-09-24T04:00:00Z");
const s = (e0: number, e1: number, e2: number) => settlement({ curbErrorBps: e0, lastPrintErrorBps: e1, closingVwapErrorBps: e2 });

test("wins are strict, exactly as Scorecard.settle() counts them: an exact tie is not a win, one bp worse is a loss", () => {
  const snap = snapshot([
    row({ settlement: s(5, 10, 10) }),    // beats both
    row({ settlement: s(7, 7, 7) }),      // exact tie with both
    row({ settlement: s(10, 9, 11) }),    // loses the last print by 1 bp, beats the VWAP
    row({ settlement: null }),            // committed, not settled yet
  ]);
  const a = buildRecord({ snapshot: snap, chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW });

  assert.equal(a.schema, RECORD_SCHEMA);
  assert.deepEqual(a.skill, { settled: 3, beatLastPrint: 1, beatClosingVwap: 2 }, "the contract's own triple, verbatim");
  assert.deepEqual(a.rows.map((r) => [r.beatLastPrint, r.beatClosingVwap, r.tie, r.tieClosingVwap]), [
    [null, null, null, null],     // newest first: the unsettled row
    [false, true, false, false],
    [false, false, true, true],   // 7 < 7 is false: no win on either side
    [true, true, false, false],
  ]);
  // The recount of the rows' own flags reproduces skill() exactly.
  assert.equal(a.rows.filter((r) => r.beatLastPrint).length, a.skill.beatLastPrint);
  assert.equal(a.rows.filter((r) => r.beatClosingVwap).length, a.skill.beatClosingVwap);
  assert.equal(a.warnings.length, 1, JSON.stringify(a.warnings));
  assert.match(a.warnings[0], /swap evidence is empty and closingVwapE18 equals lastPrintE18 whatever the pool did/, "D-15, for a machine reader");

  assert.deepEqual(a.perSymbol, {
    wTCENTx: {
      wrapper: TCENT, committed: 4, settled: 3, beatLast: 1, beatVwap: 2, ties: 1, tiesClosingVwap: 1,
      medianCurbErrorBps: 7, medianLastPrintErrorBps: 9,
    },
  });
  assert.match(a.note, /strictly less than/);
  assert.match(a.note, /A tie is not a win\./);
  assert.match(a.note, /1 of the 3 settled rows tie the last print exactly\./);
  assert.match(a.note, /curb\.scorecard\.mark\/1/);

  const pending = a.rows[0];
  assert.equal(pending.settled, false);
  assert.equal(pending.reopenPrintE18, null);
  assert.equal(pending.curbErrorBps, null);
  assert.equal(pending.settledAt, null);

  const tie = a.rows[2];
  assert.deepEqual(Object.keys(tie), [
    "id", "wrapper", "symbol", "committedAt", "committedBlock", "settleAfter", "settledAt", "settledBlock",
    "markE18", "bandBps", "lastPrintE18", "closingVwapE18", "reopenPrintE18",
    "curbErrorBps", "lastPrintErrorBps", "closingVwapErrorBps", "beatLastPrint", "beatClosingVwap", "tie", "tieClosingVwap",
    "inputRoot", "methodDigest", "method", "settled", "evidenceUrl", "evidenceStatus",
  ]);
  assert.equal(tie.symbol, "wTCENTx");
  assert.equal(tie.methodDigest, MARK1);
  assert.equal(tie.method, "curb.scorecard.mark/1");
  assert.equal(tie.evidenceUrl, `${EVIDENCE_BASE_URL}${tie.inputRoot}.json`);
  assert.match(tie.evidenceUrl, /^https:\/\/archive\.curb\.markets\/marks\/0x[0-9a-f]{64}\.json$/);
  assert.equal(tie.evidenceStatus, "archived");
  assert.match(a.evidenceNote, /write-once archive/);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, "plain JSON: no bigint, no undefined");
});

test("shaped like the live record on 24 Sep: twelve settled ties, zero wins, and the note says why", () => {
  // Errors as read from Scorecard v2 at block 71,450,876 (mark = last print = closing VWAP in every row).
  const live = [0, 7, 3, 53, 73, 30, 5, 71, 12, 31, 15, 64];
  const snap = snapshot(live.map((e, i) => row({ wrapper: i % 3 === 1 ? OTHER : TCENT, settlement: s(e, e, e) })));
  // The "block not set" path (MAX_SAFE_INTEGER); the set path, now the module default, is tested below with FROM.
  const a = buildRecord({ snapshot: snap, chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW, swapEvidenceFromBlock: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(a.skill, { settled: 12, beatLastPrint: 0, beatClosingVwap: 0 });
  assert.match(a.note, /12 of the 12 settled rows tie the last print exactly\./);
  assert.match(a.note, /Under curb\.scorecard\.mark\/1 the mark is the last print moved by half of what the pool did between the cut and the commit\./);
  assert.match(a.note, /Rows committed before the keeper's swap-decoding fix were built by a keeper that decoded no pool Swap logs \(DECISIONS D-15\)/,
    "the ties are explained by the defect, not by a pool that did not trade; with the block not yet set, no rows are counted");
  assert.doesNotMatch(a.note, /can only tie/);
  assert.deepEqual(Object.keys(a.perSymbol), ["wHKTWOx", "wTCENTx"]);
  assert.equal(a.perSymbol.wHKTWOx.ties, 4);
  assert.equal(a.perSymbol.wHKTWOx.medianCurbErrorBps, 43, "median of 7, 73, 71, 15");
  assert.equal(a.perSymbol.wTCENTx.medianLastPrintErrorBps, 21, "median of 0, 3, 53, 30, 5, 12, 31, 64: (12 + 30) / 2");
});

test("limit and symbol cut the rows, newest first; perSymbol covers the whole scope; the preview is the skill triple and row count only", () => {
  const snap = snapshot([
    row({ settlement: s(1, 2, 2) }),
    row({ wrapper: OTHER, settlement: s(3, 3, 3) }),
    row({ settlement: s(4, 4, 4) }),
    row({ settlement: s(9, 8, 8) }),
    row({ wrapper: OTHER, settlement: null }),
  ]);
  const a = buildRecord({ snapshot: snap, chainId: 196, symbols: SYMBOLS, filter: { symbol: "wTCENTx", wrapper: TCENT }, limit: 2, nowMs: NOW });
  assert.equal(a.symbol, "wTCENTx");
  assert.equal(a.totalRows, 3);
  assert.deepEqual(a.rows.map((r) => r.curbErrorBps), [9, 4], "the two newest wTCENTx rows");
  assert.deepEqual(Object.keys(a.perSymbol), ["wTCENTx"]);
  assert.equal(a.perSymbol.wTCENTx.settled, 3, "not just the rows returned");
  assert.deepEqual(a.skill, { settled: 4, beatLastPrint: 1, beatClosingVwap: 1 }, "skill() is contract-wide whatever the filter");
  assert.match(a.note, /1 of the 3 settled rows for wTCENTx tie the last print exactly/);

  const p = recordPreviewOf(a);
  assert.deepEqual(p, { schema: RECORD_PREVIEW_SCHEMA, skill: { settled: 4, beatLastPrint: 1, beatClosingVwap: 1 }, rowCount: 3 });
});

test("a skill() the rows cannot reproduce is disclosed, never smoothed over; unknown wrappers are keyed by address", () => {
  const stranger = getAddress("0x9999999999999999999999999999999999999999");
  const snap = snapshot([row({ settlement: s(1, 2, 2) }), row({ wrapper: stranger, settlement: s(2, 2, 2) })], {
    skill: { settled: 2, beatLast: 2, beatVwap: 1 },
  });
  const a = buildRecord({ snapshot: snap, chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW });
  assert.deepEqual(a.skill, { settled: 2, beatLastPrint: 2, beatClosingVwap: 1 }, "served as read");
  assert.ok(a.warnings.some((w) => /strict recount .* gives \(2, 1, 1\)/.test(w)), JSON.stringify(a.warnings));
  assert.ok(a.warnings.some((w) => /outside MarketClock's current cohort/.test(w)));
  assert.equal(a.rows[0].symbol, null);
  assert.ok(stranger in a.perSymbol);
});

test("an empty record is a valid answer, not an error", () => {
  const a = buildRecord({ snapshot: snapshot([]), chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW });
  assert.deepEqual(a.skill, { settled: 0, beatLastPrint: 0, beatClosingVwap: 0 });
  assert.deepEqual(a.rows, []);
  assert.deepEqual(a.perSymbol, {});
  assert.equal(a.totalRows, 0);
  assert.match(a.note, /0 of the 0 settled rows tie/);
  assert.doesNotMatch(a.note, /mark\/1/, "no claim about a method no row uses");
  assert.doesNotMatch(a.note, /mark\/2/);
  assert.deepEqual(recordPreviewOf(a).rowCount, 0);
});

test("mark/2 rows are named, and the note says plainly when mark/2 applies no signal", () => {
  const MARK2 = methodDigestOf("curb.scorecard.mark/2").toLowerCase();
  const snap = snapshot([
    row({ settlement: s(53, 53, 53) }),                          // an old mark/1 row keeps its method
    row({ methodDigest: MARK2, settlement: s(7, 31, 31) }),      // mark/2 moved the mark and beat the last print
    row({ methodDigest: hex32(0xdead), settlement: s(1, 1, 1) }),
  ]);
  const a = buildRecord({ snapshot: snap, chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW });
  assert.deepEqual(a.rows.map((r) => r.method), [null, "curb.scorecard.mark/2", "curb.scorecard.mark/1"]);
  assert.match(a.note, /curb\.scorecard\.mark\/2 moves the last print by 0\.79 x the mean return/);
  assert.match(a.note, /lunch recess, for the US names, and whenever neither signal could be fetched, its mark is mark\/1's\./);
  assert.doesNotMatch(a.note, /applies no move|can only tie/, "a recess row moves with the pool once swaps are counted (D-15)");
  assert.match(a.note, /none is re-marked/);
  assert.match(a.note, /Under curb\.scorecard\.mark\/1/, "both methods are in scope, so both are explained");
});

test("rows before the swap-evidence block are named as pre-fix by block once it is set; later rows are not", () => {
  const FROM = 75_800_000;
  const snap = snapshot([
    row({ committedBlock: FROM - 1, settlement: s(7, 7, 7) }),   // the old keeper: ties by the defect
    row({ committedBlock: FROM + 10, settlement: s(5, 9, 6) }),  // the fixed keeper
    row({ committedBlock: FROM + 20, settlement: null }),
  ]);
  const a = buildRecord({ snapshot: snap, chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW, swapEvidenceFromBlock: FROM });
  assert.match(a.note, /Rows committed before block 75800000 \(1 of the 3 in scope\) were built by a keeper that decoded no pool Swap logs \(DECISIONS D-15\)\./);
  assert.match(a.note, /closingVwapE18 equals lastPrintE18, so beatClosingVwap repeats beatLastPrint/);

  const after = buildRecord({ snapshot: snapshot([row({ committedBlock: FROM, settlement: s(5, 9, 6) })]), chainId: 196, symbols: SYMBOLS, filter: null, limit: 50, nowMs: NOW, swapEvidenceFromBlock: FROM });
  assert.doesNotMatch(after.note, /D-15/, "no pre-fix claim about a row the fixed keeper wrote");
  assert.deepEqual(after.warnings, []);
  assert.ok(a.warnings.some((w) => /^1 of 3 rows in scope were committed before block 75800000: their swap evidence is empty/.test(w)), JSON.stringify(a.warnings));
  assert.match(a.evidenceNote, /bundles of rows committed before block 75800000 are empty whatever the pool did/);
});

test("the swap-evidence block is the placeholder or a block after the last pre-fix row checked on 14 Nov", () => {
  assert.ok(SWAP_EVIDENCE_FROM_BLOCK === Number.MAX_SAFE_INTEGER || SWAP_EVIDENCE_FROM_BLOCK >= 75_776_413, String(SWAP_EVIDENCE_FROM_BLOCK));
  assert.equal(swapEvidenceSet(Number.MAX_SAFE_INTEGER), false);
  assert.equal(isPreFix(75_776_412), true, "the 13 Nov rows are pre-fix whatever the constant holds");
});
