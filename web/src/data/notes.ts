/**
 * /notes: ReopenNote (ERC-1155 escrow of wrapper shares), ClosedAuction (descending clock) and
 * ReopenPointer (verified reopens), per docs/specs/W3W4-contracts.md and src/interfaces/*.sol.
 *
 * While an address in addresses.ts is null, every reader returns the specimen fixtures with
 * `specimen: true` and every writer throws; the page labels it "Specimen" / "in build".
 * ABIs are generated from forge out/ by `node web/scripts/sync-abi.mjs` (24 Sep, src/*.sol on main):
 * ClosedAuction.lotOf/lotCount, ReopenNote.noteCount and ReopenPointer.headOf are the real getters.
 */
import { decodeEventLog, maxUint256 } from "viem";
import { CLOSED_AUCTION, CHAIN_ID, DEMO_IDS, REOPEN_NOTE, REOPEN_POINTER, USDG, assetByWrapper, symbolOf } from "./addresses.ts";
import { closedAuctionAbi } from "./abi/closedAuction.ts";
import { erc20Abi } from "./abi/erc20.ts";
import { reopenNoteAbi } from "./abi/reopenNote.ts";
import { reopenPointerAbi } from "./abi/reopenPointer.ts";
import { publicClient, units } from "./chain.ts";
import { fixture, isMock } from "./mock.ts";
import { nextReopenMs, venueFor } from "./schedule.ts";
import { getPriceNow } from "./scorecard.ts";
import type { Address, AuctionLot, LotStatus, NoteView, PointerEpoch } from "./types.ts";
import type { WriteOutcome, WriteRequest } from "./wallet.ts";

/** The wallet path (viem wallet actions, EIP-6963) loads only when a visitor actually writes. */
const write = async (req: WriteRequest): Promise<WriteOutcome> => (await import("./wallet.ts")).write(req);

export const FALLBACK_AFTER_MS = 10 * 86_400_000;
export const PRINT_DELAY_S = 300;
export const PRINT_WINDOW_S = 1800;
export const LOT_STATUS: LotStatus[] = ["NONE", "LIVE", "SOLD", "WITHDRAWN"];

export const notesLive = () => REOPEN_NOTE !== null && REOPEN_POINTER !== null && !isMock();
export const auctionLive = () => CLOSED_AUCTION !== null && !isMock();

// --- pure maths (mirrors the contracts; bigint-exact) -------------------------------------------

/** valueUsdg(S, P) = mulDiv(S, P, 1e30): wrapper-share wei × 1e18 USD/share → USDG (6 dp). */
export function valueUsdg(sharesWei: bigint, priceE18: bigint): bigint {
  return (sharesWei * priceE18) / 10n ** 30n;
}

/** ClosedAuction price: start − (start − floor)·min(t − startAt, decay)/decay; flat at floor until endAt. */
export function lotPriceAt(lot: { startPrice: bigint; floorPrice: bigint; startAt: number; decaySeconds: number }, tSec: number): bigint {
  const dt = BigInt(Math.max(0, Math.min(tSec - lot.startAt, lot.decaySeconds)));
  const decay = BigInt(Math.max(1, lot.decaySeconds));
  return lot.startPrice - ((lot.startPrice - lot.floorPrice) * dt) / decay;
}

export function discountBps(ref: bigint, price: bigint): number {
  return ref > price && ref > 0n ? Number(((ref - price) * 10_000n) / ref) : 0;
}

// --- remembered ids (the browser cannot enumerate; see DEMO_IDS) --------------------------------

const idsKey = (kind: string) => `curb:ids:${CHAIN_ID}:${kind}`;

export function knownIds(kind: "notes" | "lots" | "certs"): number[] {
  let mine: number[] = [];
  try {
    mine = JSON.parse(globalThis.localStorage?.getItem(idsKey(kind)) ?? "[]");
  } catch {
    mine = [];
  }
  return [...new Set([...DEMO_IDS[kind], ...mine])].sort((a, b) => b - a);
}

export function rememberId(kind: "notes" | "lots" | "certs", id: number | bigint): void {
  try {
    const cur = new Set<number>(JSON.parse(globalThis.localStorage?.getItem(idsKey(kind)) ?? "[]"));
    cur.add(Number(id));
    globalThis.localStorage?.setItem(idsKey(kind), JSON.stringify([...cur]));
  } catch {
    /* storage unavailable */
  }
}

// --- readers ---------------------------------------------------------------------------------

