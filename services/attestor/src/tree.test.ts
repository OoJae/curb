import { test } from "node:test";
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import {
  buildTree, loadTree, jcs, hashJson, hashBytes, subjectOf, subjectOfAddress, LeafKind, LEAF_ENCODING,
} from "./tree.ts";
import type { Leaf } from "./tree.ts";

const W_TCENT = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";

// Seven leaves on purpose: an odd, non-power-of-two count is where hand-rolled Merkle trees and
// the OpenZeppelin construction disagree. The root below must match the library used directly.
function vectorLeaves(): Leaf[] {
  const body = new TextEncoder().encode('{"trading":{"currentPeriod":"closed"}}');
  return [
    [LeafKind.PARAMS, subjectOf("params"), hashJson({ method: "curb.marketclock/1", evaluatedAtMs: 1789358400000 })],
    [LeafKind.HTTP_EXCHANGE, subjectOf("https://api.xstocks.fi/api/v2/public/assets/TCENTx?network=XLayer"), hashBytes(body)],
    [LeafKind.HTTP_EXCHANGE, subjectOf("https://api.xstocks.fi/api/v2/public/exchanges/XHKG"), hashJson({ mic: "XHKG" })],
    [LeafKind.CHAIN_CALL, subjectOf("getCurrentMultiplier@0xfa15"), hashJson({ block: 70545887, ret: "0x" })],
    [LeafKind.REGISTRY, subjectOf("registry"), hashJson({ count: 6 })],
    [LeafKind.FETCH_LOG, subjectOf("fetchlog"), hashJson([])],
    [LeafKind.CLAIM, subjectOfAddress(W_TCENT), hashJson({ regime: 1, capUsd: "0" })],
  ];
}

test("JCS canonicalizes key order and number formatting", () => {
  assert.equal(jcs({ b: 1, a: [2, { d: 1.0, c: "x" }] }), '{"a":[2,{"c":"x","d":1}],"b":1}');
  assert.equal(hashJson({ b: 1, a: 2 }), hashJson({ a: 2, b: 1 }));
});

test("root equals the unmodified OpenZeppelin library on an odd leaf count", () => {
  const leaves = vectorLeaves();
  const ours = buildTree(leaves).root;
  const theirs = StandardMerkleTree.of(leaves, [...LEAF_ENCODING]).root;
  assert.equal(ours, theirs);
  assert.equal(leaves.length % 2, 1);
});

test("root is independent of the order inputs were collected in", () => {
  const leaves = vectorLeaves();
  const shuffled = [leaves[6], leaves[2], leaves[0], leaves[5], leaves[1], leaves[4], leaves[3]];
  assert.equal(buildTree(leaves).root, buildTree(shuffled).root);
});

test("a single wrapper's claim is disputable with one proof", () => {
  const leaves = vectorLeaves();
  const { root, tree } = buildTree(leaves);
  const claim = leaves[6];
  const proof = tree.getProof(claim);
  assert.equal(StandardMerkleTree.verify(root, [...LEAF_ENCODING], claim, proof), true);
  const forged: Leaf = [LeafKind.CLAIM, claim[1], hashJson({ regime: 4, capUsd: "10000000" })];
  assert.equal(StandardMerkleTree.verify(root, [...LEAF_ENCODING], forged, proof), false);
});

test("a verifier rebuilding from the published dump gets the same root", () => {
  const { root, tree } = buildTree(vectorLeaves());
  const reloaded = loadTree(JSON.parse(JSON.stringify(tree.dump())));
  assert.equal(reloaded.root, root);
});

test("changing one byte of one HTTP body changes the root", () => {
  const leaves = vectorLeaves();
  const tampered = [...leaves];
  tampered[1] = [LeafKind.HTTP_EXCHANGE, leaves[1][1], hashBytes(new TextEncoder().encode('{"trading":{"currentPeriod":"market"}}'))];
  assert.notEqual(buildTree(leaves).root, buildTree(tampered).root);
});

test("duplicate leaves are rejected rather than silently collapsed", () => {
  const leaves = vectorLeaves();
  assert.throws(() => buildTree([...leaves, leaves[0]]), /duplicate leaf/);
});

test("address subjects are checksum-insensitive and readable in a proof", () => {
  assert.equal(subjectOfAddress(W_TCENT.toLowerCase()), subjectOfAddress(W_TCENT));
  assert.ok(subjectOfAddress(W_TCENT).toLowerCase().endsWith(W_TCENT.slice(2).toLowerCase()));
});
