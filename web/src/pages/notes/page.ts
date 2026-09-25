// /notes: sell the reopen, not the asset (lane E).
// ReopenNote certificates, the ClosedAuction descending clock, the ReopenPointer panel, the lots and
// their graded discount, and the mint → list → bid → observe/print → redeem flow for a connected wallet.
// While the W3 addresses are null the page renders lane B's fixtures as an honest "Specimen · in build".
import { boot } from '../../shell/boot';
import './page.css';

import { parseUnits } from 'viem';
import {
  approveNotesForAuction, approveUsdgForAuction, approveWrapperForNote, auctionLive, bidLot, getClosureCap, getLot, getLotCount,
  getNote, getNoteCount, getNotes, getPointer, knownIds, listNote, lotPriceAt, mintNote, notesLive, observe,
  recordPrint, redeemNote, type LotView, PRINT_DELAY_S, PRINT_WINDOW_S,
} from '../../data/notes';
import {
  AGENTIC_WALLET, ASSETS, CLOSED_AUCTION, CURB_DESK, ELIGIBILITY_REGISTRY, MARKET_CLOCK, REOPEN_NOTE, REOPEN_POINTER,
  SCORECARD, USDG, assetByWrapper, type CohortAsset,
} from '../../data/addresses';
import { isMock } from '../../data/mock';
import { getRegime } from '../../data/regime';
import { nextReopenMs, venueFor } from '../../data/schedule';
import type { Address, NoteView, PointerEpoch, RegimeState } from '../../data/types';
import { certificateHTML, enableTilt } from '../../certificate/certificate';
import { countdown, type CountdownHandle } from '../../ui/countdown';
import { fmtAgo, fmtBlock, fmtBp } from '../../ui/format';
import { html, raw, render, type SafeHTML } from '../../ui/html';
import { statHTML } from '../../ui/stat';
import { addressLinkHTML, blockLinkHTML } from '../../ui/txlink';
import {
  fmtShares, gate, hktDate, hktShort, mountWalletBar, statusTagHTML, txAction, usdgFixed, vsReference, whoHTML,
} from './instrument';

const shell = boot({ page: 'notes' });
const $ = <T extends Element = HTMLElement>(sel: string) => shell.main.querySelector<T>(sel);

const TEAM: Record<string, string> = {
  [CURB_DESK.toLowerCase()]: 'team: curb-desk',
  [AGENTIC_WALLET.toLowerCase()]: 'team: Agentic Wallet',
};
const NOTE_ASSETS: CohortAsset[] = ASSETS.filter((a) => a.noteCapShares > 0);
const LIVE = { notes: notesLive(), auction: auctionLive() };
const ANY_LIVE = LIVE.notes || LIVE.auction;

// ---------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------

type Cap = Awaited<ReturnType<typeof getClosureCap>>;
interface State {
  notes: NoteView[];
  lots: LotView[];
  pointers: PointerEpoch[];
  caps: Map<string, Cap>;
  featuredLot: LotView | null;
  featuredNote: NoteView | null;
  block: number | null;
}
let state: State | null = null;
let account: Address | null = null;
let flowAsset: CohortAsset = NOTE_ASSETS[0]!;
let flowRegime: RegimeState | null = null;

/** Ids to read: every remembered/demo id that exists, plus the latest few by count. */
function idsFrom(known: number[], count: number, latest = 8): number[] {
  const out = new Set<number>(known.filter((i) => i >= 1 && i <= count));
  for (let i = count; i >= Math.max(1, count - latest + 1); i--) out.add(i);
  return [...out].sort((a, b) => b - a);
}

/**
 * A specimen lot is replayed from when the visitor opened the page, keeping the demo's terms
 * (start, floor, decay), and ending at the earlier of the attested cutoff and five minutes before
 * the scheduled reopen. Labelled as a replay wherever it is shown.
 */
const PAGE_OPENED = Date.now();
function replaySpecimen(l: LotView, cutoffMs: number | null): LotView {
  const startAtMs = PAGE_OPENED - Math.round(l.decaySeconds * 350);
  const asset = assetByWrapper(l.wrapper);
  const reopen = asset ? nextReopenMs(PAGE_OPENED, venueFor(asset.mic)) : null;
  const candidates = [cutoffMs, reopen !== null ? reopen - 5 * 60_000 : null].filter((x): x is number => x !== null && x > PAGE_OPENED);
  const endAtMs = Math.max(startAtMs + l.decaySeconds * 1000 + 60_000, candidates.length ? Math.min(...candidates) : PAGE_OPENED + 3 * 3_600_000);
  return { ...l, startAtMs, endAtMs, cutoffMs: cutoffMs ?? l.cutoffMs, status: 'LIVE', currentPrice: null };
}

