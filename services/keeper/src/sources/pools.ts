/**
 * Pool reads: the price side of Curb.
 *
 * The attestor answers "is the primary market open". The keeper answers "what is this thing worth
 * while it is shut", and the only live evidence during a closure is the AMM, which keeps trading
 * because nothing stops it. So every number here comes from a Uniswap V3-style pool: the spot price
 * from `slot0`, the manipulation guard from the pool's own `observe` oracle, and traded volume from
 * `Swap` logs.
 *
 * The price arithmetic is deliberately identical to `Scorecard._priceFromSqrt`, because a mark
 * computed in different units from the price it is graded against is a silently wrong row that the
 * contract can never revise. The one fact that makes this easy to get wrong: three of the five live
 * pools list the stable as token0, so which side is the equity is detected, never assumed.
 */
import { Interface, getAddress } from "ethers";
import { rpcAny, multicallAt, LOG_RANGE } from "./chain.ts";
import type { Call, CallResult, PinnedBlock, MulticallSnapshot } from "./chain.ts";

export const Q96 = 1n << 96n;

export const poolAbi = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

export const erc20Abi = new Interface(["function decimals() view returns (uint8)"]);

export interface PoolSpec {
  wrapper: string;
  symbol: string;
  pool: string;
  equityIsToken0: boolean;
  equityDecimals: number;
  stableDecimals: number;
}

/**
 * sqrtPriceX96 -> 1e18 stable units per wrapper share.
 * Mirrors Scorecard._priceFromSqrt exactly, including the order of divisions, so an onchain
 * settlement and an offchain mark can never disagree because of rounding.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, s: Pick<PoolSpec, "equityIsToken0" | "equityDecimals" | "stableDecimals">): bigint {
  const half = (sqrtPriceX96 * sqrtPriceX96) / Q96;
  if (half === 0n) return 0n;
  const scale = 10n ** BigInt(s.equityDecimals);
  const stable = 10n ** BigInt(s.stableDecimals);
  return s.equityIsToken0
    ? (half * (10n ** 18n) * scale) / Q96 / stable
    : ((10n ** 18n) * scale * Q96) / half / stable;
}

/** Average tick over a window, from the pool's own oracle: what the settlement guard will compare against. */
export function twapTick(cumulatives: bigint[], windowS: number): number {
  return Number((cumulatives[0] - cumulatives[1]) / BigInt(windowS));
}

export interface PoolRead {
  pool: string;
  wrapper: string;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  priceE18: bigint;
  observationCardinality: number;
}

export function poolCalls(spec: PoolSpec): Call[] {
  const p = getAddress(spec.pool);
  return [
    { label: `slot0:${p}`, target: p, callData: poolAbi.encodeFunctionData("slot0") },
    { label: `liq:${p}`, target: p, callData: poolAbi.encodeFunctionData("liquidity") },
  ];
}

export function decodePool(spec: PoolSpec, results: CallResult[]): PoolRead | null {
  const p = getAddress(spec.pool);
  const slot = results.find((r) => r.label === `slot0:${p}`);
  const liq = results.find((r) => r.label === `liq:${p}`);
  if (!slot?.success) return null;
  try {
    const d = poolAbi.decodeFunctionResult("slot0", slot.returnData);
    const sqrtPriceX96 = BigInt(d[0]);
    return {
      pool: p,
      wrapper: getAddress(spec.wrapper),
      sqrtPriceX96,
      tick: Number(d[1]),
      observationCardinality: Number(d[3]),
      liquidity: liq?.success ? BigInt(poolAbi.decodeFunctionResult("liquidity", liq.returnData)[0]) : 0n,
      priceE18: priceFromSqrt(sqrtPriceX96, spec),
    };
  } catch {
    return null;
  }
}

/** One pinned multicall covering every pool, so all marks in a round share one chain state. */
export async function readPools(block: PinnedBlock, specs: PoolSpec[], rpcs: string[]): Promise<{ snapshot: MulticallSnapshot; reads: Map<string, PoolRead> }> {
  const snapshot = await multicallAt(block, specs.flatMap(poolCalls), rpcs);
  const reads = new Map<string, PoolRead>();
  for (const s of specs) {
    const r = decodePool(s, snapshot.results);
    if (r) reads.set(getAddress(s.wrapper), r);
  }
  return { snapshot, reads };
}

/** Token decimals, read once at startup: a wrong decimal is a 10^n error in every row after it. */
export async function readDecimals(pool: string, wrapper: string, rpcs: string[]): Promise<PoolSpec["equityIsToken0"] extends never ? never : { equityIsToken0: boolean; equityDecimals: number; stableDecimals: number }> {
  const token0 = getAddress(String(poolAbi.decodeFunctionResult("token0", await rpcAny<string>(rpcs, "eth_call", [{ to: pool, data: poolAbi.encodeFunctionData("token0") }, "latest"]))[0]));
  const token1 = getAddress(String(poolAbi.decodeFunctionResult("token1", await rpcAny<string>(rpcs, "eth_call", [{ to: pool, data: poolAbi.encodeFunctionData("token1") }, "latest"]))[0]));
  const w = getAddress(wrapper);
  if (token0 !== w && token1 !== w) throw new Error(`pool ${pool} does not hold ${wrapper}`);
  const equityIsToken0 = token0 === w;
  const stable = equityIsToken0 ? token1 : token0;
  const dec = async (t: string) =>
    Number(erc20Abi.decodeFunctionResult("decimals", await rpcAny<string>(rpcs, "eth_call", [{ to: t, data: erc20Abi.encodeFunctionData("decimals") }, "latest"]))[0]);
  return { equityIsToken0, equityDecimals: await dec(w), stableDecimals: await dec(stable) };
}

