// /clock: per asset, is the primary market open now, and the proof of it.
// Board: MarketClock.stateOf + isInMultiplierBlackout for the six (data/clock.ts, one Multicall at one block).
// Next change: data/schedule.ts (never stateOf.nextTransitionAt). Latest round: StateAttested, ≤ 4 × 100 blocks.
import { boot } from '../../shell/boot';
import './page.css';

import { getBoard, getLatestRound } from '../../data/clock';
import { isMock } from '../../data/mock';
import { MAX_ATTESTATION_AGE_MS, pollDelayMs } from '../../data/regime';
import { nextChange, slotStates, SLOT_MS, SLOTS_PER_WEEK, venueClock, venueFor, weekStartMs } from '../../data/schedule';
import { symbolOf } from '../../data/addresses';
import type { AssetBoard, AssetBoardRow, AttestationRound, Glyph, Mic, RegimeName } from '../../data/types';
import { glyphSVG } from '../../shell/mark';
import { fmtHKT } from '../../shell/hkt';
import { copyButton, enhanceCopyButtons } from '../../ui/copy';
import { fmtBlock, fmtDuration, fmtUsd, shortHash } from '../../ui/format';
import { html, render, safeUrl } from '../../ui/html';
import { slotStrip, type SlotState, type SlotStrip } from '../../ui/slotstrip';
import { blockLinkHTML, txLinkHTML } from '../../ui/txlink';

try {
  boot({ page: 'clock' });
} catch (err) {
  // The shell is lane A's; if it fails, the page still reads the chain.
  console.warn('clock: shell boot failed', err);
}

const main = document.getElementById('main')!;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = main) => root.querySelector<T>(sel);

// ── words ──────────────────────────────────────────────────────────────────────────────────────

const REGIME_WORD: Record<RegimeName, string> = {
  MARKET: 'Regular session',
  EXTENDED: 'Extended session',
  OVERNIGHT: 'Overnight session',
  CLOSED: 'Closed',
  UNKNOWN: 'Unknown',
};

const GLYPH_WORD: Record<Glyph, string> = {
  open: 'Open',
  shut: 'Shut, pool trading',
  unknown: 'Stale',
};

function agoMin(thenMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - thenMs) / 60_000));
}

function agoText(thenMs: number, nowMs: number): string {
  const m = agoMin(thenMs, nowMs);
  if (m === 0) return 'under a minute ago';
  if (m < 120) return `${m} min ago`;
  return `${fmtDuration(nowMs - thenMs)} ago`;
}

function hkt(ms: number): string {
  return `${venueClock(ms).label} HKT`;
}

// ── week strips: the HK week for every row, so all six share one time axis ─────────────────────

const slotCache = new Map<string, SlotState[]>();

function weekFor(mic: Mic, nowMs: number): { slots: SlotState[]; nowIndex: number } {
  const start = weekStartMs(nowMs);
  const key = `${mic}:${start}`;
  let slots = slotCache.get(key);
  if (!slots) {
    slots = slotStates(start, venueFor(mic)).map((o) => (o ? 'open' : 'shut'));
    if (slotCache.size > 8) slotCache.clear();
    slotCache.set(key, slots);
  }
  const nowIndex = Math.min(SLOTS_PER_WEEK - 1, Math.max(0, Math.floor((nowMs - start) / SLOT_MS)));
  return { slots, nowIndex };
}

// ── board ──────────────────────────────────────────────────────────────────────────────────────

interface RowEls {
  tr: HTMLTableRowElement;
  glyph: HTMLElement;
  regime: HTMLElement;
  cap: HTMLElement;
  next: HTMLElement;
  att: HTMLElement;
  strip: SlotStrip | null;
  stripEl: HTMLElement;
  lastGlyph: Glyph | null;
}

const rowEls = new Map<string, RowEls>();
main.querySelectorAll<HTMLTableRowElement>('[data-clk-rows] tr[data-sym]').forEach((tr) => {
  rowEls.set(tr.dataset.sym!, {
    tr,
    glyph: $('[data-glyph]', tr)!,
    regime: $('.clk-regime', tr)!,
    cap: $('.clk-cap', tr)!,
    next: $('.clk-next', tr)!,
    att: $('.clk-att', tr)!,
    stripEl: $('[data-strip]', tr)!,
    strip: null,
    lastGlyph: null,
  });
});

let board: AssetBoard | null = null;
let round: AttestationRound | null | undefined;
const announceEl = $('[data-clk-announce]');

function nextHTML(row: AssetBoardRow, nowMs: number) {
  const venue = venueFor(row.mic);
  // Live: the schedule is deterministic, so the next change is recomputed locally as time passes.
  const nc = isMock() ? row.nextChange : nextChange(nowMs, venue) ?? row.nextChange;
  if (!nc) return html`<span class="muted">No change scheduled</span>`;
  const what = nc.kind === 'reopen' ? 'Reopens' : 'Cut to zero';
  const inMs = nc.atMs - nowMs;
  return html`<span class="clk-line">${what} ${hkt(nc.atMs)}</span><span class="clk-sub muted">${inMs > 0 ? `in ${fmtDuration(inMs)}` : 'due now'}</span>`;
}

