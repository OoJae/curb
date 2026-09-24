/**
 * viem public client for X Layer (chain 196). Only /clock, /scorecard, /notes and /depth import this.
 *
 * rpc.xlayer.tech allows ~7 requests/s per IP and 100 blocks per eth_getLogs; xlayer.drpc.org is the
 * fallback. Measured 24 Sep: JSON-RPC batching does not help — rpc.xlayer.tech counts batch ITEMS against
 * its per-second limit (items 6+ of a 10-item getLogs batch fail -32016 "over rate limit"), and drpc's
 * free plan rejects batches of more than 3. So viem's HTTP batching is off, reads are aggregated with
 * Multicall3 instead, and every outgoing request takes a slot from ratelimit.ts (≤ 5 in any second,
 * shared with rpc-lite), so a page cannot trip the limit on its own.
 */
import {
  createClient, defineChain, fallback, http,
  type Abi, type Client, type ContractFunctionArgs, type ContractFunctionName, type GetLogsParameters,
  type Log, type MulticallParameters, type ReadContractParameters, type Transport, type WaitForTransactionReceiptParameters,
} from "viem";
import { getBlock, getBlockNumber, getLogs, multicall, readContract, simulateContract, waitForTransactionReceipt } from "viem/actions";
import { CHAIN_ID, MULTICALL3, OKLINK, RPC_URLS } from "./addresses.ts";
import { rpcSlot } from "./ratelimit.ts";

export const xLayer = defineChain({
  id: CHAIN_ID,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [...RPC_URLS] } },
  blockExplorers: { default: { name: "OKLink", url: OKLINK } },
  contracts: { multicall3: { address: MULTICALL3, blockCreated: 47416 } },
});

/** rpc.xlayer.tech caps eth_getLogs at 100 blocks; the browser never asks for more. */
export const MAX_LOG_RANGE = 100;

const limitedFetch: typeof fetch = async (input, init) => {
  await rpcSlot(1);
  return fetch(input, init);
};

let base: Client<Transport, typeof xLayer> | null = null;

/** The bare viem client (no action bundle attached, so only the actions below are shipped). */
export function baseClient(): Client<Transport, typeof xLayer> {
  if (!base) {
    base = createClient({
      chain: xLayer,
      batch: { multicall: { wait: 16 } },
      transport: fallback(
        RPC_URLS.map((url) => http(url, { batch: false, retryCount: 1, timeout: 10_000, fetchFn: limitedFetch })),
        { rank: false, retryCount: 1 },
      ),
    });
  }
  return base;
}

/**
 * The public actions the site uses, bound to the bare client. `createPublicClient` would attach every
 * public action viem has (~96 KB gz measured for a page reader); importing these from viem/actions
 * tree-shakes to ~40 KB gz, inside the spec's 50 KB viem-chunk budget. Same call shapes as a PublicClient.
 */
export function publicClient() {
  const c = baseClient();
  return {
    /** The latest block (the site never asks for another). */
    getBlock: (_?: { blockTag?: "latest" }) => getBlock(c, { blockTag: "latest" }),
    getBlockNumber: () => getBlockNumber(c, { cacheTime: 0 }),
    readContract: <
      const abi extends Abi | readonly unknown[],
      functionName extends ContractFunctionName<abi, "pure" | "view">,
      const args extends ContractFunctionArgs<abi, "pure" | "view", functionName>,
    >(a: ReadContractParameters<abi, functionName, args>) => readContract(c, a),
    multicall: <const contracts extends readonly unknown[], allowFailure extends boolean = true>(
      a: MulticallParameters<contracts, allowFailure>,
    ) => multicall(c, a),
    getLogs: (a: GetLogsParameters<any, any, any>) => getLogs(c, a) as Promise<Log<bigint, number, false, any, true>[]>,
    simulateContract: (a: any) => simulateContract(c, a) as Promise<{ result: unknown; request: any }>,
    waitForTransactionReceipt: (a: WaitForTransactionReceiptParameters<typeof xLayer>) => waitForTransactionReceipt(c, a),
  };
}

/** Fixed-point integer → float, for display only (18 dp shares/prices, 6 dp USDG). */
export function units(v: bigint | null | undefined, decimals = 18): number {
  if (v === null || v === undefined) return 0;
  const s = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const n = Number(a / s) + Number(a % s) / Number(s);
  return neg ? -n : n;
}
