/**
 * X Layer reads, pinned to one block. The JSON-RPC, head and Multicall3 helpers are COPIED from
 * services/asp/src/sources/chain.ts (itself a copy of the keeper's); keep the copies in step.
 *
 * Differences from the asp copy, all deliberate:
 *   - Shorter deadlines. The asp reads on a background tick; here an agent is waiting on the answer, so a
 *     head read gets 4 s and two attempts, and an eth_call 6 s per endpoint, not 8 s and three attempts.
 *   - Only the read path: no attestation, log-scan or raw-token helpers.
 *   - `ChainReader` wraps pin + multicall and shares one head across concurrent tool calls for HEAD_TTL_MS,
 *     so a burst of calls costs one head read, not one per call per endpoint.
 *
 * Every tool answer comes from ONE aggregate3 call (or a short sequence of them) pinned by block hash
 * (EIP-1898), so every number in it describes the same chain state, and `asOf` names that block. A failed
 * sub-call is surfaced as a failure, never decoded as zero.
 *
 * Error strings name an endpoint by endpointLabel (position and origin), never by its full URL: they can
 * reach a tool result, and a keyed provider carries its API key in the URL.
 */
import { Interface, getAddress } from "ethers";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** drpc first: the attestor, keeper and asp lean on rpc.xlayer.tech, and this service need not add to it. */
export const DEFAULT_RPCS = ["https://xlayer.drpc.org", "https://rpc.xlayer.tech"];
const MAX_LAG_BLOCKS = 5;
const HEAD_TIMEOUT_MS = 4_000;
const CALL_TIMEOUT_MS = 6_000;

const multicall = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export interface Call {
  label: string;
  target: string;
  callData: string;
}

export interface CallResult extends Call {
  success: boolean;
  returnData: string;
}

export interface PinnedBlock {
  number: number;
  hash: string;
  timestamp: number;
  rpc: string;
}

export interface MulticallSnapshot {
  block: PinnedBlock;
  results: CallResult[];
}

let rpcId = 0;

/** How an RPC endpoint is named anywhere a person can read it: "rpc[1] https://host", never its path or query. */
export function endpointLabel(url: string, i: number): string {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? `rpc[${i}] ${origin}` : `rpc[${i}]`;
  } catch {
    return `rpc[${i}]`;
  }
}

async function rpc<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    if (json.result === undefined) throw new Error(`${method}: empty result`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return `${e.name}: ${e.message}${cause ? ` (${cause.code ?? cause.message})` : ""}`;
}

