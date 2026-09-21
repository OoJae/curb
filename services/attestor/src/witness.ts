/**
 * Witnessing: a second host's signed, independent check of every MarketClock write.
 *
 * MarketClock accepts a round from any single registered attestor. This module is what makes a round
 * more than one host's word. For each onchain `attestBatch`, the witness:
 *
 *   1. fetches the round's evidence bundle by the inputRoot in the calldata;
 *   2. re-derives it offline (leaf hashes, root, derive() under the committed method);
 *   3. checks that what was WRITTEN equals what was COMMITTED. The calldata must equal the committed
 *      CLAIM leaves exactly, in order, and the chain read must predate the write. Offline
 *      verification alone checks only that a bundle is internally consistent. It cannot see a host
 *      that commits one thing and writes another.
 *   4. compares the committed claims with its OWN independent reading of the issuer, taken from a
 *      different provider, region and CDN edge at about the same time;
 *   5. signs the result as EIP-712 typed data, whether it passed or failed.
 *
 * The signature does not change what MarketClock stores (the contract is immutable and single-signer).
 * It is a public, attributable statement that a second party checked the write, so a round with no
 * matching witness, or a witness that says `reproduced: false`, is visible to anyone.
 */
import { keccak256, verifyTypedData, getAddress } from "ethers";
import type { Wallet, HDNodeWallet } from "ethers";
import { clockAbi } from "./sources/chain.ts";
import type { TxInfo } from "./sources/chain.ts";
import { verifyBundleOffline } from "./verify/offline.ts";
import { loadTree, LeafKind, subjectOf } from "./tree.ts";
import type { Leaf } from "./tree.ts";
import type { Bundle } from "./round.ts";

export const WITNESS_SCHEMA = "curb.marketclock.witness/1";

export const WITNESS_TYPES = {
  RoundWitness: [
    { name: "inputRoot", type: "bytes32" },
    { name: "txHash", type: "bytes32" },
    { name: "blockNumber", type: "uint64" },
    { name: "writtenAt", type: "uint64" },
    { name: "attestor", type: "address" },
    { name: "calldataHash", type: "bytes32" },
    { name: "method", type: "string" },
    { name: "evaluatedAtMs", type: "uint64" },
    { name: "reproduced", type: "bool" },
    { name: "labelsConsistent", type: "bool" },
    { name: "observation", type: "uint8" },
    { name: "checkedAt", type: "uint64" },
  ],
};

/**
 * Freshness bounds, in two tiers. A round that re-derives perfectly can still lie about time: old inputs
 * replayed get stamped with a new block.timestamp. But an honest host can also write late. A timed-out
 * transaction can still mine after STUCK_MS (120s) plus a replacement tick, so lateness alone must not
 * turn an honest round into a signed "not reproduced".
 *   - Beyond the honest worst case (LATE_*) the round is reproduced but carries a warning.
 *   - Beyond the replay bound (REPLAY_*) it is not reproduced. 30 minutes is also MarketClock's own
 *     fail-closed age: inputs that old describe a state the contract would already call UNKNOWN.
 */
export const LATE_EVAL_TO_WRITE_MS = 240_000;
export const REPLAY_EVAL_TO_WRITE_MS = 30 * 60_000;
export const LATE_READ_TO_WRITE_BLOCKS = 240;
export const REPLAY_READ_TO_WRITE_BLOCKS = 1_800;
export const LATE_EVAL_AFTER_WRITE_MS = 5_000;
export const REPLAY_EVAL_AFTER_WRITE_MS = 60_000;

/**
 * The blocks in which each derivation method may legitimately appear. A method retired by a fix must not be
 * accepted afterwards, or a replay of the old rules would pass. derive/1 ran from the first write until
 * the derive/2 deploy (DECISIONS D-7): its last round is block 70,619,011 and the first derive/2 round is
 * 70,619,137.
 */
export const METHOD_BLOCKS: Record<string, { fromBlock: number; toBlock: number }> = {
  "curb.marketclock.derive/1": { fromBlock: 0, toBlock: 70_619_136 },
  // derive/2 ran until the derive/3 cutover at block 71,173,967; a later round carrying it is a rollback.
  "curb.marketclock.derive/2": { fromBlock: 70_619_012, toBlock: 71_173_966 },
  // derive/3 went live 20 Sep 2026 22:26Z, block 71,173,967 (tx 0x20dd8be0…).
  "curb.marketclock.derive/3": { fromBlock: 71_173_967, toBlock: Number.MAX_SAFE_INTEGER },
};

