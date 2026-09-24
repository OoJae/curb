/**
 * Wallet: EIP-6963 discovery (OKX Wallet `com.okex.wallet` first), switch/add X Layer (0xc4), and one
 * `write()` every page uses: simulateContract → writeContract({ dataSuffix }) → receipt → {hash, block}.
 * Every Curb transaction carries the Builder Code suffix; it is appended to the simulation too, so what
 * is simulated is byte-for-byte what is sent.
 */
import {
  BaseError, ContractFunctionRevertedError, createClient, custom,
  type Abi, type Account, type Client, type EIP1193Provider, type TransactionReceipt, type Transport,
} from "viem";
import { writeContract } from "viem/actions";
import { CHAIN_ID_HEX, OKLINK, RPC_URLS, oklinkTx } from "./addresses.ts";
import { publicClient, xLayer } from "./chain.ts";
import { DATA_SUFFIX } from "./suffix.ts";
import type { Address, Hex, WalletInfo, WriteResult } from "./types.ts";

export const OKX_RDNS = "com.okex.wallet";

interface Announced {
  info: WalletInfo;
  provider: EIP1193Provider;
}

const found = new Map<string, Announced>();
const listeners = new Set<(w: WalletInfo[]) => void>();
let listening = false;

function sorted(): WalletInfo[] {
  return [...found.values()].map((a) => a.info).sort((a, b) => (a.rdns === OKX_RDNS ? -1 : b.rdns === OKX_RDNS ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Start EIP-6963 discovery. Returns the wallets announced so far (OKX first) and calls `onChange`
 * whenever another announces. Safe to call repeatedly.
 */
export function discoverWallets(onChange?: (w: WalletInfo[]) => void): WalletInfo[] {
  if (onChange) listeners.add(onChange);
  if (typeof window === "undefined") return [];
  if (!listening) {
    listening = true;
    window.addEventListener("eip6963:announceProvider", ((ev: CustomEvent<Announced>) => {
      const d = ev.detail;
      if (!d?.info?.uuid || !d.provider) return;
      found.set(d.info.uuid, { info: d.info, provider: d.provider });
      const list = sorted();
      listeners.forEach((l) => l(list));
    }) as EventListener);
  }
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return sorted();
}

let active: { provider: EIP1193Provider; client: Client<Transport, typeof xLayer, Account>; account: Address; info: WalletInfo | null } | null = null;

export function connectedAccount(): Address | null {
  return active?.account ?? null;
}

export function connectedWallet(): WalletInfo | null {
  return active?.info ?? null;
}

function pickProvider(uuidOrRdns?: string): Announced | { info: null; provider: EIP1193Provider } | null {
  const all = [...found.values()];
  if (uuidOrRdns) {
    const hit = all.find((a) => a.info.uuid === uuidOrRdns || a.info.rdns === uuidOrRdns);
    if (hit) return hit;
  }
  const okx = all.find((a) => a.info.rdns === OKX_RDNS);
  if (okx) return okx;
  if (all[0]) return all[0];
  const legacy = (globalThis as { okxwallet?: EIP1193Provider; ethereum?: EIP1193Provider }).okxwallet ?? (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  return legacy ? { info: null, provider: legacy } : null;
}

/** wallet_switchEthereumChain 0xc4; on 4902 (unknown chain) wallet_addEthereumChain, then switch. */
export async function ensureChain(provider: EIP1193Provider): Promise<void> {
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === CHAIN_ID_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } })?.code ?? (e as any)?.data?.originalError?.code;
    if (code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN_ID_HEX,
        chainName: "X Layer",
        nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
        rpcUrls: [...RPC_URLS],
        blockExplorerUrls: [OKLINK],
      }],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  }
}

/** Connect (OKX Wallet first unless a specific uuid/rdns is given), then put it on X Layer. */
export async function connect(uuidOrRdns?: string): Promise<Address> {
  discoverWallets();
  const picked = pickProvider(uuidOrRdns);
  if (!picked) throw new Error("No wallet found. Install OKX Wallet or another EIP-6963 wallet.");
  const accounts = (await picked.provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts?.[0]) throw new Error("The wallet returned no account.");
  await ensureChain(picked.provider);
  const client = createClient({ chain: xLayer, transport: custom(picked.provider), account: accounts[0] });
  active = { provider: picked.provider, client, account: accounts[0], info: picked.info };
  picked.provider.on?.("accountsChanged", (a: string[]) => {
    if (active) active.account = (a?.[0] as Address) ?? active.account;
    if (!a?.length) active = null;
  });
  return accounts[0];
}

export function disconnect(): void {
  active = null;
}

export interface WriteRequest {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface WriteOutcome extends WriteResult {
  receipt: TransactionReceipt;
}

/**
 * The one write path: simulate (with the suffix) → send (with the suffix) → wait for the receipt.
 * Throws a WriteError carrying the decoded revert name if simulation fails; a mined revert returns
 * status "reverted". `onSent` fires with the hash as soon as the wallet returns it (for the pending UI).
 */
export async function write(req: WriteRequest, onSent?: (hash: Hex) => void): Promise<WriteOutcome> {
  if (!active) throw new WriteError("Connect a wallet first.", null);
  await ensureChain(active.provider);
  const pc = publicClient();
  let request: any;
  try {
    ({ request } = await pc.simulateContract({
      address: req.address,
      abi: req.abi as Abi,
      functionName: req.functionName as never,
      args: (req.args ?? []) as never,
      value: req.value,
      account: active.account,
      dataSuffix: DATA_SUFFIX,
    } as any));
  } catch (e) {
    throw new WriteError(describeError(e), revertName(e));
  }
  const hash = (await writeContract(active.client, { ...request, account: active.account, chain: xLayer, dataSuffix: DATA_SUFFIX })) as Hex;
  onSent?.(hash);
  const receipt = await pc.waitForTransactionReceipt({ hash, confirmations: 1 });
  return { hash, block: Number(receipt.blockNumber), status: receipt.status, oklinkTxUrl: oklinkTx(hash), receipt };
}

export class WriteError extends Error {
  /** The custom error name, e.g. "MarketNotClosed", when the revert decoded against the ABI. */
  readonly errorName: string | null;
  constructor(message: string, errorName: string | null) {
    super(message);
    this.name = "WriteError";
    this.errorName = errorName;
  }
}

export function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? null;
  }
  return null;
}

/** "Reverted: MarketNotClosed()" / "Rejected in wallet" / short message. */
export function describeError(e: unknown): string {
  const name = revertName(e);
  if (name) return `Reverted: ${name}()`;
  const msg = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);
  if (/user rejected|denied/i.test(msg)) return "Rejected in wallet";
  return msg;
}

