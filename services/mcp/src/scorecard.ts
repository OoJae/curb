/**
 * curb_scorecard: Curb's graded record, read from Scorecard v2 at one pinned block.
 *
 * `skill()` is the contract's own running tally, incremented inside settle(): settled rows, and STRICT wins
 * against the last print and against the pre-close price (the contract's `closingVwap`: the 15-minute closing
 * VWAP, or the last pool price when nothing traded, as README.md says). A tie is not a win. The recent rows
 * come from the public getters (closureCount, closureIds, commitments, settlements), newest first, the same reads
 * services/asp/src/index/scorecard.ts makes. Every read in one answer is pinned to the same block hash, so
 * the tally and the rows describe one chain state.
 *
 * Prices are USD per whole wrapper share, 1e18-scaled on chain, printed exactly. The grade of a settled row
 * is recomputed here the way settle() counts it (curbErrorBps < lastPrintErrorBps), so a row's `result`
 * always agrees with the tally.
 */
import { Interface, formatUnits, keccak256, toUtf8Bytes, getAddress } from "ethers";
import { ASSETS, CONTRACTS, CHAIN_ID } from "./assets.ts";
import { asOfBlock } from "./sources/chain.ts";
import type { AsOf, Call, CallResult, ChainReader } from "./sources/chain.ts";

export const scorecardAbi = new Interface([
  "function skill() view returns (uint256 settled_, uint256 beatLast, uint256 beatVwap)",
  "function closureCount() view returns (uint256)",
  "function closureIds(uint256) view returns (bytes32)",
  "function commitments(bytes32) view returns (address wrapper,uint64 committedAt,uint64 committedBlock,uint64 settleAfter,uint128 mark,uint32 bandBps,bytes32 inputRoot,bytes32 methodDigest,uint128 lastPrint,uint128 closingVwap,uint128 staleOracle)",
  "function settlements(bytes32) view returns (uint64 settledAt,uint64 settledBlock,uint128 reopenPrint,uint32 curbErrorBps,uint32 lastPrintErrorBps,uint32 closingVwapErrorBps,uint32 staleOracleErrorBps,uint8 source,bool settled)",
  "function priceNow(address) view returns (uint128)",
  "event ClosureCommitted(bytes32 indexed id, address indexed wrapper, uint128 mark, uint32 bandBps, uint64 settleAfter, uint64 committedBlock, bytes32 inputRoot, bytes32 methodDigest)",
]);

/** Scorecard.SETTLE_DELAY and SETTLE_WINDOW. */
export const SETTLE_DELAY_S = 300;
export const SETTLE_WINDOW_S = 6 * 3600;
export const DEFAULT_ROWS = 10;
export const MAX_ROWS = 50;

/** The published mark methods, by the digest each commitment pins. */
export const METHODS = new Map(["curb.scorecard.mark/1", "curb.scorecard.mark/2"].map((m) => [keccak256(toUtf8Bytes(m)).toLowerCase(), m]));

const usd = (e18: bigint) => formatUnits(e18, 18);
const iso = (s: number) => new Date(s * 1000).toISOString();

export interface ScorecardRowView {
  index: number;
  id: string;
  symbol: string;
  wrapper: string;
  method: string;
  committedAt: string;
  committedBlock: number;
  /** The commit transaction (from ClosureCommitted), for curb-verify; null if it could not be looked up this call. */
  commitTx: string | null;
  /** The reopen the mark predicts. Settlement opens SETTLE_DELAY after it and closes SETTLE_WINDOW later. */
  settleAfter: string;
  markUsd: string;
  bandBps: number;
  lastPrintUsd: string;
  closingVwapUsd: string;
  inputRoot: string;
  /**
   * By block time. in-settlement-window: anyone may call settle(id), which still reverts while primaryCapNow is 0.
   * expired-unsettled: the window closed with no settle, so the row can never be graded and is not in skill().
   */
  status: "settled" | "awaiting-reopen" | "in-settlement-window" | "expired-unsettled";
  settlement: {
    settledAt: string;
    settledBlock: number;
    reopenPrintUsd: string;
    curbErrorBps: number;
    lastPrintErrorBps: number;
    closingVwapErrorBps: number;
    /** Against the last print, exactly as settle() counts it. */
    result: "win" | "tie" | "loss";
    resultVsClosingVwap: "win" | "tie" | "loss";
  } | null;
}

