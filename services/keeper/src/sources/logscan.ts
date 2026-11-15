/**
 * The swap scan: Swap logs of the price pools over a block range, with every wait bounded and every failure named.
 *
 * Why this exists beside `pools.ts`. `scanSwaps` throws when one 100-block chunk is refused, has no deadline, and keeps
 * only an error message; the keeper called it inside `tick()`, so one refused chunk lost the whole tick, commits and
 * settles included. `scanRange` is total: it never throws, keeps the progress made before an unserved chunk, never
 * waits past its deadline (each request's timeout is `min(8 s, time left)`, and nothing starts with under 500 ms left),
 * and reports what each endpoint answered so the caller can alarm on it.
 *
 * Rules measured on the two public X Layer RPCs (nov/reports/rpc-behaviour.md):
 *  - never ask an endpoint for a block above the head it reported (dRPC silently drops blocks it does not have yet;
 *    rpc.xlayer.tech answers -32019);
 *  - chunks are 100 blocks inclusive (both cap at 101), `from <= to` always (dRPC answers [] for from > to), and the
 *    address list is never empty (both treat [] as "every contract");
 *  - one attempt per endpoint per chunk per call, no sleeps; endpoint order is RPCS order (rpc.xlayer.tech first:
 *    fresher head, errors instead of truncating), except round-robin for chunks at least 200 blocks below every known
 *    head, which both endpoints serve identically;
 *  - an answer holding a log that will not decode is set aside and the next endpoint asked; if no endpoint decodes it,
 *    the chunk is served and that log's block is reported as a hole, which the caller must NOT count as covered.
 *
 * `chain.ts` is byte-identical with the attestor's and keeps its own `rpc()`; new RPC code lives here.
 */
import { getAddress } from "ethers";
import { LOG_RANGE } from "./chain.ts";
import { SWAP_TOPIC0, decodeSwapLog, newSwapScanStats } from "./pools.ts";
import type { PoolSpec, RawSwapLog, SwapRow } from "./pools.ts";

export type RpcKind = "rate-limit" | "not-yet" | "malformed-request" | "transport" | "rpc";
export type RpcAnswer<T> =
  | { ok: true; result: T; ms: number }
  | { ok: false; kind: RpcKind; httpStatus: number; code: number | null; message: string; ms: number };

/** Never start a request with less than this left on the caller's deadline. */
export const MIN_REQUEST_MS = 500;
/** The longest any single request may wait. */
export const MAX_REQUEST_MS = 8_000;

let rpcId = 0;

/**
 * One JSON-RPC call that never throws: the HTTP status, the JSON-RPC code and the message survive, so the answer can
 * be classified. `httpStatus` is 0 when no HTTP answer arrived (timeout, network error). The wait is bounded by
 * `timeoutMs` even if `fetchImpl` ignores its abort signal.
 */
export async function rpcRaw<T>(url: string, method: string, params: unknown[], timeoutMs = MAX_REQUEST_MS,
                                fetchImpl: typeof fetch = fetch): Promise<RpcAnswer<T>> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const fail = (kind: RpcKind, httpStatus: number, code: number | null, message: string): RpcAnswer<T> =>
    ({ ok: false, kind, httpStatus, code, message: message.slice(0, 300), ms: ms() });
  const wait = Math.max(0, Math.floor(timeoutMs));
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<RpcAnswer<T>>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error(`timeout after ${wait} ms`));
      resolve(fail("transport", 0, null, `${method}: timeout after ${wait} ms`));
    }, wait);
  });
  const work = (async (): Promise<RpcAnswer<T>> => {
    let status = 0;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      status = res.status;
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch {
        return fail(status === 429 ? "rate-limit" : "transport", status, null, `${method}: non-JSON body (HTTP ${status}): ${text.slice(0, 120)}`);
      }
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        return fail(status === 429 ? "rate-limit" : "transport", status, null, `${method}: unexpected JSON body (HTTP ${status})`);
      }
      const j = json as { result?: unknown; error?: { code?: unknown; message?: unknown } | null };
      if (j.error !== undefined && j.error !== null) {
        const code = typeof j.error.code === "number" && Number.isFinite(j.error.code) ? j.error.code : null;
        const message = typeof j.error.message === "string" ? j.error.message : JSON.stringify(j.error);
        return fail(classifyRpcError(status, code, message), status, code, message);
      }
      if (status === 429) return fail("rate-limit", status, null, `${method}: HTTP 429`);
      if (!("result" in j) || j.result === undefined) return fail("transport", status, null, `${method}: JSON without result (HTTP ${status})`);
      return { ok: true, result: j.result as T, ms: ms() };
    } catch (e) {
      const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return fail(status === 429 ? "rate-limit" : "transport", status, null, `${method}: ${m}`);
    }
  })();
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
    if (!ctrl.signal.aborted) ctrl.abort(new Error("done"));
  }
}

