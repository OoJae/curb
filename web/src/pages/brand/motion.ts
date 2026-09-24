/**
 * Live motion specimens for /brand (spec §1 Motion, §3 micro-interactions). Web Animations API only; transform and
 * opacity only; every specimen has a static final state for prefers-reduced-motion.
 */
import { C_HALF_GAP, MARK_ARC, MARK_BOX, MARK_C, MARK_C_LOWER, MARK_C_UPPER } from './mark-data';

const root = () => getComputedStyle(document.documentElement);
const cssVar = (prop: string, fallback: string) => root().getPropertyValue(prop).trim() || fallback;

// ADAPTER — lane A's motion tokens, if defined; else the spec's values.
export const EASE = {
  curb: () => cssVar('--ease-curb', 'cubic-bezier(0.16, 1, 0.3, 1)'),
  exit: () => cssVar('--ease-exit', 'cubic-bezier(0.7, 0, 0.84, 0)'),
};

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface Specimen {
  id: string;
  title: string;
  spec: string;
  stage: string;
  /** Wire up after insertion; returns play() for the Replay button (null = continuous or hover-only). */
  mount(el: HTMLElement): (() => void) | null;
}

/** The mark as inline SVG. The arc carries an ink moat (stroke, painted under) so it never touches ivory as it moves. */
const markSvg = (cls: string, parts: 'whole' | 'halves' = 'whole') =>
  `<svg class="brand-mk ${cls}" viewBox="0 0 ${MARK_BOX} ${MARK_BOX}" aria-hidden="true">` +
  (parts === 'whole'
    ? `<path class="brand-mk-c" d="${MARK_C}"/>`
    : `<path class="brand-mk-c brand-mk-up" d="${MARK_C_UPPER}"/><path class="brand-mk-c brand-mk-lo" d="${MARK_C_LOWER}"/>`) +
  `<path class="brand-mk-arc" d="${MARK_ARC}"/></svg>`;

const q = <T extends Element>(el: Element, s: string) => el.querySelector(s) as T;