/** The best head across all RPCs, rejecting any endpoint lagging more than MAX_LAG_BLOCKS. */
export async function pinLatest(rpcs = DEFAULT_RPCS, attempts = 2): Promise<PinnedBlock> {
  const reasons: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const heads = await Promise.allSettled(
      rpcs.map(async (url) => {
        const b = await rpc<{ number: string; hash: string; timestamp: string }>(url, "eth_getBlockByNumber", ["latest", false], HEAD_TIMEOUT_MS);
        return { url, number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) };
      }),
    );
    const ok = heads.flatMap((h) => (h.status === "fulfilled" ? [h.value] : []));
    if (ok.length) {
      const best = Math.max(...ok.map((h) => h.number));
      const pick = ok.filter((h) => best - h.number <= MAX_LAG_BLOCKS).sort((a, b) => b.number - a.number)[0];
      return { number: pick.number, hash: pick.hash, timestamp: pick.timestamp, rpc: pick.url };
    }
    heads.forEach((h, i) => {
      if (h.status === "rejected") reasons.push(`attempt ${attempt} ${endpointLabel(rpcs[i], i)}: ${describe(h.reason)}`);
    });
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no RPC returned a head after ${attempts} attempts: ${reasons.join(" | ")}`);
}

/** One aggregate3 call, pinned to an exact block hash. allowFailure is always true so one bad target cannot hide the rest. */
export async function multicallAt(block: PinnedBlock, calls: Call[], rpcs = DEFAULT_RPCS): Promise<MulticallSnapshot> {
  const data = multicall.encodeFunctionData("aggregate3", [
    calls.map((c) => ({ target: getAddress(c.target), allowFailure: true, callData: c.callData })),
  ]);
  // Prefer the RPC that produced the pinned head; fall back to the others at the same block hash.
  const order = [block.rpc, ...rpcs.filter((u) => u !== block.rpc)];
  const reasons: string[] = [];
  for (const url of order) {
    try {
      const out = await rpc<string>(url, "eth_call", [{ to: MULTICALL3, data }, { blockHash: block.hash }], CALL_TIMEOUT_MS);
      const [decoded] = multicall.decodeFunctionResult("aggregate3", out);
      const results: CallResult[] = calls.map((c, i) => ({ ...c, success: Boolean(decoded[i][0]), returnData: String(decoded[i][1]) }));
      return { block, results };
    } catch (e) {
      reasons.push(`${endpointLabel(url, rpcs.indexOf(url))}: ${describe(e)}`);
    }
  }
  throw new Error(`multicall failed on every RPC: ${reasons.join(" | ")}`);
}

/** The block a tool answer is read at, as every answer reports it. */
export interface AsOf {
  block: number;
  blockHash: string;
  timestamp: number;
  time: string;
  rpc: string;
}

export function asOfBlock(b: PinnedBlock, rpcs: string[]): AsOf {
  const i = rpcs.indexOf(b.rpc);
  return { block: b.number, blockHash: b.hash, timestamp: b.timestamp, time: new Date(b.timestamp * 1000).toISOString(), rpc: endpointLabel(b.rpc, i < 0 ? 0 : i) };
}

/** The two chain operations the tools need; tests answer them from an in-memory contract. */
export interface ChainReader {
  rpcs: string[];
  pin(): Promise<PinnedBlock>;
  multicall(block: PinnedBlock, calls: Call[]): Promise<CallResult[]>;
  /** The last head pinned, for /healthz. */
  last?(): PinnedBlock | null;
  /** eth_getLogs over a range the public RPCs accept (at most 100 blocks), trying each endpoint in turn. */
  logs?(filter: LogFilter): Promise<LogEntry[]>;
}

export interface LogFilter {
  address: string;
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
}

export interface LogEntry {
  transactionHash: string;
  blockNumber: string;
  topics: string[];
  data: string;
}

const HEAD_TTL_MS = 2_000;

/**
 * The live reader. The head is shared for HEAD_TTL_MS (about two X Layer blocks) and single-flight, so a
 * burst of tool calls costs one head read. A failed head read is not cached.
 */
export function rpcChain(rpcs: string[], now: () => number = Date.now): ChainReader {
  let head: { atMs: number; p: Promise<PinnedBlock> } | null = null;
  let last: PinnedBlock | null = null;
  return {
    rpcs,
    pin() {
      if (head && now() - head.atMs < HEAD_TTL_MS) return head.p;
      const p = pinLatest(rpcs);
      const entry = { atMs: now(), p };
      head = entry;
      p.then((b) => { last = b; }, () => { if (head === entry) head = null; });
      return p;
    },
    last: () => last,
    async multicall(block, calls) {
      const snap = await multicallAt(block, calls, rpcs);
      if (snap.block.hash !== block.hash) throw new Error("multicall answered at a different block than the one pinned");
      return snap.results;
    },
    async logs(f) {
      const params = [{ address: getAddress(f.address), topics: f.topics, fromBlock: "0x" + f.fromBlock.toString(16), toBlock: "0x" + f.toBlock.toString(16) }];
      const reasons: string[] = [];
      for (const [i, url] of rpcs.entries()) {
        try { return await rpc<LogEntry[]>(url, "eth_getLogs", params, CALL_TIMEOUT_MS); } catch (e) { reasons.push(`${endpointLabel(url, i)}: ${describe(e)}`); }
      }
      throw new Error(`eth_getLogs failed on every RPC: ${reasons.join(" | ")}`);
    },
  };
}
