// /scorecard: the graded record, including that it has no wins yet.
// Rows: Scorecard v2 storage at one pinned block (data/scorecard.ts). Tx hashes: one single-block getLogs
// per row, cached forever (resolveTxHashes). Never hard-code a count: every number here is read.
import { boot } from '../../shell/boot';
import './page.css';

import { getScorecard, getSkill, resolveTxHashes } from '../../data/scorecard';
import { isMock } from '../../data/mock';
import type { ClosureKind, Outcome, ScorecardRow, ScorecardView, SkillTally } from '../../data/types';
import { copyButton, enhanceCopyButtons } from '../../ui/copy';
import { fmtBlock, fmtBp, fmtDuration, fmtInt, shortHash } from '../../ui/format';
import { html, render, type SafeHTML } from '../../ui/html';
import { blockLinkHTML, txLinkHTML } from '../../ui/txlink';
import { prefersReducedMotion } from '../../motion/reduced';

boot({ page: 'scorecard' });

const main = document.getElementById('main')!;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = main) => root.querySelector<T>(sel);

// ── formatting ─────────────────────────────────────────────────────────────────────────────────

const hkParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  weekday: 'short',
  day: 'numeric',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 24 Sep 13:00 HKT" */
function whenHKT(ms: number): string {
  const parts = hkParts.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = String(Number(get('hour')) % 24).padStart(2, '0');
  return `${get('weekday')} ${get('day')} ${MONTHS[Number(get('month')) - 1] ?? ''} ${hh}:${get('minute')} HKT`;
}

const KIND_WORD: Record<ClosureKind, string> = {
  recess: 'Lunch recess',
  overnight: 'Overnight',
  weekend: 'Weekend',
  holiday: 'Holiday',
  handover: 'Session handover',
  'multi-day': 'Multi-day closure',
  'open-ended': 'Open-ended closure',
};

const OUTCOME_WORD: Record<Outcome, string> = { win: 'Win', tie: 'Tie', loss: 'Loss' };

