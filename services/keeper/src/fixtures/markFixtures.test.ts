/**
 * Test support, not a test: the archived mark bundles in `fixtures/marks/` turned back into the inputs that built
 * them, and the real Swap logs of the 13 Nov 2026 lunch recess (`sources/fixtures/swaplogs-hk-recess-20261113.json`)
 * decoded into rows, so tests can rebuild a real round with or without swap evidence.
 *
 * Named `*.test.ts` on purpose: `codeDigest()` (main.ts) skips test files, `src/fixtures` is left out of the
 * keeper image, and the npm package leaves out `*.test.ts`. A plain `.ts` here would change the code digest of
 * the repo without changing the deployed one. It defines no tests itself.
 */
import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { LeafKind, loadTree, subjectOf } from "../tree.ts";
import type { Leaf } from "../tree.ts";
import type { MarkBundle, MarkInputs, VenueEvidence } from "../markRound.ts";
import { SIGNAL_KEYS } from "../sources/signal.ts";
import type { SignalAttempt, SignalExchange } from "../sources/signalFetch.ts";
import { SWAP_TOPIC0, decodeSwapLog, vwap } from "../sources/pools.ts";
import type { PoolSpec, RawSwapLog, SwapRow } from "../sources/pools.ts";
import { SWAP_EVIDENCE_VERSION, closingRangeFor, commitList, swapListDigest } from "../swapEvidence.ts";
import type { CutRead, SwapEvidenceFields } from "../swapEvidence.ts";

export const ROOTS = {
  /** 13 Nov 2026 lunch recess, cut block 75,773,120, read block 75,776,392 (rows 230-232). */
  recessXIAO: "0x06a92e8238992e4d2ed25fac5b4a6ac243e6bbadc8dd99cced80fbe16ca71b75",
  recessTCENT: "0x63d4a265a784b0a76f922bb1632fbd7f5b5334ba7003fd97653848e9a05adc61",
  recessMEIT: "0xf48e2f2681fef245a8e42ef1e587931001c161bf77bff2507c8706a924b563cb",
  /** The XHKG holiday rows of 2 Oct and 20 Oct (wXIAOx), two of the six the cut-walk misses. */
  holiday2Oct: "0x3dafc1b6355ef8bfacc33bbc0563489b65530afc2474a8b78fd9d560c7ff18ed",
  holiday20Oct: "0x4db753ad7eb06acf7ba22d0b4fe2ded09ab39eda8803b6cc6ba811b6e4a36ad5",
  /** XNAS weekend row, wNVDAx, 9 Nov: the price moved 373.9 bp with 0 swaps listed. */
  us9Nov: "0xa5e1ff04a41bb46293fa07b6d62a386a86a5cb0da3378f6d34c0a6d968652efd",
} as const;

export const RECESS = { cutBlock: 75_773_120, pinnedBlock: 75_776_392, closingFrom: 75_772_220 } as const;
export const RECESS_ROOT_OF = { wXIAOx: ROOTS.recessXIAO, wTCENTx: ROOTS.recessTCENT, wMEITx: ROOTS.recessMEIT } as const;
export type RecessSymbol = keyof typeof RECESS_ROOT_OF;

/** A fresh parse of an archived bundle every call, so a test can mutate it freely. */
export function loadBundle(root: string): MarkBundle {
  return JSON.parse(readFileSync(new URL(`./marks/${root}.json`, import.meta.url), "utf8"));
}

export function leavesOf(b: MarkBundle): Leaf[] {
  return [...loadTree(b.tree as never).entries()].map(([, v]: [number, Leaf]) => v);
}

/** The parsed preimage of the first leaf of `kind` (and `subject`, when given); null when there is none. */
export function leafValue(b: MarkBundle, kind: number, subject?: string): any {
  const l = leavesOf(b).find(([k, s]) => Number(k) === kind && (subject === undefined || s === subject));
  return l ? JSON.parse(b.json[l[2]]) : null;
}

/**
 * The MarkInputs that built an archived bundle, read back out of its leaves. buildMarkRound of the result
 * reproduces the archived root exactly when no swap evidence is added (a test pins this).
 */
