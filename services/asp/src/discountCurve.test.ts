import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";
import {
  buildCurve, curvePreviewOf, bucketOf, bucketStatus, discountBpsOf, DISCLOSURE,
  CURVE_SCHEMA, CURVE_PREVIEW_SCHEMA, CURVE_METHOD, RECORD_STARTED_AT_MS,
} from "./discountCurve.ts";
import { quantileSorted, summarize, median } from "./stats.ts";
import { row, settlement, snapshot, transition, closureView, TCENT } from "./fixtures/scorecard.ts";
import type { RegimeTransition } from "./index/closures.ts";
import type { ScorecardRow } from "./index/scorecard.ts";
import { Regime } from "./regime.ts";

const V = getAddress("0x076cf393e701839fc7a5832d2c68aafa235682ae");
const SYMBOLS = new Map([[TCENT.toLowerCase(), "wTCENTx"], [V.toLowerCase(), "wHKTWOx"]]);
const NOW = Date.parse("2026-09-24T04:00:00Z");
const DAY = 86_400;
const ONE = 10n ** 18n;
/**
 * X Layer's block at unix time t, anchored on the live read (block 71,450,876 at ~1,790,222,000; ~1 block/s).
 * Fixtures derive every block from its time, because the lookup relies on what the chain guarantees:
 * block time never decreases with block number.
 */
const B = (t: number) => t - 1_718_771_124;

/**
 * k closures of `durationS` each, one a day, each with its own RegimeChanged into CLOSED: closing VWAP 1.0,
 * reopen 1.0 - (i+1) bp, so the i-th observation's discount is exactly i+1 bp.
 */
function closures(k: number, durationS: number, t0 = 1_790_053_200) {
  const rows: ScorecardRow[] = [];
  const log: RegimeTransition[] = [];
  for (let i = 0; i < k; i++) {
    const settleAfter = t0 + i * DAY;
    log.push(transition({ at: settleAfter - durationS, block: B(settleAfter - durationS) }));
    rows.push(row({
      committedAt: settleAfter - 580, committedBlock: B(settleAfter - 580), settleAfter,
      closingVwapE18: String(ONE), markE18: String(ONE), lastPrintE18: String(ONE),
      settlement: settlement({ reopenPrintE18: String(ONE - BigInt(i + 1) * 10n ** 14n) }),
    }));
    log.push(transition({ at: settleAfter + 4, block: B(settleAfter + 4), from: Regime.CLOSED, to: Regime.MARKET }));
  }
  return { rows, log };
}

const curve = (rows: ScorecardRow[], log: RegimeTransition[], lastScanned = 80_000_000, minMinutes = 30, p: Partial<Parameters<typeof buildCurve>[0]> = {}) =>
  buildCurve({ snapshot: snapshot(rows), closures: closureView(log, lastScanned), chainId: 196, symbols: SYMBOLS, filter: null, minMinutes, nowMs: NOW, ...p });