function px(v: number | null): string {
  if (v === null) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function plural(n: number, one: string, many: string): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Sign of (estimate − reopen) from the exact 18-dp integers; the magnitude is the contract's own bps. */
function signedBps(estE18: string, reopenE18: string | null, bps: number | null): number | null {
  if (bps === null || reopenE18 === null) return null;
  const d = BigInt(estE18) - BigInt(reopenE18);
  return d > 0n ? bps : d < 0n ? -bps : 0;
}

// ── the headline: live values, adapted to whatever the record holds ──────────────────────────

function headline(skill: SkillTally, pending: number): { line: string; note: string } {
  const n = skill.settled;
  const wins = skill.beatLastPrint;
  const ties = skill.tiesLastPrint;
  const losses = skill.lossesLastPrint;
  const waiting = pending ? ` ${plural(pending, 'more mark is', 'more marks are')} committed and waiting for the reopen.` : '';
  if (n === 0) return { line: 'Nothing graded yet.', note: waiting.trim() || 'The first row settles after its reopen.' };

  let line = `${fmtInt(n)} graded. `;
  if (wins === 0) {
    const parts = [ties ? plural(ties, 'tie', 'ties') : '', losses ? plural(losses, 'loss', 'losses') : ''].filter(Boolean);
    line += `No wins yet${parts.length ? `: ${parts.join(', ')}` : ''}.`;
  } else {
    const parts = [plural(wins, 'win', 'wins'), ties ? plural(ties, 'tie', 'ties') : '', losses ? plural(losses, 'loss', 'losses') : ''].filter(Boolean);
    line += `${parts.join(', ')}.`;
  }
  if (ties) line += ' A tie is not a win.';

  const vwapSame =
    skill.beatClosingVwap === wins && skill.tiesClosingVwap === ties && skill.lossesClosingVwap === losses;
  const vs = vwapSame
    ? 'Against the last print; the closing VWAP gives the same count.'
    : `Against the last print. Against the closing VWAP: ${plural(skill.beatClosingVwap, 'win', 'wins')}, ${plural(skill.tiesClosingVwap, 'tie', 'ties')}, ${plural(skill.lossesClosingVwap, 'loss', 'losses')}.`;
  return { line, note: `${vs}${waiting}` };
}

// ── rows ───────────────────────────────────────────────────────────────────────────────────────

function txCell(label: string, tx: string | null, block: number | null): SafeHTML {
  if (block === null) return html``;
  return html`<span class="sc-tx"><span class="sc-tx__k muted">${label}</span> ${tx ? txLinkHTML(tx, { label: fmtBlock(block) }) : blockLinkHTML(block, { label: fmtBlock(block) })}</span>`;
}

function bars(r: ScorecardRow, scale: number): SafeHTML {
  const items: [string, number | null][] = [
    ['Curb', signedBps(r.markE18, r.reopenPrintE18, r.curbErrorBps)],
    ['Last print', signedBps(r.lastPrintE18, r.reopenPrintE18, r.lastPrintErrorBps)],
    ['Closing VWAP', signedBps(r.closingVwapE18, r.reopenPrintE18, r.closingVwapErrorBps)],
  ];
  if (r.status !== 'settled') return html`<span class="muted">Not graded until the reopen</span>`;
  return html`<span class="sc-bars">${items.map(([k, v]) => {
    const w = v === null ? 0 : Math.min(1, Math.abs(v) / scale);
    return html`<span class="sc-bar"><span class="sc-bar__k">${k}</span><span class="sc-bar__track" aria-hidden="true"><span class="sc-bar__fill" style="transform:scaleX(${w.toFixed(4)})"></span></span><span class="sc-bar__v">${v === null ? '—' : fmtBp(v)}</span></span>`;
  })}</span>`;
}

function gradeHTML(r: ScorecardRow): SafeHTML {
  if (r.status !== 'settled') {
    return html`<span class="sc-line">Pending</span><span class="sc-sub muted">settles after ${whenHKT(r.settleAfterMs + 300_000)}</span>`;
  }
  const g = (o: Outcome | null) => (o ? OUTCOME_WORD[o] : '—');
  return html`<span class="sc-grade"><span class="sc-grade__k muted">vs last print</span> ${g(r.vsLastPrint)}</span><span class="sc-grade"><span class="sc-grade__k muted">vs closing VWAP</span> ${g(r.vsClosingVwap)}</span>`;
}

function rowHTML(r: ScorecardRow, scale: number): SafeHTML {
  const kind = r.closureKind ? KIND_WORD[r.closureKind] : 'Closure';
  const lead = r.settleAfterMs - r.committedAtMs;
  return html`<tr class="sc-row" data-id="${r.id}" data-sym="${r.symbol}">
  <th scope="row" class="sc-closure"><span class="sc-sym">${r.symbol}</span><span class="sc-sub">${kind}</span><span class="sc-sub muted">reopen ${whenHKT(r.settleAfterMs)}</span></th>
  <td class="sc-blocks" data-label="Committed, then settled">${txCell('commit', r.commitTx, r.committedBlock)}${r.status === 'settled' ? txCell('settle', r.settleTx, r.settledBlock) : html`<span class="sc-tx"><span class="sc-tx__k muted">settle</span> <span class="muted">awaiting</span></span>`}<span class="sc-sub muted">${lead > 0 ? `committed ${fmtDuration(lead)} before the reopen` : 'committed after the scheduled reopen'}</span></td>
  <td class="num" data-label="Mark">${px(r.mark)}</td>
  <td class="num" data-label="Last print">${px(r.lastPrint)}</td>
  <td class="num" data-label="Closing VWAP">${px(r.closingVwap)}</td>
  <td class="num" data-label="Reopen print">${r.status === 'settled' ? px(r.reopenPrint) : html`<span class="muted">awaiting</span>`}</td>
  <td class="sc-err" data-label="Error, signed">${bars(r, scale)}</td>
  <td class="sc-gr" data-label="Grade">${gradeHTML(r)}</td>
  <td class="sc-meth" data-label="Method"><code title="${r.method ?? r.methodDigest}">${r.methodShort ?? shortHash(r.methodDigest)}</code></td>
</tr>`;
}

// ── state ──────────────────────────────────────────────────────────────────────────────────────

let view: ScorecardView | null = null;
let filter = 'all';
const known = new Set<string>();
const tbody = $<HTMLTableSectionElement>('[data-sc-rows]')!;

function errScale(rows: ScorecardRow[]): number {
  let max = 0;
  for (const r of rows) {
    for (const v of [r.curbErrorBps, r.lastPrintErrorBps, r.closingVwapErrorBps]) if (v !== null && v > max) max = v;
  }
  // A shared scale for the whole ledger, with headroom; a zero error draws an empty track.
  return Math.max(10, Math.ceil(max / 10) * 10);
}

function renderTally(v: ScorecardView): void {
  const s = v.skill;
  const set = (k: string, n: number) => {
    const el = $(`[data-t="${k}"]`);
    if (el) el.textContent = fmtInt(n);
  };
  set('bl', s.beatLastPrint);
  set('tl', s.tiesLastPrint);
  set('ll', s.lossesLastPrint);
  set('bv', s.beatClosingVwap);
  set('tv', s.tiesClosingVwap);
  set('lv', s.lossesClosingVwap);
  const asof = $('[data-sc-asof]');
  if (asof) render(asof, html`${v.source === 'fixture' ? 'Fixture captured at ' : 'Read at '}${blockLinkHTML(v.block)} · ${plural(s.closureCount, 'row', 'rows')}, ${fmtInt(s.settled)} settled`);
  const pending = v.rows.filter((r) => r.status !== 'settled').length;
  const h = headline(s, pending);
  const hl = $('[data-sc-headline]');
  const note = $('[data-sc-headline-note]');
  if (hl) hl.textContent = h.line;
  if (note) note.textContent = h.note;
  const prices = $('[data-sc-prices]');
  if (prices) {
    const priced = v.prices.filter((p) => p.price !== null).map((p) => `${p.symbol} ${px(p.price)}`);
    const unpriced = v.prices.filter((p) => p.price === null).map((p) => `${p.symbol} (${p.error ?? 'unreadable'})`);
    prices.textContent = `Scorecard's pool price now, block ${fmtBlock(v.block)}: ${priced.join(' · ') || 'none readable'}${unpriced.length ? `. No price: ${unpriced.join(', ')}` : ''}.`;
  }
  const m1 = v.rows.filter((r) => r.methodShort === 'mark/1').length;
  const m2 = v.rows.filter((r) => r.methodShort === 'mark/2').length;
  const m1Live = $('[data-sc-m1-live]');
  if (m1Live) {
    const graded = v.rows.filter((r) => r.methodShort === 'mark/1' && r.status === 'settled');
    const t = graded.filter((r) => r.vsLastPrint === 'tie').length;
    const w = graded.filter((r) => r.vsLastPrint === 'win').length;
    const l = graded.filter((r) => r.vsLastPrint === 'loss').length;
    const flat = graded.filter((r) => r.markE18 === r.lastPrintE18).length;
    const moved = Math.max(0, ...graded.map((r) => r.lastPrintErrorBps ?? 0));
    const tally = [w ? plural(w, 'win', 'wins') : '', t ? plural(t, 'tie', 'ties') : '', l ? plural(l, 'loss', 'losses') : ''].filter(Boolean).join(', ');
    m1Live.textContent = graded.length
      ? `On the record: ${plural(graded.length, 'settled mark/1 row', 'settled mark/1 rows')}, ${tally || 'none decided'}. In ${fmtInt(flat)} of them the mark was exactly the last print, while the reopen landed as far as ${fmtInt(moved)} bp from it.`
      : '';
  }
  const m1El = $('[data-sc-m1-count]');
  const m2El = $('[data-sc-m2-count]');
  if (m1El) m1El.textContent = m1 ? `${plural(m1, 'row', 'rows')} on the record` : 'No rows on the record';
  if (m2El) m2El.textContent = m2 ? `${plural(m2, 'row', 'rows')} on the record` : 'In force for new rows; none graded yet';
}

function renderFilter(v: ScorecardView): void {
  const box = $('[data-sc-filter]');
  if (!box) return;
  const counts = new Map<string, number>();
  for (const r of v.rows) counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1);
  const syms = [...counts.keys()].sort();
  if (filter !== 'all' && !counts.has(filter)) filter = 'all';
  render(
    box,
    html`<button type="button" class="sc-chip" aria-pressed="${String(filter === 'all')}" data-asset="all">All <span class="sc-chip__n">${fmtInt(v.rows.length)}</span></button>${syms.map(
      (s) => html`<button type="button" class="sc-chip" aria-pressed="${String(filter === s)}" data-asset="${s}">${s} <span class="sc-chip__n">${fmtInt(counts.get(s) ?? 0)}</span></button>`,
    )}`,
  );
}

