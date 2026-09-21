/**
 * Check one Scorecard row against its published bundle.
 *
 * `verifyMarkBundleOffline` answers "is this bundle internally consistent?". It cannot see a keeper
 * that publishes one thing and commits another, because it never looks at the chain. This does, and
 * it is the mark-bundle analogue of the attestor's `checkRound`.
 *
 * Pure: no network, no clock. Total: never throws, because a malformed bundle must become a reported
 * "not reproduced", never a crash in whatever is calling this.
 */
import { LeafKind, loadTree, subjectOf } from "./tree.ts";
import type { Leaf } from "./tree.ts";
import { MARK_BUNDLE_SCHEMA, isMarkBundleShaped, verifyMarkBundleOffline } from "./markRound.ts";
import type { MarkBundle, MarkRow } from "./markRound.ts";
import { MARK_METHODS } from "./mark.ts";
import { closureId, decodeCommitCalldata, methodDigestOf } from "./sources/scorecard.ts";
import type { CommittedRow } from "./sources/scorecard.ts";
import type { TxInfo } from "./sources/chain.ts";

/**
 * A method is only valid for rows committed while it was the live method.
 * Scorecard v2 was deployed at block 71,231,806; a row claiming to predate its own contract is not
 * a row. Mirrors the attestor's METHOD_BLOCKS, which exists so a replay of retired rules cannot pass.
 */
export const MARK_METHOD_BLOCKS: Record<string, { fromBlock: number; toBlock: number }> = {
  "curb.scorecard.mark/1": { fromBlock: 71_231_806, toBlock: Number.MAX_SAFE_INTEGER },
};

/** Looser than the attestor's: the keeper ticks at 30s and commits on a 600s lead with a retry ladder. */
export const LATE_EVAL_TO_COMMIT_MS = 900_000;
export const REPLAY_EVAL_TO_COMMIT_MS = 3_600_000;
export const LATE_EVAL_AFTER_COMMIT_MS = 5_000;
export const REPLAY_EVAL_AFTER_COMMIT_MS = 60_000;
export const LATE_READ_TO_COMMIT_BLOCKS = 240;
export const REPLAY_READ_TO_COMMIT_BLOCKS = 1_800;

export interface SettlementInfo { settledAt: number; settledBlock: number; reopenPrint: string; settled: boolean }

export interface MarkCheck {
  reproduced: boolean;
  labelsConsistent: boolean;
  /** False when only the log was available, so the baselines could not be cross-checked. */
  baselinesChecked: boolean;
  method: string;
  evaluatedAtMs: number | null;
  /** Recomputed from (wrapper, settleAfter, inputRoot), never taken from an index. */
  closureId: string;
  failures: string[];
  labelFailures: string[];
  warnings: string[];
  rows: MarkRow[];
}