/** How the witness's own, independent reading compared with the committed claims. */
export const Observation = { NO_SAMPLE: 0, AGREE: 1, DISAGREE: 2 } as const;
export type Observation = (typeof Observation)[keyof typeof Observation];

export function witnessDomain(chainId: number, clock: string) {
  return { name: "Curb MarketClock Witness", version: "1", chainId, verifyingContract: getAddress(clock) };
}

export interface CommittedClaim {
  wrapper: string;
  symbol: string;
  regime: number;
  capUsd: string;
  nextAt: number;
  halted: boolean;
}

export interface RoundCheck {
  /** Root, leaves, derive() and calldata all agree. The one bit that matters. */
  reproduced: boolean;
  /** Uncommitted convenience fields (top-level kind, claims copy) agree with the committed leaves. */
  labelsConsistent: boolean;
  method: string;
  evaluatedAtMs: number | null;
  failures: string[];
  labelFailures: string[];
  /** Non-fatal: e.g. an honest but late write. */
  warnings: string[];
  claims: CommittedClaim[];
}

const sortByWrapper = <T extends { wrapper: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.wrapper.toLowerCase().localeCompare(b.wrapper.toLowerCase()));

/** A bundle fetched over HTTP is untrusted input: check its shape before anything reads it. */
export function isBundleShaped(b: unknown): b is Bundle {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  return typeof x.inputRoot === "string" && /^0x[0-9a-fA-F]{64}$/.test(x.inputRoot)
    && !!x.tree && typeof x.tree === "object"
    && !!x.json && typeof x.json === "object"
    && !!x.blobs && typeof x.blobs === "object";
}

/**
 * Check one onchain write against its bundle. Pure: no network, no clock. Total: never throws, because
 * a malformed bundle must become a signed "not reproduced", not a stuck witness queue.
 * @param writtenAtS the write's block timestamp
 */