export async function getPointer(wrapper: Address): Promise<PointerEpoch> {
  if (!notesLive()) {
    const all = await fixture("pointer");
    return all.find((p) => p.wrapper.toLowerCase() === wrapper.toLowerCase()) ?? all[0];
  }
  const pc = publicClient();
  // headOf(w) → Head { uint32 epoch; bool open; uint64 lastShutAt; uint64 lastObservedAt }
  const head = await pc.readContract({ address: REOPEN_POINTER!, abi: reopenPointerAbi, functionName: "headOf", args: [wrapper] });
  const e = Number(head.epoch);
  const info = e > 0 ? await pc.readContract({ address: REOPEN_POINTER!, abi: reopenPointerAbi, functionName: "epochInfo", args: [wrapper, e] }) : null;
  return {
    wrapper,
    symbol: symbolOf(wrapper),
    epoch: e,
    open: head.open,
    shutSeenAtMs: info ? Number(info.shutSeenAt) * 1000 : null,
    openedAtMs: info ? Number(info.openedAt) * 1000 : null,
    openedBlock: info ? Number(info.openedBlock) : null,
    print: info && info.print > 0n ? units(info.print) : null,
    printE18: info && info.print > 0n ? info.print.toString() : null,
    printedAtMs: info && info.printedAt > 0n ? Number(info.printedAt) * 1000 : null,
  };
}

export async function getNote(id: number | bigint, holder?: Address | null): Promise<NoteView> {
  if (!notesLive()) {
    const all = await fixture("notes");
    return all.find((n) => n.id === String(id)) ?? all[0];
  }
  const pc = publicClient();
  const block = await pc.getBlockNumber();
  const nid = BigInt(id);
  const [unit, outstanding, redeemable, balance] = await pc.multicall({
    blockNumber: block,
    allowFailure: false,
    contracts: [
      { address: REOPEN_NOTE!, abi: reopenNoteAbi, functionName: "unitOf", args: [nid] },
      { address: REOPEN_NOTE!, abi: reopenNoteAbi, functionName: "outstanding", args: [nid] },
      { address: REOPEN_NOTE!, abi: reopenNoteAbi, functionName: "redeemable", args: [nid] },
      { address: REOPEN_NOTE!, abi: reopenNoteAbi, functionName: "balanceOf", args: [holder ?? "0x0000000000000000000000000000000000000000", nid] },
    ],
  });
  const u = unit as { wrapper: Address; issuer: Address; wrapperShares: bigint; underlyingAtMint: bigint; multiplierNonce: number; epochAtMint: number; mintedAt: bigint; mintedBlock: bigint };
  const pointer = await getPointer(u.wrapper);
  let print: NoteView["print"] = null;
  if (pointer.epoch > u.epochAtMint) {
    const info = await pc.readContract({ address: REOPEN_POINTER!, abi: reopenPointerAbi, functionName: "epochInfo", args: [u.wrapper, u.epochAtMint + 1] });
    if (info.print > 0n) print = { price: units(info.print), priceE18: info.print.toString(), printedAtMs: Number(info.printedAt) * 1000 };
  }
  const price = await getPriceNow(u.wrapper);
  const mintedAtMs = Number(u.mintedAt) * 1000;
  const asset = assetByWrapper(u.wrapper);
  return {
    id: nid.toString(),
    wrapper: u.wrapper,
    symbol: symbolOf(u.wrapper),
    issuer: u.issuer,
    wrapperSharesRaw: u.wrapperShares.toString(),
    shares: units(u.wrapperShares),
    underlyingAtMintRaw: u.underlyingAtMint.toString(),
    multiplierNonce: Number(u.multiplierNonce),
    epochAtMint: Number(u.epochAtMint),
    mintedAtMs,
    mintedBlock: Number(u.mintedBlock),
    outstandingRaw: (outstanding as bigint).toString(),
    balanceRaw: holder ? (balance as bigint).toString() : null,
    redeemable: redeemable as boolean,
    epochNow: pointer.epoch,
    reopened: pointer.epoch > Number(u.epochAtMint),
    fallbackAtMs: mintedAtMs + FALLBACK_AFTER_MS,
    expectedReopenMs: asset ? nextReopenMs(Date.now(), venueFor(asset.mic)) : null,
    print,
    valueNowUsd: price.price !== null ? units(u.wrapperShares) * price.price : null,
    specimen: false,
    block: Number(block),
    source: "chain",
  };
}

export async function getNotes(ids: (number | bigint)[] = knownIds("notes"), holder?: Address | null): Promise<NoteView[]> {
  if (!notesLive()) return fixture("notes");
  return Promise.all(ids.map((id) => getNote(id, holder)));
}