async function load(): Promise<State> {
  // The public RPC allows a few requests a second, so read the lots first and then only the one note the
  // certificate shows (the featured lot's note, else the newest).
  const [noteCount, lotCount] = await Promise.all([getNoteCount().catch(() => 0), getLotCount().catch(() => 0)]);
  const lotIds = idsFrom(knownIds('lots'), lotCount, 6);
  const lotResults = await Promise.allSettled(LIVE.auction ? lotIds.map((id) => getLot(id)) : [getLot(1)]);
  let lots = lotResults.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const liveLot = lots.find((l) => l.status === 'LIVE' && Date.now() <= l.endAtMs) ?? lots[0];
  const noteId = liveLot && Number(liveLot.noteId) <= noteCount ? Number(liveLot.noteId) : noteCount;
  const notes: NoteView[] = LIVE.notes
    ? noteId > 0 ? await getNotes([noteId], account).catch(() => [] as NoteView[]) : []
    : await getNotes([], account).catch(() => [] as NoteView[]);
  const assets = LIVE.notes ? NOTE_ASSETS : NOTE_ASSETS.slice(0, 1);
  const pointers = (await Promise.allSettled(assets.map((a) => getPointer(a.wrapper)))).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const caps = new Map<string, Cap>();
  (await Promise.allSettled(assets.map((a) => getClosureCap(a.wrapper)))).forEach((r, i) => {
    if (r.status === 'fulfilled') caps.set(assets[i]!.wrapper.toLowerCase(), r.value);
  });

  if (!LIVE.auction && lots.length) {
    const r = await getRegime({ wrapper: lots[0]!.wrapper }).catch(() => null);
    const cutoff = r?.nextTransitionAtMs ?? null;
    lots = lots.map((l) => replaySpecimen(l, cutoff && cutoff > Date.now() ? cutoff : null));
  }
  const featuredLot = lots.find((l) => l.status === 'LIVE' && Date.now() <= l.endAtMs) ?? lots[0] ?? null;
  const featuredNote = (featuredLot && notes.find((n) => n.id === featuredLot.noteId)) ?? notes[0] ?? null;
  const block = [...notes, ...lots].map((x) => x.block).find((b): b is number => typeof b === 'number') ?? null;
  return { notes, lots, pointers, caps, featuredLot, featuredNote, block };
}

// ---------------------------------------------------------------------------------------------
// 1. the certificate
// ---------------------------------------------------------------------------------------------

let stopTilt: (() => void) | null = null;

/**
 * The note as a certificate. `null` draws the same card with dashes (the first paint, before any read,
 * and the "nothing minted yet" state), so the real card replaces it without moving the page.
 */
function noteCertificate(n: NoteView | null, loaded = true): SafeHTML {
  const now = Date.now();
  const dash = '—';
  const DATE_DASH = '— — —, —:— HKT';
  const promise = !n
    ? loaded
      ? html`No note has been minted yet. The first demo note is minted while Hong Kong is shut, after the contracts are deployed.`
      : html`Settles at the verified reopen, expected <strong>${DATE_DASH}</strong> by the published schedule. The pointer’s witnessed epoch decides, not the timetable.`
    : n.reopened && BigInt(n.outstandingRaw) === 0n && !n.specimen
      ? html`Reopen witnessed at epoch ${n.epochNow}. <strong>Redeemed in full:</strong> all ${fmtShares(n.shares)} ${n.symbol} delivered to the holder, share for share.`
    : n.reopened
      ? html`Reopen witnessed: the pointer is at epoch ${n.epochNow}. <strong>Redeemable now</strong> for exactly ${fmtShares(n.shares)} ${n.symbol}, share for share.`
      : html`Settles at the verified reopen, expected <strong>${n.expectedReopenMs ? hktDate(n.expectedReopenMs) : 'at the next reopen'}</strong> by the published schedule. The pointer’s witnessed epoch decides, not the timetable.`;
  const underlying = n ? Number(BigInt(n.underlyingAtMintRaw)) / 1e18 : 0;
  const team = n ? TEAM[n.issuer.toLowerCase()] : undefined;
  return certificateHTML({
    kind: 'note',
    id: n?.id ?? 0,
    ...(n ? {} : { serial: '—', label: 'Curb Reopen Note, not yet read' }),
    title: 'Curb Reopen Note',
    asset: n?.symbol ?? dash,
    face: `${n ? fmtShares(n.shares) : dash} wrapper shares, delivered share for share`,
    promise,
    specimen: n?.specimen ?? false,
    vt: true,
    fields: [
      { label: 'Wrapper shares', value: n ? fmtShares(n.shares) : dash, note: 'One unit of the note is one wei of a share' },
      { label: 'Underlying at mint', value: n ? fmtShares(underlying) : dash, note: 'Provenance only: the wrapper absorbs splits and dividends' },
      { label: 'Multiplier nonce', value: n ? String(n.multiplierNonce) : dash },
      { label: 'Epoch at mint', value: n ? String(n.epochAtMint) : dash, note: `Unlocks when the pointer passes this epoch` },
      { label: 'Minted', value: n ? blockLinkHTML(n.mintedBlock) : dash, note: n ? hktDate(n.mintedAtMs) : DATE_DASH },
      { label: 'Issuer', value: n ? addressLinkHTML(n.issuer) : dash, note: team ? `${team.replace('team: ', 'Team wallet: ')}` : 'Can cancel only while holding every unit' },
      { label: 'Fallback', value: n ? hktDate(n.fallbackAtMs) : DATE_DASH, note: !n || n.fallbackAtMs > now ? 'Redeemable then even if no reopen is witnessed' : 'Passed: redeemable by fallback' },
    ],
  });
}

