/**
 * /scorecard: the graded record, read from Scorecard v2 storage at one pinned block.
 *
 * closureCount → closureIds(i) → commitments(id), settlements(id), plus skill() and priceNow(w), all in
 * Multicall3 batches pinned to one block. Storage, not logs: ClosureCommitted does not carry the baselines,
 * and the browser never scans history (rpc.xlayer.tech: 100 blocks per getLogs, ~7 req/s).
 *
 * Transaction hashes: one single-block getLogs at committedBlock / settledBlock per row, filtered by the
 * indexed id, then cached in localStorage forever (a mined commit or settle never changes).
 * The record grows during the build: never hard-code a row count; read it.
 */
import { keccak256, stringToBytes } from "viem";
import { ASSETS, CHAIN_ID, SCORECARD, symbolOf } from "./addresses.ts";
import { scorecardAbi } from "./abi/scorecard.ts";
import { publicClient, units } from "./chain.ts";
import { fixture, isMock } from "./mock.ts";
import { closureAt, venueFor } from "./schedule.ts";
import type { Address, Hex, Outcome, PriceNow, ScorecardRow, ScorecardView, SkillTally } from "./types.ts";

const UINT32_MAX = 4294967295;
const BATCH = 120;

/** Published mark methods, by the digest committed with each row. */
export const KNOWN_METHODS: Record<string, string> = Object.fromEntries(
  ["curb.scorecard.mark/1", "curb.scorecard.mark/2"].map((m) => [keccak256(stringToBytes(m)).toLowerCase(), m]),
);

export function methodName(digest: string): string | null {
  return KNOWN_METHODS[digest.toLowerCase()] ?? null;
}

export function outcome(curbErr: number | null, baselineErr: number | null): Outcome | null {
  if (curbErr === null || baselineErr === null) return null;
  return curbErr < baselineErr ? "win" : curbErr === baselineErr ? "tie" : "loss";
}

type Commitment = {
  wrapper: Address; committedAt: bigint; committedBlock: bigint; settleAfter: bigint; mark: bigint; bandBps: number;
  inputRoot: Hex; methodDigest: Hex; lastPrint: bigint; closingVwap: bigint; staleOracle: bigint;
};
type Settlement = {
  settledAt: bigint; settledBlock: bigint; reopenPrint: bigint; curbErrorBps: number; lastPrintErrorBps: number;
  closingVwapErrorBps: number; staleOracleErrorBps: number; source: number; settled: boolean;
};

// public mapping getters return the struct fields as a positional tuple
function asCommitment(r: readonly unknown[]): Commitment {
  const [wrapper, committedAt, committedBlock, settleAfter, mark, bandBps, inputRoot, methodDigest, lastPrint, closingVwap, staleOracle] = r as any[];
  return { wrapper, committedAt, committedBlock, settleAfter, mark, bandBps, inputRoot, methodDigest, lastPrint, closingVwap, staleOracle };
}
function asSettlement(r: readonly unknown[]): Settlement {
  const [settledAt, settledBlock, reopenPrint, curbErrorBps, lastPrintErrorBps, closingVwapErrorBps, staleOracleErrorBps, source, settled] = r as any[];
  return { settledAt, settledBlock, reopenPrint, curbErrorBps, lastPrintErrorBps, closingVwapErrorBps, staleOracleErrorBps, source, settled };
}

export function buildRow(index: number, id: Hex, c: Commitment, s: Settlement | null): ScorecardRow {
  const settled = !!s?.settled;
  const err = (v: number | undefined) => (settled && v !== undefined && v !== UINT32_MAX ? Number(v) : null);
  const curbErrorBps = err(s?.curbErrorBps);
  const lastPrintErrorBps = err(s?.lastPrintErrorBps);
  const closingVwapErrorBps = err(s?.closingVwapErrorBps);
  const committedAtMs = Number(c.committedAt) * 1000;
  const asset = ASSETS.find((a) => a.wrapper.toLowerCase() === c.wrapper.toLowerCase());
  const method = methodName(c.methodDigest);
  return {
    index,
    id,
    wrapper: c.wrapper,
    symbol: symbolOf(c.wrapper),
    status: settled ? "settled" : "committed",
    mark: units(c.mark),
    markE18: c.mark.toString(),
    bandBps: Number(c.bandBps),
    lastPrint: units(c.lastPrint),
    lastPrintE18: c.lastPrint.toString(),
    closingVwap: units(c.closingVwap),
    closingVwapE18: c.closingVwap.toString(),
    staleOracle: c.staleOracle > 0n ? units(c.staleOracle) : null,
    reopenPrint: settled ? units(s!.reopenPrint) : null,
    reopenPrintE18: settled ? s!.reopenPrint.toString() : null,
    curbErrorBps,
    lastPrintErrorBps,
    closingVwapErrorBps,
    staleOracleErrorBps: err(s?.staleOracleErrorBps),
    vsLastPrint: outcome(curbErrorBps, lastPrintErrorBps),
    vsClosingVwap: outcome(curbErrorBps, closingVwapErrorBps),
    committedAtMs,
    committedBlock: Number(c.committedBlock),
    commitTx: cachedTx(id, "commit"),
    settleAfterMs: Number(c.settleAfter) * 1000,
    settledAtMs: settled ? Number(s!.settledAt) * 1000 : null,
    settledBlock: settled ? Number(s!.settledBlock) : null,
    settleTx: settled ? cachedTx(id, "settle") : null,
    inputRoot: c.inputRoot,
    methodDigest: c.methodDigest,
    method,
    methodShort: method ? method.replace(/^curb\.scorecard\./, "") : null,
    closureKind: asset ? closureAt(committedAtMs, venueFor(asset.mic))?.kind ?? null : null,
  };
}

