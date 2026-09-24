/**
 * /clock: the board of six, read from MarketClock in one Multicall3 call at one block, plus the latest
 * attestation round found by scanning back from the head in 100-block steps (at most 4 getLogs calls).
 */
import type { Log } from "viem";
import { ASSETS, MARKET_CLOCK, oklinkTx, roundBundleUrl } from "./addresses.ts";
import { marketClockAbi } from "./abi/marketClock.ts";
import { MAX_LOG_RANGE, publicClient } from "./chain.ts";
import { fixture, isMock } from "./mock.ts";
import { glyphOf, MAX_ATTESTATION_AGE_MS, regimeName } from "./regime.ts";
import { closureAt, nextChange, venueFor } from "./schedule.ts";
import type { Address, AssetBoard, AssetBoardRow, AttestationRound, Hex, RegimeName } from "./types.ts";

const stateAttested = marketClockAbi.find((e) => e.type === "event" && e.name === "StateAttested")!;
export const MAX_ROUND_SCAN_CALLS = 4;

export async function getBoard(opts: { withRound?: boolean } = {}): Promise<AssetBoard> {
  if (isMock()) return fixture("board");
  const client = publicClient();
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const blockTimeMs = Number(block.timestamp) * 1000;

  const contracts = [
    { address: MARKET_CLOCK, abi: marketClockAbi, functionName: "registeredCount" } as const,
    ...ASSETS.flatMap((a) => [
      { address: MARKET_CLOCK, abi: marketClockAbi, functionName: "stateOf", args: [a.wrapper] } as const,
      { address: MARKET_CLOCK, abi: marketClockAbi, functionName: "isInMultiplierBlackout", args: [a.wrapper] } as const,
    ]),
  ];
  const res = await client.multicall({ contracts, blockNumber, allowFailure: false });
  const registeredCount = Number(res[0] as bigint);

  // "now" is the chain's clock, not the visitor's: staleness is judged as MarketClock judges it.
  const now = blockTimeMs;
  const rows: AssetBoardRow[] = ASSETS.map((a, i) => {
    const s = res[1 + i * 2] as { regime: number; primaryCapUsd: bigint; nextTransitionAt: bigint; observedAt: bigint; multiplierNonce: number; halted: boolean };
    const blackout = res[2 + i * 2] as boolean;
    const observedAtMs = Number(s.observedAt) * 1000;
    const stale = observedAtMs === 0 || now - observedAtMs > MAX_ATTESTATION_AGE_MS;
    const attestedRegime = regimeName(s.regime);
    const regime: RegimeName = stale ? "UNKNOWN" : attestedRegime;
    const cap = regime === "UNKNOWN" ? 0 : Number(s.primaryCapUsd);
    const venue = venueFor(a.mic);
    return {
      symbol: a.symbol,
      wrapper: a.wrapper,
      mic: a.mic,
      pool: a.pool,
      hasPriceSource: a.pool !== null,
      regime,
      attestedRegime,
      cap,
      glyph: glyphOf(regime, cap),
      stale,
      halted: s.halted,
      blackout,
      multiplierNonce: Number(s.multiplierNonce),
      observedAtMs,
      attestedAgoMin: observedAtMs ? Math.max(0, Math.floor((now - observedAtMs) / 60_000)) : null,
      nextTransitionAtMs: s.nextTransitionAt ? Number(s.nextTransitionAt) * 1000 : null,
      nextChange: nextChange(now, venue),
      closure: closureAt(now, venue),
    };
  });

  const latestObserved = Math.max(0, ...rows.map((r) => r.observedAtMs));
  const latestRound = opts.withRound === false ? null : await getLatestRound({
    head: blockNumber,
    headTimeMs: blockTimeMs,
    observedAtMs: latestObserved || null,
  }).catch(() => null);

  return { rows, registeredCount, block: Number(blockNumber), blockTimeMs, readAtMs: Date.now(), latestRound, source: "chain" };
}

/**
 * The latest StateAttested round. Never scans history: at most 4 getLogs calls of 100 blocks each.
 * With `observedAtMs` (the newest stateOf.observedAt, which IS that round's block timestamp) the first
 * window is aimed at the block that timestamp implies (X Layer: ~1 block/s); the rest step back from
 * the head. Returns null when nothing is found in range; the page then shows "attested N min ago" alone.
 */
export async function getLatestRound(opts: { head?: bigint; headTimeMs?: number; observedAtMs?: number | null } = {}): Promise<AttestationRound | null> {
  if (isMock()) return (await fixture("board")).latestRound;
  const client = publicClient();
  let head = opts.head;
  let headTimeMs = opts.headTimeMs;
  if (head === undefined || headTimeMs === undefined) {
    const b = await client.getBlock({ blockTag: "latest" });
    head = b.number;
    headTimeMs = Number(b.timestamp) * 1000;
  }
  const R = BigInt(MAX_LOG_RANGE);
  const windows: [bigint, bigint][] = [];
  if (opts.observedAtMs) {
    const est = head - BigInt(Math.max(0, Math.round((headTimeMs - opts.observedAtMs) / 1000)));
    if (est > head - 4n * R) {
      const to = est + 49n > head ? head : est + 49n;
      windows.push([to - R + 1n, to]);
    }
  }
  for (let to = head; windows.length < MAX_ROUND_SCAN_CALLS; to -= R) {
    const from = to - R + 1n;
    if (windows.some(([f, t]) => from <= t && to >= f)) continue;
    windows.push([from, to]);
  }

  for (const [fromBlock, toBlock] of windows) {
    const logs = await client.getLogs({ address: MARKET_CLOCK, event: stateAttested as any, fromBlock, toBlock });
    if (!logs.length) continue;
    const last = logs.reduce((a: Log, b: Log) =>
      b.blockNumber! > a.blockNumber! || (b.blockNumber === a.blockNumber && b.logIndex! > a.logIndex!) ? b : a);
    const sameTx = logs.filter((l) => l.transactionHash === last.transactionHash);
    const inputRoot = ((last as any).args?.inputRoot ?? "0x") as Hex;
    return {
      txHash: last.transactionHash as Hex,
      block: Number(last.blockNumber),
      inputRoot,
      wrappers: sameTx.map((l) => (l as any).args?.wrapper as Address),
      bundleUrl: roundBundleUrl(inputRoot),
      oklinkTxUrl: oklinkTx(last.transactionHash!),
    };
  }
  return null;
}

/** MarketClock.registeredCount() alone (the board already includes it). */
export async function getRegisteredCount(): Promise<number> {
  if (isMock()) return (await fixture("board")).registeredCount;
  return Number(await publicClient().readContract({ address: MARKET_CLOCK, abi: marketClockAbi, functionName: "registeredCount" }));
}