export interface ScorecardResult {
  summary: string;
  asOf: AsOf;
  source: { chainId: number; scorecard: string; reads: string };
  skill: { settled: number; beatLastPrint: number; beatClosingVwap: number; note: string };
  closureCount: number;
  rows: ScorecardRowView[];
  verify: string;
}

const cmp = (curb: number, base: number): "win" | "tie" | "loss" => (curb < base ? "win" : curb === base ? "tie" : "loss");

export function statusAt(settleAfter: number, settled: boolean, blockTs: number): ScorecardRowView["status"] {
  if (settled) return "settled";
  if (blockTs < settleAfter + SETTLE_DELAY_S) return "awaiting-reopen";
  if (blockTs <= settleAfter + SETTLE_DELAY_S + SETTLE_WINDOW_S) return "in-settlement-window";
  return "expired-unsettled";
}

function need(results: CallResult[], label: string): CallResult {
  const r = results.find((x) => x.label === label);
  if (!r || !r.success || r.returnData === "0x") throw new Error(`Scorecard getter failed: ${label}`);
  return r;
}

export function decodeRow(index: number, id: string, c: CallResult, s: CallResult, blockTs: number): ScorecardRowView {
  const d = scorecardAbi.decodeFunctionResult("commitments", c.returnData);
  if (Number(d[1]) === 0) throw new Error(`closureIds lists ${id} but commitments(${id}) is empty`);
  const t = scorecardAbi.decodeFunctionResult("settlements", s.returnData);
  const wrapper = getAddress(String(d[0]));
  const settled = Boolean(t[8]);
  const settleAfter = Number(d[3]);
  const digest = String(d[7]).toLowerCase();
  return {
    index, id,
    symbol: ASSETS.find((a) => a.wrapper === wrapper)?.symbol ?? wrapper,
    wrapper,
    method: METHODS.get(digest) ?? `unrecognised method digest ${digest}`,
    committedAt: iso(Number(d[1])),
    committedBlock: Number(d[2]),
    commitTx: null,
    settleAfter: iso(settleAfter),
    markUsd: usd(BigInt(d[4])),
    bandBps: Number(d[5]),
    lastPrintUsd: usd(BigInt(d[8])),
    closingVwapUsd: usd(BigInt(d[9])),
    inputRoot: String(d[6]).toLowerCase(),
    status: statusAt(settleAfter, settled, blockTs),
    settlement: settled
      ? {
          settledAt: iso(Number(t[0])),
          settledBlock: Number(t[1]),
          reopenPrintUsd: usd(BigInt(t[2])),
          curbErrorBps: Number(t[3]),
          lastPrintErrorBps: Number(t[4]),
          closingVwapErrorBps: Number(t[5]),
          result: cmp(Number(t[3]), Number(t[4])),
          resultVsClosingVwap: cmp(Number(t[3]), Number(t[5])),
        }
      : null,
  };
}

/** ClosureCommitted's topic0; topic1 is the closure id. */
const COMMITTED_TOPIC = scorecardAbi.getEvent("ClosureCommitted")!.topicHash;
/** At most this many eth_getLogs per call, three at a time; a row not looked up yet shows commitTx null. */
const MAX_TX_LOOKUPS = 20;
/**
 * No new lookup starts after this long, so a slow RPC cannot push the answer toward the tool deadline (a
 * lookup is ~1 s on drpc; one can take 12 s when both endpoints time out). What is left is looked up next call.
 */
const TX_LOOKUP_BUDGET_MS = 6_000;

/**
 * The transaction that committed each row, so an agent can hand it straight to curb-verify. The getters do not
 * carry it, so it is found from ClosureCommitted in the row's own committedBlock (one block: well inside the
 * public RPCs' 100-block log range). A commit is final, so each answer is kept for the life of the process in
 * `known`; a failed or empty lookup is not kept and is retried on a later call, as is a row the time budget
 * did not reach.
 */