/** ClosedAuction.Lot as viem decodes lotOf(lotId): uint32/uint8 → number, wider → bigint. */
type LotTuple = {
  seller: Address; wrapper: Address; noteId: bigint; amount: bigint; startPrice: bigint; floorPrice: bigint; refPrice: bigint;
  startAt: bigint; endAt: bigint; decaySeconds: number; epochAtMint: number; status: number; buyer: Address; clearedPrice: bigint; clearedAt: bigint;
  /** MarketClock.stateOf(w).nextTransitionAt read at list time; the lot's endAt is at most this. */
  cutoff: bigint;
};

/** A lot plus its cutoff (unix ms; null in fixtures, which predate the field). */
export type LotView = AuctionLot & { cutoffMs: number | null };

/** ClosedAuction.lotCount(): lot ids run 1..lotCount. Specimen: the fixture's highest id. */
export async function getLotCount(): Promise<number> {
  if (!auctionLive()) return (await fixture("lots")).reduce((m, l) => Math.max(m, Number(l.lotId)), 0);
  return Number(await publicClient().readContract({ address: CLOSED_AUCTION!, abi: closedAuctionAbi, functionName: "lotCount" }));
}

/** ReopenNote.noteCount(): note ids run 1..noteCount. Specimen: the fixture's highest id. */
export async function getNoteCount(): Promise<number> {
  if (!notesLive()) return (await fixture("notes")).reduce((m, n) => Math.max(m, Number(n.id)), 0);
  return Number(await publicClient().readContract({ address: REOPEN_NOTE!, abi: reopenNoteAbi, functionName: "noteCount" }));
}

export async function getLot(lotId: number | bigint): Promise<LotView> {
  if (!auctionLive()) {
    const all = await fixture("lots");
    return { ...(all.find((l) => l.lotId === String(lotId)) ?? all[0]!), cutoffMs: null };
  }
  const pc = publicClient();
  const block = await pc.getBlockNumber();
  const id = BigInt(lotId);
  const res = await pc.multicall({
    blockNumber: block,
    allowFailure: true,
    contracts: [
      { address: CLOSED_AUCTION!, abi: closedAuctionAbi, functionName: "lotOf", args: [id] },
      { address: CLOSED_AUCTION!, abi: closedAuctionAbi, functionName: "currentPrice", args: [id] },
      { address: CLOSED_AUCTION!, abi: closedAuctionAbi, functionName: "realisedDiscountBps", args: [id] },
    ],
  });
  if (res[0].status !== "success") throw new Error(`lot ${id}: unreadable (${String(res[0].error)})`);
  const l = res[0].result as unknown as LotTuple;
  const status = LOT_STATUS[l.status] ?? "NONE";
  const current = status === "LIVE" && res[1].status === "success" ? (res[1].result as bigint) : null;
  const usd = (v: bigint) => units(v, 6);
  return {
    lotId: id.toString(),
    seller: l.seller,
    wrapper: l.wrapper,
    symbol: symbolOf(l.wrapper),
    noteId: l.noteId.toString(),
    amountRaw: l.amount.toString(),
    shares: units(l.amount),
    startPrice: usd(l.startPrice),
    startPriceRaw: l.startPrice.toString(),
    floorPrice: usd(l.floorPrice),
    floorPriceRaw: l.floorPrice.toString(),
    refPrice: usd(l.refPrice),
    refPriceRaw: l.refPrice.toString(),
    startAtMs: Number(l.startAt) * 1000,
    endAtMs: Number(l.endAt) * 1000,
    decaySeconds: Number(l.decaySeconds),
    epochAtMint: Number(l.epochAtMint),
    status,
    buyer: status === "SOLD" ? l.buyer : null,
    clearedPrice: status === "SOLD" ? usd(l.clearedPrice) : null,
    clearedAtMs: status === "SOLD" ? Number(l.clearedAt) * 1000 : null,
    currentPrice: current !== null ? usd(current) : null,
    discountBpsVsRef: current !== null ? discountBps(l.refPrice, current) : null,
    realisedDiscountBps: res[2].status === "success" ? Number(res[2].result as bigint) : null,
    cutoffMs: l.cutoff > 0n ? Number(l.cutoff) * 1000 : null,
    specimen: false,
    block: Number(block),
    source: "chain",
  };
}

export async function getLots(ids: (number | bigint)[] = knownIds("lots")): Promise<LotView[]> {
  if (!auctionLive()) return (await fixture("lots")).map((l) => ({ ...l, cutoffMs: null }));
  return Promise.all(ids.map((id) => getLot(id)));
}

// --- writers (each: simulate → send with Builder Code → receipt) --------------------------------