/**
 * The error table of rpc-behaviour.md (2.4, 2.6, 5.4). Messages match case-insensitively. A malformed request is a
 * programming error (sev-1), never a reason to stop trusting an endpoint.
 */
export function classifyRpcError(httpStatus: number, code: number | null, message: string): RpcKind {
  const m = String(message ?? "").toLowerCase();
  if (httpStatus === 429 || code === -32016 || code === 15 || m.includes("rate limit")) return "rate-limit";
  if (code === -32602 || m.includes("block range greater than")) return "malformed-request";
  if (m.includes("ranges over")) return "malformed-request";
  if (code === -32700 || m.includes("parse error")) return "malformed-request";
  if (code === -32601 && m.includes("hex")) return "malformed-request";
  if (code === -32019 || m.includes("block is out of range")) return "not-yet";
  if (m.includes("unsupported block number")) return "not-yet";
  if (m.includes("unknown block")) return "not-yet";
  if (m.includes("temporary internal error")) return "not-yet";
  if (/block\b.*\bnot found/.test(m)) return "not-yet";
  return "rpc";
}

/** `eth_blockNumber` on every endpoint IN PARALLEL; -1 for an endpoint that failed, timed out or answered nonsense. */
export async function readHeads(rpcs: string[], timeoutMs = 3_000, fetchImpl: typeof fetch = fetch): Promise<number[]> {
  return Promise.all(rpcs.map(async (url) => {
    const a = await rpcRaw<unknown>(url, "eth_blockNumber", [], timeoutMs, fetchImpl);
    return a.ok ? parseQuantity(a.result) ?? -1 : -1;
  }));
}

/** A JSON-RPC quantity ("0x1a") as a safe non-negative integer, else null. */
export function parseQuantity(v: unknown): number | null {
  if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v)) return null;
  const n = Number(BigInt(v));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const hex = (n: number) => "0x" + n.toString(16);
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

export interface ScanOptions {
  maxChunks: number; deadlineMs: number;   // deadlineMs bounds the WHOLE call, in-flight requests included
  heads: number[];                         // per endpoint, from readHeads; -1 = unknown (never asked)
  endpointOrder: "first" | "roundRobin";   // roundRobin applies only to chunks ending <= min(known heads) - 200
  now?: () => number; fetchImpl?: typeof fetch;
}
export interface ScanRow extends SwapRow { blockHash: string | null }
export interface ScanStats {
  chunks: number; logs: number; decoded: number; unmatched: number; anomalies: number; programmingErrors: number;
  decodeRetries: number;                   // answers set aside because a log did not decode
  decodeFailed: Array<{ pool: string; blockNumber: number; logIndex: number; error: string }>;  // no endpoint decoded it
  refusals: Array<{ endpoint: string; kind: RpcKind; code: number | null; message: string }>;
  servedBy: Record<string, number>;
}
export interface ScanResult {
  from: number; to: number; servedTo: number;
  rows: Map<string, ScanRow[]>;            // key: checksummed pool; every requested pool has an entry
  holes: Map<string, number[]>;            // key: checksummed pool; blocks holding a log no endpoint decoded
  stats: ScanStats; stopReason: null | "chunk-budget" | "time-budget" | "unserved";
}

/** Blocks a historical chunk must sit below every known head before round-robin may spread it across endpoints. */
export const HISTORICAL_DEPTH = 200;

