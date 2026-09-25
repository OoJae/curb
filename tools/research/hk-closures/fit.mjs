#!/usr/bin/env node
// The Hong Kong closure backtest behind curb.scorecard.mark/2 (D-13), and its out-of-sample check (D-14).
//
//   node tools/research/hk-closures/fit.mjs            offline: reads data/ only, and a cache miss is an error
//   node tools/research/hk-closures/fit.mjs --fetch    fills a klines-cache miss from Binance (HTTP 451 from US IPs)
//   node tools/research/hk-closures/fit.mjs --check    writes nothing; exits 1 unless out/results.json is exactly what it would write
//
// One row per overnight or weekend closure of the primary share behind wTCENTx, wXIAOx and wMEITx, 22 Jul to
// 22 Sep 2026, EXCLUDING the nights behind the six D-11 overnight rows (they reopen 23 and 24 Sep):
//   y      = HK open(D') / HK close(D) - 1             (the overnight gap the mark has to predict)
//   r_perp = perp close(minute before 01:20Z D') / perp close(07:54Z minute on D) - 1
//   r_adr  = ADR close(last US session ending inside the closure) x USDHKD / sharesPerADR / HK close(D) - 1
//   x      = mean(r_perp, r_adr) when both exist, else the one that exists
// OLS through the origin: beta = sum(xy) / sum(x^2). mark/2 publishes round(0.8 x pooled beta, 2) = 0.79.
//
// Every error here is |estimate - HK open| / HK close(D), in bp: for a mark m = close x (1 + b x) that is
// exactly |y - b x|. This is D-13's metric. The Scorecard contract divides by the reopen print instead; the
// band section reports how many coverage calls that choice changes.
//
// 1. D-13, reproduced: the fit and the in-sample numbers D-13 published. Exits 1 if any of them differ.
// 2. The estimators, in-sample and walk-forward. Walk-forward marks each closure with the beta the published
//    rule gives when it is fitted only on closures whose reopen came before this one's (an earlier reopen
//    date; same-night closures of the other names are not yet known at 01:20Z). The first MIN_TRAIN closures
//    have no mark. Every estimator is scored on the same rows.
// 3. The keeper's committed band (services/keeper/src/mark.ts), and how often it would have held the gap.
// Writes out/results.json. It carries no timestamp, so an unchanged input gives byte-identical output.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const D = join(HERE, "data");
const OUT = join(HERE, "out");
const FETCH = process.argv.includes("--fetch");
const CHECK = process.argv.includes("--check");
const UA = { "user-agent": "Mozilla/5.0 (compatible; curb-keeper-research/1.0)" };

const ASSETS = [
  { name: "wTCENTx", hk: "0700.HK", adr: "TCEHY", shares: 1, perp: "HK0700USDT", listed: "2026-07-22" },
  { name: "wXIAOx", hk: "1810.HK", adr: "XIACY", shares: 5, perp: "HK1810USDT", listed: "2026-07-22" },
  { name: "wMEITx", hk: "3690.HK", adr: "MPNGY", shares: 2, perp: "MEITUANUSDT", listed: "2026-08-11" },
];
const LAST_OPEN_IN_FIT = "2026-09-22"; // nights whose HK reopen is on or before this date; D-11 rows reopen 23 and 24 Sep

/** What D-13 published, to the digit it published. The run fails unless the fit gives exactly these. */
const D13 = {
  n: 118, beta: "0.983", se: "0.093", r2: "0.49", damped: 0.79,
  names: {
    wTCENTx: { beta: "1.048", lastClose: "92.7", mark2: "58.2" },
    wXIAOx: { beta: "0.901", lastClose: "96.6", mark2: "78.5" },
    wMEITx: { beta: "0.976", lastClose: "93.2", mark2: "67.3" },
  },
};

/** The published rule: damp the pooled fit by 0.8, round to cents, clamp to [0, 1]. */
const publish = (beta) => Math.min(1, Math.max(0, Math.round(0.8 * beta * 100) / 100));

/** Walk-forward warm-up: no walk-forward mark until this many earlier closures (about ten trading days). */
const MIN_TRAIN = 30;

/** The keeper's band for mark/2 (services/keeper/src/mark.ts, MARK_METHODS["curb.scorecard.mark/2"]). */
const BAND = { floorBps: 25, capBps: 2_000, maxLegBps: 2_000 };