function need(addr: Address | null, name: string): Address {
  if (!addr || isMock()) throw new Error(`${name} is not deployed yet (Specimen).`);
  return addr;
}

function idFromTransferSingle(o: WriteOutcome, contract: Address): bigint | null {
  for (const log of o.receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: reopenNoteAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "TransferSingle") return (ev.args as { id: bigint }).id;
    } catch {
      /* other event */
    }
  }
  return null;
}

/** Approve ReopenNote to pull `shares` wrapper-share wei (the wrapper is an ERC-20). */
export function approveWrapperForNote(wrapper: Address, shares: bigint = maxUint256) {
  return write({ address: wrapper, abi: erc20Abi, functionName: "approve", args: [need(REOPEN_NOTE, "ReopenNote"), shares] });
}

/** Mint a note while the market is shut; resolves with the new note id (from TransferSingle). */
export async function mintNote(wrapper: Address, shares: bigint, to: Address): Promise<WriteOutcome & { noteId: bigint | null }> {
  const note = need(REOPEN_NOTE, "ReopenNote");
  const o = await write({ address: note, abi: reopenNoteAbi, functionName: "mint", args: [wrapper, shares, to] });
  const noteId = idFromTransferSingle(o, note);
  if (noteId !== null) rememberId("notes", noteId);
  return { ...o, noteId };
}

/** Let ClosedAuction pull notes when listing. */
export function approveNotesForAuction() {
  return write({ address: need(REOPEN_NOTE, "ReopenNote"), abi: reopenNoteAbi, functionName: "setApprovalForAll", args: [need(CLOSED_AUCTION, "ClosedAuction"), true] });
}

export async function listNote(p: { noteId: bigint; amount: bigint; startPrice: bigint; floorPrice: bigint; decaySeconds: number; endAt: number }): Promise<WriteOutcome & { lotId: bigint | null }> {
  const auction = need(CLOSED_AUCTION, "ClosedAuction");
  const o = await write({
    address: auction, abi: closedAuctionAbi, functionName: "list",
    // list(uint256 noteId, uint128 amount, uint128 startPrice, uint128 floorPrice, uint32 decaySeconds, uint64 endAt);
    // endAt must be <= MarketClock.stateOf(wrapper).nextTransitionAt (else SpansTransition / NoCutoff).
    args: [p.noteId, p.amount, p.startPrice, p.floorPrice, p.decaySeconds, BigInt(p.endAt)],
  });
  let lotId: bigint | null = null;
  for (const log of o.receipt.logs) {
    if (log.address.toLowerCase() !== auction.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: closedAuctionAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Listed") lotId = (ev.args as { lotId: bigint }).lotId;
    } catch {
      /* other event */
    }
  }
  if (lotId !== null) rememberId("lots", lotId);
  return { ...o, lotId };
}

/** Approve ClosedAuction to pull USDG for a bid. */
export function approveUsdgForAuction(amount: bigint = maxUint256) {
  return write({ address: USDG, abi: erc20Abi, functionName: "approve", args: [need(CLOSED_AUCTION, "ClosedAuction"), amount] });
}

export function bidLot(lotId: bigint, maxPrice: bigint) {
  return write({ address: need(CLOSED_AUCTION, "ClosedAuction"), abi: closedAuctionAbi, functionName: "bid", args: [lotId, maxPrice] });
}

export function withdrawLot(lotId: bigint) {
  return write({ address: need(CLOSED_AUCTION, "ClosedAuction"), abi: closedAuctionAbi, functionName: "withdraw", args: [lotId] });
}

/** Permissionless: witness the market's state so the pointer can advance its epoch. */
export function observe(wrapper: Address) {
  return write({ address: need(REOPEN_POINTER, "ReopenPointer"), abi: reopenPointerAbi, functionName: "observe", args: [wrapper] });
}

/** Permissionless: record the reopen print, in [openedAt + 300 s, + 1800 s]. */
export function recordPrint(wrapper: Address, epoch: number) {
  return write({ address: need(REOPEN_POINTER, "ReopenPointer"), abi: reopenPointerAbi, functionName: "recordPrint", args: [wrapper, epoch] });
}

export function redeemNote(id: bigint, amount: bigint, to: Address) {
  return write({ address: need(REOPEN_NOTE, "ReopenNote"), abi: reopenNoteAbi, functionName: "redeem", args: [id, amount, to] });
}

export function cancelNote(id: bigint) {
  return write({ address: need(REOPEN_NOTE, "ReopenNote"), abi: reopenNoteAbi, functionName: "cancel", args: [id] });
}
