/**
 * The global regime chip's chain read (and the home page's record line), without viem: one JSON-RPC
 * batch POST of [eth_blockNumber, eth_call …] to rpc.xlayer.tech, falling back to xlayer.drpc.org. Both
 * answer CORS `*`. Each batch item counts against the ~7/s limit, so every batch takes its slots from
 * ratelimit.ts; batches stay ≤ 3 items (drpc's free-plan maximum).
 *
 * Selector and layout checked against forge's out/MarketClock.sol/MarketClock.json:
 *   stateOf(address) = 0x45b4903a, returns the static tuple
 *   (uint8 regime, uint128 primaryCapUsd, uint64 nextTransitionAt, uint64 observedAt, uint32 multiplierNonce, bool halted)
 * i.e. exactly six 32-byte words, no offset word (every member is static).
 */
import { MARKET_CLOCK, RPC_URLS, SCORECARD } from "./addresses.ts";
import { rpcSlot } from "./ratelimit.ts";

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

/** Scorecard selectors, checked against out/Scorecard.sol: skill() → 3 words, closureCount() → 1 word. */
export const SKILL_SELECTOR = "0x6fcb6dc6";
export const CLOSURE_COUNT_SELECTOR = "0xece527e2";

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

/**
 * One batch: eth_blockNumber + the given eth_calls at "latest" (≤ 3 items, the most drpc's free plan
 * accepts). Returns [blockNumber | null, ...call results as hex]. Tries each RPC in turn.
 */
async function batchCalls(calls: { to: string; data: string }[], signal?: AbortSignal): Promise<[number | null, ...string[]]> {
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] },
    ...calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [c, "latest"] })),
  ];
  let lastErr: unknown;
  for (const url of RPC_URLS) {
    try {
      await rpcSlot(batch.length); // the RPC counts each batch item
      const out = await post(url, batch, signal);
      const arr: any[] = Array.isArray(out) ? out : [out];
      const byId = (id: number) => arr.find((r) => r && r.id === id);
      const results = calls.map((_, i) => {
        const r = byId(i + 1);
        if (!r || r.error || typeof r.result !== "string") throw new Error(`${url}: ${r?.error?.message ?? "no eth_call result"}`);
        return r.result as string;
      });
      const bn = byId(0)?.result;
      return [typeof bn === "string" ? Number(BigInt(bn)) : null, ...results];
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** MarketClock.stateOf(wrapper) at the latest block, with that block's number. */
export async function readStateOf(wrapper: string, signal?: AbortSignal): Promise<RawState> {
  const [block, hex] = await batchCalls([{ to: MARKET_CLOCK, data: stateOfCalldata(wrapper) }], signal);
  return { ...decodeStateOf(hex), block };
}

export interface RawSkill {
  settled: number;
  beatLastPrint: number;
  beatClosingVwap: number;
  closureCount: number;
  block: number | null;
}

/** Scorecard.skill() and closureCount() without viem (the home page's record line). */
export async function readSkill(signal?: AbortSignal): Promise<RawSkill> {
  const [block, skill, count] = await batchCalls(
    [{ to: SCORECARD, data: SKILL_SELECTOR }, { to: SCORECARD, data: CLOSURE_COUNT_SELECTOR }],
    signal,
  );
  const h = skill.replace(/^0x/, "");
  if (h.length !== 3 * 64) throw new Error(`skill: expected 96 bytes, got ${h.length / 2}`);
  const w = (i: number) => Number(BigInt("0x" + h.slice(i * 64, (i + 1) * 64)));
  return { settled: w(0), beatLastPrint: w(1), beatClosingVwap: w(2), closureCount: Number(BigInt(count)), block };
}
