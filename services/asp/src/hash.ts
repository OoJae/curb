/**
 * Content hashes: the digest half of services/keeper/src/tree.ts, copied.
 *
 * The keeper and attestor commit to issuer bytes and canonical JSON with these exact functions, so a
 * hash printed by this service is directly comparable with a hash inside a published mark bundle or an
 * attestation round. Only the digests are copied: the ASP publishes no Merkle root of its own, so the
 * tree (and its @openzeppelin/merkle-tree dependency) stays out of this package.
 */
import { createHash } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import canonicalize from "canonicalize";

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

/** sha256 over exact bytes, as 0x-prefixed hex so it concatenates like any other 32-byte word. */
export function sha256Hex(bytes: Uint8Array): string {
  return "0x" + createHash("sha256").update(bytes).digest("hex");
}