export const SPECIMENS: Specimen[] = [
  {
    id: 'pending',
    title: 'Pending',
    spec: 'A transaction in flight: the label becomes a 16 px C whose amber arc turns once every 1.6 s. The only infinite animation.',
    stage: `<div class="brand-mo-row"><span class="brand-mo-btn is-pending">${markSvg('brand-mk-16 brand-spin')}<span>Minting</span></span>${markSvg('brand-mk-64 brand-spin')}</div>`,
    mount(el) {
      if (reduced()) return null;
      for (const arc of el.querySelectorAll<SVGElement>('.brand-spin .brand-mk-arc'))
        arc.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: 1600, iterations: Infinity }); // clockwise: forward in time
      return null;
    },
  },
  {
    id: 'confirmed',
    title: 'Confirmed',
    spec: `The arc stops and fades; the two halves of the C turn ±${C_HALF_GAP}° to meet at three o’clock. 480 ms, curb ease.`,
    stage: `<div class="brand-mo-row">${markSvg('brand-mk-64 brand-conf', 'halves')}<p class="brand-mo-note">Confirmed ↗<br><span>Builder Code dd7u50nckt5e729f attached</span></p></div>`,
    mount(el) {
      const up = q<SVGElement>(el, '.brand-mk-up');
      const lo = q<SVGElement>(el, '.brand-mk-lo');
      const arc = q<SVGElement>(el, '.brand-mk-arc');
      const note = q<HTMLElement>(el, '.brand-mo-note');
      const end = () => {
        up.style.transform = `rotate(${C_HALF_GAP}deg)`;
        lo.style.transform = `rotate(${-C_HALF_GAP}deg)`;
        arc.style.opacity = '0';
      };
      if (reduced()) {
        end();
        return null;
      }
      return () => {
        const o = { duration: 480, easing: EASE.curb(), fill: 'both' as const };
        arc.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE.exit(), fill: 'both' });
        up.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${C_HALF_GAP}deg)` }], { ...o, delay: 120 });
        lo.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${-C_HALF_GAP}deg)` }], { ...o, delay: 120 });
        note.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { ...o, delay: 420 });
      };
    },
  },
  {
    id: 'countdown',
    title: 'Ticking numbers',
    spec: 'Digits sit in fixed-width cells; a changed digit leaves upward and its successor rises in, 280 ms. Numbers never count up to a value.',
    stage: `<div class="brand-mo-row"><p class="brand-mo-clock" aria-label="Hong Kong time"><span class="brand-mo-digits"></span> <span class="brand-mo-unit">HKT</span></p></div>`,
    mount(el) {
      const box = q<HTMLElement>(el, '.brand-mo-digits');
      const fmt = () =>
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
      let prev = fmt();
      box.innerHTML = [...prev].map((c) => `<span class="brand-cell"><span>${c}</span></span>`).join('');
      const tick = () => {
        const next = fmt();
        const cells = box.querySelectorAll<HTMLElement>('.brand-cell');
        [...next].forEach((c, i) => {
          if (c === prev[i] || !cells[i]) return;
          const old = cells[i].firstElementChild as HTMLElement;
          const neu = document.createElement('span');
          neu.textContent = c;
          cells[i].append(neu);
          if (reduced()) {
            old.remove();
            return;
          }
          const o = { duration: 280, easing: EASE.curb() };
          old.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], o).finished.then(() => old.remove());
          neu.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], o);
        });
        prev = next;
      };
      let timer = 0;
      const io = new IntersectionObserver(([e]) => {
        clearInterval(timer);
        if (e.isIntersecting) timer = window.setInterval(() => !document.hidden && tick(), 1000);
      });
      io.observe(el);
      return null;
    },
  },
  {
    id: 'hover',
    title: 'Hover and press',
    spec: 'Hover draws an amber hairline under the label from the left, 180 ms; it leaves to the right. A press scales to 0.98 for 90 ms.',
    stage: `<div class="brand-mo-row"><a class="brand-mo-link" href="#motion">Read the clock →</a><button type="button" class="brand-mo-press">Ask the API ↗</button></div>`,
    mount(el) {
      const a = q<HTMLElement>(el, '.brand-mo-link');
      const b = q<HTMLElement>(el, '.brand-mo-press');
      if (reduced()) return null;
      return () => {
        a.classList.add('is-demo');
        setTimeout(() => a.classList.remove('is-demo'), 1100);
        b.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.98)' }, { transform: 'scale(1)' }], { duration: 180, delay: 1300 });
      };
    },
  },
  {
    id: 'reveal',
    title: 'Headline reveal',
    spec: 'Lines rise from behind a mask, yPercent 110 → 0, 0.08 s apart, 900 ms, after the fonts are ready. Once per page.',
    stage: `<p class="brand-mo-h"><span class="brand-line"><span>Sell the <em>reopen</em>,</span></span><span class="brand-line"><span>not the asset.</span></span></p>`,
    mount(el) {
      if (reduced()) return null;
      return () => {
        el.querySelectorAll<HTMLElement>('.brand-line > span').forEach((s, i) =>
          s.animate([{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }], { duration: 900, delay: 80 * i, easing: EASE.curb(), fill: 'backwards' }),
        );
      };
    },
  },
  {
    id: 'window',
    title: 'Page transition',
    spec: 'The masthead stays; the mark’s amber arc steps 30° once. The old page leaves in 200 ms, the new one rises 24 px in 560 ms.',
    stage: `<div class="brand-mo-row">${markSvg('brand-mk-64 brand-step')}<div class="brand-mo-pages"><div class="brand-mo-page is-old">/clock</div><div class="brand-mo-page is-new">/scorecard</div></div></div>`,
    mount(el) {
      const arc = q<SVGElement>(el, '.brand-mk-arc');
      const [o, n] = el.querySelectorAll<HTMLElement>('.brand-mo-page');
      let turn = 0;
      if (reduced()) return null;
      return () => {
        const from = turn;
        turn = (turn + 30) % 360;
        arc.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from + 30}deg)` }], { duration: 560, easing: EASE.curb(), fill: 'forwards' });
        o.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 200, easing: EASE.exit(), fill: 'forwards' });
        n.animate([{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay: 60, easing: EASE.curb(), fill: 'both' });
        setTimeout(() => {
          [o.textContent, n.textContent] = [n.textContent, o.textContent];
          o.getAnimations().forEach((a) => a.cancel());
          n.getAnimations().forEach((a) => a.cancel());
        }, 1400);
      };
    },
  },
  {
    id: 'regime',
    title: 'Paper and ink',
    spec: 'When Hong Kong opens, the site turns to paper; when it shuts, back to ink. A 1.2 s crossfade (a View Transition on the real page).',
    stage:
      `<div class="brand-mo-regime" data-regime="shut">` +
      `<div class="brand-mo-face is-ink"><span class="brand-mo-chip">${markSvg('brand-mk-16')} Shut · still trading</span><p>Curb keeps the record.</p></div>` +
      `<div class="brand-mo-face is-paper"><span class="brand-mo-chip"><span class="brand-mo-tile">${markSvg('brand-mk-16')}</span> Paper hours: Hong Kong is open</span><p>Curb goes dark at 11:55 HKT.</p></div>` +
      `</div>`,
    mount(el) {
      const box = q<HTMLElement>(el, '.brand-mo-regime');
      const paper = q<HTMLElement>(el, '.is-paper');
      return () => {
        const toPaper = box.dataset.regime === 'shut';
        box.dataset.regime = toPaper ? 'open' : 'shut';
        if (reduced()) return;
        paper.animate([{ opacity: toPaper ? 0 : 1 }, { opacity: toPaper ? 1 : 0 }], { duration: 1200, easing: 'ease-in-out' });
      };
    },
  },
];