export function checkMarkRound(
  bundle: unknown,
  onchain: CommittedRow,
  tx: TxInfo | null,
  chainId: number,
  scorecard: string,
  committedAtS: number,
  settlement?: SettlementInfo,
): MarkCheck {
  const c: MarkCheck = {
    reproduced: false, labelsConsistent: false, baselinesChecked: false,
    method: "", evaluatedAtMs: null, closureId: "",
    failures: [], labelFailures: [], warnings: [], rows: [],
  };
  try { return checkMarkRoundUnsafe(c, bundle, onchain, tx, chainId, scorecard, committedAtS, settlement); }
  catch (e) {
    c.failures.push(`check threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    c.reproduced = false;
    return c;
  }
}

function checkMarkRoundUnsafe(
  c: MarkCheck, raw: unknown, onchain: CommittedRow, tx: TxInfo | null,
  chainId: number, scorecard: string, committedAtS: number, settlement?: SettlementInfo,
): MarkCheck {
  if (!isMarkBundleShaped(raw)) { c.failures.push("bundle is malformed"); return c; }
  const bundle = raw as MarkBundle;
  if (bundle.schema !== MARK_BUNDLE_SCHEMA) { c.failures.push(`bundle schema ${bundle.schema} is not ${MARK_BUNDLE_SCHEMA}`); return c; }

  if (String(bundle.inputRoot).toLowerCase() !== onchain.inputRoot.toLowerCase()) {
    c.failures.push(`bundle inputRoot ${bundle.inputRoot} is not the committed ${onchain.inputRoot}`);
    return c;
  }

  // The calldata carries the baselines the event does not. Cross-checking the two catches a log
  // attributed to a transaction that did not produce it.
  if (tx) {
    if (tx.to === null || tx.to.toLowerCase() !== scorecard.toLowerCase()) {
      c.failures.push(`transaction was sent to ${tx.to}, not to Scorecard ${scorecard}`);
    } else {
      const call = decodeCommitCalldata(tx.input);
      if (!call) c.failures.push("transaction calldata is not a Scorecard commit()");
      else {
        c.baselinesChecked = true;
        const disagree: string[] = [];
        if (call.wrapper !== onchain.wrapper) disagree.push(`wrapper ${call.wrapper} vs ${onchain.wrapper}`);
        if (call.settleAfter !== onchain.settleAfter) disagree.push(`settleAfter ${call.settleAfter} vs ${onchain.settleAfter}`);
        if (call.mark !== onchain.mark) disagree.push(`mark ${call.mark} vs ${onchain.mark}`);
        if (call.bandBps !== onchain.bandBps) disagree.push(`bandBps ${call.bandBps} vs ${onchain.bandBps}`);
        if (call.inputRoot !== onchain.inputRoot.toLowerCase()) disagree.push(`inputRoot ${call.inputRoot} vs ${onchain.inputRoot}`);
        if (call.methodDigest !== onchain.methodDigest.toLowerCase()) disagree.push(`methodDigest ${call.methodDigest} vs ${onchain.methodDigest}`);
        if (disagree.length) c.failures.push(`calldata disagrees with the event: ${disagree.join("; ")}`);
        onchain = { ...onchain, lastPrint: call.lastPrint, closingVwap: call.closingVwap, staleOracle: call.staleOracle };
      }
    }
  } else {
    c.warnings.push("no transaction supplied: the committed baselines could not be cross-checked");
  }

  // The id is a derived fact. Recomputing it stops a row being matched to the wrong closure.
  c.closureId = closureId(onchain.wrapper, onchain.settleAfter, onchain.inputRoot);
  if (c.closureId.toLowerCase() !== onchain.id.toLowerCase()) {
    c.failures.push(`closure id ${onchain.id} does not equal keccak256(wrapper, settleAfter, inputRoot) = ${c.closureId}`);
  }

  const offline = verifyMarkBundleOffline(bundle);
  for (const f of offline.failures) (f.startsWith("top-level ") ? c.labelFailures : c.failures).push(f);

  const leaves = leavesOf(bundle);
  const params = leafJson(bundle, leaves, LeafKind.PARAMS, subjectOf("params"));
  if (!params) { c.failures.push("bundle has no PARAMS leaf"); return finish(c); }
  c.method = String(params.method);
  c.evaluatedAtMs = Number(params.evaluatedAtMs);

  if (Number(params.chainId) !== chainId) c.failures.push(`committed chainId ${params.chainId} is not ${chainId}`);
  // Not in checkRound, and it matters more here: a bundle built against the retired Scorecard v1
  // must never validate a v2 row.
  if (String(params.scorecard).toLowerCase() !== scorecard.toLowerCase()) {
    c.failures.push(`committed scorecard ${params.scorecard} is not ${scorecard}`);
  }

  const range = MARK_METHODS[c.method] ? MARK_METHOD_BLOCKS[c.method] : undefined;
  if (!MARK_METHODS[c.method]) c.failures.push(`unknown mark method ${c.method}`);
  else if (!range) c.failures.push(`method ${c.method} has no committed block range`);
  else if (onchain.committedBlock < range.fromBlock || onchain.committedBlock > range.toBlock) {
    c.failures.push(`method ${c.method} is not valid at block ${onchain.committedBlock} (valid ${range.fromBlock}..${range.toBlock})`);
  }

  // The keeper computes this and nothing has ever verified it. It is the strongest binding between
  // the onchain row and the published method.
  const wantDigest = methodDigestOf(c.method);
  if (wantDigest.toLowerCase() !== onchain.methodDigest.toLowerCase()) {
    c.failures.push(`committed methodDigest ${onchain.methodDigest} is not keccak256("${c.method}") = ${wantDigest}`);
  }

  // Compare against the COMMITTED claim leaves, not the uncommitted `marks` array.
  const claims = leaves.filter(([k]) => Number(k) === LeafKind.CLAIM)
    .map(([, , h]) => JSON.parse(bundle.json[h]) as MarkRow);
  c.rows = claims;
  const mine = claims.filter((r) => r.wrapper.toLowerCase() === onchain.wrapper.toLowerCase());
  if (mine.length === 0) c.failures.push(`no committed claim for ${onchain.wrapper}`);
  else if (mine.length > 1) c.failures.push(`${mine.length} committed claims for ${onchain.wrapper}; expected exactly one`);
  else {
    const row = mine[0];
    if (row.settleAfterS !== onchain.settleAfter) c.failures.push(`claim settleAfter ${row.settleAfterS} is not the committed ${onchain.settleAfter}`);
    if (row.markE18 !== onchain.mark) c.failures.push(`claim mark ${row.markE18} is not the committed ${onchain.mark}`);
    if (row.bandBps !== onchain.bandBps) c.failures.push(`claim bandBps ${row.bandBps} is not the committed ${onchain.bandBps}`);
    if (c.baselinesChecked) {
      if (row.lastPrintE18 !== onchain.lastPrint) c.failures.push(`claim lastPrint ${row.lastPrintE18} is not the committed ${onchain.lastPrint}`);
      if (row.closingVwapE18 !== onchain.closingVwap) c.failures.push(`claim closingVwap ${row.closingVwapE18} is not the committed ${onchain.closingVwap}`);
      if (onchain.staleOracle !== "0") c.failures.push(`committed staleOracle is ${onchain.staleOracle}; nothing in the bundle can back a non-zero value`);
    }
  }

  // Freshness, two-tier.
  if (c.evaluatedAtMs !== null && Number.isFinite(c.evaluatedAtMs)) {
    const lag = committedAtS * 1000 - c.evaluatedAtMs;
    if (lag > REPLAY_EVAL_TO_COMMIT_MS) c.failures.push(`evidence was evaluated ${Math.round(lag / 1000)}s before the commit; a replay of stale evidence`);
    else if (lag > LATE_EVAL_TO_COMMIT_MS) c.warnings.push(`evidence evaluated ${Math.round(lag / 1000)}s before the commit`);
    if (-lag > REPLAY_EVAL_AFTER_COMMIT_MS) c.failures.push(`evidence claims to be evaluated ${Math.round(-lag / 1000)}s AFTER the commit`);
    else if (-lag > LATE_EVAL_AFTER_COMMIT_MS) c.warnings.push(`evidence timestamped ${Math.round(-lag / 1000)}s after the commit`);
  }

  // The chain read must precede the write. verifyMarkBundleOffline never looks at CHAIN_CALL.
  const chainLeaf = leaves.find(([k]) => Number(k) === LeafKind.CHAIN_CALL);
  if (chainLeaf) {
    const snap = JSON.parse(bundle.json[chainLeaf[2]]) as { block?: { number?: number } };
    const readBlock = Number(snap.block?.number);
    if (Number.isFinite(readBlock)) {
      const gap = onchain.committedBlock - readBlock;
      if (gap < 0) c.failures.push(`the pinned chain read is at block ${readBlock}, AFTER the commit at ${onchain.committedBlock}`);
      else if (gap > REPLAY_READ_TO_COMMIT_BLOCKS) c.failures.push(`the pinned chain read is ${gap} blocks before the commit`);
      else if (gap > LATE_READ_TO_COMMIT_BLOCKS) c.warnings.push(`the pinned chain read is ${gap} blocks before the commit`);
    }
  }

  // The anti-backfill invariant. `Scorecard.commit` does NOT enforce it -- it only requires that
  // primaryCapNow is zero -- so a row whose claimed grading instant had already passed at commit
  // time would be accepted by the contract and is only catchable here.
  if (committedAtS >= onchain.settleAfter) {
    c.failures.push(`committed at ${committedAtS}, at or after its own settleAfter ${onchain.settleAfter}: the mark did not precede the reopen it claims to predict`);
  }

  // The cut must precede the commit too.
  const swapsLeaf = leaves.find(([k, s]) => Number(k) === LeafKind.FETCH_LOG && s === subjectOf(`swaps:${onchain.wrapper.toLowerCase()}`));
  if (swapsLeaf) {
    const ev = JSON.parse(bundle.json[swapsLeaf[2]]) as { cutBlock?: number; cutAtMs?: number };
    if (Number.isFinite(Number(ev.cutBlock)) && Number(ev.cutBlock) >= onchain.committedBlock) {
      c.failures.push(`the closure's cut block ${ev.cutBlock} is not before the commit block ${onchain.committedBlock}`);
    }
  }

  if (settlement?.settled) {
    if (settlement.settledBlock <= onchain.committedBlock) {
      c.failures.push(`settled at block ${settlement.settledBlock}, not after the commit block ${onchain.committedBlock}`);
    }
    if (settlement.settledAt < onchain.settleAfter + 300) {
      c.failures.push(`settled at ${settlement.settledAt}, before settleAfter + SETTLE_DELAY (${onchain.settleAfter + 300})`);
    }
  }

  return finish(c);
}

function finish(c: MarkCheck): MarkCheck {
  c.reproduced = c.failures.length === 0;
  c.labelsConsistent = c.labelFailures.length === 0;
  return c;
}

function leavesOf(bundle: MarkBundle): Leaf[] {
  const tree = loadTree(bundle.tree as never);
  return [...tree.entries()].map(([, v]: [number, Leaf]) => v);
}

function leafJson(bundle: MarkBundle, leaves: Leaf[], kind: number, subject: string): Record<string, unknown> | null {
  const l = leaves.find(([k, s]) => Number(k) === kind && s === subject);
  if (!l) return null;
  const s = bundle.json[l[2]];
  return typeof s === "string" ? JSON.parse(s) : null;
}
