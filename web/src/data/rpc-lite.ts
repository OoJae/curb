/**
 * The global regime chip's only chain read, without viem: one JSON-RPC batch POST of
 * [eth_blockNumber, eth_call MarketClock.stateOf(wrapper)] (one request against the 7 req/s limit),
 * to rpc.xlayer.tech, falling back to xlayer.drpc.org. Both answer CORS `*`.
 *
 * Selector and layout checked against forge's out/MarketClock.sol/MarketClock.json:
 *   stateOf(address) = 0x45b4903a, returns the static tuple
 *   (uint8 regime, uint128 primaryCapUsd, uint64 nextTransitionAt, uint64 observedAt, uint32 multiplierNonce, bool halted)
 * i.e. exactly six 32-byte words, no offset word (every member is static).
 */
import { MARKET_CLOCK, RPC_URLS } from "./addresses.ts";

export const STATE_OF_SELECTOR = "0x45b4903a";

export interface RawState {
  regime: number;
  /** Whole USD. */
  cap: bigint;
  /** Unix seconds (0 = unknown). */
  nextTransitionAt: number;
  observedAt: number;
  multiplierNonce: number;
  halted: boolean;
  block: number | null;
}

/** Hand decode of the six-word return. Throws on anything else (e.g. `0x` from a wrong address). */
export function decodeStateOf(hex: string): Omit<RawState, "block"> {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 6 * 64) throw new Error(`stateOf: expected 192 bytes, got ${h.length / 2}`);
  const w = (i: number) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
  return {
    regime: Number(w(0)),
    cap: w(1),
    nextTransitionAt: Number(w(2)),
    observedAt: Number(w(3)),
    multiplierNonce: Number(w(4)),
    halted: w(5) !== 0n,
  };
}

export function stateOfCalldata(wrapper: string): string {
  return STATE_OF_SELECTOR + wrapper.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`${url}: http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** MarketClock.stateOf(wrapper) at the latest block, with that block's number. */
export async function readStateOf(wrapper: string, signal?: AbortSignal): Promise<RawState> {
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: MARKET_CLOCK, data: stateOfCalldata(wrapper) }, "latest"] },
  ];
  let lastErr: unknown;
  for (const url of RPC_URLS) {
    try {
      const out = await post(url, batch, signal);
      const arr: any[] = Array.isArray(out) ? out : [out];
      const byId = (id: number) => arr.find((r) => r && r.id === id);
      const call = byId(2);
      if (!call || call.error || typeof call.result !== "string") throw new Error(`${url}: ${call?.error?.message ?? "no eth_call result"}`);
      const bn = byId(1)?.result;
      return { ...decodeStateOf(call.result), block: typeof bn === "string" ? Number(BigInt(bn)) : null };
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
