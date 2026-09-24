/**
 * Live smoke test, read-only, mainnet: the real regime (rpc-lite), the board of six (viem multicall +
 * latest round), the Scorecard tally, the API's unpaid 402. Counts every HTTP request to stay honest
 * about the ~7 req/s limit.
 *
 *   node --experimental-strip-types web/src/data/dev/smoke.ts
 */
import { setMock } from "../mock.ts";
import { getRegime, pollDelayMs, nextTransitionMs } from "../regime.ts";
import { getBoard } from "../clock.ts";
import { getScorecard } from "../scorecard.ts";
import { askWithoutPaying } from "../api.ts";
import { getRecord } from "../record.ts";
import { countdown, formatDuration, nextReopenMs, closureAt, venueClock, weekSlots } from "../schedule.ts";

setMock(false);
const realFetch = globalThis.fetch;
const stamps: number[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (/xlayer/.test(url)) {
    let items = 1;
    try { const b = JSON.parse(String(init?.body ?? "")); if (Array.isArray(b)) items = b.length; } catch {}
    for (let i = 0; i < items; i++) stamps.push(Date.now());
  }
  return realFetch(input, init);
}) as typeof fetch;

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : "—");
const t0 = Date.now();

// 1. the global chip
const r = await getRegime();
console.log(`REGIME  ${r.symbol} ${r.regime} (attested ${r.attestedRegime}) cap $${r.cap} · attested ${r.attestedAgoMin} min ago (${iso(r.asOfMs)}) · block ${r.block} · stale=${r.stale} · paper=${r.paper} · glyph=${r.glyph}`);
const now = Date.now();
const reopen = nextReopenMs(now);
const cl = closureAt(now);
if (cl) {
  const c = countdown(reopen!, now);
  console.log(`        shut since ${venueClock(cl.startMs!).label} HKT (${cl.kind}); reopens ${venueClock(reopen!).label} HKT in ${c.h}:${c.m}:${c.s}; chain nextTransitionAt ${iso(r.nextTransitionAtMs)} (a boundary, not the reopen)`);
}
const ws = weekSlots(now);
console.log(`        week ring: ${ws.open.length} slots, now #${ws.nowIndex}, ${ws.openSlots} open, shut ${formatDuration(ws.shutMinutes * 60_000)}; next poll in ${Math.round(pollDelayMs(nextTransitionMs(r, now), now) / 1000)} s`);

// 2. the board
const b = await getBoard();
console.log(`\nBOARD   block ${b.block} (${iso(b.blockTimeMs)}) · registeredCount ${b.registeredCount}`);
for (const row of b.rows) {
  const nx = row.nextChange ? `${row.nextChange.kind} ${iso(row.nextChange.atMs)}` : "—";
  console.log(`  ${row.symbol.padEnd(8)} ${row.mic} ${row.regime.padEnd(9)} cap $${String(row.cap).padEnd(9)} ${row.glyph.padEnd(7)} attested ${row.attestedAgoMin} min ago · blackout=${row.blackout} · next ${nx}${row.closure ? ` · ${row.closure.kind}` : ""}`);
}
if (b.latestRound) console.log(`  latest round: block ${b.latestRound.block} tx ${b.latestRound.txHash} root ${b.latestRound.inputRoot.slice(0, 18)}… (${b.latestRound.wrappers.length} wrappers)\n  ${b.latestRound.bundleUrl}`);

// 3. the Scorecard
const s = await getScorecard({ resolveTx: true });
const k = s.skill;
console.log(`\nSCORECARD block ${s.block} · closureCount ${k.closureCount} · skill() settled=${k.settled} beatLastPrint=${k.beatLastPrint} beatClosingVwap=${k.beatClosingVwap} · ties vs last print ${k.tiesLastPrint}, losses ${k.lossesLastPrint}`);
console.log(`  headline: "${k.settled} graded. ${k.beatLastPrint === 0 ? "No" : k.beatLastPrint} wins, ${k.tiesLastPrint} ties. A tie is not a win."`);
for (const row of s.rows.slice(0, 3)) {
  console.log(`  #${row.index} ${row.symbol} ${row.closureKind ?? ""} ${row.methodShort} mark ${row.mark.toFixed(4)} last ${row.lastPrint.toFixed(4)} vwap ${row.closingVwap.toFixed(4)} reopen ${row.reopenPrint?.toFixed(4)} err ${row.curbErrorBps}/${row.lastPrintErrorBps}/${row.closingVwapErrorBps} bp → ${row.vsLastPrint}; commit ${row.commitTx?.slice(0, 12)}… @${row.committedBlock}, settle ${row.settleTx?.slice(0, 12)}… @${row.settledBlock}`);
}
console.log(`  tx hashes resolved: ${s.rows.filter((x) => x.commitTx).length}/${s.rows.length} commits, ${s.rows.filter((x) => x.settleTx).length}/${s.rows.filter((x) => x.status === "settled").length} settles`);
console.log(`  priceNow: ${s.prices.map((p) => `${p.symbol} ${p.price?.toFixed(2) ?? p.error}`).join(" · ")}`);

const rec = await getRecord();
console.log(`  home record line (rpc-lite, no viem): settled ${rec.settled}, beatLast ${rec.beatLastPrint}, beatVwap ${rec.beatClosingVwap}, rows ${rec.closureCount} @ block ${rec.block} [${rec.source}]`);

// 4. the API, unpaid
const u = await askWithoutPaying("/v1/closure-calendar");
const a = u.paymentRequired?.accepts[0];
console.log(`\nAPI     GET /v1/closure-calendar → ${u.status}; x402 v${u.paymentRequired?.x402Version} ${a?.scheme} ${a?.network} amount ${a?.amount} ${a?.extra?.name} → ${a?.payTo}`);
console.log(`        preview ${JSON.stringify(u.preview)}`);

// rate check
let peak = 0;
for (const t of stamps) peak = Math.max(peak, stamps.filter((x) => x >= t && x < t + 1000).length);
console.log(`\nRPC     ${stamps.length} JSON-RPC items to X Layer RPCs in ${((Date.now() - t0) / 1000).toFixed(1)} s; peak ${peak} in any 1 s window (limit 7)`);
