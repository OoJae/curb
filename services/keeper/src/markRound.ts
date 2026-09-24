/**
 * The evidence for one committed mark.
 *
 * `Scorecard.Commitment` carries an `inputRoot`, and that root is the entire reason a mark is worth
 * anything: it lets a stranger take the published bundle, re-run `computeMark`, and get the same
 * number Curb put on chain -- or catch it not matching. Same shape as the attestor's round bundle,
 * so one verifier idea covers both: every leaf's preimage is published, the root is rebuilt from the
 * leaves, and the claims are re-derived from the committed inputs rather than trusted.
 */
import { sha256, toUtf8Bytes } from "ethers";
import { hashJson, hashBytes, subjectOf, subjectOfAddress, buildTree, loadTree, jcs, LeafKind } from "./tree.ts";
import type { Leaf } from "./tree.ts";
import { computeMark, hasSignal, MARK_METHODS, MARK_METHOD_VERSION, SIGNAL_PROXIES } from "./mark.ts";
import type { ClosureInput, Mark, MarkSignal, SignalInput } from "./mark.ts";
import { deriveSignal, evidenceBytes, SIGNAL_KEYS, BINANCE_FAPI, YAHOO_CHART } from "./sources/signal.ts";
import type { SignalEvidenceBytes } from "./sources/signal.ts";
import type { SignalAttempt, SignalExchange } from "./sources/signalFetch.ts";
import type { MulticallSnapshot } from "./sources/chain.ts";
import type { PoolSpec, SwapRow } from "./sources/pools.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { PeriodLimits } from "./reopen.ts";
import type { ExchangeSchedule } from "./regime.ts";

export const MARK_BUNDLE_SCHEMA = "curb.scorecard.markbundle/1";

/**
 * Why this closure ends when the row says it does.
 *
 * `settleAfter` is half the closure id and the instant the mark is graded against, so asserting it
 * is not enough: the bundle carries the venue schedule and the issuer's per-period caps that were
 * actually used, and a verifier re-runs `nextCapReturnMs` over them and gets the same instant or
 * catches us. Without this, the one number nobody can check would be the one that decides the grade.
 */
export interface VenueEvidence {
  mic: string;
  assetUrl: string;
  assetBodyHash: string;
  exchangeUrl: string;
  exchangeBodyHash: string;
  /** Observed instant at which onchain primary capacity was first seen at zero. */
  cutAtMs: number;
  limitsPerPeriod: PeriodLimits;
  schedule: ExchangeSchedule["schedule"];
  predictedReopenMs: number;
}

export interface MarkInputs {
  /** The mark method to apply; defaults to the live one. Old methods stay buildable for tests and replays. */
  method?: string;
  chainId: number;
  clock: string;
  scorecard: string;
  evaluatedAtMs: number;
  codeDigest: string;
  specs: PoolSpec[];
  /** The pinned pool reads this round used. */
  chain: MulticallSnapshot;
  /** Per wrapper: the closure evidence the mark is derived from. */
  closures: Array<{
    wrapper: string;
    symbol: string;
    cutAtMs: number;
    cutBlock: number;
    settleAfterS: number;
    input: ClosureInput;
    /** Swaps used for the closing VWAP, and those seen during the closure. */
    closingSwaps: SwapRow[];
    closureSwaps: SwapRow[];
    /** The schedule evidence behind `settleAfterS`. Omitted only in tests. */
    venue?: VenueEvidence;
    /**
     * mark/2: the cross-market responses, exact bytes, and every fetch attempt including failures. The
     * signal in `input` is ignored and re-derived from these, so a round can never commit a signal that
     * does not follow from its own evidence.
     */
    signal?: { exchanges: SignalExchange[]; attempts: SignalAttempt[] };
  }>;
}

export interface MarkRow {
  wrapper: string;
  symbol: string;
  settleAfterS: number;
  markE18: string;
  bandBps: number;
  lastPrintE18: string;
  closingVwapE18: string;
  driftBps: number;
  flags: string[];
  reason: string;
  /** mark/2 rows only: what the cross-market term was, and whether it was applied. */
  signal?: MarkSignal;
}

