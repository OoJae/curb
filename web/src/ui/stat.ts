/**
 * A labelled figure with its as-of (copy rule: every live number carries its as-of block or time).
 * Numbers never count up: an update swaps the value and briefly dims it (motion reports change).
 *
 *   const s = stat(el, { label: 'Hours shut this week', value: '141 h 20 m', asOf: 'timetable' });
 *   s.update({ value: '…', asOf: 'block 71,484,120' });
 */
import { html, render, type SafeHTML } from './html';

export interface StatOptions {
  label: string;
  value: string;
  unit?: string;
  /** "block 71,484,120" / "12:41 HKT" / "timetable" */
  asOf?: string;
  note?: string;
  /** numeral = Bodoni hero numeral; display = Bodoni h2 (default); data = Martian Mono */
  size?: 'numeral' | 'display' | 'data';
}

export function statHTML(o: StatOptions): SafeHTML {
  const mod = o.size === 'numeral' ? ' stat--numeral' : o.size === 'data' ? ' stat--data' : '';
  return html`<div class="stat${mod}">
  <span class="stat__label">${o.label}</span>
  <span class="stat__value" data-stat-value>${o.value}${o.unit ? html`<span class="stat__unit">${o.unit}</span>` : ''}</span>
  ${o.asOf ? html`<span class="stat__asof" data-stat-asof>as of ${o.asOf}</span>` : ''}
  ${o.note ? html`<span class="stat__note">${o.note}</span>` : ''}
</div>`;
}

export interface StatHandle {
  el: HTMLElement;
  update(next: Partial<Omit<StatOptions, 'size'>>): void;
}

/** Render a stat into `el` (replacing its children). */
export function stat(el: HTMLElement, o: StatOptions): StatHandle {
  let current = { ...o };
  const draw = () => render(el, statHTML(current));
  draw();
  return {
    el,
    update(next) {
      const changed = next.value !== undefined && next.value !== current.value;
      current = { ...current, ...next };
      draw();
      const root = el.querySelector<HTMLElement>('.stat');
      if (changed && root) {
        root.removeAttribute('data-changed');
        void root.offsetWidth;
        root.setAttribute('data-changed', '');
      }
    },
  };
}