export function inputsFromBundle(b: MarkBundle): MarkInputs {
  const params = leafValue(b, LeafKind.PARAMS, subjectOf("params"));
  const registry = leafValue(b, LeafKind.REGISTRY, subjectOf("registry"));
  const chain = leafValue(b, LeafKind.CHAIN_CALL);
  const leaves = leavesOf(b);
  const closures: MarkInputs["closures"] = [];
  for (const [k, , h] of leaves) {
    if (Number(k) !== LeafKind.CA_SNAPSHOT) continue;
    const mi = JSON.parse(b.json[h]);
    const w = String(mi.wrapper).toLowerCase();
    const swaps = leafValue(b, LeafKind.FETCH_LOG, subjectOf(`swaps:${w}`));
    const venue = leafValue(b, LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${w}`)) as VenueEvidence | null;
    const exchanges: SignalExchange[] = [];
    for (const key of SIGNAL_KEYS) {
      const ex = leafValue(b, LeafKind.HTTP_EXCHANGE, subjectOf(`signal:${w}:${key}`));
      if (ex) exchanges.push(ex);
    }
    const log = leafValue(b, LeafKind.FETCH_LOG, subjectOf(`signal:${w}`)) as { attempts: SignalAttempt[] } | null;
    const toRow = (r: { blockNumber: number; logIndex: number; equityAbs: string; priceE18: string }): SwapRow =>
      ({ blockNumber: r.blockNumber, logIndex: r.logIndex, equityAbs: BigInt(r.equityAbs), priceE18: BigInt(r.priceE18) });
    closures.push({
      wrapper: mi.wrapper, symbol: mi.symbol, cutAtMs: swaps.cutAtMs, cutBlock: swaps.cutBlock, settleAfterS: swaps.settleAfterS,
      input: {
        wrapper: mi.wrapper, symbol: mi.symbol,
        lastPrintE18: BigInt(mi.lastPrintE18), midAtCutE18: BigInt(mi.midAtCutE18), midNowE18: BigInt(mi.midNowE18),
        closingVwapE18: mi.closingVwapE18 === null ? null : BigInt(mi.closingVwapE18), swapsDuringClosure: mi.swapsDuringClosure,
      },
      closingSwaps: swaps.closingSwaps.map(toRow),
      closureSwaps: swaps.closureSwaps.map(toRow),
      ...(venue ? { venue } : {}),
      ...(log ? { signal: { exchanges, attempts: log.attempts } } : {}),
    });
  }
  return {
    method: params.method, chainId: params.chainId, clock: params.clock, scorecard: params.scorecard,
    evaluatedAtMs: params.evaluatedAtMs, codeDigest: params.codeDigest,
    specs: registry.pools.map((p: PoolSpec) => ({ ...p })),
    chain: { block: { ...chain.block, rpc: "" }, results: chain.calls },
    closures,
  };
}

/** The REGISTRY spec of `symbol` in an archived bundle. */
export function specOf(b: MarkBundle, symbol: string): PoolSpec {
  return leafValue(b, LeafKind.REGISTRY, subjectOf("registry")).pools.find((p: PoolSpec) => p.symbol === symbol);
}

interface SwapLogFixture { fromBlock: number; toBlock: number; cutBlock: number; pinnedBlock: number; logs: RawSwapLog[] }

/** Every Swap log of the three HK pools in blocks 75,772,220..75,776,392 (real eth_getLogs output). */
export function recessLogs(): SwapLogFixture {
  return JSON.parse(readFileSync(new URL("../sources/fixtures/swaplogs-hk-recess-20261113.json", import.meta.url), "utf8"));
}

/** The decoded rows of one pool, closing window and closure together, sorted by (block, logIndex). */
export function recessRows(symbol: RecessSymbol): SwapRow[] {
  const spec = specOf(loadBundle(RECESS_ROOT_OF[symbol]), symbol);
  const pool = getAddress(spec.pool);
  return recessLogs().logs
    .filter((l) => getAddress(l.address) === pool)
    .map((l) => {
      const r = decodeSwapLog(l, spec);
      if (!r) throw new Error(`fixture log ${l.blockNumber}:${l.logIndex} does not decode`);
      return r;
    })
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** The slot0 returnData of `symbol`'s pool in an archived bundle's CHAIN_CALL leaf. */
export function slot0Of(b: MarkBundle, symbol: string): string {
  const label = `slot0:${getAddress(specOf(b, symbol).pool)}`;
  return leafValue(b, LeafKind.CHAIN_CALL).calls.find((c: { label: string }) => c.label === label).returnData;
}

/**
 * The 13 Nov recess round of `symbol` rebuilt as deploy 2 would commit it, built BY HAND from the real logs (not
 * by evidence.ts, so the verifier's tests do not lean on the keeper's assembly): full coverage, no gaps, the
 * closing window and the closure from the fixture, lastPrint and closingVwap from the closing list, the count
 * from the closure list. `cutRead` null unless given (then cutBlockHash is its block hash).
 */
export function strictRecessInputs(symbol: RecessSymbol, cutRead: CutRead | null = null): MarkInputs {
  const b = loadBundle(RECESS_ROOT_OF[symbol]);
  const i = inputsFromBundle(b);
  const c = i.closures[0];
  const spec = specOf(b, symbol);
  const rows = recessRows(symbol);
  const closing = closingRangeFor(c.cutBlock, 900_000);
  const C = rows.filter((r) => r.blockNumber >= closing.fromBlock && r.blockNumber <= c.cutBlock);
  const K = rows.filter((r) => r.blockNumber > c.cutBlock && r.blockNumber <= i.chain.block.number);
  const { committed, omitted } = commitList(K);
  const ev: SwapEvidenceFields = {
    evidence: SWAP_EVIDENCE_VERSION, pool: getAddress(spec.pool), topic0: SWAP_TOPIC0,
    cutBlockHash: cutRead ? cutRead.blockHash : null, cutRead,
    closingRange: closing, closingComplete: true,
    closureRange: { fromBlock: c.cutBlock + 1, toBlock: i.chain.block.number },
    complete: true, gaps: [],
    counts: { closingLogs: C.length, closureLogs: K.length },
    closureCount: K.length, closureOmitted: omitted, closureDigest: swapListDigest(K),
  };
  c.input = {
    ...c.input,
    lastPrintE18: C.length ? C[C.length - 1].priceE18 : c.input.midAtCutE18,
    closingVwapE18: vwap(C),
    swapsDuringClosure: K.length,
  };
  c.closingSwaps = C;
  c.closureSwaps = committed;
  c.swapEvidence = ev;
  return i;
}