export interface MarkBundle {
  schema: string;
  chainId: number;
  clock: string;
  scorecard: string;
  evaluatedAtMs: number;
  inputRoot: string;
  tree: unknown;
  json: Record<string, string>;
  marks: MarkRow[];
}

export interface BuiltMarkRound {
  root: string;
  marks: Array<{ row: MarkRow; mark: Mark; wrapper: string; settleAfterS: number }>;
  bundle: MarkBundle;
}

const toRow = (wrapper: string, symbol: string, settleAfterS: number, m: Mark): MarkRow => ({
  wrapper,
  symbol,
  settleAfterS,
  markE18: m.markE18.toString(),
  bandBps: m.bandBps,
  lastPrintE18: m.lastPrintE18.toString(),
  closingVwapE18: m.closingVwapE18.toString(),
  driftBps: m.driftBps,
  flags: m.flags,
  reason: m.reason,
  ...(m.signal ? { signal: m.signal } : {}),
});

const swapJson = (rows: SwapRow[]) =>
  rows.map((r) => ({ blockNumber: r.blockNumber, logIndex: r.logIndex, equityAbs: r.equityAbs.toString(), priceE18: r.priceE18.toString() }));

const inputJson = (i: ClosureInput) => ({
  wrapper: i.wrapper,
  symbol: i.symbol,
  lastPrintE18: i.lastPrintE18.toString(),
  midAtCutE18: i.midAtCutE18.toString(),
  midNowE18: i.midNowE18.toString(),
  closingVwapE18: i.closingVwapE18 === null ? null : i.closingVwapE18.toString(),
  swapsDuringClosure: i.swapsDuringClosure,
  ...(i.signal ? { signal: i.signal } : {}),
});

/**
 * The PARAMS fields a method fixes. A verifier requires the committed PARAMS to carry exactly these for the
 * method it names, so a bundle cannot claim mark/2 while committing different weights or proxies.
 */
export function methodParams(methodId: string): Record<string, unknown> {
  const m = MARK_METHODS[methodId];
  if (!m) throw new Error(`unknown mark method ${methodId}`);
  const base = {
    method: methodId,
    lambdaBps: m.lambdaBps,
    bandFloorBps: m.bandFloorBps,
    bandCapBps: m.bandCapBps,
    closingVwapWindowMs: m.closingVwapWindowMs,
  };
  if (!hasSignal(methodId)) return base;
  return {
    ...base,
    betaBps: m.betaBps,
    minSignalClosureS: m.minSignalClosureS,
    maxLegBps: m.maxLegBps,
    proxies: SIGNAL_PROXIES,
  };
}

/**
 * What mark/2's PARAMS says in words, for a reader of the bundle. Documentation only: the verifier checks
 * `methodParams`, and reads the bytes with sources/signal.ts, never with this text.
 */