function regimeHTML(row: AssetBoardRow, nowMs: number) {
  const notes: string[] = [];
  if (row.halted) notes.push('Halted by the issuer');
  if (row.blackout) notes.push('Corporate-action blackout');
  if (row.stale) {
    const since = row.observedAtMs ? `no attestation for ${agoMin(row.observedAtMs, nowMs)} min` : 'never attested';
    return html`<span class="clk-line">${GLYPH_WORD.unknown}</span><span class="clk-sub muted">${since}; reads as unknown, cap zero</span>`;
  }
  const sub = [REGIME_WORD[row.regime], ...notes].join(' · ');
  return html`<span class="clk-line">${GLYPH_WORD[row.glyph]}</span><span class="clk-sub muted">${sub}</span>`;
}

function attHTML(row: AssetBoardRow, nowMs: number) {
  if (!row.observedAtMs) return html`<span class="muted">Never</span>`;
  const stale = nowMs - row.observedAtMs > MAX_ATTESTATION_AGE_MS;
  return html`<span class="clk-line${stale ? ' clk-stale' : ''}">${agoText(row.observedAtMs, nowMs)}</span><span class="clk-sub muted">${fmtHKT(row.observedAtMs)} HKT</span>`;
}

function glyphMarkup(g: Glyph): string {
  return glyphSVG(g, { className: 'clk-glyph__svg' });
}

/** The clock "now": the chain's for fixtures (so a capture reads as captured), the visitor's otherwise. */
function nowFor(b: AssetBoard): number {
  return isMock() ? b.blockTimeMs : Date.now();
}

function renderRows(b: AssetBoard, first: boolean): void {
  const nowMs = nowFor(b);
  const changes: string[] = [];
  for (const row of b.rows) {
    const els = rowEls.get(row.symbol);
    if (!els) continue;
    if (els.lastGlyph !== row.glyph) {
      els.glyph.innerHTML = glyphMarkup(row.glyph);
      els.glyph.dataset.glyph = row.glyph;
      els.tr.dataset.glyph = row.glyph;
      if (els.lastGlyph !== null && !first) {
        changes.push(`${row.symbol} is now ${GLYPH_WORD[row.glyph].toLowerCase()}.`);
        els.tr.removeAttribute('data-changed');
        void els.tr.offsetWidth;
        els.tr.setAttribute('data-changed', '');
      }
      els.lastGlyph = row.glyph;
    }
    render(els.regime, regimeHTML(row, nowMs));
    render(els.cap, html`<span class="clk-line clk-num">${fmtUsd(row.cap)}</span><span class="clk-sub muted">${row.stale ? 'stale, reads as zero' : row.cap > 0 ? 'creates and redeems' : 'no creation or redemption'}</span>`);
    render(els.next, nextHTML(row, nowMs));
    render(els.att, attHTML(row, nowMs));
    const w = weekFor(row.mic, nowMs);
    if (els.strip) els.strip.update(w.slots, w.nowIndex);
    else els.strip = slotStrip(els.stripEl, w.slots, { nowIndex: w.nowIndex, label: `${row.symbol} this week` });
  }
  if (changes.length && announceEl) announceEl.textContent = changes.join(' ');
}

function renderSummary(b: AssetBoard): void {
  const shut = b.rows.filter((r) => r.glyph !== 'open').length;
  const shutEl = $('[data-clk-shut]');
  const totalEl = $('[data-clk-total]');
  if (shutEl) shutEl.textContent = String(shut);
  if (totalEl) totalEl.textContent = String(b.rows.length);
  const sum = $('[data-clk-summary]');
  sum?.setAttribute('aria-label', `${shut} of ${b.rows.length} assets shut`);
  const asof = $('[data-clk-asof]');
  if (asof) {
    const src = b.source === 'fixture' ? 'Fixture captured at ' : 'Read at ';
    render(asof, html`${src}${blockLinkHTML(b.block)} · ${fmtHKT(b.blockTimeMs, true)} HKT`);
  }
  const reg = $('[data-clk-registered]');
  if (reg) reg.textContent = `${b.registeredCount} assets, as of block ${fmtBlock(b.block)}`;
  const cap = $('[data-clk-caption]');
  if (cap) cap.textContent = `MarketClock state for each registered asset, read at block ${fmtBlock(b.block)}.`;
}

// ── latest round ───────────────────────────────────────────────────────────────────────────────

const roundCmd = { verify: 'npx -y curb-verify tx <round transaction>', witness: 'npx -y curb-verify witness <inputRoot>' };