export interface SwapRow {
  blockNumber: number;
  logIndex: number;
  /** Positive size of the equity leg traded, in raw wrapper units. */
  equityAbs: bigint;
  /** Price implied by the pool AFTER this swap, 1e18. */
  priceE18: bigint;
}

/**
 * Swap events over a block range, decoded into (size, price) pairs for a volume-weighted average.
 * Pages in 100-block windows: the public RPC refuses anything wider, and a node that has not yet
 * indexed a block answers with an empty list rather than an error, so a chunk is only accepted from
 * an endpoint whose head has reached its end.
 */
export async function swapsInRange(rpcs: string[], spec: PoolSpec, fromBlock: number, toBlock: number): Promise<SwapRow[]> {
  const topic = poolAbi.getEvent("Swap")!.topicHash;
  const out: SwapRow[] = [];
  const heads = await Promise.all(rpcs.map((u) => rpcAny<string>([u], "eth_blockNumber", []).then((h) => Number(BigInt(h)), () => -1)));
  for (let b = fromBlock; b <= toBlock; b += LOG_RANGE) {
    const end = Math.min(b + LOG_RANGE - 1, toBlock);
    let logs: { blockNumber: string; logIndex: string; data: string }[] | null = null;
    for (const [i, url] of rpcs.entries()) {
      if (heads[i] < end) continue;
      try {
        logs = await rpcAny([url], "eth_getLogs", [{ address: getAddress(spec.pool), topics: [topic], fromBlock: "0x" + b.toString(16), toBlock: "0x" + end.toString(16) }]);
        break;
      } catch { /* try the next endpoint */ }
    }
    if (!logs) throw new Error(`no RPC could serve Swap logs for ${b}..${end}`);
    for (const l of logs) {
      try {
        const d = poolAbi.decodeEventLog("Swap", l.data, []);
        const amount0 = BigInt(d[2]);
        const amount1 = BigInt(d[3]);
        const equity = spec.equityIsToken0 ? amount0 : amount1;
        out.push({
          blockNumber: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          equityAbs: equity < 0n ? -equity : equity,
          priceE18: priceFromSqrt(BigInt(d[4]), spec),
        });
      } catch { /* a malformed log is evidence of nothing; skip it */ }
    }
  }
  return out;
}

/** Volume-weighted average price over a set of swaps; null when nothing traded. */
export function vwap(rows: SwapRow[]): bigint | null {
  let num = 0n;
  let den = 0n;
  for (const r of rows) {
    if (r.equityAbs === 0n || r.priceE18 === 0n) continue;
    num += r.priceE18 * r.equityAbs;
    den += r.equityAbs;
  }
  return den === 0n ? null : num / den;
}

/** Swap logs for several pools in one pass, keyed by pool address. One query per 100-block chunk. */
export async function scanSwaps(rpcs: string[], specs: PoolSpec[], fromBlock: number, toBlock: number): Promise<Map<string, SwapRow[]>> {
  const topic = poolAbi.getEvent("Swap")!.topicHash;
  const byPool = new Map<string, SwapRow[]>();
  const spec = new Map(specs.map((s) => [getAddress(s.pool).toLowerCase(), s]));
  for (const s of specs) byPool.set(getAddress(s.pool), []);
  if (toBlock < fromBlock) return byPool;

  const heads = await Promise.all(rpcs.map((u) => rpcAny<string>([u], "eth_blockNumber", []).then((h) => Number(BigInt(h)), () => -1)));
  for (let b = fromBlock; b <= toBlock; b += LOG_RANGE) {
    const end = Math.min(b + LOG_RANGE - 1, toBlock);
    let logs: { address: string; blockNumber: string; logIndex: string; data: string }[] | null = null;
    for (const [i, url] of rpcs.entries()) {
      if (heads[i] < end) continue;
      try {
        logs = await rpcAny([url], "eth_getLogs", [{
          address: specs.map((s) => getAddress(s.pool)),
          topics: [topic],
          fromBlock: "0x" + b.toString(16),
          toBlock: "0x" + end.toString(16),
        }]);
        break;
      } catch { /* next endpoint */ }
    }
    if (!logs) throw new Error(`no RPC could serve Swap logs for ${b}..${end}`);
    for (const l of logs) {
      const s = spec.get(String(l.address).toLowerCase());
      if (!s) continue;
      try {
        const d = poolAbi.decodeEventLog("Swap", l.data, []);
        const equity = s.equityIsToken0 ? BigInt(d[2]) : BigInt(d[3]);
        byPool.get(getAddress(s.pool))!.push({
          blockNumber: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          equityAbs: equity < 0n ? -equity : equity,
          priceE18: priceFromSqrt(BigInt(d[4]), s),
        });
      } catch { /* skip a malformed log */ }
    }
  }
  return byPool;
}
