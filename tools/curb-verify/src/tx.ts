/**
 * From a transaction hash to a verdict: `curb-verify tx <hash>` and `curb-verify range <from>..<to>`.
 *
 * A judge has a hash from OKLink. They should not need to know what an inputRoot is, where a bundle
 * lives, or which of two contracts wrote the row. So this:
 *   1. reads the transaction and its receipt from a public RPC;
 *   2. decodes the calldata. MarketClock.attestBatch is a regime round and Scorecard.commit is a mark.
 *      Anything else is not a Curb write;
 *   3. takes the inputRoot from that calldata, which is what the chain committed to, and never from
 *      whatever an archive says;
 *   4. fetches rounds/<root>.json or marks/<root>.json from the first archive that serves one;
 *   5. runs the same full check host B's witness runs (`checkRound`) or its mark analogue
 *      (`checkMarkRound`) against the chain's own record of the write.
 *
 * Exit codes follow render.ts. "Could not reach the evidence" (3) is kept apart from "the evidence
 * does not back the number" (1), and a write the tool has no verifier for is 4.
 *
 * Network access goes through `Deps`, so the whole pipeline is tested offline against real mainnet
 * fixtures. The Mac backfill reuses it too, so the archive is filled by the same check a judge runs.
 */
import { clockAbi, rpcAny, attestedRounds } from "../../../services/attestor/src/sources/chain.ts";
import type { TxInfo } from "../../../services/attestor/src/sources/chain.ts";
import { checkRound } from "../../../services/attestor/src/witness.ts";
import { Regime } from "../../../services/attestor/src/regime.ts";
import { checkMarkRound } from "../../../services/keeper/src/markWitness.ts";
import type { SettlementInfo } from "../../../services/keeper/src/markWitness.ts";
import { closuresCommitted, decodeClosureCommitted, decodeCommitCalldata, scorecardAbi } from "../../../services/keeper/src/sources/scorecard.ts";
import { LeafKind, loadTree, subjectOf } from "../../../services/keeper/src/tree.ts";
import type { Leaf } from "../../../services/keeper/src/tree.ts";
import { registrySpecOf } from "../../../services/keeper/src/swapEvidence.ts";
import { Interface, getAddress } from "ethers";
import { classify } from "./classify.ts";
import { EXIT, exitFor, iso } from "./render.ts";
import type { CheckLike } from "./render.ts";

export const CHAIN_ID = 196;
export const CLOCK = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
/** Scorecard v2. v1 is retired, and a v1 row is not something this tool vouches for. */
export const SCORECARD = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
/** The first attestation MarketClock ever received. */
export const FIRST_ROUND_BLOCK = 70_617_365;
/** Scorecard v2's deployment block. */
export const SCORECARD_FROM_BLOCK = 71_231_806;
export const HOST_A = "https://attestor-a-production.up.railway.app";
export const ARCHIVE = "https://archive.curb.markets";
/** The archive first: it is locked and outlives the hosts. Then host A, which serves rounds only. */
export const DEFAULT_ARCHIVES = [ARCHIVE, HOST_A];

/** Scorecard's write-once price source per wrapper (src/Scorecard.sol `priceSources`). */
export const priceSourcesAbi = new Interface([
  "function priceSources(address) view returns (address pool, bool equityIsToken0, uint32 twapWindow, uint8 equityDecimals, uint8 stableDecimals)",
]);
/**
 * The six rows D-16 explains: the XHKG holiday closures of 30 Sep-2 Oct and 16-20 Oct 2026. The release gate
 * (spec W8a) needs the set of rows that get E6 to be exactly these.
 */