function drawCertificate(n: NoteView | null, loaded = true): void {
  const slot = $('[data-nt-cert]');
  if (!slot) return;
  stopTilt?.();
  render(slot, noteCertificate(n, loaded));
  const card = slot.querySelector<HTMLElement>('.crt');
  if (card) stopTilt = enableTilt(card, 6);
}

// ---------------------------------------------------------------------------------------------
// 2. the descending clock
// ---------------------------------------------------------------------------------------------

const PAD = { l: 2, r: 2, t: 26, b: 30 };
let cd: CountdownHandle | null = null;
let tickTimer: ReturnType<typeof setInterval> | undefined;

function lotBig(l: LotView) {
  return { startPrice: BigInt(l.startPriceRaw), floorPrice: BigInt(l.floorPriceRaw), startAt: Math.floor(l.startAtMs / 1000), decaySeconds: l.decaySeconds };
}

function chartWindow(l: LotView): [number, number] {
  const a = l.startAtMs;
  const b = Math.min(l.endAtMs, a + l.decaySeconds * 1000 * 1.6);
  return [a, Math.max(b, a + 60_000)];
}

function drawChart(l: LotView): void {
  const el = $('[data-nt-chart]');
  if (!el) return;
  // Drawn at the box's real pixel size, so the type in the SVG stays at its CSS size.
  const W = Math.max(240, Math.round(el.clientWidth || 600));
  const H = Math.max(160, Math.round(el.clientHeight || 240));
  const [t0, t1] = chartWindow(l);
  const start = Number(l.startPriceRaw);
  const floor = Number(l.floorPriceRaw);
  const ref = Number(l.refPriceRaw);
  const hi = Math.max(start, ref || start);
  const lo = Math.min(floor, ref || floor);
  const span = Math.max(1, hi - lo);
  const yMin = lo - span * 0.25;
  const yMax = hi + span * 0.2;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - (p - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const tDecay = l.startAtMs + l.decaySeconds * 1000;
  const path = `M${x(t0).toFixed(1)} ${y(start).toFixed(1)} L${x(Math.min(tDecay, t1)).toFixed(1)} ${y(tDecay <= t1 ? floor : start - ((start - floor) * (t1 - t0)) / (tDecay - t0)).toFixed(1)}${tDecay < t1 ? ` L${x(t1).toFixed(1)} ${y(floor).toFixed(1)}` : ''}`;
  const refLine = ref > 0 ? `<line class="nt-chart__ref" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(ref).toFixed(1)}" y2="${y(ref).toFixed(1)}"/><text class="nt-chart__label" x="${W - PAD.r}" y="${(y(ref) - 6).toFixed(1)}" text-anchor="end">reference ${usdgFixed(BigInt(l.refPriceRaw), 2)}</text>` : '';
  const floorLabel = `<text class="nt-chart__label" x="${W - PAD.r}" y="${(y(floor) + 16).toFixed(1)}" text-anchor="end">floor ${usdgFixed(BigInt(l.floorPriceRaw), 2)}${l.endAtMs > t1 ? ` until ${hktShort(l.endAtMs)}` : ''}</text>`;
  const startLabel = `<text class="nt-chart__label" x="${PAD.l}" y="${(y(start) - 8).toFixed(1)}">start ${usdgFixed(BigInt(l.startPriceRaw), 2)}</text>`;
  const axis = `<line class="nt-chart__axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}"/>
    <text class="nt-chart__tick" x="${PAD.l}" y="${H - 8}">${hktShort(t0)}</text>
    <text class="nt-chart__tick" x="${x(Math.min(tDecay, t1)).toFixed(1)}" y="${H - 8}" text-anchor="middle">${hktShort(Math.min(tDecay, t1))}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="nt-chart" focusable="false" aria-hidden="true">
    ${axis}${refLine}
    <path class="nt-chart__future" d="${path}"/>
    <clipPath id="nt-past"><rect data-nt-past x="0" y="0" width="0" height="${H}"/></clipPath>
    <path class="nt-chart__path" d="${path}" clip-path="url(#nt-past)"/>
    ${startLabel}${floorLabel}
    <g data-nt-now class="nt-chart__now"><line x1="0" x2="0" y1="${PAD.t - 8}" y2="${H - PAD.b}"/><circle r="5" cx="0" cy="0" data-nt-dot/></g>
  </svg>`;
  const txt = $('[data-nt-chart-text]');
  if (txt) {
    txt.textContent = `Price path: ${usdgFixed(BigInt(l.startPriceRaw), 2)} USDG falling in a straight line to ${usdgFixed(BigInt(l.floorPriceRaw), 2)} over ${Math.round(l.decaySeconds / 60)} minutes from ${hktShort(l.startAtMs)}, then flat at the floor until ${hktShort(l.endAtMs)}.${ref > 0 ? ` Reference ${usdgFixed(BigInt(l.refPriceRaw), 2)} USDG.` : ''}`;
  }
  // keep the scales for the ticking marker
  (el as HTMLElement & { _scale?: unknown })._scale = { x, y, t0, t1 };
}

function tickClock(l: LotView): void {
  const now = Date.now();
  const sold = l.status === 'SOLD';
  const over = l.status !== 'LIVE' || now > l.endAtMs;
  const tNow = sold && l.clearedAtMs ? l.clearedAtMs : Math.min(now, l.endAtMs);
  const p = lotPriceAt(lotBig(l), Math.floor(tNow / 1000));
  const labelEl = $('[data-nt-price-label]');
  if (labelEl) labelEl.textContent = sold ? 'Cleared at, whole lot' : over ? 'Price at the end, whole lot' : 'Price now, whole lot';
  const priceEl = $('[data-nt-price]');
  if (priceEl) priceEl.textContent = sold && l.clearedPrice !== null ? `${usdgFixed(BigInt(Math.round(l.clearedPrice * 1e6)), 4)} USDG` : `${usdgFixed(p, 4)} USDG`;
  const ref = BigInt(l.refPriceRaw);
  const disc = $('[data-nt-disc]');
  if (disc) disc.textContent = ref > 0n ? vsReference(Number(((ref - p) * 10_000n) / ref), true) : 'no reference (price unreadable at listing)';
  const st = $('[data-nt-lotstatus]');
  if (st) {
    st.textContent = sold
      ? `Sold${l.clearedAtMs ? ` at ${hktShort(l.clearedAtMs, now, true)}` : ''}`
      : l.status === 'WITHDRAWN' ? 'Withdrawn by the seller'
      : over ? 'Ended unsold'
      : now < l.startAtMs + l.decaySeconds * 1000 ? 'Live, falling' : 'Live, at the floor';
  }
  // the marker
  const el = $('[data-nt-chart]') as (HTMLElement & { _scale?: { x: (t: number) => number; y: (p: number) => number; t0: number; t1: number } }) | null;
  const s = el?._scale;
  const g = el?.querySelector('[data-nt-now]');
  if (s && g) {
    const tt = Math.min(Math.max(tNow, s.t0), s.t1);
    const px = s.x(tt);
    g.setAttribute('transform', `translate(${px.toFixed(1)} 0)`);
    g.querySelector('[data-nt-dot]')?.setAttribute('cy', s.y(Number(p)).toFixed(1));
    el!.querySelector('[data-nt-past]')?.setAttribute('width', px.toFixed(1));
  }
}

function drawClock(l: LotView | null): void {
  clearInterval(tickTimer);
  cd?.stop();
  cd = null;
  const title = $('[data-nt-clock-title]');
  const asof = $('[data-nt-clock-asof]');
  const note = $('[data-nt-clock-note]');
  if (!l) {
    if (title) title.textContent = 'No lot yet';
    if (asof) asof.textContent = LIVE.auction ? 'ClosedAuction has no lots' : 'in build';
    render($('[data-nt-chart]')!, html`<p class="t-small muted nt-chart__empty">The first demo lot lists while Hong Kong is shut, after ClosedAuction is deployed.</p>`);
    return;
  }
  if (title) title.textContent = `Lot ${l.lotId} · note ${l.noteId} · ${fmtShares(l.shares)} ${l.symbol}`;
  if (asof) asof.textContent = l.specimen ? 'Specimen replay' : l.block ? `as of block ${fmtBlock(l.block)}` : '';
  if (note) {
    note.textContent = l.specimen
      ? `Specimen: the demo lot’s terms (${usdgFixed(BigInt(l.startPriceRaw), 2)} → ${usdgFixed(BigInt(l.floorPriceRaw), 2)} USDG over ${Math.round(l.decaySeconds / 60)} minutes), replayed from when you opened this page and ending by the attested cutoff. The live lot replaces it once ClosedAuction is deployed.`
      : `The price is computed from the contract’s own formula at your clock; the chain’s block time decides the price a bid pays. The lot’s cutoff is ${l.cutoffMs ? hktShort(l.cutoffMs) : 'recorded at listing'}.`;
  }
  const set = (sel: string, v: string) => {
    const e = $(sel);
    if (e) e.textContent = v;
  };
  set('[data-nt-start]', `${usdgFixed(BigInt(l.startPriceRaw), 2)} USDG`);
  set('[data-nt-floor]', `${usdgFixed(BigInt(l.floorPriceRaw), 2)} USDG`);
  set('[data-nt-ends]', hktShort(l.endAtMs));
  drawChart(l);
  const cdEl = $('[data-nt-countdown]');
  if (cdEl) {
    if (l.status === 'LIVE' && l.endAtMs > Date.now()) cd = countdown(cdEl, { target: l.endAtMs, format: 'hms', label: 'Lot ends in' });
    else cdEl.textContent = l.status === 'SOLD' ? 'cleared' : 'ended';
  }
  tickClock(l);
  if (l.status === 'LIVE') tickTimer = setInterval(() => tickClock(l), 1000);
}

// Redraw the chart when its box changes width (rotation, resize).
let lastW = 0;
const chartBox = document.querySelector<HTMLElement>('[data-nt-chart]');
if (chartBox && 'ResizeObserver' in window) {
  new ResizeObserver(() => {
    const w = Math.round(chartBox.clientWidth);
    if (w === lastW || !state?.featuredLot) return;
    lastW = w;
    drawChart(state.featuredLot);
    tickClock(state.featuredLot);
  }).observe(chartBox);
}

// ---------------------------------------------------------------------------------------------
// 4. pointer, 5. lots, 6. provenance
// ---------------------------------------------------------------------------------------------

function capText(c: Cap | undefined): string {
  if (!c) return '—';
  const used = Number(c.usedRaw) / 1e18;
  const cap = Number(c.capRaw) / 1e18;
  return `${fmtShares(used)} of ${fmtShares(cap)}`;
}

function drawPointer(ps: PointerEpoch[], caps: Map<string, Cap>): void {
  const body = $('[data-nt-pointer]');
  const cap = $('[data-nt-pointer-cap]');
  if (!body) return;
  const now = Date.now();
  if (cap) cap.textContent = LIVE.notes ? 'ReopenPointer, per note asset, read now' : 'ReopenPointer, per note asset · Specimen, in build';
  if (!ps.length) {
    render(body, html`<tr><td colspan="7" class="muted">ReopenPointer is unreadable just now.</td></tr>`);
    return;
  }
  render(
    body,
    html`${ps.map((p) => {
      const asset = assetByWrapper(p.wrapper);
      const reopen = asset ? nextReopenMs(now, venueFor(asset.mic)) : null;
      const bracket = p.shutSeenAtMs && p.openedAtMs
        ? html`<span class="t-data">(${hktShort(p.shutSeenAtMs, now, true)}, ${hktShort(p.openedAtMs, now, true)}]</span>`
        : html`<span class="muted">none witnessed yet</span>`;
      let print: SafeHTML;
      if (p.print !== null && p.printedAtMs) print = html`<span class="t-data">$${p.print.toFixed(4)}</span> <span class="muted">at ${hktShort(p.printedAtMs, now, true)}</span>`;
      else if (p.openedAtMs) {
        const a = p.openedAtMs + PRINT_DELAY_S * 1000;
        const b = a + PRINT_WINDOW_S * 1000;
        print = now < b ? html`<span class="muted">window ${hktShort(a, now)} to ${hktShort(b, now)}</span>` : html`<span class="muted">window missed; unprinted</span>`;
      } else print = html`<span class="muted">none</span>`;
      return html`<tr>
        <th scope="row">${p.symbol}</th>
        <td class="num">${p.epoch}</td>
        <td>${p.open ? 'open' : 'shut'}</td>
        <td>${bracket}</td>
        <td>${print}</td>
        <td>${reopen ? hktShort(reopen, now) : '—'}</td>
        <td class="num">${capText(caps.get(p.wrapper.toLowerCase()))}</td>
      </tr>`;
    })}`,
  );
}

function drawLots(lots: LotView[]): void {
  const body = $('[data-nt-lots]');
  const cap = $('[data-nt-lots-cap]');
  if (!body) return;
  const now = Date.now();
  if (cap) cap.textContent = LIVE.auction ? `Lots on ClosedAuction, newest first` : 'Lots on ClosedAuction · Specimen, in build (the demo lot, replayed)';
  if (!lots.length) {
    render(body, html`<tr><td colspan="9" class="muted">No lots yet.</td></tr>`);
  } else {
    render(
      body,
      html`${lots.map((l) => {
        const live = l.status === 'LIVE' && now <= l.endAtMs;
        const nowPrice = l.status === 'SOLD' && l.clearedPrice !== null ? `${usdgFixed(BigInt(Math.round(l.clearedPrice * 1e6)), 4)} paid` : live ? `${usdgFixed(lotPriceAt(lotBig(l), Math.floor(now / 1000)), 4)}` : '—';
        const status = l.status === 'SOLD' ? html`sold to ${whoHTML(l.buyer!, TEAM)}` : live ? 'live' : l.status === 'WITHDRAWN' ? 'withdrawn' : 'ended unsold';
        return html`<tr>
          <th scope="row" class="t-data">${l.lotId}</th>
          <td class="t-data">${l.noteId}</td>
          <td>${l.symbol}</td>
          <td class="num">${fmtShares(l.shares)}</td>
          <td class="num">${l.startPrice.toFixed(2)} → ${l.floorPrice.toFixed(2)}</td>
          <td class="num">${nowPrice}</td>
          <td>${hktShort(l.endAtMs, now)}</td>
          <td>${status}</td>
          <td class="num">${l.realisedDiscountBps !== null ? fmtBp(l.realisedDiscountBps) : html`<span class="muted">${l.status === 'SOLD' ? 'awaiting print' : '—'}</span>`}</td>
        </tr>`;
      })}`,
    );
  }
  const stat = $('[data-nt-realised]');
  if (stat) {
    const graded = lots.filter((l) => l.realisedDiscountBps !== null);
    const last = graded[0];
    render(
      stat,
      last
        ? statHTML({
            label: `Realised discount, lot ${last.lotId}`,
            value: fmtBp(last.realisedDiscountBps!),
            asOf: last.block ? `block ${fmtBlock(last.block)}` : undefined,
            note: last.realisedDiscountBps! >= 0 ? 'The buyer paid below the reopen print.' : 'The buyer paid above the reopen print.',
          } as Parameters<typeof statHTML>[0])
        : statHTML({
            label: 'Realised discount',
            value: 'Not graded yet',
            size: 'display',
            note: ANY_LIVE ? 'A sold lot is graded once the reopen print is recorded.' : 'Specimen: graded after the first live sale and the reopen that follows it.',
          }),
    );
  }
}

function drawProvenance(): void {
  const el = $('[data-nt-prov]');
  if (!el) return;
  const row = (dt: string, dd: SafeHTML | string) => html`<div class="ledger__row"><dt>${dt}</dt><dd>${dd}</dd></div>`;
  const addr = (a: Address | null) => (a ? addressLinkHTML(a, { full: false }) : html`<span class="muted">not deployed yet · in build</span>`);
  render(
    el,
    html`${row('ReopenNote (CURB-RN)', addr(REOPEN_NOTE))}
    ${row('ClosedAuction', addr(CLOSED_AUCTION))}
    ${row('ReopenPointer', addr(REOPEN_POINTER))}
    ${row('Eligibility registry', addr(ELIGIBILITY_REGISTRY))}
    ${row('MarketClock (open or shut)', addressLinkHTML(MARKET_CLOCK))}
    ${row('Scorecard (the guarded price)', addressLinkHTML(SCORECARD))}
    ${row('USDG (6 dp)', addressLinkHTML(USDG))}
    ${row('Demo wallets', html`curb-desk ${addressLinkHTML(CURB_DESK)} sells · Agentic Wallet ${addressLinkHTML(AGENTIC_WALLET)} buys. Demo counterparties are team wallets.`)}
    ${row('Admin', 'None. ReopenNote, ClosedAuction and ReopenPointer have no admin, no fee and no upgrade path.')}`,
  );
}

function drawStatus(block: number | null): void {
  const el = $('[data-nt-status]');
  if (!el) return;
  render(el, html`${statusTagHTML(ANY_LIVE && !isMock(), block)}${!LIVE.auction && LIVE.notes ? html` <span class="tag tag--specimen">ClosedAuction in build</span>` : ''}`);
}

// ---------------------------------------------------------------------------------------------
// 3. the flow
// ---------------------------------------------------------------------------------------------

const wallet = mountWalletBar($('[data-nt-wallet]')!, { live: LIVE.notes && LIVE.auction });
const btn = (k: string) => $<HTMLButtonElement>(`[data-nt-tx="${k}"]`)!;
const input = (k: string) => $<HTMLInputElement>(`[data-nt-in="${k}"]`)!;
const statusFor = (k: string) => $<HTMLElement>(`[data-nt-status-for="${k}"]`) ?? undefined;
const ALL_TX = ['approve', 'mint', 'approveAll', 'list', 'approveUsdg', 'bid', 'observe', 'print', 'redeem'];

function num(k: string, what: string): string {
  const v = input(k).value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) throw new Error(`Enter ${what} as a positive number.`);
  return v;
}
function me(): Address {
  const a = wallet.account();
  if (!a) throw new Error('Connect a wallet first.');
  return a;
}

