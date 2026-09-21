/**
 * One attestation round: gather inputs, derive claims, commit everything to an inputRoot.
 *
 * The bundle produced here is the public evidence for one MarketClock write. It contains every
 * preimage needed to rebuild the root and to re-run derive() without touching the network, except
 * the chain reads, which are pinned by block hash and can be re-queried from any archive RPC.
 *
 * Reconstruction contract (what a verifier needs, and where it is in the bundle):
 *   evaluatedAtMs, method       -> PARAMS leaf
 *   asset and schedule bodies   -> HTTP_EXCHANGE leaves, bytes in `blobs`
 *   fetchedAtMs per body        -> FETCH_LOG leaf
 *   wrapper -> symbol, mic      -> REGISTRY leaf
 *   nonce / multiplier reads    -> CHAIN_CALL leaf, re-queryable at `block.hash`
 *   what was written            -> one CLAIM leaf per wrapper
 */
import { hashBytes, hashJson, subjectOf, subjectOfAddress, buildTree, jcs, LeafKind } from "./tree.ts";
import type { Leaf } from "./tree.ts";
import { deriveDetailed, METHODS, METHOD_VERSION, LAST_KNOWN_GOOD_MS } from "./derive.ts";
import type { Claim, PriorObservation } from "./derive.ts";
import type { Exchange, FetchLogEntry } from "./sources/xstocks.ts";
import type { MulticallSnapshot } from "./sources/chain.ts";

export const BUNDLE_SCHEMA = "curb.marketclock.bundle/1";

export type RoundKind = "heartbeat" | "venue-close" | "transition" | "activation" | "diff";

export interface CohortEntry {
  wrapper: string;
  raw: string;
  symbol: string;
  mic: string;
}

export interface RoundInputs {
  chainId: number;
  clock: string;
  kind: RoundKind;
  /** The boundary this round targets, unix ms; equals evaluatedAtMs for heartbeats. */
  targetMs: number;
  evaluatedAtMs: number;
  codeDigest: string;
  cohort: CohortEntry[];
  assetExchanges: Map<string, Exchange>;     // symbol -> exchange
  scheduleExchanges: Map<string, Exchange>;  // mic -> exchange
  fetchLog: FetchLogEntry[];
  chain: MulticallSnapshot;
  /** The previous tick's observation. derive/3 needs it to confirm a reopen; it is committed as a leaf. */
  prior?: PriorObservation | null;
}

export interface Round {
  root: string;
  claims: Claim[];
  bundle: Bundle;
  /** This round's raw observation; pass it as `prior` to the next round. */
  observed: PriorObservation;
}

export interface Bundle {
  schema: string;
  chainId: number;
  clock: string;
  kind: RoundKind;
  targetMs: number;
  evaluatedAtMs: number;
  inputRoot: string;
  tree: unknown;
  /** contentHash -> canonical JSON string, for every JSON leaf. */
  json: Record<string, string>;
  /** contentHash -> base64 of the exact HTTP body bytes. */
  blobs: Record<string, string>;
  claims: Array<Omit<Claim, "capUsd"> & { capUsd: string }>;
}

const toClaimJson = (c: Claim) => ({ ...c, capUsd: c.capUsd.toString() });

export function buildRound(r: RoundInputs): Round {
  const leaves: Leaf[] = [];
  const json: Record<string, string> = {};
  const blobs: Record<string, string> = {};

  const addJson = (kind: Leaf[0], subject: string, value: unknown) => {
    const h = hashJson(value);
    json[h] = jcs(value);
    leaves.push([kind, subject, h]);
  };
  const addBlob = (subject: string, bytes: Uint8Array) => {
    const h = hashBytes(bytes);
    blobs[h] = Buffer.from(bytes).toString("base64");
    leaves.push([LeafKind.HTTP_EXCHANGE, subject, h]);
  };

  addJson(LeafKind.PARAMS, subjectOf("params"), {
    method: METHOD_VERSION,
    lastKnownGoodMs: LAST_KNOWN_GOOD_MS,
    chainId: r.chainId,
    clock: r.clock,
    kind: r.kind,
    targetMs: r.targetMs,
    evaluatedAtMs: r.evaluatedAtMs,
    codeDigest: r.codeDigest,
  });

  addJson(LeafKind.REGISTRY, subjectOf("registry"), {
    wrappers: [...r.cohort]
      .sort((a, b) => a.wrapper.toLowerCase().localeCompare(b.wrapper.toLowerCase()))
      .map((c) => ({ wrapper: c.wrapper, raw: c.raw, symbol: c.symbol, mic: c.mic })),
  });

  for (const [, ex] of r.scheduleExchanges) if (ex.body) addBlob(subjectOf(ex.url), ex.body);
  for (const [, ex] of r.assetExchanges) if (ex.body) addBlob(subjectOf(ex.url), ex.body);

  addJson(LeafKind.FETCH_LOG, subjectOf("fetchlog"), r.fetchLog);

  // Under a method that confirms reopens, the prior observation is an INPUT to the claims, so it is
  // committed like any other input. `null` (no usable prior) is itself committed, so a verifier can tell
  // "there was no prior" apart from "a prior was withheld".
  if (METHODS[METHOD_VERSION].confirmBeforeOpen) {
    addJson(LeafKind.PRIOR, subjectOf("prior"), r.prior ?? null);
  }

  addJson(LeafKind.CHAIN_CALL, subjectOf(`multicall@${r.chain.block.hash}`), {
    block: { number: r.chain.block.number, hash: r.chain.block.hash, timestamp: r.chain.block.timestamp },
    calls: r.chain.results.map((c) => ({
      label: c.label, target: c.target, callData: c.callData, success: c.success, returnData: c.returnData,
    })),
  });

  const schedules: Record<string, Uint8Array | null> = {};
  for (const [mic, ex] of r.scheduleExchanges) schedules[mic] = ex.body;

  const { claims, observed } = deriveDetailed({
    evaluatedAtMs: r.evaluatedAtMs,
    schedules,
    prior: r.prior ?? null,
    assets: r.cohort.map((c) => {
      const ex = r.assetExchanges.get(c.symbol);
      return { wrapper: c.wrapper, symbol: c.symbol, mic: c.mic, body: ex?.body ?? null, fetchedAtMs: ex?.ok ? ex.respEndMs : null };
    }),
  }, METHOD_VERSION); // the same id committed in PARAMS above, so the two can never diverge

  for (const c of claims) addJson(LeafKind.CLAIM, subjectOfAddress(c.wrapper), toClaimJson(c));

  const { root, tree } = buildTree(leaves);
  return {
    root,
    claims,
    observed,
    bundle: {
      schema: BUNDLE_SCHEMA,
      chainId: r.chainId,
      clock: r.clock,
      kind: r.kind,
      targetMs: r.targetMs,
      evaluatedAtMs: r.evaluatedAtMs,
      inputRoot: root,
      tree: tree.dump(),
      json,
      blobs,
      claims: claims.map(toClaimJson),
    },
  };
}
