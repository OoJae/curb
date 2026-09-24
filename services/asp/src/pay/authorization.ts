/**
 * One EIP-3009 authorization: what a buyer's `exact` payment on X Layer actually is, and the chain's own
 * answer to "was it used?".
 *
 * An `exact` payment here is a signed transferWithAuthorization(from, to, value, validAfter, validBefore,
 * nonce) on USD₮0 (the SDK's default for eip155:196, EIP-3009 unless a requirement says permit2, and ours
 * never does). Three properties make it the right thing to key every payment decision on:
 *
 *   - It is single-use by construction. USD₮0 keeps authorizationState(from, nonce) and reverts a second
 *     use, so (payer, nonce) names one payment for its whole life, whoever submits it and however often.
 *   - It is self-describing on chain. A use emits AuthorizationUsed(payer, nonce) and then Transfer(payer,
 *     to, value) in the same transaction -- read off X Layer mainnet on 24 Sep 2026 -- and `to` and `value`
 *     are inside the signature. So once the Broker has verified the authorization against our terms,
 *     "the chain says it is used" already means "PAY_TO received the price".
 *   - It dies on a clock the chain keeps. After a block whose timestamp is past validBefore, the
 *     authorization can never be used, so "not used" becomes a final answer rather than a guess.
 *
 * So when the Broker cannot say whether a settle happened -- it timed out, or answered a gateway error
 * after it may already have submitted the transfer -- the chain can, without trusting anyone
 * (ledger.ts). And the settlement-timeout hook (server.ts) checks THIS payment's authorization in the
 * transaction the Broker names, not merely "some transfer to PAY_TO".
 *
 * X Layer makes one block a second (99 blocks in 99 s on 24 Sep 2026), and its public RPC caps eth_getLogs
 * at 100 blocks, which is what shapes `findUse`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Interface, getAddress, id as eventTopic, zeroPadValue } from "ethers";
import { LOG_RANGE } from "../sources/chain.ts";

export const AUTHORIZATION_USED = eventTopic("AuthorizationUsed(address,bytes32)");
export const TRANSFER = eventTopic("Transfer(address,address,uint256)");
const eip3009 = new Interface(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface Eip3009Authorization {
  /** Checksummed. */
  payer: string;
  /** 0x + 64 lower-case hex. */
  nonce: string;
  /** Unix seconds; the authorization cannot be used in a block at or after it. */
  validBefore: number;
  value: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,78}$/;

/**
 * The EIP-3009 authorization inside a decoded x402 payment payload, or null when there is none that this
 * service can account for. Null is a refusal, not a pass: a payload the ledger cannot key -- a permit2
 * variant a client opted into by adding `assetTransferMethod` to its copy of our terms, or anything
 * malformed -- would settle with no replay guard and no way to ask the chain what happened, so the flow
 * refuses it before the Broker is asked anything.
 */
export function authorizationOf(payload: unknown): Eip3009Authorization | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { accepted?: { extra?: Record<string, unknown> }; payload?: { authorization?: Record<string, unknown> } };
  const method = p.accepted?.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return null;
  const a = p.payload?.authorization;
  if (typeof a !== "object" || a === null) return null;
  const { from, nonce, validBefore, value } = a;
  if (typeof from !== "string" || !ADDRESS.test(from)) return null;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return null;
  const vb = typeof validBefore === "number" ? String(validBefore) : validBefore;
  const v = typeof value === "number" ? String(value) : value;
  if (typeof vb !== "string" || !UINT.test(vb) || typeof v !== "string" || !UINT.test(v)) return null;
  const vbN = Number(vb);
  if (!Number.isSafeInteger(vbN)) return null;
  return { payer: getAddress(from), nonce: nonce.toLowerCase(), validBefore: vbN, value: v };
}

/** The ledger key: filename-safe, and one per payment for the payment's whole life. */
export function authorizationKey(a: { payer: string; nonce: string }): string {
  return `${a.payer.toLowerCase()}-${a.nonce.toLowerCase()}`;
}

/** What one priced request's settlement must look like on chain. */
export interface SettlementExpectation {
  payer: string;
  nonce: string;
  /** The price in atomic units: a transfer of less is not this sale. */
  minAmount: bigint;
}

/**
 * The expectation for the settlement in progress, carried through the SDK's processSettlement to the
 * settlement-timeout hook, which the SDK calls with only (txHash, network). Async context rather than a
 * map keyed on the tx hash, because the hash is exactly what we do not know until the Broker names it.
 */
