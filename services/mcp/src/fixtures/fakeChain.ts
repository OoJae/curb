/**
 * An in-memory X Layer for the tests: a ChainReader whose aggregate3 answers come from a function of
 * (contract, function name, decoded args). Calls are decoded and results encoded with the same ABIs the tools
 * use, so a test exercises the real encode/decode path. Returning `undefined` makes that sub-call fail, as a
 * revert does under allowFailure.
 */
import { getAddress } from "ethers";
import type { Interface } from "ethers";
import { clockAbi } from "../clock.ts";
import { scorecardAbi } from "../scorecard.ts";
import { creditAbi, depthAbi } from "../credit.ts";
import type { CallResult, ChainReader, LogEntry, LogFilter, PinnedBlock } from "../sources/chain.ts";

export const BLOCK: PinnedBlock = {
  number: 71_530_000,
  hash: "0x" + "ab".repeat(32),
  timestamp: Math.floor(Date.parse("2026-09-25T01:16:00Z") / 1000),
  rpc: "https://rpc.example",
};

export type Answer = (target: string, fn: string, args: unknown[]) => unknown[] | undefined;

const ABIS: Interface[] = [clockAbi, scorecardAbi, creditAbi, depthAbi];

export function fakeChain(answer: Answer, opts: { block?: PinnedBlock; logs?: (f: LogFilter) => LogEntry[] } = {}): ChainReader & { calls: number } {
  const block = opts.block ?? BLOCK;
  const reader = {
    rpcs: [block.rpc],
    calls: 0,
    async pin() { return block; },
    async multicall(b: PinnedBlock, calls: { label: string; target: string; callData: string }[]): Promise<CallResult[]> {
      reader.calls++;
      if (b.hash !== block.hash) throw new Error("pinned to an unknown block");
      return calls.map((c) => {
        const selector = c.callData.slice(0, 10);
        for (const abi of ABIS) {
          const f = abi.getFunction(selector);
          if (!f) continue;
          const args = [...abi.decodeFunctionData(f, c.callData)];
          const out = answer(getAddress(c.target), f.name, args);
          if (out === undefined) return { ...c, success: false, returnData: "0x" };
          return { ...c, success: true, returnData: abi.encodeFunctionResult(f, out) };
        }
        return { ...c, success: false, returnData: "0x" };
      });
    },
    last: () => block,
    async logs(f: LogFilter) { return opts.logs ? opts.logs(f) : []; },
  };
  return reader;
}

/** MarketClock state for one wrapper, as the fake answers it. */
export interface ClockState {
  regime: number;
  cap: bigint;
  toNext?: number;
  blackoutUntil?: number;
  observedAt?: number;
}

export function clockAnswer(states: Record<string, ClockState>, clock: string): Answer {
  return (target, fn, args) => {
    if (target !== getAddress(clock)) return undefined;
    const s = states[getAddress(String(args[0]))];
    if (!s) return undefined;
    switch (fn) {
      case "regime": return [s.regime];
      case "primaryCapNow": return [s.cap];
      case "secondsToNextTransition": return [s.toNext ?? 0];
      case "isInMultiplierBlackout": return [(s.blackoutUntil ?? 0) > BLOCK.timestamp];
      case "blackoutUntil": return [s.blackoutUntil ?? 0];
      case "stateOf": return [[s.regime, s.cap, s.toNext ? BLOCK.timestamp + s.toNext : 0, s.observedAt ?? BLOCK.timestamp - 30, 0, false]];
    }
    return undefined;
  };
}