export function checkRound(bundle: unknown, tx: TxInfo, chainId: number, clock: string, writtenAtS: number): RoundCheck {
  try {
    return checkRoundUnsafe(bundle, tx, chainId, clock, writtenAtS);
  } catch (e) {
    return {
      reproduced: false, labelsConsistent: false, method: "", evaluatedAtMs: null, labelFailures: [], warnings: [], claims: [],
      failures: [`bundle check threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

function checkRoundUnsafe(rawBundle: unknown, tx: TxInfo, chainId: number, clock: string, writtenAtS: number): RoundCheck {
  const failures: string[] = [];
  const labelFailures: string[] = [];
  const warnings: string[] = [];
  let method = "";
  let evaluatedAtMs: number | null = null;
  let claims: CommittedClaim[] = [];
  if (!isBundleShaped(rawBundle)) {
    return { reproduced: false, labelsConsistent: false, method, evaluatedAtMs, failures: ["bundle is malformed"], labelFailures, warnings, claims };
  }
  const bundle = rawBundle;

  if (!tx.to || tx.to.toLowerCase() !== clock.toLowerCase()) failures.push(`tx.to ${tx.to} is not MarketClock ${clock}`);

  let args: ReturnType<typeof clockAbi.decodeFunctionData> | null = null;
  try {
    args = clockAbi.decodeFunctionData("attestBatch", tx.input);
  } catch {
    failures.push("calldata is not attestBatch");
  }
  const calldataRoot = args ? String(args[5]).toLowerCase() : "";
  if (args && calldataRoot !== String(bundle.inputRoot).toLowerCase()) {
    failures.push(`calldata inputRoot ${calldataRoot} != bundle inputRoot ${bundle.inputRoot}`);
  }

  const offline = verifyBundleOffline(bundle);
  for (const f of offline.failures) {
    // Only leaves are covered by the root. The top-level copies are conveniences; a mismatch there
    // is a labelling defect, not a wrong write, and is reported separately.
    if (f.startsWith("top-level")) labelFailures.push(f);
    else failures.push(f);
  }

  let leaves: Leaf[] = [];
  try {
    leaves = [...loadTree(bundle.tree as never).entries()].map(([, v]) => v as Leaf);
  } catch {
    /* already reported by verifyBundleOffline */
  }
  const json = (h: string): Record<string, unknown> | null => {
    const s = bundle.json[h];
    if (typeof s !== "string") { failures.push(`missing preimage ${h}`); return null; }
    try { return JSON.parse(s); } catch { failures.push(`unparseable preimage ${h}`); return null; }
  };
  const paramsLeaf = leaves.find(([k, s]) => Number(k) === LeafKind.PARAMS && s === subjectOf("params"));
  const p = paramsLeaf ? json(paramsLeaf[2]) : null;
  if (p) {
    method = String(p.method);
    evaluatedAtMs = Number(p.evaluatedAtMs);
    if (Number(p.chainId) !== chainId) failures.push(`PARAMS.chainId ${p.chainId} != ${chainId}`);
    if (String(p.clock).toLowerCase() !== clock.toLowerCase()) failures.push(`PARAMS.clock ${p.clock} != ${clock}`);
    const range = METHOD_BLOCKS[method];
    if (!range) failures.push(`method ${method} has no accepted block range`);
    else if (tx.blockNumber < range.fromBlock || tx.blockNumber > range.toBlock) {
      failures.push(`method ${method} is not valid at block ${tx.blockNumber} (accepted ${range.fromBlock}..${range.toBlock})`);
    }
    if (!Number.isFinite(evaluatedAtMs)) failures.push("PARAMS.evaluatedAtMs is not a number");
    else {
      const lagMs = writtenAtS * 1000 - evaluatedAtMs;
      const lag = `evaluated ${Math.round(lagMs / 1000)}s before the write`;
      if (lagMs > REPLAY_EVAL_TO_WRITE_MS) failures.push(`${lag} (replay bound ${REPLAY_EVAL_TO_WRITE_MS / 1000}s): stale or replayed inputs`);
      else if (lagMs > LATE_EVAL_TO_WRITE_MS) warnings.push(`late write: ${lag}`);
      const ahead = `evaluatedAtMs is ${Math.round(-lagMs / 1000)}s AFTER the write's block timestamp`;
      if (-lagMs > REPLAY_EVAL_AFTER_WRITE_MS) failures.push(ahead);
      else if (-lagMs > LATE_EVAL_AFTER_WRITE_MS) warnings.push(ahead);
    }
  } else {
    failures.push("bundle has no PARAMS leaf");
  }

  // The chain read a round commits to must come from a block shortly before the write itself.
  const chainLeaf = leaves.find(([k]) => Number(k) === LeafKind.CHAIN_CALL);
  const chainCall = chainLeaf ? json(chainLeaf[2]) : null;
  if (chainCall) {
    const readBlock = Number((chainCall.block as { number?: unknown } | undefined)?.number);
    if (!(readBlock < tx.blockNumber)) failures.push(`chain read at block ${readBlock} does not precede write at ${tx.blockNumber}`);
    else if (tx.blockNumber - readBlock > REPLAY_READ_TO_WRITE_BLOCKS) failures.push(`chain read at block ${readBlock} is ${tx.blockNumber - readBlock} blocks before the write`);
    else if (tx.blockNumber - readBlock > LATE_READ_TO_WRITE_BLOCKS) warnings.push(`late write: chain read ${tx.blockNumber - readBlock} blocks before the write`);
  } else {
    failures.push("bundle has no CHAIN_CALL leaf");
  }

  claims = sortByWrapper(
    leaves.filter(([k]) => Number(k) === LeafKind.CLAIM).map(([, , h]) => json(h)).filter((c): c is Record<string, unknown> => c !== null) as unknown as CommittedClaim[],
  );
  const seen = new Set<string>();
  for (const c of claims) {
    const w = String(c.wrapper).toLowerCase();
    if (seen.has(w)) failures.push(`duplicate CLAIM leaves for ${w}`);
    seen.add(w);
  }

  // What was written must be exactly what was committed, element by element and in order.
  if (args) {
    const [wrappers, regimes, caps, nextAt, halted] = [args[0], args[1], args[2], args[3], args[4]] as unknown as [string[], bigint[], bigint[], bigint[], boolean[]];
    if (wrappers.length !== claims.length) {
      failures.push(`calldata writes ${wrappers.length} assets, bundle commits ${claims.length}`);
    } else {
      claims.forEach((c, i) => {
        const wrote = `${String(wrappers[i]).toLowerCase()} ${Number(regimes[i])} ${BigInt(caps[i])} ${BigInt(nextAt[i])} ${Boolean(halted[i])}`;
        const committed = `${c.wrapper.toLowerCase()} ${c.regime} ${BigInt(c.capUsd)} ${BigInt(c.nextAt)} ${c.halted}`;
        if (wrote !== committed) failures.push(`calldata[${i}] "${wrote}" != committed "${committed}"`);
      });
    }
  }

  return { reproduced: failures.length === 0, labelsConsistent: labelFailures.length === 0, method, evaluatedAtMs, failures, labelFailures, warnings, claims };
}

export interface Sample {
  evaluatedAtMs: number;
  claims: { wrapper: string; regime: number; capUsd: bigint; halted: boolean }[];
}

/**
 * Compare committed claims with the witness's own reading nearest in time.
 * Differences within a few minutes of a boundary are expected, because CDN edges see issuer flips up
 * to ~30s apart (DECISIONS D-4 Finding 2). The caller decides whether a disagreement is alarming.
 */
export function compareObservation(
  committed: CommittedClaim[],
  evaluatedAtMs: number | null,
  samples: Sample[],
  maxSkewMs = 45_000,
): { observation: Observation; sampleAtMs: number | null; detail: string[] } {
  if (evaluatedAtMs === null || samples.length === 0) return { observation: Observation.NO_SAMPLE, sampleAtMs: null, detail: [] };
  const nearest = samples.reduce((best, s) =>
    Math.abs(s.evaluatedAtMs - evaluatedAtMs) < Math.abs(best.evaluatedAtMs - evaluatedAtMs) ? s : best,
  );
  if (Math.abs(nearest.evaluatedAtMs - evaluatedAtMs) > maxSkewMs) return { observation: Observation.NO_SAMPLE, sampleAtMs: null, detail: [] };
  const detail: string[] = [];
  for (const c of committed) {
    const mine = nearest.claims.find((m) => m.wrapper.toLowerCase() === c.wrapper.toLowerCase());
    if (!mine) { detail.push(`${c.symbol}: no own reading`); continue; }
    if (mine.regime !== c.regime || mine.capUsd !== BigInt(c.capUsd) || mine.halted !== c.halted) {
      detail.push(`${c.symbol}: committed ${c.regime}/${c.capUsd} witness ${mine.regime}/${mine.capUsd}`);
    }
  }
  return { observation: detail.length ? Observation.DISAGREE : Observation.AGREE, sampleAtMs: nearest.evaluatedAtMs, detail };
}

export interface WitnessDoc {
  schema: typeof WITNESS_SCHEMA;
  domain: ReturnType<typeof witnessDomain>;
  primaryType: "RoundWitness";
  types: typeof WITNESS_TYPES;
  message: {
    inputRoot: string;
    txHash: string;
    blockNumber: number;
    writtenAt: number;
    attestor: string;
    calldataHash: string;
    method: string;
    evaluatedAtMs: number;
    reproduced: boolean;
    labelsConsistent: boolean;
    observation: number;
    checkedAt: number;
  };
  signer: string;
  signature: string;
  /** Unsigned diagnostics. The signed message is authoritative. */
  notes: { failures: string[]; labelFailures: string[]; warnings: string[]; observationDetail: string[]; sampleAtMs: number | null; hostId: string };
}

export async function signWitness(
  wallet: Wallet | HDNodeWallet,
  a: {
    chainId: number; clock: string; tx: TxInfo; writtenAtS: number; inputRoot: string;
    check: Pick<RoundCheck, "reproduced" | "labelsConsistent" | "method" | "evaluatedAtMs" | "failures" | "labelFailures" | "warnings">;
    observation: ReturnType<typeof compareObservation>; checkedAtS: number; hostId: string;
  },
): Promise<WitnessDoc> {
  const domain = witnessDomain(a.chainId, a.clock);
  const evaluatedAtMs = a.check.evaluatedAtMs;
  const message = {
    inputRoot: a.inputRoot.toLowerCase(),
    txHash: a.tx.hash.toLowerCase(),
    blockNumber: a.tx.blockNumber,
    writtenAt: a.writtenAtS,
    attestor: getAddress(a.tx.from),
    calldataHash: keccak256(a.tx.input),
    method: a.check.method,
    evaluatedAtMs: evaluatedAtMs !== null && Number.isSafeInteger(evaluatedAtMs) && evaluatedAtMs >= 0 ? evaluatedAtMs : 0,
    reproduced: a.check.reproduced,
    labelsConsistent: a.check.labelsConsistent,
    observation: a.observation.observation,
    checkedAt: a.checkedAtS,
  };
  const signature = await wallet.signTypedData(domain, WITNESS_TYPES, message);
  return {
    schema: WITNESS_SCHEMA, domain, primaryType: "RoundWitness", types: WITNESS_TYPES, message,
    signer: getAddress(wallet.address), signature,
    notes: { failures: a.check.failures, labelFailures: a.check.labelFailures, warnings: a.check.warnings, observationDetail: a.observation.detail, sampleAtMs: a.observation.sampleAtMs, hostId: a.hostId },
  };
}

/** Recover the signer of a witness document and check it matches the claimed signer. */
export function verifyWitness(doc: WitnessDoc): { ok: boolean; recovered: string } {
  const recovered = verifyTypedData(doc.domain, WITNESS_TYPES, doc.message, doc.signature);
  return { ok: recovered.toLowerCase() === doc.signer.toLowerCase(), recovered };
}