const SIGNAL_NOTES = {
  combine: "r = mean of the legs present (perp, adr) in whole bps, truncated; mark = lastPrint x (1 + betaBps x r / 1e8). No leg, a recess, or no proxy: exactly mark/1.",
  perp: {
    url: `${BINANCE_FAPI}/fapi/v1/klines?symbol={perp}&interval=1m&startTime={openTimeMs}&limit=1`,
    cutMinute: "floor(cutAtMs/60000)*60000 - 60000",
    commitMinute: "floor((evaluatedAtMs-5000)/60000)*60000 - 60000",
    price: "kline close; leg = commitClose / cutClose - 1",
    reproducible: true,
    via: "fetched through curb-asp's byte-exact relay (Binance refuses US hosts); the committed url is the upstream one",
  },
  adr: {
    url: `${YAHOO_CHART}{ticker}?interval=1h&range=5d`,
    session: "latest ADR meta.tradingPeriods entry ending in (cutAtMs, evaluatedAtMs]; close = last hourly bar in it, starting within its final hour",
    primary: "latest primary trading period starting at or before the cut, ending within 1 h of it and before the commit; close = last bar in it, within its final hour",
    fx: "last USD->primary bar at or before the ADR session end, at most 3 h before it",
    leg: "(adrClose x fx / sharesPerAdr) / primaryClose - 1",
    reproducible: false,
    note: "Yahoo does not return identical bytes twice: this leg is checkable against the committed bytes, not by refetching",
  },
  recess: "a closure shorter than minSignalClosureS applies no cross-market term: over 23 measured lunch recesses a perp-adjusted mark lost to the last print on all three names, even at half weight. The perp leg is still fetched and committed, flagged recess-no-edge.",
  betaFit: {
    fit: 0.983, se: 0.093, n: 118, r2Uncentred: 0.49,
    sample: "HK overnight and weekend closures whose reopen fell 2026-07-23..2026-09-22 (wMEITx from 2026-08-12): every night the perps existed, and none of the rows in D-11",
    model: "HK open / HK close - 1 = beta x r, least squares through the origin",
    published: "round(0.8 x fit, 2) capped to [0, 1] = 0.79",
  },
};

function paramsLeaf(methodId: string, r: MarkInputs): Record<string, unknown> {
  return {
    ...methodParams(methodId),
    ...(hasSignal(methodId) ? { signalNotes: SIGNAL_NOTES } : {}),
    chainId: r.chainId,
    clock: r.clock,
    scorecard: r.scorecard,
    evaluatedAtMs: r.evaluatedAtMs,
    codeDigest: r.codeDigest,
  };
}

