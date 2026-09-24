/** OKLink (X Layer) links for transactions, addresses and blocks. External arrow from type (↗). */
import { html, type SafeHTML } from './html';
import { fmtBlock, shortAddress, shortHash } from './format';

export const OKLINK = 'https://www.oklink.com/xlayer';

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isTxHash(v: string): boolean {
  return TX_RE.test(v);
}

/** https://www.oklink.com/xlayer/tx/<hash> */
export function txUrl(hash: string): string {
  if (!TX_RE.test(hash)) throw new Error(`txUrl: not a tx hash: ${hash}`);
  return `${OKLINK}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  if (!ADDR_RE.test(address)) throw new Error(`addressUrl: not an address: ${address}`);
  return `${OKLINK}/address/${address}`;
}

export function blockUrl(block: number | bigint): string {
  return `${OKLINK}/block/${block.toString()}`;
}

const EXT = html`<span class="arrow arrow--ext" aria-hidden="true">→</span><span class="visually-hidden"> (opens OKLink)</span>`;

export interface TxLinkOptions {
  /** visible text (default: the shortened hash, e.g. 0xe8740458…4de7) */
  label?: string;
  /** render the full hash instead of the short form */
  full?: boolean;
  className?: string;
}

/** <a class="txlink" href="https://www.oklink.com/xlayer/tx/…">0xe8740458…4de7 ↗</a> */
export function txLinkHTML(hash: string, opts: TxLinkOptions = {}): SafeHTML {
  const text = opts.label ?? (opts.full ? hash : shortHash(hash));
  return html`<a class="txlink${opts.className ? ` ${opts.className}` : ''}" href="${txUrl(hash)}" target="_blank" rel="noopener" title="${hash}">${text}${EXT}</a>`;
}

export function addressLinkHTML(address: string, opts: TxLinkOptions = {}): SafeHTML {
  const text = opts.label ?? (opts.full ? address : shortAddress(address));
  return html`<a class="txlink${opts.className ? ` ${opts.className}` : ''}" href="${addressUrl(address)}" target="_blank" rel="noopener" title="${address}">${text}${EXT}</a>`;
}

export function blockLinkHTML(block: number | bigint, opts: Omit<TxLinkOptions, 'full'> = {}): SafeHTML {
  const text = opts.label ?? `block ${fmtBlock(block)}`;
  return html`<a class="txlink${opts.className ? ` ${opts.className}` : ''}" href="${blockUrl(block)}" target="_blank" rel="noopener">${text}${EXT}</a>`;
}

/** DOM version of txLinkHTML. */
export function txLink(hash: string, opts: TxLinkOptions = {}): HTMLAnchorElement {
  const t = document.createElement('template');
  t.innerHTML = txLinkHTML(hash, opts).value;
  return t.content.firstElementChild as HTMLAnchorElement;
}