function wireFlow(): void {
  const sel = $<HTMLSelectElement>('[data-nt-asset]')!;
  render(sel, html`${NOTE_ASSETS.map((a) => html`<option value="${a.wrapper}">${a.symbol} · cap ${a.noteCapShares} shares</option>`)}`);
  sel.addEventListener('change', () => {
    flowAsset = NOTE_ASSETS.find((a) => a.wrapper === sel.value) ?? NOTE_ASSETS[0]!;
    void readFlowRegime();
  });

  txAction(btn('approve'), () => approveWrapperForNote(flowAsset.wrapper, parseUnits(num('shares', 'the shares'), 18)), { status: statusFor('approve') });
  txAction(btn('mint'), () => mintNote(flowAsset.wrapper, parseUnits(num('shares', 'the shares'), 18), me()), {
    status: statusFor('mint'),
    after: (o, s) => {
      const id = (o as typeof o & { noteId?: bigint | null }).noteId;
      if (id) {
        input('noteId').value = String(id);
        input('redeemId').value = String(id);
        s.insertAdjacentHTML('beforeend', html` · note <strong>#${String(id)}</strong> minted`.value);
      }
      void refresh();
    },
  });
  txAction(btn('approveAll'), () => approveNotesForAuction(), { status: statusFor('approveAll') });
  txAction(
    btn('list'),
    async () => {
      const id = BigInt(num('noteId', 'the note id'));
      const n = await getNote(id, me());
      const amount = BigInt(n.balanceRaw ?? '0');
      if (amount === 0n) throw new Error(`You hold no units of note ${id}.`);
      const r = await getRegime({ wrapper: n.wrapper });
      const cutoff = r.nextTransitionAtMs;
      if (!cutoff || cutoff <= Date.now() + 60_000) throw new Error('MarketClock has no future transition attested for this asset (NoCutoff): a lot cannot be listed now.');
      return listNote({
        noteId: id,
        amount,
        startPrice: parseUnits(num('start', 'the start price'), 6),
        floorPrice: parseUnits(num('floor', 'the floor price'), 6),
        decaySeconds: Math.round(Number(num('decay', 'the minutes')) * 60),
        endAt: Math.floor(cutoff / 1000),
      });
    },
    {
      status: statusFor('list'),
      after: (o, s) => {
        const id = (o as typeof o & { lotId?: bigint | null }).lotId;
        if (id) {
          input('lotId').value = String(id);
          s.insertAdjacentHTML('beforeend', html` · lot <strong>#${String(id)}</strong> is on the clock`.value);
        }
        void refresh();
      },
    },
  );
  txAction(btn('approveUsdg'), () => approveUsdgForAuction(parseUnits(num('maxPrice', 'your maximum'), 6)), { status: statusFor('bid') });
  txAction(btn('bid'), () => bidLot(BigInt(num('lotId', 'the lot id')), parseUnits(num('maxPrice', 'your maximum'), 6)), {
    status: statusFor('bid'),
    after: () => void refresh(),
  });
  txAction(btn('observe'), () => observe(flowAsset.wrapper), { status: statusFor('redeem'), after: () => void refresh() });
  txAction(
    btn('print'),
    () => {
      const p = state?.pointers.find((x) => x.wrapper.toLowerCase() === flowAsset.wrapper.toLowerCase());
      return recordPrint(flowAsset.wrapper, p?.epoch ?? 0);
    },
    { status: statusFor('redeem'), after: () => void refresh() },
  );
  txAction(btn('redeem'), () => redeemNote(BigInt(num('redeemId', 'the note id')), parseUnits(num('redeemAmt', 'the units'), 18), me()), {
    status: statusFor('redeem'),
    after: () => void refresh(),
  });

  wallet.onChange((a) => {
    account = a;
    applyGate();
    if (a) void refresh();
  });
  applyGate();
  void readFlowRegime();
}