function applyFilter(): void {
  let shown = 0;
  tbody.querySelectorAll<HTMLTableRowElement>('tr[data-sym]').forEach((tr) => {
    const on = filter === 'all' || tr.dataset.sym === filter;
    tr.hidden = !on;
    if (on) shown++;
  });
  $('[data-sc-filter]')
    ?.querySelectorAll<HTMLButtonElement>('button[data-asset]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.asset === filter)));
  const count = $('[data-sc-count]');
  if (count && view) {
    count.textContent =
      filter === 'all' ? `Showing all ${plural(view.rows.length, 'row', 'rows')}.` : `Showing ${plural(shown, 'row', 'rows')} for ${filter}, of ${fmtInt(view.rows.length)}.`;
  }
}

$('[data-sc-filter]')?.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button[data-asset]');
  if (!b) return;
  filter = b.dataset.asset ?? 'all';
  applyFilter();
});

function renderRows(v: ScorecardView, animateNew: boolean): void {
  const scale = errScale(v.rows);
  render(tbody, html`${v.rows.map((r) => rowHTML(r, scale))}`);
  const cap = $('[data-sc-caption]');
  if (cap) cap.textContent = `Every Scorecard row, newest first, read at block ${fmtBlock(v.block)}.`;
  for (const r of v.rows) {
    if (!known.has(r.id)) {
      if (animateNew && !prefersReducedMotion()) tbody.querySelector(`tr[data-id="${r.id}"]`)?.classList.add('sc-row--new');
      known.add(r.id);
    }
  }
  applyFilter();
}