export function tally(rows: ScorecardRow[], skill: { settled: number; beatLastPrint: number; beatClosingVwap: number }, closureCount: number, block: number, readAtMs: number): SkillTally {
  const count = (k: "vsLastPrint" | "vsClosingVwap", o: Outcome) => rows.filter((r) => r[k] === o).length;
  return {
    ...skill,
    tiesLastPrint: count("vsLastPrint", "tie"),
    tiesClosingVwap: count("vsClosingVwap", "tie"),
    lossesLastPrint: count("vsLastPrint", "loss"),
    lossesClosingVwap: count("vsClosingVwap", "loss"),
    closureCount,
    block,
    readAtMs,
  };
}

async function multicallChunks(contracts: any[], blockNumber: bigint): Promise<any[]> {
  const client = publicClient();
  const out: any[] = [];
  for (let i = 0; i < contracts.length; i += BATCH) {
    out.push(...(await client.multicall({ contracts: contracts.slice(i, i + BATCH), blockNumber, allowFailure: true })));
  }
  return out;
}

/**
 * The whole record, newest first, with skill() and priceNow for the cohort.
 * `resolveTx: true` also fills commitTx/settleTx (cached rows cost nothing; each uncached one costs a
 * single-block getLogs, rate-limited). Pages can instead call resolveTxHashes() after first paint.
 */
export async function getScorecard(opts: { resolveTx?: boolean } = {}): Promise<ScorecardView> {
  if (isMock()) return fixture("scorecard");
  const client = publicClient();
  const blockNumber = await client.getBlockNumber();
  const headCalls: any[] = [
    { address: SCORECARD, abi: scorecardAbi, functionName: "closureCount" },
    { address: SCORECARD, abi: scorecardAbi, functionName: "skill" },
    ...ASSETS.map((a) => ({ address: SCORECARD, abi: scorecardAbi, functionName: "priceNow", args: [a.wrapper] })),
  ];
  const head = (await client.multicall({ blockNumber, allowFailure: true, contracts: headCalls })) as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
  if (head[0].status !== "success" || head[1].status !== "success") throw new Error("Scorecard: closureCount/skill unreadable");
  const count = Number(head[0].result as bigint);
  const [settledN, beatLast, beatVwap] = head[1].result as unknown as readonly [bigint, bigint, bigint];
  const prices: PriceNow[] = ASSETS.map((a, i) => {
    const r = head[2 + i];
    return r.status === "success"
      ? { symbol: a.symbol, wrapper: a.wrapper, price: units(r.result as bigint), priceE18: (r.result as bigint).toString(), error: null }
      : { symbol: a.symbol, wrapper: a.wrapper, price: null, priceE18: null, error: errorName(r.error) };
  });

  const idRes = await multicallChunks(
    Array.from({ length: count }, (_, i) => ({ address: SCORECARD, abi: scorecardAbi, functionName: "closureIds", args: [BigInt(i)] })),
    blockNumber,
  );
  const ids = idRes.map((r) => r.result as Hex);
  const rowRes = await multicallChunks(
    ids.flatMap((id) => [
      { address: SCORECARD, abi: scorecardAbi, functionName: "commitments", args: [id] },
      { address: SCORECARD, abi: scorecardAbi, functionName: "settlements", args: [id] },
    ]),
    blockNumber,
  );
  const rows = ids.map((id, i) => buildRow(i, id, asCommitment(rowRes[i * 2].result), asSettlement(rowRes[i * 2 + 1].result)));
  if (opts.resolveTx) await resolveTxHashes(rows);
  rows.reverse();

  const block = Number(blockNumber);
  const readAtMs = Date.now();
  const skill = tally(rows, { settled: Number(settledN), beatLastPrint: Number(beatLast), beatClosingVwap: Number(beatVwap) }, count, block, readAtMs);
  return { rows, skill, prices, block, readAtMs, source: "chain" };
}

