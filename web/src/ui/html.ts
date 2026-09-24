/**
 * A tiny escaping `html` tagged template. Every interpolated value is escaped unless it is itself
 * the result of `html` or `raw`. Arrays are flattened; null / undefined / false render nothing.
 *
 *   const row = html`<tr><td>${label}</td><td>${fmtBlock(block)}</td></tr>`;
 *   render(tbody, html`${rows.map(r => html`<tr>…</tr>`)}`);
 */

const SAFE = Symbol.for('curb.safe-html');

export interface SafeHTML {
  readonly [SAFE]: true;
  readonly value: string;
  toString(): string;
}

function safe(value: string): SafeHTML {
  return { [SAFE]: true, value, toString: () => value };
}

export function isSafeHTML(v: unknown): v is SafeHTML {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[SAFE] === true;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ESC[c]!);
}

/** Mark a trusted string (e.g. an SVG from shell/mark.ts) as HTML. Never pass user or chain data. */
export function raw(s: string): SafeHTML {
  return safe(s);
}

function toHTML(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (isSafeHTML(v)) return v.value;
  if (Array.isArray(v)) return v.map(toHTML).join('');
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return escapeHTML(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHTML {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += toHTML(values[i]) + (strings[i + 1] ?? '');
  return safe(out);
}

/** Replace `target`'s children with `content`. */
export function render(target: Element, content: SafeHTML): void {
  target.innerHTML = content.value;
}

/** Parse `content` into a DocumentFragment. */
export function frag(content: SafeHTML): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = content.value;
  return t.content;
}

/** Parse `content` and return its first element. Throws if there is none. */
export function el<T extends Element = HTMLElement>(content: SafeHTML): T {
  const node = frag(content).firstElementChild;
  if (!node) throw new Error('html: no element in template');
  return node as T;
}

/** Allow only http(s), mailto and same-origin relative URLs in href/src built from data. */
export function safeUrl(u: string): string {
  const s = u.trim();
  if (/^(https?:|mailto:)/i.test(s) || /^[/?#.]/.test(s)) return s;
  return '#';
}