export const KNOWN_E6_ROOTS = [
  "0xfa50604164a77feb3cb38f6e56f8f37e5aec9a54030d997f95d5efda63351bdc",
  "0x3dafc1b6355ef8bfacc33bbc0563489b65530afc2474a8b78fd9d560c7ff18ed",
  "0xd81c7e07d527dfa1e9952f02c9d8f4c37380f2b2c8cc2617ff46b14804bb4e89",
  "0xf1da8c479ddbdf42cfa39c57125b17f7339ec7b73b1b3a556c130f0a8671490f",
  "0x4db753ad7eb06acf7ba22d0b4fe2ded09ab39eda8803b6cc6ba811b6e4a36ad5",
  "0x67daecc7a7788552b0b7e649283e31600f1b43d21d3d5c00b8bf4a0a35e508fe",
];

/** Scorecard.SETTLE_DELAY and SETTLE_WINDOW: `settle` reverts TooLate after settleAfter + 300 + 6 h. */
export const SETTLE_DELAY_S = 300;
export const SETTLE_WINDOW_S = 6 * 3600;

const ATTEST_BATCH = clockAbi.getFunction("attestBatch")!.selector;
const COMMIT = scorecardAbi.getFunction("commit")!.selector;
const CLOSURE_COMMITTED = scorecardAbi.getEvent("ClosureCommitted")!.topicHash;

/** `bytes`, when given, are the exact bytes served; `text` is their UTF-8 decoding. */
export type Evidence = { ok: true; text: string; source: string; bytes?: Uint8Array } | { ok: false; tried: string[] };

export interface Deps {
  /** One JSON-RPC call against X Layer mainnet. */
  rpc<T>(method: string, params: unknown[]): Promise<T>;
  /** The first source that serves `key` as JSON, with the exact text it served. */
  evidence(key: string): Promise<Evidence>;
  /** Tests only: replaces the keeper's SWAP_EVIDENCE_FROM_BLOCK when deciding a mark's era. */
  swapEvidenceFromBlock?: number;
}

export interface Verdict {
  exit: number;
  kind: "round" | "mark" | null;
  tx: string;
  block?: number;
  inputRoot?: string;
  key?: string;
  source?: string;
  /** The document checked, as served. The backfill uploads exactly these bytes and nothing else. */
  text?: string;
  bytes?: Uint8Array;
  check?: CheckLike & { method: string; evaluatedAtMs: number | null };
  /** Human-readable facts about the write, for rendering. */
  fields: Array<[string, string]>;
  /** Why no check was run, when none was. */
  message?: string;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const hex = (n: number) => "0x" + n.toString(16);
/** A tampered bundle can carry any "timestamp"; rendering it must not throw. */
const when = (ms: number | null) => (ms !== null && Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? iso(ms) : "(unreadable)");

interface RawTx { hash: string; from: string; to: string | null; blockNumber: string | null; input: string }
interface RawReceipt { status: string; blockNumber: string; logs: Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }> }