function applyGate(): void {
  const hint = $('[data-nt-gate]');
  const buttons = ALL_TX.map(btn);
  const reason = !(LIVE.notes && LIVE.auction)
    ? 'In build: ReopenNote and ClosedAuction are not deployed yet, so every step below is shown but closed. They open by themselves once the addresses are published.'
    : !wallet.account()
      ? 'Connect a wallet to send. Each step is simulated before your wallet is asked to sign; a step that would revert says why and sends nothing.'
      : null;
  gate(buttons, hint, reason);
}

async function readFlowRegime(): Promise<void> {
  const el = $('[data-nt-asset-state]');
  try {
    flowRegime = await getRegime({ wrapper: flowAsset.wrapper });
  } catch {
    flowRegime = null;
  }
  const r = flowRegime;
  if (!el) return;
  if (!r) {
    el.textContent = `${flowAsset.symbol}: MarketClock unreadable just now.`;
    return;
  }
  const shut = r.regime === 'CLOSED' && r.cap === 0;
  const cutoff = r.nextTransitionAtMs && r.nextTransitionAtMs > Date.now() ? r.nextTransitionAtMs : null;
  el.textContent = r.stale
    ? `${flowAsset.symbol}: the clock is stale (no attestation for ${r.attestedAgoMin ?? '?'} min). Everything refuses until it is fresh.`
    : shut
      ? `${flowAsset.symbol}: shut, primary capacity $0 (attested ${fmtAgo(r.asOfMs)}). Mint, list and bid are open.${cutoff ? ` Next attested transition ${hktShort(cutoff)}.` : ''}`
      : `${flowAsset.symbol}: ${r.regime.toLowerCase()}, primary capacity $${r.cap.toLocaleString('en-US')}. Notes mint and trade only while the market is shut; observe, print and redeem work now.`;
  const capEl = $('[data-nt-capused]');
  if (capEl) {
    const c = state?.caps.get(flowAsset.wrapper.toLowerCase()) ?? (await getClosureCap(flowAsset.wrapper).catch(() => undefined));
    capEl.textContent = c ? `Cap used this closure for ${flowAsset.symbol}: ${capText(c)} shares (epoch ${c.epoch}).` : '';
  }
  const cutEl = $('[data-nt-cutoff]');
  if (cutEl) cutEl.textContent = cutoff ? `For ${flowAsset.symbol} that is ${hktDate(cutoff)}, and the lot will end then.` : '';
}