export async function findCommitTxs(chain: ChainReader, rows: ScorecardRowView[], known: Map<string, string>, budgetMs = TX_LOOKUP_BUDGET_MS): Promise<void> {
  const todo = rows.filter((r) => !known.has(r.id)).slice(0, MAX_TX_LOOKUPS);
  if (!chain.logs || todo.length === 0) return;
  const logs = chain.logs.bind(chain);
  const stopAt = Date.now() + budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < stopAt) {
      const r = todo[next++];
      try {
        const found = await logs({ address: CONTRACTS.scorecard, topics: [COMMITTED_TOPIC, r.id], fromBlock: r.committedBlock, toBlock: r.committedBlock });
        const hit = found.find((l) => (l.topics[1] ?? "").toLowerCase() === r.id);
        if (hit) known.set(r.id, hit.transactionHash.toLowerCase());
      } catch { /* retried on a later call */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function summaryOf(block: number, count: number, skill: { settled: number; beatLastPrint: number; beatClosingVwap: number }, shown: number): string {
  const notWins = skill.settled - skill.beatLastPrint;
  return (
    `Scorecard v2 at block ${block}: ${count} marks committed, ${skill.settled} settled. Curb's mark beat the last print in ` +
    `${skill.beatLastPrint} and the pre-close price (closingVwap) in ${skill.beatClosingVwap} (strict wins; ${notWins} of the settled rows did not beat the last print). ` +
    `${shown ? `Newest ${shown} rows below.` : "No rows yet."}`
  );
}

/** The newest `limit` rows of an answer read with a larger limit, as if it had been read with `limit`. Never mutates `r`. */
export function limitScorecard(r: ScorecardResult, limit: number): ScorecardResult {
  const rows = r.rows.slice(0, limit);
  return { ...r, rows, summary: summaryOf(r.asOf.block, r.closureCount, r.skill, rows.length) };
}

export async function readScorecard(chain: ChainReader, limit = DEFAULT_ROWS, commitTxs?: Map<string, string>): Promise<ScorecardResult> {
  const sc = CONTRACTS.scorecard;
  const call = (label: string, fn: string, args: unknown[] = []): Call => ({ label, target: sc, callData: scorecardAbi.encodeFunctionData(fn, args) });
  const block = await chain.pin();
  const head = await chain.multicall(block, [call("count", "closureCount"), call("skill", "skill")]);
  const count = Number(scorecardAbi.decodeFunctionResult("closureCount", need(head, "count").returnData)[0]);
  const sk = scorecardAbi.decodeFunctionResult("skill", need(head, "skill").returnData);
  const skill = { settled: Number(sk[0]), beatLastPrint: Number(sk[1]), beatClosingVwap: Number(sk[2]) };

  const n = Math.min(limit, count);
  const indexes = Array.from({ length: n }, (_, k) => count - 1 - k);
  const rows: ScorecardRowView[] = [];
  if (n > 0) {
    const idRes = await chain.multicall(block, indexes.map((i) => call(`id:${i}`, "closureIds", [i])));
    const ids = indexes.map((i) => String(scorecardAbi.decodeFunctionResult("closureIds", need(idRes, `id:${i}`).returnData)[0]).toLowerCase());
    const detail = await chain.multicall(block, ids.flatMap((id) => [call(`c:${id}`, "commitments", [id]), call(`s:${id}`, "settlements", [id])]));
    ids.forEach((id, k) => rows.push(decodeRow(indexes[k], id, need(detail, `c:${id}`), need(detail, `s:${id}`), block.timestamp)));
  }
  if (commitTxs) {
    await findCommitTxs(chain, rows, commitTxs);
    for (const r of rows) r.commitTx = commitTxs.get(r.id) ?? null;
  }

  return {
    summary: summaryOf(block.number, count, skill, rows.length),
    asOf: asOfBlock(block, chain.rpcs),
    source: { chainId: CHAIN_ID, scorecard: sc, reads: "skill(), closureCount(), closureIds(i), commitments(id), settlements(id)" },
    skill: { ...skill, note: "skill() counts strict wins only: equal error is a tie, and a tie is not a win" },
    closureCount: count,
    rows,
    verify: "Re-derive any row from its published evidence with its commit transaction: npx -y github:OoJae/curb tx <commitTx>",
  };
}
