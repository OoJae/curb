/**
 * The evidence for one committed mark.
 *
 * `Scorecard.Commitment` carries an `inputRoot`, and that root is the entire reason a mark is worth
 * anything: it lets a stranger take the published bundle, re-run `computeMark`, and get the same
 * number Curb put on chain -- or catch it not matching. Same shape as the attestor's round bundle,
 * so one verifier idea covers both: every leaf's preimage is published, the root is rebuilt from the
 * leaves, and the claims are re-derived from the committed inputs rather than trusted.
 */
import { hashJson, subjectOf, subjectOfAddress, buildTree, loadTree, jcs, LeafKind } from "./tree.ts";
import type { Leaf } from "./tree.ts";
import { computeMark, MARK_METHODS, MARK_METHOD_VERSION } from "./mark.ts";
import type { ClosureInput, Mark } from "./mark.ts";
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
});

export function buildMarkRound(r: MarkInputs): BuiltMarkRound {
  const leaves: Leaf[] = [];
  const json: Record<string, string> = {};
  const addJson = (kind: Leaf[0], subject: string, value: unknown) => {
    const h = hashJson(value);
    json[h] = jcs(value);
    leaves.push([kind, subject, h]);
  };

  const method = MARK_METHODS[MARK_METHOD_VERSION];
  addJson(LeafKind.PARAMS, subjectOf("params"), {
    method: MARK_METHOD_VERSION,
    lambdaBps: method.lambdaBps,
    bandFloorBps: method.bandFloorBps,
    bandCapBps: method.bandCapBps,
    closingVwapWindowMs: method.closingVwapWindowMs,
    chainId: r.chainId,
    clock: r.clock,
    scorecard: r.scorecard,
    evaluatedAtMs: r.evaluatedAtMs,
    codeDigest: r.codeDigest,
  });

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
    addJson(LeafKind.CA_SNAPSHOT, subjectOf(`markinput:${c.wrapper.toLowerCase()}`), inputJson(c.input));
    if (c.venue) addJson(LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${c.wrapper.toLowerCase()}`), c.venue);

    const m = computeMark(c.input, MARK_METHOD_VERSION);
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
    const again = computeMark({
      wrapper: raw.wrapper,
      symbol: raw.symbol,
      lastPrintE18: BigInt(raw.lastPrintE18),
      midAtCutE18: BigInt(raw.midAtCutE18),
      midNowE18: BigInt(raw.midNowE18),
      closingVwapE18: raw.closingVwapE18 === null ? null : BigInt(raw.closingVwapE18),
      swapsDuringClosure: raw.swapsDuringClosure,
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