function fillDefaults(s: State): void {
  const n = s.featuredNote;
  const l = s.featuredLot;
  if (n && !input('noteId').value) input('noteId').value = n.id;
  if (n && !input('redeemId').value) input('redeemId').value = n.id;
  if (n && !input('redeemAmt').value) input('redeemAmt').value = fmtShares(n.shares).replace(/,/g, '');
  if (n?.valueNowUsd && !input('start').value) {
    input('start').value = (Math.ceil(n.valueNowUsd * 1.002 * 100) / 100).toFixed(2);
    input('floor').value = (Math.floor(n.valueNowUsd * 0.972 * 100) / 100).toFixed(2);
  }
  if (l && !input('lotId').value) input('lotId').value = l.lotId;
  if (l && !input('maxPrice').value) {
    const p = lotPriceAt(lotBig(l), Math.floor(Date.now() / 1000));
    input('maxPrice').value = usdgFixed(p, 2).replace(/,/g, '');
  }
}

// ---------------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    state = await load();
  } catch (e) {
    console.warn('notes: read failed', e);
    return;
  }
  drawStatus(state.block);
  drawCertificate(state.featuredNote);
  drawClock(state.featuredLot);
  drawPointer(state.pointers, state.caps);
  drawLots(state.lots);
  fillDefaults(state);
}

drawCertificate(null, false); // first paint: the same card with dashes, so the data lands without a shift
drawProvenance();
wireFlow();
void refresh();

// Live pages re-read every 60 s while visible (the public RPC is rate-limited); the specimen does not change.
if (ANY_LIVE && !isMock()) {
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 60_000);
}

void raw;
