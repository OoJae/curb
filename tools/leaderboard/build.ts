#!/usr/bin/env node
/**
 * web/public/data/leaderboard.json: Scorecard's on-chain record next to the historical backtest, for the
 * Benchmarks section of /scorecard. Run from the repo root, after tools/research/hk-closures/fit.mjs:
 *
 *   node --experimental-strip-types tools/leaderboard/build.ts
 *   RPCS=https://xlayer.drpc.org,https://rpc.xlayer.tech node --experimental-strip-types tools/leaderboard/build.ts
 *
 * Two sources. The output keeps them apart and labels each one:
 *
 *   onChain   Every Scorecard v2 row at one pinned block, read with curb-asp's own index
 *             (services/asp/src/index/scorecard.ts). The strict recount of the rows (grade() / recount()) must
 *             equal skill() read at that same block, or nothing is written. The commit and settle
 *             transactions come from one single-block getLogs each. The settler is the settle transaction's
 *             sender. Both are best effort: a failed lookup leaves null and is logged, never guessed.
 *   backtest  tools/research/hk-closures/out/results.json. This is a historical backtest graded against the
 *             HKEX official open, not the pool print Scorecard settles at. It is not on chain and never enters
 *             an on-chain count. Before it is used, its data files are re-hashed against the hashes it records.
 *
 * Read-only: eth_getBlockByNumber, eth_call, eth_getLogs and eth_getTransactionByHash, paced at about three
 * requests a second. It never signs or sends anything.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, getAddress } from "ethers";
import { ScorecardIndex, grade, recount, rpcChain } from "../../services/asp/src/index/scorecard.ts";
import type { ScorecardRow } from "../../services/asp/src/index/scorecard.ts";
import { rpcAny } from "../../services/asp/src/sources/chain.ts";
import { methodDigestOf, scorecardAbi } from "../../services/asp/src/sources/scorecard.ts";

export const LEADERBOARD_SCHEMA = "curb.leaderboard/1";
const RESULTS_SCHEMA = "curb.hk-closures.results/1";

const ROOT = join(import.meta.dirname, "..", "..");
const RESULTS = join(ROOT, "tools/research/hk-closures/out/results.json");
const OUT = join(ROOT, "web/public/data/leaderboard.json");

export const SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
const CHAIN_ID = 196;
const RPCS = (process.env.RPCS ?? "https://xlayer.drpc.org,https://rpc.xlayer.tech").split(",").map((s) => s.trim()).filter(Boolean);

/** Scorecard.SETTLE_DELAY and SETTLE_WINDOW (src/Scorecard.sol). After both, an unsettled row can never settle. */
const SETTLE_DELAY_S = 300;
const SETTLE_WINDOW_S = 6 * 3600;

const SYMBOLS = new Map<string, string>([
  ["0x41333Df9E7639188BBfca5522dC4844398Af9f9E", "wTCENTx"],
  ["0x076CF393E701839FC7a5832D2c68AaFA235682AE", "wXIAOx"],
  ["0xad1b65C8556957cf23d1B5e9accdc449b415fA97", "wMEITx"],
  ["0xff637d2d435D6745Df3faf61272B1216e7e8b727", "wSHEINx"],
  ["0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5", "wNVDAx"],
  ["0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f", "wAAPLx"],
].map(([a, s]) => [getAddress(a), s]));

/** Wallets docs/WALLETS.md discloses, so a settler can be named. Any other sender is reported as-is, unnamed. */
const KNOWN_WALLETS = new Map<string, string>([
  ["0xd3D9Bf9Ff2A80Aa13D9C0299fadc9775343a1AF6", "Curb keeper"],
  ["0x78a5955b433988198bccA2E8bdC671444798f809", "Curb deployer"],
  ["0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E", "curb-desk (team)"],
  ["0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8", "Curb attestor (cold spare)"],
  ["0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4", "Curb attestor, host A"],
  ["0x50Fa162a1dE84D2719644DC45E44EC5D16e539fB", "Curb attestor, host B"],
].map(([a, l]) => [getAddress(a), l]));

const METHODS = new Map(["curb.scorecard.mark/1", "curb.scorecard.mark/2"].map((m) => [methodDigestOf(m).toLowerCase(), m]));

// ── pacing: about three requests a second across every lookup below ─────────────────────────────

const GAP_MS = 350;
let nextAt = 0;
async function paced<T>(method: string, params: unknown[]): Promise<T> {
  const wait = nextAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextAt = Date.now() + GAP_MS;
  return rpcAny<T>(RPCS, method, params);
}

