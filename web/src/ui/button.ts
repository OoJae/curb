/**
 * Buttons. Press scale 0.98 / 90 ms and the hover hairline are CSS (.btn, .btn__label).
 *
 * txButton(el, run): the transaction states from spec §3 micro-interactions.
 *   pending   → the label becomes a 16 px C whose amber arc turns once every 1.6 s
 *   confirmed → the two C halves the C and its arc give way to a closed ring (the loop closes); status: "Confirmed in block N ↗ ·
 *               Builder Code dd7u50nckt5e729f attached"
 *   reverted  → the arc stops; status: "Reverted: ErrorName()"
 *
 *   txButton(btn, async () => {
 *     const hash = await writeContract(…);            // simulate → write (with dataSuffix)
 *     const r = await waitForTransactionReceipt({ hash });
 *     if (r.status !== 'success') throw new TxReverted('ErrorName()', hash);
 *     return { hash, block: r.blockNumber };
 *   });
 */
import { ARC_PATH, C_BOTTOM_PATH, C_TOP_PATH, MARK_VIEWBOX, RING_PATH } from '../shell/mark';
import { EXTERNAL } from '../shell/markup';
import { fmtBlock } from './format';
import { html } from './html';
import { txUrl } from './txlink';

export type TxState = 'idle' | 'pending' | 'confirmed' | 'reverted';

export interface TxResult {
  hash: string;
  block: number | bigint;
}

/** Throw this from `run` to report a revert with a readable error name. */
export class TxReverted extends Error {
  constructor(
    readonly errorName: string,
    readonly hash?: string,
  ) {
    super(`Reverted: ${errorName}`);
    this.name = 'TxReverted';
  }
}

export interface TxButtonOptions {
  /** where the status line goes (default: a .tx-status <p> inserted after the button) */
  status?: HTMLElement;
  /** map an error to "ErrorName()" (default: best effort for viem errors) */
  errorName?: (err: unknown) => string;
  /** return to idle this long after confirming (default: stay confirmed; null = stay) */
  resetAfterMs?: number | null;
  onConfirmed?: (r: TxResult) => void;
  onReverted?: (err: unknown) => void;
}

export interface TxButtonHandle {
  readonly state: TxState;
  /** run the transaction programmatically (same as a click) */
  run(): Promise<TxResult | null>;
  reset(): void;
  destroy(): void;
}

const svg = (cls: string, d: string) =>
  `<svg class="${cls}" viewBox="${MARK_VIEWBOX}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path class="${cls.includes('arc') ? 'mark__arc' : 'mark__c'}" d="${d}"/></svg>`;

/** The spinner: two C halves and the arc, stacked, so each can rotate about the mark's centre. */
export const SPINNER_HTML =
  svg('spin__top', C_TOP_PATH) + svg('spin__bottom', C_BOTTOM_PATH) + svg('spin__arc', ARC_PATH) + svg('spin__ring', RING_PATH);

/** Best-effort "ErrorName()" from viem / wallet errors. */
export function defaultErrorName(err: unknown): string {
  const e = err as Record<string, any> | null;
  if (!e) return 'UnknownError()';
  if (e instanceof TxReverted) return e.errorName;
  if (e.code === 4001 || e.cause?.code === 4001 || /user rejected|denied/i.test(String(e.shortMessage ?? e.message ?? ''))) {
    return 'Rejected in wallet';
  }
  const walk = (x: any, depth = 0): string | null => {
    if (!x || depth > 6) return null;
    const name = x.data?.errorName ?? x.errorName;
    if (typeof name === 'string' && name) return `${name}()`;
    if (typeof x.reason === 'string' && x.reason) return x.reason;
    return walk(x.cause, depth + 1);
  };
  return walk(e) ?? (typeof e.shortMessage === 'string' ? e.shortMessage : `${e.name ?? 'Error'}()`);
}

export function txButton(el: HTMLButtonElement, run: () => Promise<TxResult>, opts: TxButtonOptions = {}): TxButtonHandle {
  el.classList.add('btn', 'btn--tx');
  if (!el.querySelector('.btn__label')) {
    const label = document.createElement('span');
    label.className = 'btn__label';
    label.append(...Array.from(el.childNodes));
    el.append(label);
  }
  const label = el.querySelector<HTMLElement>('.btn__label')!;
  const idleHTML = label.innerHTML;
  let spinner = el.querySelector<HTMLElement>('.btn__spinner');
  if (!spinner) {
    spinner = document.createElement('span');
    spinner.className = 'btn__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    spinner.innerHTML = SPINNER_HTML;
    el.append(spinner);
  }
  let status = opts.status ?? null;
  if (!status) {
    status = document.createElement('p');
    status.className = 'tx-status';
    // In a flex/grid row of buttons, put the status line under the row, not between buttons.
    const parent = el.parentElement;
    const display = parent ? getComputedStyle(parent).display : '';
    if (parent && parent !== document.body && /flex|grid/.test(display)) parent.after(status);
    else el.after(status);
  }
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  let state: TxState = 'idle';
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const setState = (s: TxState) => {
    state = s;
    el.dataset.state = s;
    el.setAttribute('aria-busy', String(s === 'pending'));
  };
  setState('idle');

  const go = async (): Promise<TxResult | null> => {
    if (state === 'pending') return null;
    clearTimeout(resetTimer);
    setState('pending');
    label.innerHTML = idleHTML;
    status!.textContent = 'Waiting for the wallet and the chain…';
    try {
      const r = await run();
      setState('confirmed');
      const block = fmtBlock(r.block);
      status!.innerHTML = html`<a href="${txUrl(r.hash)}" target="_blank" rel="noopener">Confirmed in block ${block}<span class="arrow arrow--ext" aria-hidden="true">→</span><span class="visually-hidden"> (opens OKLink)</span></a> · Builder Code <code>${EXTERNAL.builderCode}</code> attached`.value;
      // After the halves meet, the label returns as "Confirmed".
      setTimeout(() => {
        if (state !== 'confirmed') return;
        label.textContent = 'Confirmed';
        el.dataset.state = 'idle';
        el.dataset.done = '';
      }, 700);
      opts.onConfirmed?.(r);
      if (opts.resetAfterMs) resetTimer = setTimeout(reset, opts.resetAfterMs);
      return r;
    } catch (err) {
      setState('reverted');
      const name = (opts.errorName ?? defaultErrorName)(err);
      status!.innerHTML = name === 'Rejected in wallet' ? html`Rejected in the wallet. Nothing was sent.`.value : html`Reverted: <code>${name}</code>`.value;
      setTimeout(() => {
        if (state === 'reverted') {
          el.dataset.state = 'idle';
          state = 'idle';
        }
      }, 900);
      opts.onReverted?.(err);
      return null;
    }
  };

  const reset = () => {
    clearTimeout(resetTimer);
    setState('idle');
    delete el.dataset.done;
    label.innerHTML = idleHTML;
    status!.textContent = '';
  };

  const onClick = () => void go();
  el.addEventListener('click', onClick);

  return {
    get state() {
      return state;
    },
    run: go,
    reset,
    destroy() {
      clearTimeout(resetTimer);
      el.removeEventListener('click', onClick);
    },
  };
}

/** Wrap a plain button's content in .btn__label so it gets the hover hairline. Idempotent. */
export function enhanceButton(el: HTMLElement): void {
  el.classList.add('btn');
  if (el.querySelector('.btn__label')) return;
  const label = document.createElement('span');
  label.className = 'btn__label';
  label.append(...Array.from(el.childNodes));
  el.append(label);
}