const INPUTS = [
  "0700.HK.1y.json", "1810.HK.1y.json", "3690.HK.1y.json",
  "TCEHY.1y.json", "XIACY.1y.json", "MPNGY.1y.json", "HKD=X.1y.json", "klines-cache.json",
];

// ── rows (as D-13 built them) ──────────────────────────────────────────────────────────────────

const series = (f) => {
  const r = JSON.parse(readFileSync(join(D, f), "utf8")).chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ t: t * 1000, o: q.open[i], c: q.close[i] }));
};
const cachePath = join(D, "klines-cache.json");
const cacheBytes = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : "{}";
const cache = JSON.parse(cacheBytes);
let fetched = 0;
async function perpClose(sym, openTimeMs) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${openTimeMs}&limit=1`;
  if (!(url in cache)) {
    if (!FETCH) throw new Error(`klines-cache has no ${url}; run with --fetch from outside the US to fill it`);
    const r = await fetch(url, { headers: UA });
    cache[url] = await r.text();
    fetched++;
    await new Promise((res) => setTimeout(res, 60));
  }
  const j = JSON.parse(cache[url]);
  if (!Array.isArray(j) || j.length !== 1 || j[0][0] !== openTimeMs) return null;
  return Number(j[0][4]);
}
const fx = series("HKD=X.1y.json").filter((b) => b.c != null);
const fxAt = (ms) => { let v = null; for (const b of fx) if (b.t <= ms) v = b.c; return v; };
const hkDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400e3);

const out = {};
const all = [];
for (const a of ASSETS) {
  const hk = series(`${a.hk}.1y.json`).filter((b) => b.c != null && b.o != null);
  const adr = series(`${a.adr}.1y.json`);
  const rows = [];
  for (let i = 0; i + 1 < hk.length; i++) {
    const d = hkDate(hk[i].t), d2 = hkDate(hk[i + 1].t);
    if (d < a.listed || d2 > LAST_OPEN_IN_FIT) continue;
    const cutMs = Date.parse(`${d}T07:55:00Z`);
    const commitMs = Date.parse(`${d2}T01:20:00Z`);
    const pCut = await perpClose(a.perp, cutMs - 60_000);
    const pCommit = await perpClose(a.perp, commitMs - 60_000);
    const rPerp = pCut && pCommit ? pCommit / pCut - 1 : null;
    // last US session that ended inside the closure (session end = bar start + 6.5 h)
    let adrBar = null;
    for (const b of adr) { const end = b.t + 6.5 * 3600e3; if (end > cutMs && end < commitMs) adrBar = b; }
    let rAdr = null;
    if (adrBar && adrBar.c != null) {
      const f = fxAt(adrBar.t + 6.5 * 3600e3);
      rAdr = (adrBar.c * f / a.shares) / hk[i].c - 1;
    }
    const legs = [rPerp, rAdr].filter((x) => x !== null);
    if (!legs.length) continue;
    const x = legs.reduce((s, v) => s + v, 0) / legs.length;
    const y = hk[i + 1].o / hk[i].c - 1;
    // Closure length: one calendar night, or a weekend / holiday (the reopen is two or more days on).
    const kind = daysBetween(d, d2) === 1 ? "overnight" : "weekend-holiday";
    rows.push({ name: a.name, d, d2, kind, rPerp, rAdr, x, y, adrNull: !!adrBar && adrBar.c == null });
  }
  out[a.name] = rows;
  all.push(...rows);
}
if (fetched) writeFileSync(cachePath, JSON.stringify(cache));

// ── 1. D-13, reproduced ────────────────────────────────────────────────────────────────────────

const fit = (rows) => {
  const sxy = rows.reduce((s, r) => s + r.x * r.y, 0), sxx = rows.reduce((s, r) => s + r.x * r.x, 0);
  const syy = rows.reduce((s, r) => s + r.y * r.y, 0);
  const beta = sxy / sxx;
  const sse = rows.reduce((s, r) => s + (r.y - beta * r.x) ** 2, 0);
  // standard error of a through-origin slope
  const se = Math.sqrt(sse / (rows.length - 1) / sxx);
  return { n: rows.length, beta, se, r2Uncentered: 1 - sse / syy };
};
const maeOf = (rows, b) => rows.reduce((s, r) => s + Math.abs(r.y - b * r.x), 0) / rows.length * 1e4;

const pooled = fit(all);
const damped = publish(pooled.beta);
const d13 = {
  n: pooled.n, beta: pooled.beta, se: pooled.se, r2Uncentered: pooled.r2Uncentered, damped,
  names: Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, {
    n: rows.length, beta: fit(rows).beta, maeLastCloseBp: maeOf(rows, 0), maeMark2Bp: maeOf(rows, damped),
  }])),
};
const mismatches = [];
const want = (label, got, exp) => { if (got !== exp) mismatches.push(`${label}: got ${got}, D-13 says ${exp}`); };
want("n", d13.n, D13.n);
want("pooled beta", d13.beta.toFixed(3), D13.beta);
want("pooled se", d13.se.toFixed(3), D13.se);
want("pooled R2", d13.r2Uncentered.toFixed(2), D13.r2);
want("published beta", d13.damped, D13.damped);
for (const [k, e] of Object.entries(D13.names)) {
  const g = d13.names[k];
  want(`${k} beta`, g.beta.toFixed(3), e.beta);
  want(`${k} last-close error`, g.maeLastCloseBp.toFixed(1), e.lastClose);
  want(`${k} mark/2 error`, g.maeMark2Bp.toFixed(1), e.mark2);
}
console.log(`D-13 fit: n=${d13.n} beta=${d13.beta.toFixed(3)} (se ${d13.se.toFixed(3)}) R2(uncentred)=${d13.r2Uncentered.toFixed(3)} published=${d13.damped}`);
for (const [k, g] of Object.entries(d13.names)) {
  console.log(`  ${k.padEnd(8)} n=${g.n} beta=${g.beta.toFixed(3)} last close ${g.maeLastCloseBp.toFixed(1)} bp -> mark/2 ${g.maeMark2Bp.toFixed(1)} bp`);
}
if (mismatches.length) {
  console.error(`D-13 NOT reproduced:\n  ${mismatches.join("\n  ")}`);
  process.exit(1);
}
console.log("D-13 reproduced exactly.");

// ── 2. estimators, in-sample and walk-forward ──────────────────────────────────────────────────

// Each estimator is a predicted gap (a return from the HK close); the mark is close x (1 + that).
const ESTIMATORS = {
  lastClose: { label: "Last close", note: "The HK close itself: the baseline the Scorecard grades against." },
  perp: { label: "Perp alone", note: "The Binance perpetual's move from the cut to the commit, applied in full (beta 1)." },
  adr: { label: "ADR alone", note: "The ADR's last US close at USD/HKD against the HK close, applied in full (beta 1). The last close where the ADR bar is missing." },
  mark2: { label: "mark/2", note: "The published method: beta x mean of the legs. In-sample beta 0.79; walk-forward beta refitted before each closure by the same rule." },
};
const predict = (r, beta) => ({ lastClose: 0, perp: r.rPerp ?? 0, adr: r.rAdr ?? 0, mark2: beta * r.x });

// The keeper's r in whole bp: each leg truncated toward zero, a leg past maxLegBps set aside, the mean truncated.
function keeperRBps(r) {
  const leg = (v) => (v === null ? null : Math.trunc(v * 1e4));
  const have = [leg(r.rPerp), leg(r.rAdr)].filter((v) => v !== null && Math.abs(v) <= BAND.maxLegBps);
  if (!have.length) return null;
  return have.length === 1 ? have[0] : Math.trunc((have[0] + have[1]) / 2);
}
const bandFor = (rBps) => Math.min(BAND.capBps, Math.max(BAND.floorBps, BAND.floorBps + Math.floor(Math.abs(rBps ?? 0) / 2)));

// Nearest-rank quantile of the sorted absolute errors.
const quantile = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const r4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
const EPS = 1e-12;

/** Score every estimator on the same scored rows ({row, beta}). */
function score(scored) {
  const res = {};
  for (const key of Object.keys(ESTIMATORS)) {
    const errs = [];
    let wins = 0, ties = 0, losses = 0, calls = 0, hits = 0;
    for (const { row, beta } of scored) {
      const est = predict(row, beta)[key];
      const e = Math.abs(row.y - est) * 1e4;
      const base = Math.abs(row.y) * 1e4;
      errs.push(e);
      if (Math.abs(e - base) <= EPS) ties++;
      else if (e < base) wins++;
      else losses++;
      // Direction: counted only when the estimator calls one (est != 0) and the gap has one (y != 0).
      if (est !== 0 && row.y !== 0) { calls++; if (Math.sign(est) === Math.sign(row.y)) hits++; }
    }
    const sorted = [...errs].sort((a, b) => a - b);
    const n = errs.length;
    res[key] = {
      n,
      maeBp: r1(n ? errs.reduce((s, v) => s + v, 0) / n : null),
      vsLastClose: key === "lastClose" ? null : { wins, ties, losses, winRate: r4(n ? wins / n : null) },
      direction: key === "lastClose" ? null : { calls, hits, hitRate: r4(calls ? hits / calls : null) },
      absErrorBp: { p50: r1(quantile(sorted, 0.5)), p68: r1(quantile(sorted, 0.68)), p90: r1(quantile(sorted, 0.9)) },
    };
  }
  return res;
}

/** How often the mark/2 band (and a flat 25 bp band, mark/1's with no drift) held the gap. */
function bandCoverage(scored) {
  let rule = 0, flat = 0, flips = 0;
  const bands = [];
  for (const { row, beta } of scored) {
    const est = beta * row.x;
    const band = bandFor(keeperRBps(row));
    bands.push(band);
    const e = Math.abs(row.y - est) * 1e4;
    const covered = e <= band;
    if (covered) rule++;
    if (e <= BAND.floorBps) flat++;
    // The contract's own metric: floor(|mark - open| x 1e4 / open).
    const eContract = Math.floor(Math.abs(est - row.y) / (1 + row.y) * 1e4);
    if ((eContract <= band) !== covered) flips++;
  }
  const sorted = [...bands].sort((a, b) => a - b);
  return {
    n: scored.length,
    mark2Band: { covered: rule, rate: r4(scored.length ? rule / scored.length : null), bandBp: { min: sorted[0] ?? null, p50: quantile(sorted, 0.5), max: sorted.at(-1) ?? null } },
    flat25: { covered: flat, rate: r4(scored.length ? flat / scored.length : null) },
    contractMetricFlips: flips,
  };
}

/** Score by name, pooled, and by closure length. */
function evaluate(scored) {
  const groups = {};
  for (const a of ASSETS) groups[a.name] = score(scored.filter((s) => s.row.name === a.name));
  groups.pooled = score(scored);
  const byKind = {};
  for (const kind of ["overnight", "weekend-holiday"]) byKind[kind] = score(scored.filter((s) => s.row.kind === kind));
  return { n: scored.length, groups, byKind, band: bandCoverage(scored) };
}

// In-sample: every row, at the published beta.
const inSample = { beta: damped, ...evaluate(all.map((row) => ({ row, beta: damped }))) };

// Walk-forward: in reopen order, refit on closures whose reopen date is strictly earlier.
const ordered = [...all].sort((a, b) => (a.d2 < b.d2 ? -1 : a.d2 > b.d2 ? 1 : 0));
const wfScored = [];
const wfBetas = [];
for (const row of ordered) {
  const train = ordered.filter((r) => r.d2 < row.d2);
  if (train.length < MIN_TRAIN) continue;
  const f = fit(train);
  const beta = publish(f.beta);
  wfScored.push({ row, beta, fitted: f.beta, trainN: train.length });
  wfBetas.push(beta);
}
const walkForward = {
  minTrain: MIN_TRAIN,
  firstReopen: wfScored[0]?.row.d2 ?? null,
  lastReopen: wfScored.at(-1)?.row.d2 ?? null,
  warmupExcluded: all.length - wfScored.length,
  publishedBeta: { first: wfBetas[0] ?? null, last: wfBetas.at(-1) ?? null, min: Math.min(...wfBetas), max: Math.max(...wfBetas) },
  ...evaluate(wfScored),
};

// Every row, so a reader can recompute any number above without the raw charts.
const wfBy = new Map(wfScored.map((s) => [`${s.row.name}|${s.row.d}`, s]));
const rowsOut = [...all].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.name < b.name ? -1 : 1)).map((r) => {
  const w = wfBy.get(`${r.name}|${r.d}`);
  const rBps = keeperRBps(r);
  return {
    asset: r.name, cut: r.d, reopen: r.d2, kind: r.kind,
    gapBp: r4(r.y * 1e4), perpBp: r.rPerp === null ? null : r4(r.rPerp * 1e4), adrBp: r.rAdr === null ? null : r4(r.rAdr * 1e4),
    rBp: r4(r.x * 1e4), keeperRBps: rBps, bandBps: bandFor(rBps), walkForwardBeta: w ? w.beta : null,
  };
});

const sha256 = (f) => createHash("sha256").update(readFileSync(join(D, f))).digest("hex");
const results = {
  schema: "curb.hk-closures.results/1",
  generatedBy: "tools/research/hk-closures/fit.mjs",
  kind: "historical backtest",
  inputs: Object.fromEntries(INPUTS.map((f) => [`data/${f}`, sha256(f)])),
  sample: {
    firstCut: ordered.map((r) => r.d).sort()[0],
    lastReopen: LAST_OPEN_IN_FIT,
    closures: all.length,
    byAsset: Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, rows.length])),
    byKind: { overnight: all.filter((r) => r.kind === "overnight").length, "weekend-holiday": all.filter((r) => r.kind === "weekend-holiday").length },
    perpOnly: all.filter((r) => r.rAdr === null).length,
    adrOnly: all.filter((r) => r.rPerp === null).length,
    excluded: "the nights behind the six D-11 overnight rows (reopen 23 and 24 Sep 2026), and every lunch recess",
  },
  metric: "|estimate - HK open| / HK close, in bp; the HK open is the official opening price, not the pool print the Scorecard grades",
  estimators: ESTIMATORS,
  band: {
    rule: "min(2000, max(25, 25 + floor(|r| / 2))) bp, r the keeper's integer-bp mean of the legs (services/keeper/src/mark.ts)",
    covered: "|mark - open| / close <= band",
  },
  d13: { reproduced: true, ...d13 },
  inSample,
  walkForward,
  rows: rowsOut,
};

const bytes = JSON.stringify(results, null, 1) + "\n";
if (CHECK) {
  const path = join(OUT, "results.json");
  const same = existsSync(path) && readFileSync(path, "utf8") === bytes;
  console.log(same ? "out/results.json is current." : "out/results.json is STALE: re-run fit.mjs and commit it.");
  process.exit(same ? 0 : 1);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "results.json"), bytes);

// ── summary ────────────────────────────────────────────────────────────────────────────────────

const line = (label, g) => {
  const cell = (k) => {
    const s = g[k];
    const w = s.vsLastClose ? ` w${s.vsLastClose.wins}/${s.n}` : "";
    const dir = s.direction?.hitRate != null ? ` dir ${(s.direction.hitRate * 100).toFixed(0)}%` : "";
    return `${k} ${s.maeBp.toFixed(1)}${w}${dir}`;
  };
  console.log(`  ${label.padEnd(16)} n=${String(g.lastClose.n).padStart(3)}  ${Object.keys(ESTIMATORS).map(cell).join("  |  ")}  p50/68/90 ${g.mark2.absErrorBp.p50}/${g.mark2.absErrorBp.p68}/${g.mark2.absErrorBp.p90}`);
};
for (const [title, ev] of [["IN-SAMPLE (beta 0.79)", inSample], [`WALK-FORWARD (min ${MIN_TRAIN} earlier closures; beta ${walkForward.publishedBeta.min}..${walkForward.publishedBeta.max}, last ${walkForward.publishedBeta.last})`, walkForward]]) {
  console.log(title);
  for (const [k, g] of Object.entries(ev.groups)) line(k, g);
  for (const [k, g] of Object.entries(ev.byKind)) line(k, g);
  const b = ev.band;
  console.log(`  band: mark/2 rule covered ${b.mark2Band.covered}/${b.n} (bands ${b.mark2Band.bandBp.min}..${b.mark2Band.bandBp.max} bp, p50 ${b.mark2Band.bandBp.p50}); flat 25 bp covered ${b.flat25.covered}/${b.n}; contract-metric flips ${b.contractMetricFlips}`);
}
console.log(`wrote ${join("tools/research/hk-closures/out/results.json")}`);