export async function verifyTx(hashIn: string, deps: Deps): Promise<Verdict> {
  const tx0 = String(hashIn).trim();
  const base: Verdict = { exit: EXIT.USAGE, kind: null, tx: tx0, fields: [] };
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx0)) return { ...base, message: `not a transaction hash: ${JSON.stringify(hashIn)} (want 0x + 64 hex characters)` };
  const hash = tx0.toLowerCase();
  base.tx = hash;

  let raw: RawTx | null;
  let receipt: RawReceipt | null;
  try {
    [raw, receipt] = await Promise.all([
      deps.rpc<RawTx | null>("eth_getTransactionByHash", [hash]),
      deps.rpc<RawReceipt | null>("eth_getTransactionReceipt", [hash]),
    ]);
  } catch (e) {
    return { ...base, exit: EXIT.UNAVAILABLE, message: `could not read the transaction: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || !raw.blockNumber || !receipt) {
    return { ...base, exit: EXIT.UNAVAILABLE, message: `transaction ${hash} is not on X Layer mainnet (chain ${CHAIN_ID}), or not mined yet, according to the RPC` };
  }
  const tx: TxInfo = { hash, from: lower(raw.from), to: raw.to ? lower(raw.to) : null, blockNumber: Number(BigInt(raw.blockNumber)), input: raw.input };
  base.block = tx.blockNumber;
  const selector = lower(tx.input.slice(0, 10));
  const kind = tx.to === lower(CLOCK) && selector === ATTEST_BATCH ? "round"
    : tx.to === lower(SCORECARD) && selector === COMMIT ? "mark"
    : null;
  if (!kind) {
    return {
      ...base, exit: EXIT.UNSUPPORTED,
      message: `not a Curb write: it calls ${selector || "(no calldata)"} on ${tx.to ?? "(contract creation)"}. This tool verifies MarketClock.attestBatch on ${CLOCK} and Scorecard.commit on ${SCORECARD}`,
    };
  }
  base.kind = kind;
  if (receipt.status !== "0x1") {
    return { ...base, exit: EXIT.UNSUPPORTED, message: `the ${kind === "round" ? "attestBatch" : "commit"} in ${hash} reverted, so it wrote nothing and there is nothing to verify` };
  }

  let inputRoot: string;
  let row: ReturnType<typeof decodeClosureCommitted> = null;
  if (kind === "round") {
    try { inputRoot = lower(String(clockAbi.decodeFunctionData("attestBatch", tx.input)[5])); }
    catch { return { ...base, exit: EXIT.UNSUPPORTED, message: "calldata has the attestBatch selector but does not decode as attestBatch" }; }
  } else {
    const call = decodeCommitCalldata(tx.input);
    if (!call) return { ...base, exit: EXIT.UNSUPPORTED, message: "calldata has the commit selector but does not decode as commit" };
    inputRoot = lower(call.inputRoot);
    const log = receipt.logs.find((l) => lower(l.address) === lower(SCORECARD) && lower(l.topics[0]) === CLOSURE_COMMITTED);
    row = log ? decodeClosureCommitted(log) : null;
  }
  const key = `${kind === "round" ? "rounds" : "marks"}/${inputRoot}.json`;
  Object.assign(base, { inputRoot, key });

  let writtenAtS: number;
  try {
    const b = await deps.rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(tx.blockNumber), false]);
    if (!b) throw new Error(`block ${tx.blockNumber} not found`);
    writtenAtS = Number(BigInt(b.timestamp));
  } catch (e) {
    return { ...base, exit: EXIT.UNAVAILABLE, message: `could not read the block timestamp: ${e instanceof Error ? e.message : String(e)}` };
  }
  const fields: Array<[string, string]> = [
    ["tx", `${hash}  block ${tx.blockNumber.toLocaleString("en-US")}  ${iso(writtenAtS * 1000)}`],
    [kind === "round" ? "attestor" : "keeper", tx.from],
  ];

  let ev: Evidence;
  try { ev = await deps.evidence(key); }
  catch (e) { ev = { ok: false, tried: [e instanceof Error ? e.message : String(e)] }; }
  if (!ev.ok) {
    return { ...base, fields, exit: EXIT.UNAVAILABLE, message: `no archive served ${key} (${ev.tried.join("; ") || "no archive configured"})` };
  }
  let doc: unknown;
  try { doc = JSON.parse(ev.text); } catch { return { ...base, fields, source: ev.source, exit: EXIT.UNAVAILABLE, message: `${ev.source} is not JSON` }; }
  fields.push(["source", ev.source]);
  const c = classify(doc);
  if (c.kind === null) return { ...base, fields, source: ev.source, exit: EXIT.UNSUPPORTED, message: c.reason };

  const done = (check: Verdict["check"] & object): Verdict =>
    ({ ...base, fields, source: ev.source, text: ev.text, bytes: ev.bytes, check, exit: exitFor(check) });

  if (c.kind !== kind) {
    return done({
      reproduced: false, labelsConsistent: true, method: "", evaluatedAtMs: null, labelFailures: [], warnings: [],
      failures: [`the document served for ${key} is a ${c.kind} document, not a ${kind} bundle`],
    });
  }

  if (kind === "round") {
    const r = checkRound(doc, tx, CHAIN_ID, CLOCK, writtenAtS);
    fields.push(["method", r.method || "(unreadable)"], ["evaluated", when(r.evaluatedAtMs)], ["claims", summarizeClaims(r.claims)]);
    return done(r);
  }

  if (!row) {
    return done({
      reproduced: false, labelsConsistent: true, method: "", evaluatedAtMs: null, labelFailures: [], warnings: [],
      failures: ["the commit succeeded but its receipt carries no ClosureCommitted event from Scorecard"],
    });
  }
  let settlement: SettlementInfo | undefined;
  try {
    const out = await deps.rpc<string>("eth_call", [{ to: SCORECARD, data: scorecardAbi.encodeFunctionData("settlements", [row.id]) }, "latest"]);
    const s = scorecardAbi.decodeFunctionResult("settlements", out);
    settlement = { settledAt: Number(s.settledAt), settledBlock: Number(s.settledBlock), reopenPrint: String(s.reopenPrint), settled: Boolean(s.settled) };
  } catch { /* the settlement is a further check, never a precondition */ }
  const m = checkMarkRound(doc, row, tx, CHAIN_ID, SCORECARD, writtenAtS, settlement,
    deps.swapEvidenceFromBlock === undefined ? undefined : { swapEvidenceFromBlock: deps.swapEvidenceFromBlock });
  const mine = m.rows.find((x) => lower(x.wrapper) === lower(row.wrapper));

  // The pool the bundle prices from must be the one Scorecard settles against. Both are write-once, so a
  // difference is a wrong bundle; a read that fails (or answers nothing) is only a warning.
  const spec = registrySpecOf(leafOf(doc, LeafKind.REGISTRY, subjectOf("registry")), row.wrapper);
  try {
    const out = await deps.rpc<string>("eth_call", [{ to: SCORECARD, data: priceSourcesAbi.encodeFunctionData("priceSources", [row.wrapper]) }, "latest"]);
    const p = priceSourcesAbi.decodeFunctionResult("priceSources", out);
    const onchain = { pool: getAddress(String(p.pool)), equityIsToken0: Boolean(p.equityIsToken0), equityDecimals: Number(p.equityDecimals), stableDecimals: Number(p.stableDecimals) };
    if (onchain.pool === ZERO_ADDRESS) m.warnings.push(`Scorecard.priceSources(${row.wrapper}) answered no pool; the REGISTRY entry was not compared`);
    else if (!spec || lower(spec.pool) !== lower(onchain.pool) || spec.equityIsToken0 !== onchain.equityIsToken0
      || spec.equityDecimals !== onchain.equityDecimals || spec.stableDecimals !== onchain.stableDecimals) {
      m.failures.push(`REGISTRY entry for ${mine?.symbol ?? row.wrapper} (pool, equityIsToken0, decimals) is not Scorecard.priceSources: `
        + `bundle ${spec ? `${spec.pool}, ${spec.equityIsToken0}, ${spec.equityDecimals}/${spec.stableDecimals}` : "(none)"}, `
        + `chain ${onchain.pool}, ${onchain.equityIsToken0}, ${onchain.equityDecimals}/${onchain.stableDecimals}`);
      m.reproduced = false;
    }
  } catch (e) {
    m.warnings.push(`could not read Scorecard.priceSources(${row.wrapper}); the REGISTRY entry was not compared (${e instanceof Error ? e.message : String(e)})`);
  }

  fields.push(
    ["method", m.method || "(unreadable)"],
    ["evaluated", when(m.evaluatedAtMs)],
    ["row", `${mine?.symbol ?? row.wrapper}  mark ${formatE18(row.mark)}  band ${row.bandBps} bps  graded after ${iso(row.settleAfter * 1000)}`],
  );
  if (mine) fields.push(["flags", mine.flags.length ? mine.flags.join(" ") : "(none)"], ["drift", `${mine.driftBps} bp`]);
  fields.push(
    ["swaps", swapsField(doc, row.wrapper, m.evidence.era)],
    ["closure", m.closureId || row.id],
    ["settled", await settledField(settlement, row.settleAfter, deps)],
  );
  return done(m);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** One committed leaf of a mark bundle, parsed; null when absent or unreadable. Never throws. */
function leafOf(doc: unknown, kind: number, subject: string): Record<string, unknown> | null {
  try {
    const b = doc as { tree: unknown; json: Record<string, string> };
    const leaf = [...loadTree(b.tree as never).entries()].map(([, v]: [number, Leaf]) => v).find(([k, s]) => Number(k) === kind && s === subject);
    if (!leaf) return null;
    const v = JSON.parse(b.json[leaf[2]]);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

/** What the row's swap evidence covers, as committed. Strict rows only; a pre-fix keeper recorded none. */
export function swapsField(doc: unknown, wrapper: string, era: string): string {
  if (era === "pre-swap-fix") return "not recorded (pre-fix keeper)";
  const s = leafOf(doc, LeafKind.FETCH_LOG, subjectOf(`swaps:${lower(wrapper)}`));
  const range = (r: unknown) => {
    const x = r as { fromBlock?: unknown; toBlock?: unknown } | null;
    return x && typeof x === "object" ? `${x.fromBlock}..${x.toBlock}` : "?";
  };
  if (!s || !Array.isArray(s.closingSwaps)) return "(unreadable)";
  let out = `closing ${s.closingSwaps.length} in ${range(s.closingRange)}, closure ${String(s.closureCount)} in ${range(s.closureRange)}`;
  if (Array.isArray(s.gaps) && s.gaps.length) out += `, gaps ${s.gaps.map((g) => (Array.isArray(g) ? `${g[0]}..${g[1]}` : "?")).join(" ")}`;
  if (s.closingComplete === false) out += ", closing window not committed";
  if (s.closureOmitted !== null && s.closureOmitted !== undefined) out += `, truncated (${Number(s.closureCount).toLocaleString("en-US")} total)`;
  return out;
}

/**
 * Settled, or why not. An unsettled row whose window has closed can never be graded (Scorecard reverts
 * TooLate), and saying "not yet" about it would be false; row 151 (D-17) is such a row. One read of the
 * latest block decides it; a failed read keeps the cautious "not yet".
 */
export async function settledField(s: SettlementInfo | undefined, settleAfterS: number, deps: Deps): Promise<string> {
  if (!s) return "(could not read)";
  if (s.settled) return `yes, block ${s.settledBlock.toLocaleString("en-US")}, reopen print ${formatE18(s.reopenPrint)}`;
  const deadlineS = settleAfterS + SETTLE_DELAY_S + SETTLE_WINDOW_S;
  let latestS: number;
  try {
    const b = await deps.rpc<{ timestamp: string } | null>("eth_getBlockByNumber", ["latest", false]);
    if (!b) return "not yet";
    latestS = Number(BigInt(b.timestamp));
  } catch { return "not yet"; }
  return latestS > deadlineS
    ? `not settled; settle window closed ${iso(deadlineS * 1000)} (TooLate: this row can no longer be graded)`
    : `not yet (window open until ${iso(deadlineS * 1000)})`;
}

const REGIME_NAME = Object.fromEntries(Object.entries(Regime).map(([k, v]) => [v, k])) as Record<number, string>;

function summarizeClaims(claims: Array<{ symbol?: string; regime: number; halted: boolean }>): string {
  if (!claims.length) return "(none)";
  return claims.map((c) => `${c.symbol ?? "?"}:${REGIME_NAME[c.regime] ?? c.regime}${c.halted ? ":HALTED" : ""}`).join(" ");
}

export function formatE18(v: string | bigint): string {
  const n = BigInt(v);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

// ---------------------------------------------------------------------------------------------
// range
// ---------------------------------------------------------------------------------------------

export interface Write { tx: string; block: number; kind: "round" | "mark" }

export interface Scan {
  rounds(from: number, to: number): Promise<Array<{ txHash: string; blockNumber: number }>>;
  closures(from: number, to: number): Promise<Array<{ txHash: string; committedBlock: number }>>;
}

/** Every Curb write in [from, to], oldest first. Each contract is only scanned from its first block. */
export async function writesInRange(from: number, to: number, scan: Scan): Promise<Write[]> {
  const [rounds, closures] = await Promise.all([
    to >= Math.max(from, FIRST_ROUND_BLOCK) ? scan.rounds(Math.max(from, FIRST_ROUND_BLOCK), to) : Promise.resolve([]),
    to >= Math.max(from, SCORECARD_FROM_BLOCK) ? scan.closures(Math.max(from, SCORECARD_FROM_BLOCK), to) : Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  const out: Write[] = [];
  for (const r of rounds) if (!seen.has(lower(r.txHash))) { seen.add(lower(r.txHash)); out.push({ tx: lower(r.txHash), block: r.blockNumber, kind: "round" }); }
  for (const c of closures) if (!seen.has(lower(c.txHash))) { seen.add(lower(c.txHash)); out.push({ tx: lower(c.txHash), block: c.committedBlock, kind: "mark" }); }
  return out.sort((a, b) => a.block - b.block || a.tx.localeCompare(b.tx));
}

/**
 * One exit code for many verdicts. Any row that does not reproduce decides it. Next comes a write this
 * tool cannot verify, which is permanent until the tool is upgraded. Then one it could not reach,
 * which is transient. Otherwise 0, including for a range with no Curb writes in it.
 */
export function worstExit(codes: number[]): number {
  for (const c of [EXIT.NOT_REPRODUCED, EXIT.UNSUPPORTED, EXIT.UNAVAILABLE, EXIT.USAGE]) if (codes.includes(c)) return c;
  return EXIT.VERIFIED;
}

/** `70617365..70620000`, `70,617,365..latest`, `70_617_365..71000000`. */
export function parseRange(s: string): { from: number; to: number | "latest" } | null {
  const m = String(s).match(/^([0-9][0-9_,]*)\.\.([0-9][0-9_,]*|latest)$/);
  if (!m) return null;
  const n = (x: string) => Number(x.replace(/[_,]/g, ""));
  const from = n(m[1]);
  const to = m[2] === "latest" ? "latest" : n(m[2]);
  if (!Number.isSafeInteger(from) || (to !== "latest" && (!Number.isSafeInteger(to) || to < from))) return null;
  return { from, to };
}

/** Run `fn` over `items` with at most `n` in flight, keeping input order in the result. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------
// the real network
// ---------------------------------------------------------------------------------------------

/** Plain http is refused except on loopback: a verifier a network can rewrite is not a verifier. */
export function checkUrl(u: string): string | null {
  let url: URL;
  try { url = new URL(u); } catch { return `not a URL: ${u}`; }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  return `refusing ${url.protocol} ${u}: use https (plain http only on loopback)`;
}

/** A capped mark bundle is up to about 1.25 MB, so the evidence fetch gets 60 s. */
export function networkDeps(rpcs: string[], archives: string[], timeoutMs = 60_000): Deps & Scan {
  return {
    rpc: <T>(method: string, params: unknown[]) => rpcAny<T>(rpcs, method, params),
    async evidence(key: string): Promise<Evidence> {
      const tried: string[] = [];
      for (const base of archives) {
        const url = `${base.replace(/\/+$/, "")}/${key}`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) { tried.push(`${url}: HTTP ${res.status}`); continue; }
          const bytes = new Uint8Array(await res.arrayBuffer());
          const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
          try { JSON.parse(text); } catch { tried.push(`${url}: not JSON`); continue; }
          return { ok: true, text, source: url, bytes };
        } catch (e) {
          tried.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { ok: false, tried };
    },
    rounds: (from, to) => attestedRounds(rpcs, CLOCK, from, to),
    closures: (from, to) => closuresCommitted(rpcs, SCORECARD, from, to),
  };
}