/** Update one row's tx cell in place as its hash resolves. */
function patchRow(r: ScorecardRow): void {
  const tr = tbody.querySelector(`tr[data-id="${r.id}"]`);
  const cell = tr?.querySelector('.sc-blocks');
  if (!tr || !cell || !view) return;
  const fresh = document.createElement('tbody');
  fresh.innerHTML = rowHTML(r, errScale(view.rows)).value;
  const next = fresh.querySelector('.sc-blocks');
  if (next) cell.replaceWith(next);
  if (r.id === verifyId || !verifyId) renderVerifyOptions();
}

// ── verify a row ───────────────────────────────────────────────────────────────────────────────

let verifyId = '';
const select = $<HTMLSelectElement>('[data-sc-verify-row]');
const cmdEl = $('[data-sc-verify-cmd]');
const verifyNote = $('[data-sc-verify-note]');

function verifyCommand(): string {
  const r = view?.rows.find((x) => x.id === verifyId);
  if (!r) return 'npx -y curb-verify tx <commit transaction>';
  return r.commitTx ? `npx -y curb-verify tx ${r.commitTx}` : 'npx -y curb-verify tx <commit transaction>';
}

function renderVerifyOptions(): void {
  if (!select || !view) return;
  if (!verifyId || !view.rows.some((r) => r.id === verifyId)) verifyId = view.rows[0]?.id ?? '';
  render(
    select,
    html`${view.rows.map(
      (r) => html`<option value="${r.id}" ${r.id === verifyId ? html`selected` : ''}>#${r.index + 1} · ${r.symbol} · ${r.closureKind ? KIND_WORD[r.closureKind].toLowerCase() : 'closure'} · reopen ${whenHKT(r.settleAfterMs)}</option>`,
    )}`,
  );
  renderVerify();
}

function renderVerify(): void {
  const r = view?.rows.find((x) => x.id === verifyId);
  if (cmdEl) cmdEl.textContent = verifyCommand();
  if (!verifyNote) return;
  if (!r) verifyNote.textContent = '';
  else if (!r.commitTx) verifyNote.textContent = `Finding the commit transaction in block ${fmtBlock(r.committedBlock)}…`;
  else render(verifyNote, html`Commit ${txLinkHTML(r.commitTx)} in block ${fmtBlock(r.committedBlock)}${r.status === 'settled' ? '' : ', not settled yet'}.`);
}

select?.addEventListener('change', () => {
  verifyId = select.value;
  renderVerify();
  queueTx([verifyId]);
});

// ── tx hashes: resolved as rows come into view (one single-block getLogs each, then cached forever),
//    so a first visit does not spend the public RPC's budget on rows nobody scrolls to.

const wantTx = new Set<string>();
let txTimer: ReturnType<typeof setTimeout> | undefined;
let rowObserver: IntersectionObserver | null = null;

const needsTx = (r: ScorecardRow) => !r.commitTx || (r.status === 'settled' && !r.settleTx);

// At most TX_ROWS_PER_TICK rows (two getLogs each) every TX_TICK_MS: about 3 requests a second, well
// under the public RPC's per-IP limit even with the shell's regime poll running alongside.
const TX_ROWS_PER_TICK = 3;
const TX_TICK_MS = 2000;
let txBusy = false;

function queueTx(ids: string[]): void {
  if (isMock()) return;
  for (const id of ids) wantTx.add(id);
  if (!txBusy && txTimer === undefined) txTimer = setTimeout(flushTx, 250);
}

async function flushTx(): Promise<void> {
  txTimer = undefined;
  // Newest first, the order they appear in.
  const rows = (view?.rows ?? []).filter((r) => wantTx.has(r.id));
  const batch = rows.filter(needsTx).slice(0, TX_ROWS_PER_TICK);
  for (const r of rows) if (!needsTx(r)) wantTx.delete(r.id);
  for (const r of batch) wantTx.delete(r.id);
  if (!batch.length) return;
  txBusy = true;
  try {
    await resolveTxHashes(batch, patchRow);
    renderVerify();
  } finally {
    txBusy = false;
  }
  if (wantTx.size) txTimer = setTimeout(flushTx, TX_TICK_MS);
}

function observeRows(): void {
  if (isMock()) return;
  rowObserver?.disconnect();
  if (typeof IntersectionObserver !== 'function') {
    queueTx(view?.rows.map((r) => r.id) ?? []);
    return;
  }
  rowObserver = new IntersectionObserver(
    (entries) => {
      const ids: string[] = [];
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = (e.target as HTMLElement).dataset.id;
        if (id) ids.push(id);
        rowObserver?.unobserve(e.target);
      }
      if (ids.length) queueTx(ids);
    },
    { rootMargin: '200px 0px' },
  );
  tbody.querySelectorAll<HTMLElement>('tr[data-id]').forEach((tr) => rowObserver!.observe(tr));
}
const copyVerify = $<HTMLButtonElement>('[data-sc-copy-verify]');
if (copyVerify) copyButton(copyVerify, verifyCommand);
enhanceCopyButtons(main);

// ── read + poll ────────────────────────────────────────────────────────────────────────────────

let reading = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
const POLL_MS = 60_000;

async function loadAll(animateNew: boolean): Promise<void> {
  const v = await getScorecard();
  view = v;
  renderTally(v);
  renderFilter(v);
  renderRows(v, animateNew);
  renderVerifyOptions();
  observeRows();
  if (verifyId) queueTx([verifyId]);
}

async function tick(): Promise<void> {
  if (reading) return;
  reading = true;
  timer = undefined;
  let delay = POLL_MS;
  try {
    if (!view) {
      await loadAll(false);
    } else {
      // Cheap check first: only re-read every row when the count or the settled tally moved.
      const s = await getSkill();
      if (s.closureCount !== view.skill.closureCount || s.settled !== view.skill.settled) await loadAll(true);
    }
    failures = 0;
  } catch (err) {
    failures++;
    delay = Math.min(POLL_MS, 5_000 * 2 ** Math.min(failures, 4));
    const asof = $('[data-sc-asof]');
    if (asof) asof.textContent = view ? `Scorecard unreadable just now; showing block ${fmtBlock(view.block)}. Retrying.` : 'Scorecard unreadable just now. Retrying.';
    if (!view) {
      const hl = $('[data-sc-headline]');
      if (hl) hl.textContent = 'The Scorecard is unreadable just now.';
    }
    if (failures === 1) console.warn('scorecard: read failed', err);
  } finally {
    reading = false;
  }
  if (isMock()) return;
  if (document.visibilityState !== 'hidden') timer = setTimeout(tick, delay);
}

document.addEventListener('visibilitychange', () => {
  if (isMock()) return;
  if (document.visibilityState === 'hidden') {
    clearTimeout(timer);
    timer = undefined;
  } else if (!timer && !reading) {
    void tick();
  }
});

void tick();
