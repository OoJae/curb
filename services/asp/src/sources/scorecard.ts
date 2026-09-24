/**
 * COPIED from services/keeper/src/sources/scorecard.ts. Each service is built standalone from its own directory,
 * so shared pure code is copied rather than imported across packages; keep the copies in step.
 *
 * Reading Scorecard back: the ABI, the closure id, and the committed rows.
 *
 * The keeper writes these rows; nothing until now read them. Verifying a published mark against the
 * chain needs both sides, and both must come from one place so they cannot drift.
 */
import { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { endpointLabel, LOG_RANGE } from "./chain.ts";
import { rpcAny } from "./chain.ts";

export const scorecardAbi = new Interface([
  "function commit((address wrapper,uint64 committedAt,uint64 committedBlock,uint64 settleAfter,uint128 mark,uint32 bandBps,bytes32 inputRoot,bytes32 methodDigest,uint128 lastPrint,uint128 closingVwap,uint128 staleOracle) c) returns (bytes32)",
  "function settle(bytes32 id)",
  "function skill() view returns (uint256 settled_, uint256 beatLast, uint256 beatVwap)",
  "function closureCount() view returns (uint256)",
  "function closureIds(uint256) view returns (bytes32)",
  "function commitments(bytes32) view returns (address wrapper,uint64 committedAt,uint64 committedBlock,uint64 settleAfter,uint128 mark,uint32 bandBps,bytes32 inputRoot,bytes32 methodDigest,uint128 lastPrint,uint128 closingVwap,uint128 staleOracle)",
  "function settlements(bytes32) view returns (uint64 settledAt,uint64 settledBlock,uint128 reopenPrint,uint32 curbErrorBps,uint32 lastPrintErrorBps,uint32 closingVwapErrorBps,uint32 staleOracleErrorBps,uint8 source,bool settled)",
  "event ClosureCommitted(bytes32 indexed id, address indexed wrapper, uint128 mark, uint32 bandBps, uint64 settleAfter, uint64 committedBlock, bytes32 inputRoot, bytes32 methodDigest)",
  "event ClosureSettled(bytes32 indexed id, address indexed wrapper, uint128 reopenPrint, uint32 curbErrorBps, uint32 lastPrintErrorBps, uint32 closingVwapErrorBps, uint32 staleOracleErrorBps, uint8 source, uint64 settledBlock)",
  // Added in the ASP copy: the cohort reads which wrappers Scorecard can grade (keeper main.ts had these inline).
  "function priceSources(address) view returns (address pool, bool equityIsToken0, uint32 twapWindow, uint8 equityDecimals, uint8 stableDecimals)",
  "function priceNow(address) view returns (uint128)",
]);

/** The id Scorecard computes. Derived, never trusted from an index. */
export function closureId(wrapper: string, settleAfterS: number, inputRoot: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint64", "bytes32"], [getAddress(wrapper), settleAfterS, inputRoot]));
}

/** The digest the keeper pins into every commitment, binding the row to a published method. */
export const methodDigestOf = (methodId: string): string => keccak256(toUtf8Bytes(methodId));

export interface CommittedRow {
  id: string;
  wrapper: string;
  settleAfter: number;
  committedBlock: number;
  mark: string;
  bandBps: number;
  inputRoot: string;
  methodDigest: string;
  /** Calldata only -- ClosureCommitted does not carry the baselines. Null when read from a log. */
  lastPrint: string | null;
  closingVwap: string | null;
  staleOracle: string | null;
  txHash: string;
}

export function decodeClosureCommitted(log: { topics: string[]; data: string; blockNumber: string; transactionHash: string }): CommittedRow | null {
  try {
    const d = scorecardAbi.decodeEventLog("ClosureCommitted", log.data, log.topics);
    return {
      id: String(d.id ?? log.topics[1]),
      wrapper: getAddress(String(d.wrapper)),
      settleAfter: Number(d.settleAfter),
      committedBlock: Number(d.committedBlock),
      mark: String(d.mark),
      bandBps: Number(d.bandBps),
      inputRoot: String(d.inputRoot).toLowerCase(),
      methodDigest: String(d.methodDigest).toLowerCase(),
      lastPrint: null, closingVwap: null, staleOracle: null,
      txHash: log.transactionHash,
    };
  } catch { return null; }
}

/** The baselines only exist in the calldata, which is why a full check wants the transaction too. */
export function decodeCommitCalldata(input: string): Omit<CommittedRow, "id" | "committedBlock" | "txHash"> | null {
  try {
    const [c] = scorecardAbi.decodeFunctionData("commit", input);
    return {
      wrapper: getAddress(String(c.wrapper)),
      settleAfter: Number(c.settleAfter),
      mark: String(c.mark),
      bandBps: Number(c.bandBps),
      inputRoot: String(c.inputRoot).toLowerCase(),
      methodDigest: String(c.methodDigest).toLowerCase(),
      lastPrint: String(c.lastPrint),
      closingVwap: String(c.closingVwap),
      staleOracle: String(c.staleOracle),
    };
  } catch { return null; }
}

/**
 * Every committed closure in a block range. Mirrors `attestedRounds`, including its per-endpoint
 * head guard: a node that has not indexed a block answers `eth_getLogs` with an empty list rather
 * than an error, so a chunk is only accepted from an endpoint whose head has reached its end.
 */
export async function closuresCommitted(rpcs: string[], scorecard: string, fromBlock: number, toBlock: number): Promise<CommittedRow[]> {
  const topic = scorecardAbi.getEvent("ClosureCommitted")!.topicHash;
  const out: CommittedRow[] = [];
  const heads = await Promise.all(rpcs.map((u) => rpcAny<string>([u], "eth_blockNumber", []).then((h) => Number(BigInt(h)), () => -1)));

  for (let b = fromBlock; b <= toBlock; b += LOG_RANGE) {
    const end = Math.min(b + LOG_RANGE - 1, toBlock);
    let logs: Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }> | null = null;
    const reasons: string[] = [];
    for (const [i, url] of rpcs.entries()) {
      // Named by endpointLabel, never by URL: a keyed provider's URL carries its key (see chain.ts).
      if (heads[i] < end) { reasons.push(`${endpointLabel(url, i)} head ${heads[i]} < ${end}`); continue; }
      try {
        logs = await rpcAny([url], "eth_getLogs", [{
          address: getAddress(scorecard), topics: [topic],
          fromBlock: "0x" + b.toString(16), toBlock: "0x" + end.toString(16),
        }]);
        break;
      } catch (e) { reasons.push(`${endpointLabel(url, i)}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (!logs) throw new Error(`no RPC could serve Scorecard logs for ${b}..${end}: ${reasons.join(" | ")}`);
    for (const l of logs) {
      const row = decodeClosureCommitted(l);
      if (row) out.push(row);
    }
  }
  return out.sort((a, b) => a.committedBlock - b.committedBlock);
}