export const newScanStats = (): ScanStats => ({
  chunks: 0, logs: 0, decoded: 0, unmatched: 0, anomalies: 0, programmingErrors: 0, decodeRetries: 0,
  decodeFailed: [], refusals: [], servedBy: {},
});

/** min(known heads), or null when no head is known. */
export function minKnownHead(heads: number[]): number | null {
  const known = heads.filter((h) => Number.isSafeInteger(h) && h >= 0);
  return known.length ? Math.min(...known) : null;
}

type Failed = ScanStats["decodeFailed"][number];
interface Answer { url: string; rows: Map<string, ScanRow[]>; failed: Failed[] }

/**
 * Swap logs of `specs` over [from, to], chunk by chunk, total (never throws). `servedTo` is the end of the last chunk
 * served contiguously from `from` (`from - 1` if none); rows and holes beyond it are never reported.
 */
export async function scanRange(rpcs: string[], specs: PoolSpec[], from: number, to: number, o: ScanOptions): Promise<ScanResult> {
  const now = o.now ?? Date.now;
  const fetchImpl = o.fetchImpl ?? fetch;
  const t0 = now();
  const stats = newScanStats();
  const out: ScanResult = { from, to, servedTo: from - 1, rows: new Map(), holes: new Map(), stats, stopReason: null };
  const holeSets = new Map<string, Set<number>>();
  try {
    const want = new Map<string, { spec: PoolSpec; pool: string }>();
    for (const s of specs) {
      const pool = getAddress(s.pool);
      if (!want.has(pool.toLowerCase())) want.set(pool.toLowerCase(), { spec: s, pool });
      out.rows.set(pool, []);
    }
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0) {
      stats.programmingErrors++;
      stats.refusals.push({ endpoint: "", kind: "malformed-request", code: null, message: `scanRange: bad range ${from}..${to}` });
      out.stopReason = "unserved";
      return out;
    }
    if (to < from || want.size === 0) return out;          // never from > to, never an empty address list
    const addresses = [...want.values()].map((w) => w.pool);
    const left = () => o.deadlineMs - (now() - t0);

    for (let k = 0, b = from; b <= to; k++, b += LOG_RANGE) {
      if (stats.chunks >= o.maxChunks) { out.stopReason = "chunk-budget"; break; }
      if (left() < MIN_REQUEST_MS) { out.stopReason = "time-budget"; break; }
      const end = Math.min(b + LOG_RANGE - 1, to);
      const floor = minKnownHead(o.heads);
      const rotate = o.endpointOrder === "roundRobin" && floor !== null && end <= floor - HISTORICAL_DEPTH;
      const order = rpcs.map((_, i) => (rotate ? (i + k) % rpcs.length : i));

      let clean: Answer | null = null;
      let partial: Answer | null = null;
      let outOfTime = false;
      for (const idx of order) {
        const head = o.heads[idx];
        if (!Number.isSafeInteger(head) || head < end) continue;   // HARD RULE: never ask above a reported head
        const budget = left();
        if (budget < MIN_REQUEST_MS) { outOfTime = true; break; }
        const url = rpcs[idx];
        const a = await rpcRaw<unknown>(url, "eth_getLogs",
          [{ address: addresses, topics: [SWAP_TOPIC0], fromBlock: hex(b), toBlock: hex(end) }],
          Math.min(MAX_REQUEST_MS, budget), fetchImpl);
        if (!a.ok) {
          stats.refusals.push({ endpoint: url, kind: a.kind, code: a.code, message: a.message });
          if (a.kind === "malformed-request") stats.programmingErrors++;
          continue;
        }
        const ans = readAnswer(a.result, b, end, want, stats);
        if (typeof ans === "string") {
          stats.anomalies++;
          stats.refusals.push({ endpoint: url, kind: "rpc", code: null, message: `anomaly: ${ans}` });
          continue;                                                // reject this endpoint's whole answer
        }
        const answer: Answer = { url, ...ans };
        if (answer.failed.length === 0) { clean = answer; break; }
        stats.decodeRetries++;                                     // ask the next endpoint
        if (partial === null || answer.failed.length < partial.failed.length) partial = answer;
      }

      const pick = clean ?? partial;
      if (pick === null) { out.stopReason = outOfTime ? "time-budget" : "unserved"; break; }
      for (const f of pick.failed) {
        stats.decodeFailed.push(f);
        let set = holeSets.get(f.pool);
        if (!set) holeSets.set(f.pool, (set = new Set()));
        set.add(f.blockNumber);
      }
      let n = 0;
      for (const [pool, rows] of pick.rows) {
        const into = out.rows.get(pool)!;
        for (const r of rows) into.push(r);
        n += rows.length;
      }
      stats.logs += n + pick.failed.length;
      stats.decoded += n;
      stats.chunks++;
      out.servedTo = end;
      stats.servedBy[pick.url] = (stats.servedBy[pick.url] ?? 0) + 1;
    }
  } catch (e) {
    // Only a programming error can land here (a malformed pool address, say). Progress so far is kept.
    stats.programmingErrors++;
    stats.refusals.push({ endpoint: "", kind: "malformed-request", code: null, message: `scanRange: ${e instanceof Error ? e.message : String(e)}` });
    out.stopReason = "unserved";
  }
  for (const rows of out.rows.values()) rows.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  for (const [pool, set] of holeSets) out.holes.set(pool, [...set].sort((x, y) => x - y));
  return out;
}