/** Scorecard.skill() alone (the home page's record line), with the row count. */
export async function getSkill(): Promise<{ settled: number; beatLastPrint: number; beatClosingVwap: number; closureCount: number; block: number }> {
  if (isMock()) {
    const s = (await fixture("scorecard")).skill;
    return { settled: s.settled, beatLastPrint: s.beatLastPrint, beatClosingVwap: s.beatClosingVwap, closureCount: s.closureCount, block: s.block };
  }
  const client = publicClient();
  const blockNumber = await client.getBlockNumber();
  const [skill, count] = await client.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      { address: SCORECARD, abi: scorecardAbi, functionName: "skill" },
      { address: SCORECARD, abi: scorecardAbi, functionName: "closureCount" },
    ],
  });
  const [s, bl, bv] = skill as readonly [bigint, bigint, bigint];
  return { settled: Number(s), beatLastPrint: Number(bl), beatClosingVwap: Number(bv), closureCount: Number(count), block: Number(blockNumber) };
}

/** Scorecard.priceNow(wrapper) for one asset. */
export async function getPriceNow(wrapper: Address): Promise<PriceNow> {
  const symbol = symbolOf(wrapper);
  try {
    const v = await publicClient().readContract({ address: SCORECARD, abi: scorecardAbi, functionName: "priceNow", args: [wrapper] });
    return { symbol, wrapper, price: units(v), priceE18: v.toString(), error: null };
  } catch (e) {
    return { symbol, wrapper, price: null, priceE18: null, error: errorName(e) };
  }
}

export function errorName(e: unknown): string {
  const any = e as { cause?: { data?: { errorName?: string } }; data?: { errorName?: string }; shortMessage?: string; message?: string } | undefined;
  return any?.cause?.data?.errorName ?? any?.data?.errorName ?? any?.shortMessage ?? any?.message ?? String(e);
}

// --- transaction hashes: single-block getLogs, cached forever ----------------------------------

const committedEvent = scorecardAbi.find((e) => e.type === "event" && e.name === "ClosureCommitted")!;
const settledEvent = scorecardAbi.find((e) => e.type === "event" && e.name === "ClosureSettled")!;

const txKey = (id: string, kind: "commit" | "settle") => `curb:tx:${CHAIN_ID}:${SCORECARD.toLowerCase()}:${id.toLowerCase()}:${kind}`;

function cachedTx(id: string, kind: "commit" | "settle"): Hex | null {
  try {
    const v = globalThis.localStorage?.getItem(txKey(id, kind));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
  } catch {
    return null;
  }
}

function storeTx(id: string, kind: "commit" | "settle", hash: string): void {
  try {
    globalThis.localStorage?.setItem(txKey(id, kind), hash);
  } catch {
    /* private window / blocked storage: fine, we just ask again next time */
  }
}

/** The tx that wrote one event for `id` in exactly `block`. One getLogs over a single block. */
export async function txHashAt(kind: "commit" | "settle", id: Hex, block: number): Promise<Hex | null> {
  const hit = cachedTx(id, kind);
  if (hit) return hit;
  const logs = await publicClient().getLogs({
    address: SCORECARD,
    event: (kind === "commit" ? committedEvent : settledEvent) as any,
    args: { id } as any,
    fromBlock: BigInt(block),
    toBlock: BigInt(block),
  });
  const hash = (logs[0]?.transactionHash ?? null) as Hex | null;
  if (hash) storeTx(id, kind, hash);
  return hash;
}

/**
 * Fill commitTx / settleTx on rows in place (and return them). Cached hashes cost nothing; each missing
 * one is a single-block getLogs. `onRow` fires as each row resolves so a ledger can fill in progressively.
 */
export async function resolveTxHashes(rows: ScorecardRow[], onRow?: (r: ScorecardRow) => void): Promise<ScorecardRow[]> {
  if (isMock()) return rows;
  await Promise.all(rows.map(async (r) => {
    try {
      if (!r.commitTx) r.commitTx = await txHashAt("commit", r.id, r.committedBlock);
      if (r.status === "settled" && !r.settleTx && r.settledBlock !== null) r.settleTx = await txHashAt("settle", r.id, r.settledBlock);
      onRow?.(r);
    } catch {
      /* leave null; the row still renders with its block numbers */
    }
  }));
  return rows;
}