function renderRound(r: AttestationRound | null, b: AssetBoard): void {
  const txEl = $('[data-round-tx]');
  const blockEl = $('[data-round-block]');
  const rootEl = $('[data-round-root]');
  const assetsEl = $('[data-round-assets]');
  if (!txEl || !blockEl || !rootEl || !assetsEl) return;
  if (!r) {
    const newest = Math.max(0, ...b.rows.map((x) => x.observedAtMs));
    txEl.textContent = 'No round in the last 400 blocks.';
    blockEl.textContent = newest ? `The newest attestation is from ${fmtHKT(newest)} HKT.` : '—';
    rootEl.textContent = '—';
    assetsEl.textContent = '—';
    return;
  }
  render(txEl, txLinkHTML(r.txHash, { label: shortHash(r.txHash, 10, 6) }));
  const observed = b.rows.filter((x) => r.wrappers.some((w) => w.toLowerCase() === x.wrapper.toLowerCase())).map((x) => x.observedAtMs);
  const at = observed.length ? Math.max(...observed) : 0;
  render(blockEl, html`${blockLinkHTML(r.block, { label: fmtBlock(r.block) })}${at ? html`<span class="muted"> · issuer read ${fmtHKT(at, true)} HKT</span>` : ''}`);
  render(
    rootEl,
    html`<a class="txlink" href="${safeUrl(r.bundleUrl)}" target="_blank" rel="noopener" title="${r.inputRoot}">${shortHash(r.inputRoot, 10, 6)}<span class="arrow arrow--ext" aria-hidden="true">→</span><span class="visually-hidden"> (opens host A's bundle)</span></a><span class="clk-sub muted">Host A's bundle: the exact issuer responses behind this round</span>`,
  );
  const syms = r.wrappers.map((w) => symbolOf(w));
  assetsEl.textContent = syms.length ? `${syms.length}: ${syms.join(', ')}` : '—';
  roundCmd.verify = `npx -y curb-verify tx ${r.txHash}`;
  roundCmd.witness = `npx -y curb-verify witness ${r.inputRoot}`;
  const cmd = $('[data-round-cmd]');
  if (cmd) cmd.textContent = roundCmd.verify;
  const wit = $('[data-witness-cmd]');
  if (wit) wit.textContent = roundCmd.witness;
}

// ── copy buttons ───────────────────────────────────────────────────────────────────────────────

enhanceCopyButtons(main);
const copyCmd = $<HTMLButtonElement>('[data-copy-cmd]');
if (copyCmd) copyButton(copyCmd, () => roundCmd.verify);
const copySol = $<HTMLButtonElement>('[data-copy-sol]');
if (copySol) copyButton(copySol, () => $('[data-sol]')?.textContent ?? '');
const copyCast = $<HTMLButtonElement>('[data-copy-cast]');
if (copyCast) copyButton(copyCast, () => $('[data-cast]')?.textContent ?? '');

// ── read + poll ────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let roundFor = 0;
let reading = false;

function nextWakeMs(b: AssetBoard, nowMs: number): number {
  let soonest: number | null = null;
  const consider = (t: number | null | undefined) => {
    if (t && t > nowMs - 10 * 60_000 && (soonest === null || t < soonest)) soonest = t;
  };
  for (const r of b.rows) {
    consider(nextChange(nowMs, venueFor(r.mic))?.atMs);
    if (!r.stale && r.observedAtMs) consider(r.observedAtMs + MAX_ATTESTATION_AGE_MS);
  }
  return pollDelayMs(soonest, nowMs);
}

function showError(): void {
  const asof = $('[data-clk-asof]');
  if (!asof) return;
  asof.textContent = board
    ? `MarketClock unreadable just now; showing block ${fmtBlock(board.block)}. Retrying.`
    : 'MarketClock unreadable just now. Retrying.';
}

async function read(): Promise<void> {
  if (reading) return;
  reading = true;
  timer = undefined;
  let delay = 60_000;
  try {
    const b = await getBoard({ withRound: false });
    const first = board === null;
    board = b;
    failures = 0;
    renderSummary(b);
    renderRows(b, first);
    if (isMock()) {
      round = b.latestRound;
      renderRound(round, b);
    } else {
      const newest = Math.max(0, ...b.rows.map((r) => r.observedAtMs));
      if (round === undefined || newest > roundFor) {
        const r = await getLatestRound({ head: BigInt(b.block), headTimeMs: b.blockTimeMs, observedAtMs: newest || null }).catch(() => undefined);
        if (r !== undefined) {
          round = r;
          roundFor = newest;
          renderRound(r, b);
        } else if (round === undefined) {
          renderRound(null, b);
        }
      }
    }
    delay = nextWakeMs(b, Date.now());
  } catch (err) {
    failures++;
    showError();
    delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures, 4));
    if (failures === 1) console.warn('clock: board read failed', err);
  } finally {
    reading = false;
  }
  if (isMock()) return;
  if (document.visibilityState !== 'hidden') timer = setTimeout(read, delay);
}

document.addEventListener('visibilitychange', () => {
  if (isMock()) return;
  if (document.visibilityState === 'hidden') {
    clearTimeout(timer);
    timer = undefined;
  } else if (!timer && !reading) {
    void read();
  }
});

// Relative times ("3 min ago", "in 10 h 48 m") move with the wall clock between reads.
setInterval(() => {
  if (board && !isMock() && document.visibilityState !== 'hidden') renderRows(board, false);
}, 20_000);

void read();
