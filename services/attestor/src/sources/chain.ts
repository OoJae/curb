/**
 * Onchain reads, polled and pinned. Never event-driven.
 *
 * xStocks corporate actions activate on a timestamp and emit no event, so nothing here listens for
 * logs. Every tick makes ONE Multicall3.aggregate3 call, pinned by block hash (EIP-1898) so every
 * value in a round comes from a single, re-queryable chain state. The block hash and the raw return
 * data are committed as CHAIN_CALL leaves, so a verifier can re-run the exact call later.
 *
 * Two public RPCs are raced. An endpoint more than MAX_LAG_BLOCKS behind the best head is rejected,
 * because a lagging node would silently attest an old nonce.
 */
import { Interface, getAddress } from "ethers";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const DEFAULT_RPCS = ["https://rpc.xlayer.tech", "https://xlayer.drpc.org"];
const MAX_LAG_BLOCKS = 5;

const multicall = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);

export const rawToken = new Interface([
  "function getCurrentMultiplier() view returns (uint256, uint256, uint256)",
  "function newMultiplier() view returns (uint256)",
  "function newMultiplierActivationTime() view returns (uint256)",
  "function newMultiplierNonce() view returns (uint256)",
]);

export const clockAbi = new Interface([
  "function registeredCount() view returns (uint256)",
  "function registered(uint256) view returns (address)",
  "function assets(address) view returns (address raw, bytes4 mic, uint8 hoursMode, bool registered)",
  "function stateOf(address) view returns ((uint8 regime, uint128 primaryCapUsd, uint64 nextTransitionAt, uint64 observedAt, uint32 multiplierNonce, bool halted))",
  "function blackoutUntil(address) view returns (uint64)",
  "function isAttestor(address) view returns (bool)",
  "function attestBatch(address[] wrappers, uint8[] regimes, uint128[] caps, uint64[] nextAt, bool[] halted, bytes32 inputRoot)",
  "event StateAttested(address indexed wrapper, uint8 regime, uint128 primaryCapUsd, uint64 nextTransitionAt, uint32 multiplierNonce, bytes32 inputRoot)",
  "event RegimeChanged(address indexed wrapper, uint8 from, uint8 to, uint64 at)",
  "event BlackoutOpened(address indexed wrapper, uint32 fromNonce, uint32 toNonce, uint64 until)",
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

async function rpc<T>(url: string, method: string, params: unknown[], timeoutMs = 8000): Promise<T> {
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

/**
 * The best head across all RPCs, rejecting any endpoint lagging more than MAX_LAG_BLOCKS.
 *
 * Retries with backoff: a cold container measured 2.6s for a single rpc.xlayer.tech round trip
 * (DNS + TLS + request), so one short timeout on every endpoint at once can fail a healthy host.
 */
export async function pinLatest(rpcs = DEFAULT_RPCS, attempts = 3): Promise<PinnedBlock> {
  const reasons: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const heads = await Promise.allSettled(
      rpcs.map(async (url) => {
        const b = await rpc<{ number: string; hash: string; timestamp: string }>(url, "eth_getBlockByNumber", ["latest", false], 8000);
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
      if (h.status === "rejected") reasons.push(`attempt ${attempt} ${rpcs[i]}: ${describe(h.reason)}`);
    });
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  throw new Error(`no RPC returned a head after ${attempts} attempts: ${reasons.join(" | ")}`);
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return `${e.name}: ${e.message}${cause ? ` (${cause.code ?? cause.message})` : ""}`;
}

/** One aggregate3 call, pinned to an exact block hash. allowFailure is always true so one bad target
 *  cannot hide the rest; a failed read is surfaced explicitly rather than decoded as zero. */
export async function multicallAt(block: PinnedBlock, calls: Call[], rpcs = DEFAULT_RPCS): Promise<MulticallSnapshot> {
  const data = multicall.encodeFunctionData("aggregate3", [
    calls.map((c) => ({ target: getAddress(c.target), allowFailure: true, callData: c.callData })),
  ]);
  // Prefer the RPC that produced the pinned head; fall back to the others at the same block hash.
  const order = [block.rpc, ...rpcs.filter((u) => u !== block.rpc)];
  let lastErr: unknown;
  for (const url of order) {
    try {
      const out = await rpc<string>(url, "eth_call", [{ to: MULTICALL3, data }, { blockHash: block.hash }]);
      const [decoded] = multicall.decodeFunctionResult("aggregate3", out);
      const results: CallResult[] = calls.map((c, i) => ({
        ...c,
        success: Boolean(decoded[i][0]),
        returnData: String(decoded[i][1]),
      }));
      return { block, results };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`multicall failed on every RPC: ${String(lastErr)}`);
}

export function balanceCall(addr: string): Call {
  return { label: `balance:${getAddress(addr)}`, target: MULTICALL3, callData: multicall.encodeFunctionData("getEthBalance", [addr]) };
}

export function decodeBalance(r: CallResult): bigint | null {
  if (!r.success) return null;
  return multicall.decodeFunctionResult("getEthBalance", r.returnData)[0] as bigint;
}

/** The per-raw-token reads that drive blackout scheduling. */
export function rawTokenCalls(raw: string): Call[] {
  const t = getAddress(raw);
  return [
    { label: `gcm:${t}`, target: t, callData: rawToken.encodeFunctionData("getCurrentMultiplier") },
    { label: `newMult:${t}`, target: t, callData: rawToken.encodeFunctionData("newMultiplier") },
    { label: `newAct:${t}`, target: t, callData: rawToken.encodeFunctionData("newMultiplierActivationTime") },
    { label: `newNonce:${t}`, target: t, callData: rawToken.encodeFunctionData("newMultiplierNonce") },
  ];
}

export interface RawTokenState {
  raw: string;
  multiplier: bigint | null;
  middle: bigint | null;
  nonce: bigint | null;
  newMultiplier: bigint | null;
  newActivationTime: bigint | null;
  newNonce: bigint | null;
  /** True if getCurrentMultiplier itself failed. For HK names whose nonce is legitimately 0, a failed
   *  read is otherwise indistinguishable from "no corporate action", so it must be alarmed on. */
  readFailed: boolean;
}

export function decodeRawToken(raw: string, results: CallResult[]): RawTokenState {
  const t = getAddress(raw);
  const find = (p: string) => results.find((r) => r.label === `${p}:${t}`);
  // Total: an undecodable result (e.g. a raw address with no code returns "0x") is treated exactly like a
  // failed call, so one bad registered asset degrades itself instead of aborting every tick.
  const one = (p: string, fn: string) => {
    const r = find(p);
    if (!r || !r.success) return null;
    try { return rawToken.decodeFunctionResult(fn, r.returnData)[0] as bigint; } catch { return null; }
  };
  const gcm = find("gcm");
  let multiplier: bigint | null = null, middle: bigint | null = null, nonce: bigint | null = null;
  let readFailed = !gcm || !gcm.success;
  if (gcm && gcm.success) {
    try {
      const d = rawToken.decodeFunctionResult("getCurrentMultiplier", gcm.returnData);
      [multiplier, middle, nonce] = [d[0] as bigint, d[1] as bigint, d[2] as bigint];
    } catch {
      readFailed = true;
    }
  }
  return {
    raw: t, multiplier, middle, nonce,
    newMultiplier: one("newMult", "newMultiplier"),
    newActivationTime: one("newAct", "newMultiplierActivationTime"),
    newNonce: one("newNonce", "newMultiplierNonce"),
    readFailed,
  };
}

/** One JSON-RPC call, trying each endpoint in turn. */
export async function rpcAny<T>(rpcs: string[], method: string, params: unknown[], timeoutMs = 8000): Promise<T> {
  let last: unknown;
  for (const url of rpcs) {
    try {
      return await rpc<T>(url, method, params, timeoutMs);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`${method} failed on every RPC: ${describe(last)}`);
}

/** The public RPC caps eth_getLogs at a 100-block range. */
export const LOG_RANGE = 100;

export interface AttestedRound {
  txHash: string;
  blockNumber: number;
  inputRoot: string;
  /** Wrappers this write covered (StateAttested's indexed topic), checksummed. */
  wrappers: string[];
}

/**
 * Every MarketClock write in [fromBlock, toBlock], one entry per transaction.
 * StateAttested's last data word is the round's inputRoot; attestBatch emits one event per wrapper.
 *
 * A node that has not yet indexed a block answers eth_getLogs with an empty list, not an error. So each
 * chunk is only accepted from an endpoint whose head has reached the chunk's end; if none has, this throws
 * and the caller must not advance its cursor.
 */
export async function attestedRounds(rpcs: string[], clock: string, fromBlock: number, toBlock: number): Promise<AttestedRound[]> {
  const topic = clockAbi.getEvent("StateAttested")!.topicHash;
  const byTx = new Map<string, AttestedRound>();
  // Each endpoint's head, read once per scan (heads only move forward, so a head read before the queries
  // is a safe lower bound for what that endpoint has indexed).
  const heads = await Promise.all(rpcs.map((url) => rpc<string>(url, "eth_blockNumber", []).then((h) => Number(BigInt(h)), () => -1)));
  for (let b = fromBlock; b <= toBlock; b += LOG_RANGE) {
    const end = Math.min(b + LOG_RANGE - 1, toBlock);
    let logs: { transactionHash: string; blockNumber: string; data: string; topics: string[] }[] | null = null;
    const reasons: string[] = [];
    for (const [i, url] of rpcs.entries()) {
      try {
        const head = heads[i];
        if (head < end) { reasons.push(`${url} head ${head} < ${end}`); continue; }
        logs = await rpc(url, "eth_getLogs", [{ address: getAddress(clock), topics: [topic], fromBlock: "0x" + b.toString(16), toBlock: "0x" + end.toString(16) }]);
        break;
      } catch (e) {
        reasons.push(`${url}: ${describe(e)}`);
      }
    }
    if (!logs) throw new Error(`no RPC could serve logs for ${b}..${end}: ${reasons.join(" | ")}`);
    for (const l of logs) {
      const root = "0x" + l.data.slice(-64);
      const wrapper = getAddress("0x" + l.topics[1].slice(-40));
      const prev = byTx.get(l.transactionHash);
      if (prev) prev.wrappers.push(wrapper);
      else byTx.set(l.transactionHash, { txHash: l.transactionHash, blockNumber: Number(l.blockNumber), inputRoot: root, wrappers: [wrapper] });
    }
  }
  return [...byTx.values()].sort((a, b) => a.blockNumber - b.blockNumber);
}

export async function blockTimestamp(rpcs: string[], blockNumber: number): Promise<number> {
  const b = await rpcAny<{ timestamp: string } | null>(rpcs, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]);
  if (!b) throw new Error(`block ${blockNumber} not found`);
  return Number(BigInt(b.timestamp));
}

export interface TxInfo {
  hash: string;
  from: string;
  to: string | null;
  blockNumber: number;
  input: string;
}

export async function getTransaction(rpcs: string[], hash: string): Promise<TxInfo | null> {
  const t = await rpcAny<{ hash: string; from: string; to: string | null; blockNumber: string | null; input: string } | null>(rpcs, "eth_getTransactionByHash", [hash]);
  if (!t || !t.blockNumber) return null;
  return { hash: t.hash, from: getAddress(t.from), to: t.to ? getAddress(t.to) : null, blockNumber: Number(t.blockNumber), input: t.input };
}

export function clockCalls(clock: string, wrapper: string): Call[] {
  const c = getAddress(clock);
  const w = getAddress(wrapper);
  return [
    { label: `stateOf:${w}`, target: c, callData: clockAbi.encodeFunctionData("stateOf", [w]) },
    { label: `blackoutUntil:${w}`, target: c, callData: clockAbi.encodeFunctionData("blackoutUntil", [w]) },
  ];
}