export function buildMarkRound(r: MarkInputs): BuiltMarkRound {
  const leaves: Leaf[] = [];
  const json: Record<string, string> = {};
  const addJson = (kind: Leaf[0], subject: string, value: unknown) => {
    const h = hashJson(value);
    json[h] = jcs(value);
    leaves.push([kind, subject, h]);
  };

  const methodId = r.method ?? MARK_METHOD_VERSION;
  const method = MARK_METHODS[methodId];
  if (!method) throw new Error(`unknown mark method ${methodId}`);
  addJson(LeafKind.PARAMS, subjectOf("params"), paramsLeaf(methodId, r));

  addJson(LeafKind.REGISTRY, subjectOf("registry"), {
    pools: [...r.specs]
      .sort((a, b) => a.wrapper.toLowerCase().localeCompare(b.wrapper.toLowerCase()))
      .map((s) => ({
        wrapper: s.wrapper, symbol: s.symbol, pool: s.pool,
        equityIsToken0: s.equityIsToken0, equityDecimals: s.equityDecimals, stableDecimals: s.stableDecimals,
      })),
  });

  addJson(LeafKind.CHAIN_CALL, subjectOf(`multicall@${r.chain.block.hash}`), {
    block: { number: r.chain.block.number, hash: r.chain.block.hash, timestamp: r.chain.block.timestamp },
    calls: r.chain.results.map((c) => ({
      label: c.label, target: c.target, callData: c.callData, success: c.success, returnData: c.returnData,
    })),
  });

  const marks: BuiltMarkRound["marks"] = [];
  const sorted = [...r.closures].sort((a, b) => a.wrapper.toLowerCase().localeCompare(b.wrapper.toLowerCase()));

  for (const c of sorted) {
    // The exact evidence, committed before the claim derived from it.
    addJson(LeafKind.FETCH_LOG, subjectOf(`swaps:${c.wrapper.toLowerCase()}`), {
      cutAtMs: c.cutAtMs,
      cutBlock: c.cutBlock,
      settleAfterS: c.settleAfterS,
      closingSwaps: swapJson(c.closingSwaps),
      closureSwaps: swapJson(c.closureSwaps),
    });
    const w = c.wrapper.toLowerCase();
    let input: ClosureInput = c.input;
    if (hasSignal(methodId)) {
      // The signal is read out of the committed bytes here, by the verifier's own function, never taken
      // from the caller: what the row claims and what the evidence says cannot diverge.
      const exchanges = c.signal?.exchanges ?? [];
      for (const ex of exchanges) addJson(LeafKind.HTTP_EXCHANGE, subjectOf(`signal:${w}:${ex.key}`), ex);
      addJson(LeafKind.FETCH_LOG, subjectOf(`signal:${w}`), { attempts: c.signal?.attempts ?? [] });
      const signal: SignalInput = deriveSignal(
        { symbol: c.symbol, cutAtMs: c.cutAtMs, commitAtMs: r.evaluatedAtMs, settleAfterS: c.settleAfterS },
        evidenceBytes(exchanges), method.minSignalClosureS!,
      );
      input = { ...c.input, signal };
    } else if (c.input.signal) {
      input = { ...c.input };
      delete input.signal;
    }
    addJson(LeafKind.CA_SNAPSHOT, subjectOf(`markinput:${w}`), inputJson(input));
    if (c.venue) addJson(LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${w}`), c.venue);

    const m = computeMark(input, methodId);
    if (!m) continue; // not enough evidence to assert a mark: no row, rather than a wrong one
    const row = toRow(c.wrapper, c.symbol, c.settleAfterS, m);
    addJson(LeafKind.CLAIM, subjectOfAddress(c.wrapper), row);
    marks.push({ row, mark: m, wrapper: c.wrapper, settleAfterS: c.settleAfterS });
  }

  const { root, tree } = buildTree(leaves);
  return {
    root,
    marks,
    bundle: {
      schema: MARK_BUNDLE_SCHEMA,
      chainId: r.chainId,
      clock: r.clock,
      scorecard: r.scorecard,
      evaluatedAtMs: r.evaluatedAtMs,
      inputRoot: root,
      tree: tree.dump(),
      json,
      marks: marks.map((m) => m.row),
    },
  };
}

export interface VerifyResult {
  ok: boolean;
  root: string;
  failures: string[];
}

/**
 * Offline check of a published mark bundle: rebuild the root from the leaves, check every preimage,
 * and re-run the committed method on the committed inputs. No network, no trust in the keeper.
 */
/**
 * A bundle fetched over HTTP is untrusted input: check its shape before anything reads it.
 *
 * Deliberately NOT `isBundleShaped` from the attestor -- that one requires `blobs`, which a mark
 * bundle does not have, so it rejects every valid mark bundle. The two schemas mean different things
 * by the same leaf kinds and must never be validated through each other's guard.
 */
export function isMarkBundleShaped(b: unknown): b is MarkBundle {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  return x.schema === MARK_BUNDLE_SCHEMA
    && typeof x.inputRoot === "string" && /^0x[0-9a-fA-F]{64}$/.test(x.inputRoot)
    && !!x.tree && typeof x.tree === "object"
    && !!x.json && typeof x.json === "object"
    && Array.isArray(x.marks);
}

export function verifyMarkBundleOffline(bundle: MarkBundle): VerifyResult {
  if (!isMarkBundleShaped(bundle)) return { ok: false, root: "", failures: ["bundle is malformed"] };

  const failures: string[] = [];
  let root = "";
  let leaves: Leaf[] = [];
  try {
    const tree = loadTree(bundle.tree as never);
    root = tree.root;
    leaves = [...tree.entries()].map(([, v]: [number, Leaf]) => v);
  } catch (e) {
    return { ok: false, root, failures: [`tree dump does not load: ${String(e)}`] };
  }
  if (root.toLowerCase() !== String(bundle.inputRoot).toLowerCase()) {
    failures.push(`tree root ${root} != committed inputRoot ${bundle.inputRoot}`);
  }

  const byHash = (h: string) => {
    const s = bundle.json[h];
    if (typeof s !== "string") { failures.push(`missing preimage ${h}`); return null; }
    if (hashJson(JSON.parse(s)) !== h) { failures.push(`preimage hash mismatch for ${h}`); return null; }
    return JSON.parse(s);
  };

  const params = leaves.find(([k, s]) => Number(k) === LeafKind.PARAMS && s === subjectOf("params"));
  const p = params ? byHash(params[2]) : null;
  if (!p) return { ok: false, root, failures: [...failures, "bundle has no PARAMS leaf"] };
  if (!MARK_METHODS[p.method]) return { ok: false, root, failures: [...failures, `unknown mark method ${p.method}`] };
  // The weights, windows and proxies are part of the method id: a bundle naming a method must commit them.
  for (const [k, v] of Object.entries(methodParams(p.method))) {
    if (jcs(p[k] ?? null) !== jcs(v)) failures.push(`committed PARAMS.${k}=${jcs(p[k] ?? null)} is not what ${p.method} specifies (${jcs(v)})`);
  }

  // Only leaves are covered by the root. Every convenience field at the top level of the bundle must
  // agree with its committed counterpart, or a reader is shown a number the root does not back.
  // The "top-level " prefix is load-bearing: a strict checker splits these from real failures.
  const top = bundle as unknown as Record<string, unknown>;
  for (const field of ["chainId", "evaluatedAtMs"] as const) {
    if (JSON.stringify(top[field]) !== JSON.stringify(p[field])) {
      failures.push(`top-level ${field}=${JSON.stringify(top[field])} contradicts committed PARAMS.${field}=${JSON.stringify(p[field])}`);
    }
  }
  for (const field of ["clock", "scorecard"] as const) {
    if (String(top[field]).toLowerCase() !== String(p[field]).toLowerCase()) {
      failures.push(`top-level ${field} ${top[field]} contradicts committed PARAMS.${field} ${p[field]}`);
    }
  }

  for (const [kind, , h] of leaves) if (Number(kind) !== LeafKind.PARAMS) byHash(h);

  // Re-derive every claim from its committed input.
  const committedRows: MarkRow[] = [];
  for (const [kind, subject, h] of leaves) {
    if (Number(kind) !== LeafKind.CLAIM) continue;
    const row = byHash(h) as MarkRow | null;
    if (!row) continue;
    const inputLeaf = leaves.find(([k, s]) => Number(k) === LeafKind.CA_SNAPSHOT && s === subjectOf(`markinput:${row.wrapper.toLowerCase()}`));
    const raw = inputLeaf ? byHash(inputLeaf[2]) : null;
    if (!raw) { failures.push(`claim for ${row.symbol} has no committed input`); continue; }
    let signal: SignalInput | undefined;
    if (hasSignal(p.method)) {
      const s = rederiveSignal(leaves, row, raw, Number(p.evaluatedAtMs), MARK_METHODS[p.method].minSignalClosureS!, byHash, failures);
      if (s === null) continue;
      signal = s;
    }
    const again = computeMark({
      wrapper: raw.wrapper,
      symbol: raw.symbol,
      lastPrintE18: BigInt(raw.lastPrintE18),
      midAtCutE18: BigInt(raw.midAtCutE18),
      midNowE18: BigInt(raw.midNowE18),
      closingVwapE18: raw.closingVwapE18 === null ? null : BigInt(raw.closingVwapE18),
      swapsDuringClosure: raw.swapsDuringClosure,
      ...(signal ? { signal } : {}),
    }, p.method);
    if (!again) { failures.push(`claim for ${row.symbol} re-derives to no mark at all`); continue; }
    const mine = jcs(toRow(row.wrapper, row.symbol, row.settleAfterS, again));
    if (mine !== jcs(row)) failures.push(`mark mismatch for ${row.symbol}: re-derived ${mine} vs committed ${jcs(row)}`);

    // The graded instant, re-derived rather than trusted.
    const venueLeaf = leaves.find(([k, s2]) => Number(k) === LeafKind.HTTP_EXCHANGE && s2 === subjectOf(`venue:${row.wrapper.toLowerCase()}`));
    if (venueLeaf) {
      const v = byHash(venueLeaf[2]) as VenueEvidence | null;
      if (v) {
        const predicted = nextCapReturnMs(v.limitsPerPeriod, { mic: v.mic, schedule: v.schedule } as ExchangeSchedule, v.cutAtMs);
        if (predicted === null) failures.push(`reopen for ${row.symbol} does not re-derive: the committed schedule never restores capacity`);
        else if (Math.floor(predicted / 1000) !== row.settleAfterS) {
          failures.push(`reopen mismatch for ${row.symbol}: schedule gives ${Math.floor(predicted / 1000)}, row settles after ${row.settleAfterS}`);
        }
      }
    }
    void subject;
    committedRows.push(row);
  }

  // The uncommitted top-level `marks` array is a convenience copy; it must equal the committed set.
  // Without this a bundle could display one mark and commit another, and still verify.
  const topCanon = (Array.isArray(bundle.marks) ? bundle.marks : []).map((m) => jcs(m)).sort();
  const committedCanon = committedRows.map((m) => jcs(m)).sort();
  if (JSON.stringify(topCanon) !== JSON.stringify(committedCanon)) {
    failures.push("top-level marks do not match the committed CLAIM leaves");
  }

  return { ok: failures.length === 0, root, failures };
}

/**
 * mark/2: read the signal back out of the committed bytes, exactly as the keeper did, and require it to
 * equal the committed input. Every signal leaf's bytes must also match the hashes recorded next to them.
 * @returns the re-derived signal (never the committed one), or null after recording a failure.
 */
function rederiveSignal(
  leaves: Leaf[], row: MarkRow, raw: Record<string, unknown>, evaluatedAtMs: number,
  minSignalClosureS: number, byHash: (h: string) => unknown, failures: string[],
): SignalInput | null {
  const w = row.wrapper.toLowerCase();
  const swapsLeaf = leaves.find(([k, s]) => Number(k) === LeafKind.FETCH_LOG && s === subjectOf(`swaps:${w}`));
  const swaps = swapsLeaf ? byHash(swapsLeaf[2]) as { cutAtMs?: unknown; settleAfterS?: unknown } | null : null;
  if (!swaps || !Number.isFinite(Number(swaps.cutAtMs)) || !Number.isFinite(Number(swaps.settleAfterS))) {
    failures.push(`claim for ${row.symbol} has no committed cut, so its signal cannot be re-derived`);
    return null;
  }
  const ev: SignalEvidenceBytes = {};
  for (const key of SIGNAL_KEYS) {
    const leaf = leaves.find(([k, s]) => Number(k) === LeafKind.HTTP_EXCHANGE && s === subjectOf(`signal:${w}:${key}`));
    if (!leaf) continue;
    const x = byHash(leaf[2]) as { key?: unknown; url?: unknown; body?: unknown; bodyHash?: unknown; sha256?: unknown } | null;
    if (!x) continue;
    if (x.key !== key || typeof x.url !== "string" || typeof x.body !== "string") {
      failures.push(`signal leaf ${key} for ${row.symbol} is malformed`);
      continue;
    }
    const bytes = toUtf8Bytes(x.body);
    if (hashBytes(bytes) !== x.bodyHash || sha256(bytes).slice(2) !== x.sha256) {
      failures.push(`signal bytes ${key} for ${row.symbol} do not match their recorded keccak256/sha256`);
      continue;
    }
    ev[key] = { url: x.url, body: x.body };
  }
  const again = deriveSignal(
    { symbol: String(raw.symbol), cutAtMs: Number(swaps.cutAtMs), commitAtMs: evaluatedAtMs, settleAfterS: Number(swaps.settleAfterS) },
    ev, minSignalClosureS,
  );
  if (jcs(again) !== jcs(raw.signal ?? null)) {
    failures.push(`signal for ${row.symbol} does not re-derive from the committed bytes: re-derived ${jcs(again)} vs committed ${jcs(raw.signal ?? null)}`);
  }
  return again;
}