type Log = { transactionHash: string; topics: string[] };

/** The one transaction in `block` that emitted `event` for closure `id`, or null when none can be found. */
async function txOf(event: "ClosureCommitted" | "ClosureSettled", id: string, block: number): Promise<string | null> {
  const topic = scorecardAbi.getEvent(event)!.topicHash;
  const hex = "0x" + block.toString(16);
  try {
    const logs = await paced<Log[]>("eth_getLogs", [{ address: SCORECARD, topics: [topic, id], fromBlock: hex, toBlock: hex }]);
    const txs = [...new Set(logs.map((l) => l.transactionHash.toLowerCase()))];
    if (txs.length !== 1) { console.warn(`  ${event} ${id.slice(0, 10)}… at ${block}: ${txs.length} transactions`); return null; }
    return txs[0];
  } catch (e) {
    console.warn(`  ${event} ${id.slice(0, 10)}… at ${block}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function senderOf(tx: string): Promise<string | null> {
  try {
    const t = await paced<{ from: string } | null>("eth_getTransactionByHash", [tx]);
    return t?.from ? getAddress(t.from) : null;
  } catch (e) {
    console.warn(`  sender of ${tx.slice(0, 10)}…: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── the rows ───────────────────────────────────────────────────────────────────────────────────

type Outcome = "win" | "tie" | "loss";
const px = (e18: string) => formatUnits(BigInt(e18), 18);
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");

/** (mark - lastPrint) / lastPrint in whole bp, truncated toward zero: how far the method moved off the baseline. */
const movedBps = (markE18: string, lastE18: string) => {
  const last = BigInt(lastE18);
  return last > 0n ? Number(((BigInt(markE18) - last) * 10_000n) / last) : null;
};

export interface LeaderboardRow {
  index: number;
  id: string;
  asset: string | null;
  wrapper: string;
  method: string | null;
  methodDigest: string;
  reopenAt: string;
  committedAt: string;
  committedBlock: number;
  commitTx: string | null;
  mark: string;
  lastPrint: string;
  closingVwap: string;
  /** The exact committed integers (1e18 = one USD per wrapper share), for anyone re-deriving a number. */
  markE18: string;
  lastPrintE18: string;
  /** Signed, whole bp, truncated toward zero. A move under 1 bp shows 0 here but still counts as moved. */
  markMovedBps: number | null;
  bandBps: number;
  status: "settled" | "pending" | "expired";
  settledAt: string | null;
  settledBlock: number | null;
  settleTx: string | null;
  settler: string | null;
  settlerLabel: string | null;
  reopenPrint: string | null;
  reopenPrintE18: string | null;
  curbErrorBps: number | null;
  lastPrintErrorBps: number | null;
  closingVwapErrorBps: number | null;
  vsLastPrint: Outcome | null;
  vsClosingVwap: Outcome | null;
  /** curbErrorBps <= bandBps: the reopen landed inside the band committed with the mark. */
  bandCovered: boolean | null;
}

async function toRow(r: ScorecardRow, nowS: number): Promise<LeaderboardRow> {
  const s = r.settlement;
  const g = s ? grade(s) : null;
  const commitTx = await txOf("ClosureCommitted", r.id, r.committedBlock);
  const settleTx = s ? await txOf("ClosureSettled", r.id, s.settledBlock) : null;
  const settler = settleTx ? await senderOf(settleTx) : null;
  const expired = !s && nowS > r.settleAfter + SETTLE_DELAY_S + SETTLE_WINDOW_S;
  return {
    index: r.index,
    id: r.id,
    asset: SYMBOLS.get(getAddress(r.wrapper)) ?? null,
    wrapper: r.wrapper,
    method: METHODS.get(r.methodDigest) ?? null,
    methodDigest: r.methodDigest,
    reopenAt: iso(r.settleAfter),
    committedAt: iso(r.committedAt),
    committedBlock: r.committedBlock,
    commitTx,
    mark: px(r.markE18),
    lastPrint: px(r.lastPrintE18),
    closingVwap: px(r.closingVwapE18),
    markE18: r.markE18,
    lastPrintE18: r.lastPrintE18,
    markMovedBps: movedBps(r.markE18, r.lastPrintE18),
    bandBps: r.bandBps,
    status: s ? "settled" : expired ? "expired" : "pending",
    settledAt: s ? iso(s.settledAt) : null,
    settledBlock: s?.settledBlock ?? null,
    settleTx,
    settler,
    settlerLabel: settler ? KNOWN_WALLETS.get(settler) ?? null : null,
    reopenPrint: s ? px(s.reopenPrintE18) : null,
    reopenPrintE18: s?.reopenPrintE18 ?? null,
    curbErrorBps: s?.curbErrorBps ?? null,
    lastPrintErrorBps: s?.lastPrintErrorBps ?? null,
    closingVwapErrorBps: s?.closingVwapErrorBps ?? null,
    vsLastPrint: g ? (g.beatLastPrint ? "win" : g.tie ? "tie" : "loss") : null,
    vsClosingVwap: g ? (g.beatClosingVwap ? "win" : g.tieClosingVwap ? "tie" : "loss") : null,
    bandCovered: s ? s.curbErrorBps <= r.bandBps : null,
  };
}

/** Counts over a set of rows, the way the page shows them. Means are over settled rows only. */
export function tally(rows: LeaderboardRow[]) {
  const settled = rows.filter((r) => r.status === "settled");
  const count = (k: "vsLastPrint" | "vsClosingVwap", o: Outcome) => settled.filter((r) => r[k] === o).length;
  const mean = (k: "curbErrorBps" | "lastPrintErrorBps") =>
    settled.length ? Math.round((settled.reduce((a, r) => a + (r[k] ?? 0), 0) / settled.length) * 10) / 10 : null;
  const bands = settled.map((r) => r.bandBps);
  return {
    rows: rows.length,
    settled: settled.length,
    pending: rows.filter((r) => r.status === "pending").length,
    expired: rows.filter((r) => r.status === "expired").length,
    vsLastPrint: { wins: count("vsLastPrint", "win"), ties: count("vsLastPrint", "tie"), losses: count("vsLastPrint", "loss") },
    vsClosingVwap: { wins: count("vsClosingVwap", "win"), ties: count("vsClosingVwap", "tie"), losses: count("vsClosingVwap", "loss") },
    meanCurbErrorBps: mean("curbErrorBps"),
    meanLastPrintErrorBps: mean("lastPrintErrorBps"),
    markMoved: settled.filter((r) => r.markE18 !== r.lastPrintE18).length,
    band: {
      minBps: bands.length ? Math.min(...bands) : null,
      maxBps: bands.length ? Math.max(...bands) : null,
      covered: settled.filter((r) => r.bandCovered).length,
      settled: settled.length,
    },
  };
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rel = (p: string) => relative(ROOT, p);

async function main(): Promise<void> {
  // The backtest first: a stale or foreign results file stops the run before any RPC call.
  const results = JSON.parse(readFileSync(RESULTS, "utf8"));
  if (results.schema !== RESULTS_SCHEMA) throw new Error(`${rel(RESULTS)}: schema ${results.schema}, want ${RESULTS_SCHEMA}`);
  if (results.d13?.reproduced !== true) throw new Error(`${rel(RESULTS)} does not reproduce D-13`);
  const inputs: Record<string, string> = { [rel(RESULTS)]: sha256(RESULTS) };
  for (const [f, want] of Object.entries(results.inputs as Record<string, string>)) {
    const path = join(dirname(RESULTS), "..", f);
    const got = sha256(path);
    if (got !== want) throw new Error(`${rel(path)} changed since results.json was written; re-run fit.mjs`);
    inputs[rel(path)] = got;
  }

  console.log(`reading Scorecard ${SCORECARD} via ${RPCS.map((u) => new URL(u).host).join(", ")}`);
  const index = new ScorecardIndex({ scorecard: SCORECARD, chain: rpcChain(RPCS), now: Date.now });
  const snap = await index.refresh();
  const again = recount(snap.rows);
  if (snap.rows.length !== snap.closureCount) throw new Error(`read ${snap.rows.length} rows, closureCount() says ${snap.closureCount}`);
  if (again.settled !== snap.skill.settled || again.beatLast !== snap.skill.beatLast || again.beatVwap !== snap.skill.beatVwap) {
    throw new Error(`recount ${JSON.stringify(again)} != skill() ${JSON.stringify(snap.skill)} at block ${snap.block.number}`);
  }
  console.log(`block ${snap.block.number}: ${snap.closureCount} rows; skill() = recount = ${JSON.stringify(again)}`);

  const rows: LeaderboardRow[] = [];
  for (const r of snap.rows) rows.push(await toRow(r, snap.block.timestamp));

  // Integrity flags: more than one row for the same closure (wrapper and reopen), and rows that can no longer settle.
  const byClosure = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.wrapper}|${r.reopenAt}`;
    byClosure.set(k, [...(byClosure.get(k) ?? []), r.id]);
  }
  const duplicateClosures = [...byClosure.entries()].filter(([, ids]) => ids.length > 1).map(([k, ids]) => {
    const [wrapper, reopenAt] = k.split("|");
    return { wrapper, reopenAt, ids };
  });

  const methods = [...new Set(rows.map((r) => r.method ?? r.methodDigest))].sort();
  const all = tally(rows);
  const wf = results.walkForward, is = results.inSample;
  const doc = {
    schema: LEADERBOARD_SCHEMA,
    generatedAt: new Date().toISOString(),
    generatedBy: "tools/leaderboard/build.ts",
    inputs,
    onChain: {
      label: "Scorecard v2 on X Layer, read at one block. Every number here is a contract getter or a strict recount of them.",
      chainId: CHAIN_ID,
      scorecard: snap.scorecard,
      block: snap.block,
      closureCount: snap.closureCount,
      skill: snap.skill,
      recount: again,
      recountMatchesSkill: true,
      all,
      byMethod: Object.fromEntries(methods.map((m) => [m, tally(rows.filter((r) => (r.method ?? r.methodDigest) === m))])),
      integrity: {
        duplicateClosures,
        expiredUnsettled: all.expired,
        settlers: Object.entries(rows.reduce<Record<string, number>>((acc, r) => {
          if (r.status === "settled") acc[r.settler ?? "unknown"] = (acc[r.settler ?? "unknown"] ?? 0) + 1;
          return acc;
        }, {})).map(([address, n]) => ({ address, label: KNOWN_WALLETS.get(address) ?? null, rows: n })),
      },
      rows: [...rows].reverse(),
    },
    band: {
      rule: "bandBps = min(2000, max(25, 25 + floor(|move| / 2))), move in bp: mark/2's r when its signal is applied, otherwise the pool's drift (0 when the pool did not trade). Covered: curbErrorBps <= bandBps.",
      committed: { minBps: all.band.minBps, maxBps: all.band.maxBps, covered: all.band.covered, settled: all.band.settled },
      backtest: {
        walkForward: { covered: wf.band.mark2Band.covered, n: wf.band.n, medianBandBps: wf.band.mark2Band.bandBp.p50, p68ErrorBp: wf.groups.pooled.mark2.absErrorBp.p68 },
        inSample: { covered: is.band.mark2Band.covered, n: is.band.n, medianBandBps: is.band.mark2Band.bandBp.p50, p68ErrorBp: is.groups.pooled.mark2.absErrorBp.p68 },
      },
    },
    backtest: {
      label: "Historical backtest, not on chain. Graded against the HKEX official open, not the pool print Scorecard settles at.",
      source: "tools/research/hk-closures/fit.mjs",
      doc: "docs/research/HK_CLOSURE.md",
      sample: results.sample,
      metric: results.metric,
      estimators: results.estimators,
      d13: results.d13,
      walkForward: {
        label: "Walk-forward (out of sample): each closure marked with the beta the published rule gives on earlier closures only.",
        minTrain: wf.minTrain, firstReopen: wf.firstReopen, lastReopen: wf.lastReopen, warmupExcluded: wf.warmupExcluded,
        publishedBeta: wf.publishedBeta, n: wf.n, groups: wf.groups, byKind: wf.byKind, band: wf.band,
      },
      inSample: {
        label: "In-sample: every closure marked with the published beta, fitted on these same closures.",
        beta: is.beta, n: is.n, groups: is.groups, byKind: is.byKind, band: is.band,
      },
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n");
  const s = all;
  console.log(`settled ${s.settled}: ${s.vsLastPrint.wins} wins, ${s.vsLastPrint.ties} ties, ${s.vsLastPrint.losses} losses vs last print; band covered ${s.band.covered}/${s.band.settled}; pending ${s.pending}, expired ${s.expired}, duplicate closures ${duplicateClosures.length}`);
  for (const m of methods) {
    const t = doc.onChain.byMethod[m];
    console.log(`  ${m}: ${t.rows} rows, ${t.settled} settled, ${t.vsLastPrint.wins}/${t.vsLastPrint.ties}/${t.vsLastPrint.losses} w/t/l, mark moved on ${t.markMoved}`);
  }
  console.log(`wrote ${rel(OUT)}`);
}

// Run only when invoked directly, so the tests can import tally() without touching the network.
const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return ""; } })() : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
