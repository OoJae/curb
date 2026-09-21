/**
 * The inputRoot: a Merkle commitment to every input one attestation round was derived from.
 *
 * MarketClock.attestBatch takes exactly one `inputRoot` per batch. Its job is to make each onchain
 * write falsifiable rather than trusted: anyone can fetch the published bundle, check every leaf
 * against its preimage, rebuild this root, and re-run the same pure derivation.
 *
 * Construction is the unmodified @openzeppelin/merkle-tree StandardMerkleTree (version pinned in
 * package.json), so a stranger using the library directly gets the same root. Leaves are sorted by
 * the library, which makes the root independent of the order inputs were collected in.
 *
 * Leaf encoding: (uint8 kind, bytes32 subject, bytes32 contentHash)
 *   kind         what the leaf is (see LeafKind)
 *   subject      keccak256 of a stable identifier: a URL, a wrapper address, a call signature
 *   contentHash  keccak256 of the exact bytes (HTTP bodies) or of the RFC 8785 canonical JSON
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toUtf8Bytes, getAddress, zeroPadValue } from "ethers";
import canonicalize from "canonicalize";

export const LeafKind = {
  PARAMS: 1,         // method version, evaluatedAt, code digest, tolerances
  HTTP_EXCHANGE: 2,  // one issuer API response: exact body bytes
  CHAIN_CALL: 3,     // one pinned onchain read: block, call, return data
  REGISTRY: 4,       // the registered wrapper set read from MarketClock at the pinned block
  CA_SNAPSHOT: 5,    // epoch root over corporate-action (eventId, version, recordHash)
  FETCH_LOG: 6,      // every fetch attempt, including failures, so gaps are visible
  CLAIM: 7,          // the derived per-wrapper output actually written onchain
  PRIOR: 8,          // the previous tick's raw observation, which derive/3 requires to confirm a reopen
} as const;
export type LeafKind = (typeof LeafKind)[keyof typeof LeafKind];

export const LEAF_ENCODING = ["uint8", "bytes32", "bytes32"] as const;

export type Leaf = [kind: LeafKind, subject: string, contentHash: string];

/** RFC 8785 JSON Canonicalization Scheme. Throws on values JCS cannot represent. */
export function jcs(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error("value is not JCS-representable");
  return out;
}

/** keccak256 over exact bytes. */
export function hashBytes(bytes: Uint8Array): string {
  return keccak256(bytes);
}

/** keccak256 over the canonical JSON of a value. */
export function hashJson(value: unknown): string {
  return keccak256(toUtf8Bytes(jcs(value)));
}

/** A subject from a free-form identifier such as a URL or a call signature. */
export function subjectOf(id: string): string {
  return keccak256(toUtf8Bytes(id));
}

/** A subject that IS an address: left-padded to bytes32 so it stays human-readable in a proof. */
export function subjectOfAddress(addr: string): string {
  return zeroPadValue(getAddress(addr), 32);
}

export interface BuiltTree {
  root: string;
  tree: StandardMerkleTree<Leaf>;
}

export function buildTree(leaves: Leaf[]): BuiltTree {
  if (leaves.length === 0) throw new Error("a round must commit to at least one leaf");
  const seen = new Set<string>();
  for (const l of leaves) {
    const key = l.join("|");
    if (seen.has(key)) throw new Error(`duplicate leaf ${key}`);
    seen.add(key);
  }
  const tree = StandardMerkleTree.of(leaves, [...LEAF_ENCODING]);
  return { root: tree.root, tree };
}

/** Rebuild a tree from its published dump, as a verifier would. */
export function loadTree(dump: ReturnType<StandardMerkleTree<Leaf>["dump"]>): StandardMerkleTree<Leaf> {
  return StandardMerkleTree.load(dump);
}
