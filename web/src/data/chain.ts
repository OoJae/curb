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
import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";
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

let client: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: xLayer,
      batch: { multicall: { wait: 16 } },
      transport: fallback(
        RPC_URLS.map((url) => http(url, { batch: false, retryCount: 1, timeout: 10_000, fetchFn: limitedFetch })),
        { rank: false, retryCount: 1 },
      ),
    }) as PublicClient;
  }
  return client;
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
