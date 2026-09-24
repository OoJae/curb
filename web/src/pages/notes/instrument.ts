/**
 * Shared by /notes and /depth (lane E): the wallet bar and its EIP-6963 picker, the transaction
 * button adapter, the specimen/live tag and a few display formatters.
 *
 * Nothing here sends a transaction by itself: every write goes through data/wallet.ts `write()`
 * (simulate with the Builder Code suffix → send → receipt), started by a visitor's click.
 */
import { html, render, type SafeHTML } from '../../ui/html';
import { defaultErrorName, TxReverted, txButton, type TxButtonHandle } from '../../ui/button';
import { fmtBlock, shortAddress } from '../../ui/format';
import { addressLinkHTML } from '../../ui/txlink';
import { hktParts, fmtHKT } from '../../shell/hkt';
import type { Address, WalletInfo } from '../../data/types';
import type { WriteOutcome } from '../../data/wallet';
import './instrument.css';

// --- formatting ------------------------------------------------------------------------------

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 25 Sep, 09:30 HKT" (seconds optional). */
export function hktDate(ms: number, withSeconds = false): string {
  const p = hktParts(ms) as unknown as { weekday: number; day?: number; month?: number };
  const d = new Date(ms + 8 * 3_600_000);
  const day = DAYS[p.weekday] ?? '';
  return `${day} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${fmtHKT(ms, withSeconds)} HKT`;
}

/** "09:30 HKT" today, else "Fri 09:30 HKT". */
export function hktShort(ms: number, now = Date.now(), withSeconds = false): string {
  const a = hktParts(ms);
  const b = hktParts(now);
  const same = Math.abs(ms - now) < 86_400_000 && a.weekday === b.weekday;
  return `${same ? '' : `${DAYS[a.weekday] ?? ''} `}${fmtHKT(ms, withSeconds)} HKT`;
}

/** 5.6 → "5.60 USDG"; dp defaults to 2. */
export function fmtUsdg(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} USDG`;
}

/** A 6-dp USDG integer (bigint) → "5.4321" with `dp` decimals, truncated, not rounded. */
export function usdgFixed(v: bigint, dp = 4): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').slice(0, dp);
  return `${neg ? '−' : ''}${whole.toLocaleString('en-US')}${dp > 0 ? `.${frac}` : ''}`;
}

/** Shares with up to 6 decimals, trailing zeros trimmed: 0.1 → "0.1", 0.028 → "0.028". */
export function fmtShares(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

/** 3000 → "30.00%". */
export function fmtPct(bps: number | null | undefined, dp = 2): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(dp)}%`;
}

/** Signed bp in words: 281 → "281 bp under the reference", −23 → "23 bp over the reference". */
export function vsReference(bps: number, short = false): string {
  if (bps === 0) return 'at the reference';
  return `${Math.abs(bps).toLocaleString('en-US')} bp ${bps > 0 ? 'under' : 'over'}${short ? '' : ' the reference'}`;
}

// --- the specimen / live tag ------------------------------------------------------------------

export function statusTagHTML(live: boolean, block?: number | null): SafeHTML {
  if (!live) return html`<span class="tag tag--specimen">Specimen · in build</span>`;
  return html`<span class="tag"><span class="pulse" aria-hidden="true"></span>Live on X Layer${block ? html` · block ${fmtBlock(block)}` : ''}</span>`;
}

// --- errors -----------------------------------------------------------------------------------

/** "MarketNotClosed()" from a WriteError / viem error; the wallet's own words otherwise. */
export function txErrorName(err: unknown): string {
  const e = err as { errorName?: string | null; message?: string } | null;
  if (e?.errorName) return `${e.errorName}()`;
  const d = defaultErrorName(err);
  if (/^(WriteError|Error)\(\)$/.test(d) && e?.message) return /user rejected|denied/i.test(e.message) ? 'Rejected in wallet' : e.message;
  return d;
}

/**
 * A txButton over a data-layer writer. The status line gets the spec's states; a mined revert
 * (simulation passed, chain disagreed) reads "Reverted: …". `after` runs on a confirmed receipt and
 * may append a sentence to the status line (e.g. a CurbCredit Refusal, or a DepthCert fade).
 */