export const settlementScope = new AsyncLocalStorage<SettlementExpectation>();

interface TxLog { address: string; topics: string[]; data?: string }
export interface TxReceipt { status?: string; logs?: TxLog[] }

const sameAddress = (word: string | undefined, addr: string) => {
  if (typeof word !== "string" || word.length < 42) return false;
  try { return getAddress("0x" + word.slice(-40)) === getAddress(addr); } catch { return false; }
};
const amountOf = (data: string | undefined) => {
  try { return data && data !== "0x" ? BigInt(data) : -1n; } catch { return -1n; }
};

/**
 * Does this receipt show THIS payment: mined and successful, USD₮0 marking (payer, nonce) used, and USD₮0
 * moving at least the price from the payer to PAY_TO? All three, in one transaction. Anything less -- a
 * transfer from someone else, of one atomic unit, of another token, or for another authorization -- is
 * not this sale, however the Broker labels it.
 */
export function receiptPays(r: TxReceipt | null | undefined, asset: string, payTo: string, e: SettlementExpectation): boolean {
  if (!r || r.status !== "0x1") return false;
  const logs = (r.logs ?? []).filter((l) => typeof l.address === "string" && l.address.toLowerCase() === asset.toLowerCase());
  const used = logs.some((l) => l.topics?.[0] === AUTHORIZATION_USED && sameAddress(l.topics[1], e.payer) && l.topics[2]?.toLowerCase() === e.nonce.toLowerCase());
  const paid = logs.some((l) => l.topics?.[0] === TRANSFER && sameAddress(l.topics[1], e.payer) && sameAddress(l.topics[2], payTo) && amountOf(l.data) >= e.minAmount);
  return used && paid;
}

/** The chain reads the ledger needs; tests answer them from memory. */
export interface AuthorizationChain {
  /** authorizationState(payer, nonce) at the latest block, and that block's number and timestamp. */
  state(payer: string, nonce: string): Promise<{ used: boolean; block: number; timestamp: number }>;
  /** Does this transaction use this payment's authorization and pay PAY_TO at least the price? */
  txPays(tx: string, e: SettlementExpectation): Promise<boolean>;
  /** The transaction that emitted AuthorizationUsed(payer, nonce) in [fromBlock, toBlock], or null. */
  findUse(payer: string, nonce: string, fromBlock: number, toBlock: number): Promise<string | null>;
}

const hex = (n: number) => "0x" + n.toString(16);

export function rpcAuthorizationChain(rpc: RpcCall, asset: string, payTo: string): AuthorizationChain {
  const token = getAddress(asset);
  return {
    async state(payer, nonce) {
      // Pinned: the call is made AT the block whose timestamp we report, so "unused, and the chain's clock is
      // past validBefore" is one consistent statement rather than two reads that could straddle a block.
      const b = await rpc("eth_getBlockByNumber", ["latest", false]) as { number?: string; timestamp?: string } | null;
      if (!b?.number || !b.timestamp) throw new Error("no latest block");
      const block = Number(BigInt(b.number));
      const out = await rpc("eth_call", [{ to: token, data: eip3009.encodeFunctionData("authorizationState", [payer, nonce]) }, hex(block)]);
      const [used] = eip3009.decodeFunctionResult("authorizationState", String(out));
      return { used: Boolean(used), block, timestamp: Number(BigInt(b.timestamp)) };
    },
    async txPays(tx, e) {
      return receiptPays(await rpc("eth_getTransactionReceipt", [tx]) as TxReceipt | null, token, payTo, e);
    },
    async findUse(payer, nonce, fromBlock, toBlock) {
      const topics = [AUTHORIZATION_USED, zeroPadValue(getAddress(payer), 32), nonce.toLowerCase()];
      // Newest first: a use we are looking for is almost always seconds old.
      for (let end = toBlock; end >= fromBlock; end -= LOG_RANGE) {
        const start = Math.max(fromBlock, end - LOG_RANGE + 1);
        const logs = await rpc("eth_getLogs", [{ address: token, topics, fromBlock: hex(start), toBlock: hex(end) }]) as { transactionHash?: string }[];
        if (!Array.isArray(logs)) throw new Error("eth_getLogs returned a non-array");
        const hit = logs.find((l) => typeof l.transactionHash === "string");
        if (hit) return hit.transactionHash!.toLowerCase();
      }
      return null;
    },
  };
}