test("order statistics are Hyndman-Fan type 7 over the sorted sample, and nothing else", () => {
  assert.equal(quantileSorted([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantileSorted([1, 2, 3, 4], 0.75), 3.25);
  assert.equal(quantileSorted([], 0.5), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.deepEqual(summarize([0.1, 0.2]), { p25: 0.13, median: 0.15, p75: 0.18, min: 0.1, max: 0.2, mean: 0.15 });
});

test("bucket thresholds: n=2 insufficient, n=3 and n=11 indicative (median only), n=12 reportable", () => {
  const expectFor = (n: number) => {
    const { rows, log } = closures(n, 3_900);   // 65 minutes: the Hong Kong lunch cut
    const a = curve(rows, log);
    const b = a.buckets.find((x) => x.label === "30m-2h")!;
    assert.equal(Object.keys(b)[0], "n", "n comes first, before any statistic");
    assert.equal(b.n, n);
    assert.equal(a.nUsable, n);
    return b;
  };
  const two = expectFor(2);
  assert.equal(two.status, "insufficient");
  assert.deepEqual(two.discountBps, { p25: null, median: null, p75: null, min: null, max: null, mean: null });
  assert.deepEqual(two.markDiscountBps, { p25: null, median: null, p75: null, min: null, max: null, mean: null });

  const three = expectFor(3);
  assert.equal(three.status, "indicative");
  assert.deepEqual(three.discountBps, { p25: null, median: 2, p75: null, min: null, max: null, mean: null });
  assert.deepEqual(three.markDiscountBps, { p25: null, median: 0, p75: null, min: null, max: null, mean: null });

  const eleven = expectFor(11);
  assert.equal(eleven.status, "indicative");
  assert.deepEqual(eleven.discountBps, { p25: null, median: 6, p75: null, min: null, max: null, mean: null });

  const twelve = expectFor(12);
  assert.equal(twelve.status, "reportable");
  assert.deepEqual(twelve.discountBps, { p25: 3.75, median: 6.5, p75: 9.25, min: 1, max: 12, mean: 6.5 });

  assert.deepEqual([0, 2, 3, 11, 12, 500].map(bucketStatus), ["insufficient", "insufficient", "indicative", "indicative", "reportable", "reportable"]);
});

test("an empty record is a valid answer: observations [] in full, fit null, every bucket counted and insufficient", () => {
  const a = curve([], []);
  const wire = JSON.parse(JSON.stringify(a));
  assert.equal(wire.schema, CURVE_SCHEMA);
  assert.equal(wire.method, CURVE_METHOD);
  assert.ok("fit" in wire && wire.fit === null, "fit is present, and null");
  assert.deepEqual(wire.observations, []);
  assert.equal(wire.n, 0);
  assert.equal(wire.nUsable, 0);
  assert.equal(wire.recordStartedAtMs, RECORD_STARTED_AT_MS);
  assert.equal(wire.recordStartedAt, "2026-09-21T15:17:00.000Z");
  assert.deepEqual(wire.buckets.map((b: { label: string; n: number; status: string }) => [b.label, b.n, b.status]), [
    ["30m-2h", 0, "insufficient"], ["2h-8h", 0, "insufficient"], ["8h-24h", 0, "insufficient"], ["24h-72h", 0, "insufficient"], [">72h", 0, "insufficient"],
  ]);
  for (const phrase of ["There is no fit", "fit is always null", "There is no backfill", "a backfilled mark is not a mark", "Until the RegimeChanged indexer has finished backfilling", "index.status"]) {
    assert.ok(wire.disclosure.includes(phrase), `disclosure must say: ${phrase}`);
  }
  assert.equal(wire.disclosure, DISCLOSURE);
  assert.deepEqual(curvePreviewOf(a), {
    schema: CURVE_PREVIEW_SCHEMA, n: 0, nUsable: 0,
    buckets: ["30m-2h", "2h-8h", "8h-24h", "24h-72h", ">72h"].map((label) => ({ label, n: 0, status: "insufficient" })),
  });
});

test("a row whose closure start is unknown is reported with its reason, never dropped, and counted in no bucket", () => {
  const W3 = getAddress("0x3333333333333333333333333333333333333333");
  const at = (t: number, p: Partial<ScorecardRow> = {}) => row({ committedAt: t, committedBlock: B(t), settleAfter: t + 580, ...p });
  const good = closures(1, 3_900);                                   // TCENT: a 65-minute closure, start known
  const late = at(1_790_300_000);                                    // TCENT: committed past the index cursor
  const noLog = at(1_790_100_000, { wrapper: W3 });                  // W3: MarketClock never logged a CLOSED run
  const firstSeen = at(1_789_400_000, { wrapper: V });               // V: CLOSED since its very first attestation
  const reopened = at(1_790_200_000);                                // TCENT: the log says it reopened before the commit
  const unsettled = row({ settlement: null });
  const log = [
    ...good.log,
    transition({ at: 1_789_399_000, block: B(1_789_399_000), wrapper: V, from: Regime.UNKNOWN, to: Regime.CLOSED }),
    transition({ at: 1_790_190_000, block: B(1_790_190_000) }),
    transition({ at: 1_790_195_000, block: B(1_790_195_000), from: Regime.CLOSED, to: Regime.MARKET }),
  ];
  const rows = [good.rows[0], late, noLog, firstSeen, reopened, unsettled];
  const a = curve(rows, log, B(1_790_250_000));

  assert.equal(a.n, 5, "every settled row is an observation");
  assert.equal(a.nUsable, 1);
  assert.equal(a.pendingSettlement, 1, "the unsettled row is counted, not an observation");
  const by = new Map(a.observations.map((o) => [o.id, o]));
  assert.deepEqual(rows.slice(0, 5).map((r) => [by.get(r.id)!.closureStartStatus, by.get(r.id)!.excludedReason]), [
    ["known", null],
    ["pending-index", "closure-start-pending-index"],
    ["no-closed-transition", "closure-start-no-closed-transition"],
    ["first-attestation", "closure-start-first-attestation"],
    ["not-closed-at-commit", "closure-start-not-closed-at-commit"],
  ]);
  const pending = by.get(late.id)!;
  assert.equal(pending.durationS, null);
  assert.equal(pending.bucket, null);
  assert.equal(pending.usable, false);
  assert.equal(pending.closureStartAt, null);
  assert.equal(typeof pending.discountBps, "number", "the price data is still reported in full");
  assert.equal(by.get(noLog.id)!.symbol, null, "a wrapper outside the cohort keeps its row, with no symbol");
  assert.equal(a.buckets.reduce((sum, b) => sum + b.n, 0), 1, "only the usable observation is in a bucket");
  assert.ok(a.warnings.some((w) => /1 of 5 observations have no duration yet/.test(w)), JSON.stringify(a.warnings));
  assert.ok(a.warnings.some((w) => /2 observation\(s\) have no CLOSED run/.test(w)));
});

test("while the index is backfilling, the answer says so and the durations it cannot know yet are pending", () => {
  const { rows, log } = closures(3, 3_900);
  // The cursor sits between the first and second commits.
  const a = curve(rows, log, rows[0].committedBlock + 10, 30, { closures: closureView(log, rows[0].committedBlock + 10, 80_000_000) });
  assert.equal(a.index.status, "backfilling");
  assert.equal(a.index.lastScannedBlock, rows[0].committedBlock + 10);
  assert.deepEqual(a.observations.map((o) => o.closureStartStatus), ["known", "pending-index", "pending-index"]);
  assert.equal(a.nUsable, 1);
  assert.equal(a.buckets[0].status, "insufficient");
  const done = curve(rows, log);
  assert.equal(done.index.status, "current");
  assert.equal(done.nUsable, 3);
});

test("durations run from the RegimeChanged into CLOSED to settleAfter; buckets are half-open; minMinutes excludes", () => {
  assert.deepEqual([1_799, 1_800, 7_199, 7_200, 28_800, 86_399, 86_400, 259_199, 259_200, 900_000].map(bucketOf),
    [null, "30m-2h", "30m-2h", "2h-8h", "8h-24h", "8h-24h", "24h-72h", "24h-72h", ">72h", ">72h"]);

  // The live row 0: cut attested at 11:55:05 HKT, committed 12:50:18, reopen 13:00:00.
  const cut = transition({ at: Date.parse("2026-09-22T03:55:05Z") / 1000, block: 71_278_700 });
  const lunch = row({ settlement: settlement() });
  const overnight = row({
    committedAt: Date.parse("2026-09-23T01:20:18Z") / 1000, committedBlock: 71_355_000,
    settleAfter: Date.parse("2026-09-23T01:30:00Z") / 1000,
    settlement: settlement({ reopenPrintE18: "57233586614833596700" }),
    markE18: "57538211366309229177", lastPrintE18: "57538211366309229177", closingVwapE18: "57538211366309229177",
  });
  const log = [
    cut,
    transition({ at: Date.parse("2026-09-22T05:00:04Z") / 1000, block: 71_282_600, from: Regime.CLOSED, to: Regime.MARKET }),
    transition({ at: Date.parse("2026-09-22T07:55:04Z") / 1000, block: 71_293_100 }),
  ];
  const a = curve([lunch, overnight], log);
  const [l, o] = a.observations;
  assert.equal(l.closureStartAt, cut.at);
  assert.equal(l.closureStartBlock, cut.block);
  assert.equal(l.durationS, 3_895, "13:00:00 - 11:55:05");
  assert.equal(l.bucket, "30m-2h");
  assert.equal(l.discountBps, 0.9, "(58243189692637603411 - 58237918997832996539) / 58243189692637603411, truncated at 0.01 bp");
  assert.equal(l.markDiscountBps, 0, "mark == closing VWAP: the pool did not trade");
  assert.equal(o.durationS, 63_296, "09:30:00 HKT next day - 15:55:04 HKT: 17h 34m 56s");
  assert.equal(o.bucket, "8h-24h");
  assert.equal(o.discountBps, 52.94);

  const strict = curve([lunch, overnight], log, 80_000_000, 120);
  assert.equal(strict.observations[0].excludedReason, "shorter-than-minMinutes");
  assert.equal(strict.observations[0].bucket, "30m-2h", "where it would fall is still shown");
  assert.equal(strict.nUsable, 1);
  assert.equal(strict.buckets[0].n, 0);
  assert.equal(strict.minMinutes, 120);
});

test("discounts are signed and truncated toward zero at 0.01 bp, in integer arithmetic", () => {
  assert.equal(discountBpsOf("3", "4"), -3333.33, "a premium is negative");
  assert.equal(discountBpsOf("3", "2"), 3333.33);
  assert.equal(discountBpsOf(String(ONE), String(ONE - 1n)), 0, "below 0.01 bp truncates to zero, never -0");
  assert.equal(discountBpsOf("0", "1"), null, "no base, no discount");
});

test("the symbol filter scopes the observations, and the preview is n, nUsable and the bucket counts", () => {
  const a1 = closures(3, 3_900);
  const b1 = closures(2, 63_896, 1_790_200_000);
  const vRows = b1.rows.map((r) => ({ ...r, wrapper: V }));
  const vLog = b1.log.map((t) => ({ ...t, wrapper: V }));
  const all = curve([...a1.rows, ...vRows], [...a1.log, ...vLog]);
  assert.equal(all.n, 5);
  assert.deepEqual(curvePreviewOf(all).buckets.filter((b) => b.n > 0), [
    { label: "30m-2h", n: 3, status: "indicative" },
    { label: "8h-24h", n: 2, status: "insufficient" },
  ]);
  const only = curve([...a1.rows, ...vRows], [...a1.log, ...vLog], 80_000_000, 30, { filter: { symbol: "wHKTWOx", wrapper: V } });
  assert.equal(only.symbol, "wHKTWOx");
  assert.equal(only.n, 2);
  assert.ok(only.observations.every((o) => o.symbol === "wHKTWOx"));
  assert.deepEqual(Object.keys(curvePreviewOf(only)), ["schema", "n", "nUsable", "buckets"]);
});