export function txAction(
  btn: HTMLButtonElement,
  run: () => Promise<WriteOutcome>,
  opts: { status?: HTMLElement; after?: (o: WriteOutcome, status: HTMLElement) => void } = {},
): TxButtonHandle {
  let last: WriteOutcome | null = null;
  let statusEl: HTMLElement | undefined = opts.status;
  const handle = txButton(
    btn,
    async () => {
      last = null;
      const o = await run();
      last = o;
      if (o.status !== 'success') throw new TxReverted('the transaction reverted on chain', o.hash);
      return { hash: o.hash, block: o.block };
    },
    {
      ...(statusEl ? { status: statusEl } : {}),
      errorName: txErrorName,
      onConfirmed: () => {
        const s = statusEl ?? findStatus(btn);
        if (last && s) opts.after?.(last, s);
      },
    },
  );
  if (!statusEl) statusEl = findStatus(btn) ?? undefined;
  return handle;
}

function findStatus(btn: HTMLElement): HTMLElement | null {
  let n: Element | null = btn.nextElementSibling;
  while (n && !n.classList.contains('tx-status')) n = n.nextElementSibling;
  if (n) return n as HTMLElement;
  const p = btn.parentElement?.nextElementSibling;
  return p?.classList.contains('tx-status') ? (p as HTMLElement) : null;
}

/** Enable or disable a step's buttons, with the reason written next to them (never silent). */
export function gate(buttons: HTMLButtonElement[], hint: HTMLElement | null, reason: string | null): void {
  for (const b of buttons) {
    if (b.dataset.state === 'pending') continue;
    b.disabled = reason !== null;
  }
  if (hint) {
    hint.textContent = reason ?? '';
    hint.hidden = reason === null;
  }
}

// --- the wallet bar ---------------------------------------------------------------------------

type WalletMod = typeof import('../../data/wallet');
let walletMod: Promise<WalletMod> | null = null;
export const loadWallet = (): Promise<WalletMod> => (walletMod ??= import('../../data/wallet'));

export interface WalletBar {
  account(): Address | null;
  /** fires on connect and disconnect; returns an unsubscribe */
  onChange(fn: (account: Address | null) => void): () => void;
}

function iconOk(src: string): boolean {
  return /^data:image\/(svg\+xml|png|webp|jpeg|gif);/i.test(src) || /^https:\/\//i.test(src);
}

/**
 * The wallet bar: "Connect a wallet" opens a <dialog> listing EIP-6963 wallets (OKX Wallet first).
 * Connecting switches the wallet to X Layer (0xc4), adding the chain if the wallet lacks it.
 */
