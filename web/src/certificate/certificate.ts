/**
 * The Curb certificate: an engraved card for a ReopenNote (ERC-1155 id) or a DepthCert, with the
 * guilloche rosette seeded from its id, the fields of its on-chain struct, and a CSS 3D tilt of at
 * most 6° that follows the pointer (off for reduced motion and touch).
 *
 *   render(el, certificateHTML({ kind: 'note', id: 1n, asset: 'wTCENTx', … }));
 *   const stop = enableTilt(el.querySelector('.crt')!);
 *
 * Seeds (spec §2: "epitrochoid rosette seeded from keccak(tokenId|inputRoot)"):
 *   note  keccak256(uint256 id)            — the ERC-1155 token id, abi-encoded
 *   cert  keccak256(uint256 id ‖ "DC")     — so DepthCert #1 and note #1 never share a fingerprint
 */
import { concat, keccak256, toHex, type Hex } from 'viem';
import { guillocheSvg } from './guilloche';
import { html, raw, type SafeHTML } from '../ui/html';
import { prefersReducedMotion, isTouch, onReducedMotionChange } from '../motion/reduced';
import './certificate.css';

export type CertificateKind = 'note' | 'cert';

export interface CertificateField {
  label: string;
  value: string | SafeHTML;
  /** a short gloss under the value, in plain words */
  note?: string;
}

export interface CertificateOptions {
  kind: CertificateKind;
  id: string | number | bigint;
  /** "Curb Reopen Note" / "Curb Depth Certificate" */
  title: string;
  /** the asset, set in Bodoni: "wTCENTx" */
  asset: string;
  /** the face value line: "0.1 wrapper shares" */
  face: string | SafeHTML;
  /** the settlement promise, e.g. "Settles at the verified reopen · Fri 09:30 HKT" */
  promise?: string | SafeHTML;
  fields: CertificateField[];
  /** fixture data: overprints "Specimen" */
  specimen?: boolean;
  /** give the card the registered view-transition name (only one per page) */
  vt?: boolean;
  /** accessible name for the card (default: `${title} No. ${id}, ${asset}`) */
  label?: string;
}

/** The 32-byte seed for a certificate's rosette. */
export function certificateSeed(kind: CertificateKind, id: string | number | bigint): Hex {
  const word = toHex(BigInt(id), { size: 32 });
  return kind === 'note' ? keccak256(word) : keccak256(concat([word, toHex('DC')]));
}

export function certificateHTML(o: CertificateOptions): SafeHTML {
  const seed = certificateSeed(o.kind, o.id);
  const rosette = raw(guillocheSvg(seed, { stroke: 'currentColor', attrs: 'class="crt__rosette" aria-hidden="true" focusable="false"' }));
  const seal = raw(guillocheSvg(seed, { stroke: 'currentColor', size: 200, attrs: 'class="crt__seal-rosette" aria-hidden="true" focusable="false"' }));
  const label = o.label ?? `${o.title} No. ${String(o.id)}, ${o.asset}`;
  return html`<article class="crt${o.vt ? ' vt-certificate' : ''}" data-kind="${o.kind}" aria-label="${label}">
  <div class="crt__card surface-paper">
    <div class="crt__engraving" aria-hidden="true">${rosette}</div>
    <header class="crt__head">
      <span class="crt__title">${o.title}</span>
      <span class="crt__serial">No.&nbsp;${String(o.id)}</span>
    </header>
    <div class="crt__body">
      <p class="crt__asset">${o.asset}</p>
      <p class="crt__face">${o.face}</p>
      ${o.promise ? html`<p class="crt__promise">${o.promise}</p>` : ''}
    </div>
    <dl class="crt__fields">
      ${o.fields.map(
        (f) => html`<div class="crt__field"><dt>${f.label}</dt><dd>${f.value}${f.note ? html`<span class="crt__gloss">${f.note}</span>` : ''}</dd></div>`,
      )}
    </dl>
    <footer class="crt__foot">
      <span class="crt__seal" aria-hidden="true">${seal}</span>
      <span class="crt__fingerprint"><span class="crt__fp-label">Fingerprint</span> <code title="${seed}">${seed.slice(0, 10)}…${seed.slice(-6)}</code></span>
    </footer>
    ${o.specimen ? html`<span class="crt__specimen" aria-hidden="true">Specimen</span>` : ''}
  </div>
</article>`;
}

/**
 * Tilt the card toward the pointer: rotateX/rotateY within ±maxDeg (≤ 6°), transform only. Returns a
 * cleanup. Off under reduced motion (and it switches off live if the preference changes) and on touch.
 */
export function enableTilt(root: HTMLElement, maxDeg = 6): () => void {
  const card = root.querySelector<HTMLElement>('.crt__card') ?? root;
  const limit = Math.min(6, Math.max(0, maxDeg));
  let raf = 0;
  let on = !prefersReducedMotion() && !isTouch();

  const set = (rx: number, ry: number) => {
    card.style.setProperty('--crt-rx', `${rx.toFixed(2)}deg`);
    card.style.setProperty('--crt-ry', `${ry.toFixed(2)}deg`);
  };
  const move = (e: PointerEvent) => {
    if (!on || e.pointerType === 'touch') return;
    const r = root.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      root.dataset.tilting = '';
      set(-py * 2 * limit, px * 2 * limit);
    });
  };
  const leave = () => {
    cancelAnimationFrame(raf);
    delete root.dataset.tilting;
    set(0, 0);
  };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', leave);
  const offRM = onReducedMotionChange((reduced) => {
    on = !reduced && !isTouch();
    if (!on) leave();
  });
  return () => {
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerleave', leave);
    offRM();
    leave();
  };
}