/**
 * One endpoint's answer for chunk [b, end], or a string naming why the whole answer is rejected. A log for an address
 * that is not a requested pool, or whose topic0 is not Swap, is dropped and counted (it cannot be our pool's Swap); a
 * Swap log of a requested pool that will not decode is returned in `failed`.
 */
function readAnswer(result: unknown, b: number, end: number, want: Map<string, { spec: PoolSpec; pool: string }>, stats: ScanStats):
    { rows: Map<string, ScanRow[]>; failed: Failed[] } | string {
  if (!Array.isArray(result)) return `result is not an array (${result === null ? "null" : typeof result})`;
  for (const l of result) {
    if (l === null || typeof l !== "object") return "a log is not an object";
    const log = l as { blockNumber?: unknown; logIndex?: unknown; removed?: unknown };
    const bn = parseQuantity(log.blockNumber);
    if (bn === null || bn < b || bn > end) return `log block ${String(log.blockNumber)} outside ${b}..${end}`;
    if (parseQuantity(log.logIndex) === null) return `log index ${String(log.logIndex)} is not a quantity`;
    if (log.removed === true) return `removed log at block ${bn}`;
  }
  const rows = new Map<string, ScanRow[]>();
  const seen = new Map<string, ScanRow>();
  const failed: Failed[] = [];
  let unmatched = 0;
  for (const l of result as Array<RawSwapLog & { blockHash?: unknown }>) {
    const w = want.get(lower(l.address));
    if (!w || !Array.isArray(l.topics) || lower(l.topics[0]) !== SWAP_TOPIC0) { unmatched++; continue; }
    const ds = newSwapScanStats();
    const row = decodeSwapLog(l, w.spec, ds);
    const blockNumber = parseQuantity(l.blockNumber)!;
    const logIndex = parseQuantity(l.logIndex)!;
    if (!row) {
      failed.push({ pool: w.pool, blockNumber, logIndex, error: ds.undecodable[0]?.error ?? "undecodable" });
      continue;
    }
    const r: ScanRow = { ...row, blockHash: typeof l.blockHash === "string" ? l.blockHash.toLowerCase() : null };
    const key = `${w.pool}:${blockNumber}:${logIndex}`;
    const dup = seen.get(key);
    if (dup) {
      if (dup.equityAbs !== r.equityAbs || dup.priceE18 !== r.priceE18) return `two different logs at ${blockNumber}:${logIndex}`;
      continue;                                                    // the same log twice in one answer: keep one
    }
    seen.set(key, r);
    let list = rows.get(w.pool);
    if (!list) rows.set(w.pool, (list = []));
    list.push(r);
  }
  stats.unmatched += unmatched;
  return { rows, failed };
}