export function mountWalletBar(el: HTMLElement, opts: { live: boolean }): WalletBar {
  let account: Address | null = null;
  let info: WalletInfo | null = null;
  const listeners = new Set<(a: Address | null) => void>();
  const dialogId = `${el.id || 'wallet'}-dialog`;

  el.classList.add('nt-wallet');
  const draw = () => {
    render(
      el,
      account
        ? html`<p class="nt-wallet__who"><span class="nt-wallet__dot" aria-hidden="true"></span>
            <span>Connected ${addressLinkHTML(account)}${info ? html` <span class="muted">· ${info.name}</span>` : ''} <span class="muted">· X Layer, chain 196</span></span></p>
            <button type="button" class="btn btn--quiet nt-wallet__btn" data-wallet-disconnect><span class="btn__label">Disconnect</span></button>`
        : html`<p class="nt-wallet__who"><span class="nt-wallet__dot nt-wallet__dot--off" aria-hidden="true"></span>
            <span>${opts.live ? 'No wallet connected. Reading the chain needs none; sending does.' : 'No wallet connected. Nothing on this page can send a transaction until the contracts are deployed.'}</span></p>
            <button type="button" class="btn btn--secondary nt-wallet__btn" data-wallet-connect aria-haspopup="dialog" aria-controls="${dialogId}"><span class="btn__label">Connect a wallet</span></button>`,
    );
  };
  draw();

  // The picker.
  const dialog = document.createElement('dialog');
  dialog.id = dialogId;
  dialog.className = 'nt-dialog';
  dialog.setAttribute('aria-labelledby', `${dialogId}-title`);
  render(
    dialog,
    html`<form method="dialog" class="nt-dialog__form">
      <h2 class="t-h3" id="${dialogId}-title">Choose a wallet</h2>
      <p class="t-small muted">Wallets announce themselves to the page (EIP-6963); OKX Wallet is listed first. Connecting asks the wallet to switch to X Layer (chain 196), adding it if needed.</p>
      <ul class="nt-dialog__list" role="list" data-wallet-list></ul>
      <p class="nt-dialog__status t-small" role="status" aria-live="polite" data-wallet-status></p>
      <div class="cluster nt-dialog__actions"><button class="btn btn--quiet" value="cancel"><span class="btn__label">Close</span></button></div>
    </form>`,
  );
  document.body.append(dialog);
  const list = dialog.querySelector<HTMLElement>('[data-wallet-list]')!;
  const status = dialog.querySelector<HTMLElement>('[data-wallet-status]')!;

  const drawList = (wallets: WalletInfo[]) => {
    const legacy = !wallets.length && typeof (globalThis as { ethereum?: unknown }).ethereum !== 'undefined';
    render(
      list,
      wallets.length
        ? html`${wallets.map(
            (w) => html`<li><button type="button" class="nt-dialog__wallet" data-uuid="${w.uuid}">
              ${iconOk(w.icon) ? html`<img src="${w.icon}" alt="" width="28" height="28">` : html`<span class="nt-dialog__noicon" aria-hidden="true"></span>`}
              <span class="nt-dialog__name">${w.name}</span><span class="nt-dialog__rdns">${w.rdns}</span></button></li>`,
          )}`
        : legacy
          ? html`<li><button type="button" class="nt-dialog__wallet" data-uuid=""><span class="nt-dialog__noicon" aria-hidden="true"></span><span class="nt-dialog__name">The browser’s wallet</span><span class="nt-dialog__rdns">window.ethereum</span></button></li>`
          : html`<li class="t-small">No wallet announced itself. Install <a href="https://www.okx.com/web3" target="_blank" rel="noopener">OKX Wallet</a> or another EIP-6963 wallet, then reopen this dialog.</li>`,
    );
  };

  const open = async () => {
    status.textContent = '';
    drawList([]);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    const w = await loadWallet();
    drawList(w.discoverWallets((all) => drawList(all)));
    list.querySelector<HTMLButtonElement>('button')?.focus();
  };

  list.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-uuid]');
    if (!b) return;
    status.textContent = 'Waiting for the wallet…';
    try {
      const w = await loadWallet();
      account = await w.connect(b.dataset.uuid || undefined);
      info = w.connectedWallet();
      dialog.close();
      draw();
      listeners.forEach((fn) => fn(account));
      el.querySelector<HTMLButtonElement>('[data-wallet-disconnect]')?.focus();
    } catch (err) {
      status.textContent = txErrorName(err) === 'Rejected in wallet' ? 'Rejected in the wallet. Nothing was connected.' : `Could not connect: ${txErrorName(err)}`;
    }
  });

  el.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-wallet-connect]')) void open();
    if (t.closest('[data-wallet-disconnect]')) {
      (await loadWallet()).disconnect();
      account = null;
      info = null;
      draw();
      listeners.forEach((fn) => fn(null));
      el.querySelector<HTMLButtonElement>('[data-wallet-connect]')?.focus();
    }
  });

  return {
    account: () => account,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** "0x055b…7105 (team: Agentic Wallet)" when the address is one of the disclosed team wallets. */
export function whoHTML(addr: Address, team: Record<string, string>): SafeHTML {
  const tag = team[addr.toLowerCase()];
  return html`${addressLinkHTML(addr)}${tag ? html` <span class="muted nt-team">(${tag})</span>` : ''}`;
}

export { shortAddress };
