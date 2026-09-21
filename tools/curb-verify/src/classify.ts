/**
 * What kind of document is this, and may this verb touch it?
 *
 * Curb publishes three document kinds that all carry an `inputRoot` and a Merkle tree, and two of
 * them use the SAME leaf kinds to mean different things -- `HTTP_EXCHANGE` is base64 body bytes in a
 * round bundle and a JSON venue record in a mark bundle. So classification is on the `schema` string
 * and nothing else. Structural sniffing would eventually guess wrong, and guessing wrong here means
 * running a verifier over a document it was not written for: `verifyBundleOffline` throws on a mark
 * bundle's absent `blobs`, and `verifyMarkBundleOffline` would "pass" a round bundle while silently
 * ignoring every blob it commits to.
 */
import { BUNDLE_SCHEMA } from "../../../services/attestor/src/round.ts";
import type { Bundle } from "../../../services/attestor/src/round.ts";
import { WITNESS_SCHEMA, isBundleShaped } from "../../../services/attestor/src/witness.ts";
import type { WitnessDoc } from "../../../services/attestor/src/witness.ts";
import { MARK_BUNDLE_SCHEMA, isMarkBundleShaped } from "../../../services/keeper/src/markRound.ts";
import type { MarkBundle } from "../../../services/keeper/src/markRound.ts";

export type DocKind = "round" | "mark" | "witness";

export const SCHEMAS: Record<DocKind, string> = {
  round: BUNDLE_SCHEMA,
  mark: MARK_BUNDLE_SCHEMA,
  witness: WITNESS_SCHEMA,
};

export type Classified =
  | { kind: "round"; doc: Bundle }
  | { kind: "mark"; doc: MarkBundle }
  | { kind: "witness"; doc: WitnessDoc }
  | { kind: null; reason: string };

export function classify(doc: unknown): Classified {
  if (!doc || typeof doc !== "object") return { kind: null, reason: "not a JSON object" };
  const schema = (doc as { schema?: unknown }).schema;
  if (typeof schema !== "string") return { kind: null, reason: "no `schema` field" };

  if (schema === BUNDLE_SCHEMA) {
    return isBundleShaped(doc)
      ? { kind: "round", doc }
      : { kind: null, reason: `${BUNDLE_SCHEMA} is malformed: needs inputRoot, tree, json and blobs` };
  }
  if (schema === MARK_BUNDLE_SCHEMA) {
    return isMarkBundleShaped(doc)
      ? { kind: "mark", doc }
      : { kind: null, reason: `${MARK_BUNDLE_SCHEMA} is malformed: needs inputRoot, tree, json and marks` };
  }
  if (schema === WITNESS_SCHEMA) {
    const d = doc as Partial<WitnessDoc>;
    return d.message && d.signature && d.signer
      ? { kind: "witness", doc: doc as WitnessDoc }
      : { kind: null, reason: `${WITNESS_SCHEMA} is malformed: needs message, signer and signature` };
  }
  return {
    kind: null,
    reason: `unsupported schema ${JSON.stringify(schema)}; this tool verifies ${Object.values(SCHEMAS).join(", ")}`,
  };
}

/** A verb pinned to one kind must refuse the others by name, never silently cross over. */
export function expectKind(c: Classified, want: DocKind): { ok: true } | { ok: false; message: string } {
  if (c.kind === null) return { ok: false, message: c.reason };
  if (c.kind === want) return { ok: true };
  const verb = c.kind === "round" ? "round" : c.kind === "mark" ? "mark" : "witness";
  return { ok: false, message: `that document is a ${c.kind} document, not a ${want} one; use: curb-verify ${verb} ...` };
}
