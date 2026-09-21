/**
 * Offline verification of a published round bundle.
 *
 * Given only the bundle, with no network and no trust in the attestor, check that:
 *   1. every leaf's content hash matches its published preimage (JSON or exact body bytes);
 *   2. the published tree dump rebuilds to the claimed inputRoot;
 *   3. re-running derive() on the committed inputs reproduces every committed CLAIM exactly.
 *
 * Chain reads are not re-queried here (that is the online step, re-running the pinned multicall at
 * the committed block hash). Everything that turns inputs into the onchain write is checked.
 */
import { loadTree, hashBytes, hashJson, jcs, LeafKind, subjectOf } from "../tree.ts";
import type { Leaf } from "../tree.ts";
import { derive, METHODS } from "../derive.ts";
import type { Bundle } from "../round.ts";

export interface VerifyResult {
  ok: boolean;
  root: string;
  failures: string[];
}

export function verifyBundleOffline(bundle: Bundle): VerifyResult {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  // 1 + 2: rebuild the tree and check each leaf against its preimage.
  let root = "";
  let leaves: Leaf[] = [];
  try {
    const tree = loadTree(bundle.tree as never);
    root = tree.root;
    leaves = [...tree.entries()].map(([, v]) => v as Leaf);
  } catch (e) {
    return { ok: false, root, failures: [`tree dump does not load: ${String(e)}`] };
  }
  if (root.toLowerCase() !== bundle.inputRoot.toLowerCase()) {
    fail(`tree root ${root} != committed inputRoot ${bundle.inputRoot}`);
  }

  const bytesOf = new Map<string, Uint8Array>();
  for (const [kind, subject, contentHash] of leaves) {
    if (Number(kind) === LeafKind.HTTP_EXCHANGE) {
      const b64 = bundle.blobs[contentHash];
      if (!b64) { fail(`missing blob for ${contentHash}`); continue; }
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      if (hashBytes(bytes) !== contentHash) fail(`blob hash mismatch for subject ${subject}`);
      bytesOf.set(subject, bytes);
    } else {
      const s = bundle.json[contentHash];
      if (s === undefined) { fail(`missing JSON preimage for ${contentHash}`); continue; }
      if (hashJson(JSON.parse(s)) !== contentHash) fail(`JSON preimage hash mismatch for ${contentHash}`);
    }
  }

  // 3: reconstruct derive() inputs purely from committed leaves.
  const leafJson = (kind: number, subject?: string) => {
    const l = leaves.find(([k, s]) => Number(k) === kind && (subject === undefined || s === subject));
    return l ? JSON.parse(bundle.json[l[2]]) : null;
  };
  const params = leafJson(LeafKind.PARAMS, subjectOf("params"));
  // Committed only by methods that confirm reopens; absent for derive/1 and derive/2.
  const priorLeaf = leaves.find(([k, s]) => Number(k) === LeafKind.PRIOR && s === subjectOf("prior"));
  const prior = priorLeaf ? JSON.parse(bundle.json[priorLeaf[2]]) : null;
  const registry = leafJson(LeafKind.REGISTRY, subjectOf("registry"));
  const fetchLog = leafJson(LeafKind.FETCH_LOG, subjectOf("fetchlog")) as Array<{ url: string; ok: boolean; respEndMs: number }> | null;
  if (!params || !registry || !fetchLog) {
    fail("bundle lacks PARAMS, REGISTRY or FETCH_LOG leaf");
    return { ok: false, root, failures };
  }

  // Only leaves are covered by the root. Any convenience field at the top level of the bundle must
  // agree with its committed counterpart, or a reader could be shown a label the root does not back.
  for (const field of ["kind", "evaluatedAtMs", "targetMs", "chainId"] as const) {
    if (JSON.stringify((bundle as unknown as Record<string, unknown>)[field]) !== JSON.stringify(params[field])) {
      fail(`top-level ${field}=${JSON.stringify((bundle as unknown as Record<string, unknown>)[field])} contradicts committed PARAMS.${field}=${JSON.stringify(params[field])}`);
    }
  }
  if (String(bundle.clock).toLowerCase() !== String(params.clock).toLowerCase()) {
    fail(`top-level clock ${bundle.clock} contradicts committed PARAMS.clock ${params.clock}`);
  }

  const API = "https://api.xstocks.fi/api/v2/public";
  // The latest successful fetch of each URL is the one the round used.
  const lastOk = new Map<string, number>();
  for (const e of fetchLog) if (e.ok) lastOk.set(e.url, e.respEndMs);

  const wrappers = registry.wrappers as Array<{ wrapper: string; symbol: string; mic: string }>;
  const mics = [...new Set(wrappers.map((w) => w.mic))];
  const schedules: Record<string, Uint8Array | null> = {};
  for (const mic of mics) schedules[mic] = bytesOf.get(subjectOf(`${API}/exchanges/${encodeURIComponent(mic)}`)) ?? null;

  // Re-derive with the exact method the round committed to, so historical rounds stay verifiable after
  // the rules change.
  if (!METHODS[params.method]) {
    fail(`unknown derivation method ${JSON.stringify(params.method)}`);
    return { ok: false, root, failures };
  }
  if (METHODS[params.method].confirmBeforeOpen && !priorLeaf) {
    fail(`method ${params.method} requires a PRIOR leaf and the bundle has none`);
  }
  const rederived = derive(
    {
      evaluatedAtMs: params.evaluatedAtMs,
      schedules,
      prior,
      assets: wrappers.map((w) => {
        const url = `${API}/assets/${encodeURIComponent(w.symbol)}?network=XLayer`;
        return { wrapper: w.wrapper, symbol: w.symbol, mic: w.mic, body: bytesOf.get(subjectOf(url)) ?? null, fetchedAtMs: lastOk.get(url) ?? null };
      }),
    },
    params.method,
  );

  const committed = new Map<string, unknown>();
  for (const [kind, , contentHash] of leaves) {
    if (Number(kind) === LeafKind.CLAIM) {
      const c = JSON.parse(bundle.json[contentHash]);
      committed.set(String(c.wrapper).toLowerCase(), c);
    }
  }
  if (committed.size !== rederived.length) fail(`claim count ${committed.size} != re-derived ${rederived.length}`);
  for (const c of rederived) {
    // Compare canonical JSON: committed claims are stored in RFC 8785 form, so key order is fixed.
    const mine = jcs({ ...c, capUsd: c.capUsd.toString() });
    const found = committed.get(c.wrapper.toLowerCase());
    const theirs = found === undefined ? "(missing)" : jcs(found);
    if (mine !== theirs) fail(`claim mismatch for ${c.symbol}: re-derived ${mine} vs committed ${theirs}`);
  }

  // The uncommitted top-level `claims` array is a convenience copy; it must equal the committed set.
  const topClaims = Array.isArray(bundle.claims) ? bundle.claims : [];
  const topCanon = topClaims.map((c) => jcs(c)).sort();
  const committedCanon = [...committed.values()].map((c) => jcs(c)).sort();
  if (JSON.stringify(topCanon) !== JSON.stringify(committedCanon)) {
    fail("top-level claims do not match the committed CLAIM leaves");
  }

  return { ok: failures.length === 0, root, failures };
}
