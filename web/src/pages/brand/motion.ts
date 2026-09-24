/**
 * Live motion specimens for /brand. Where the site has the component (txButton, countdown, .btn, the masthead arc,
 * the regime preview), the specimen IS that component; the rest use the same eases and durations (motion/timing.ts).
 * Transform and opacity only; reduced motion shows final states.
 */
import type { Shell } from '../../shell/boot';
import { markSVG } from '../../shell/mark';
import { txButton } from '../../ui/button';
import { countdown } from '../../ui/countdown';
import { CSS_EASE, DUR, STAGGER_LINES } from '../../motion/timing';
import { prefersReducedMotion } from '../../motion/reduced';
import { nextChange } from '../../data/schedule';

export interface Specimen {
  id: string;
  title: string;
  caption: string;
  /** trusted markup for the stage */
  stage: string;
  /** label for the Play button; omit when the stage is its own control */
  play?: string;
  /** wire up after insertion; returns the Play handler, or null when there is no Play button */
  mount(fig: HTMLElement, shell: Shell): ((btn: HTMLButtonElement) => void) | null;
}

/** Host A's first MarketClock round after the Builder Code went live (docs/DEPLOYMENTS.md): a real, attributed tx. */
const ROUND = { hash: '0x5d3c92ab02abb2adbde73babc07a0eed739237f5cd36745c80ba6d123e45605e', block: 71_462_192 };

const q = <T extends Element>(el: Element, s: string) => el.querySelector(s) as T;
const ms = (s: number) => s * 1000;

export const SPECIMENS: Specimen[] = [
  {
    id: 'tx',
    title: 'A transaction',
    caption:
      'Pending: the label becomes a 16 px C whose amber arc turns once every 1.6 s, the only infinite animation. ' +
      'Confirmed: the halves of the C turn to meet. This replays host A’s first round to carry the Builder Code, in ' +
      'its real block; nothing is sent.',
    stage: `<div class="br-mo-tx"><button type="button" class="btn btn--primary br-tx">Replay a round</button><p class="tx-status br-tx-status"></p></div>`,
    mount(fig) {
      txButton(
        q<HTMLButtonElement>(fig, '.br-tx'),
        () => new Promise((resolve) => setTimeout(() => resolve(ROUND), 2600)),
        { status: q<HTMLElement>(fig, '.br-tx-status'), resetAfterMs: 9000 },
      );
      return null;
    },
  },
  {
    id: 'countdown',
    title: 'Ticking numbers',
    caption:
      'Hong Kong’s next cut or reopen, from the published schedule. Digits sit in fixed-width cells; a changed digit ' +
      'leaves upward as the next rises in, 280 ms. Numbers never count up to a value.',
    stage: `<p class="br-mo-count"><span class="t-label br-count-label">Next change</span><span class="br-count"></span></p>`,
    mount(fig) {
      const label = q<HTMLElement>(fig, '.br-count-label');
      const el = q<HTMLElement>(fig, '.br-count');
      const next = () => nextChange(Date.now());
      let n = next();
      const say = () => (label.textContent = n?.kind === 'reopen' ? 'Reopens in' : 'Cuts to zero in');
      say();
      if (!n) return null;
      const cd = countdown(el, {
        target: n.atMs,
        label: 'Next change in',
        onDone: () => {
          n = next();
          say();
          if (n) cd.set(n.atMs);
        },
      });
      return null;
    },
  },
  {
    id: 'buttons',
    title: 'Hover and press',
    caption:
      'Hover or focus draws a hairline under the label from the left, amber on ink and brass on an ivory button. ' +
      'A press scales to 0.98 for 90 ms.',
    stage: `<div class="cluster"><button type="button" class="btn btn--primary"><span class="btn__label">Read the clock</span></button><button type="button" class="btn btn--secondary"><span class="btn__label">Ask the API</span></button></div>`,
    mount() {
      return null;
    },
  },
  {
    id: 'reveal',
    title: 'Headline reveal',
    caption: 'Lines rise from behind a mask, yPercent 110 → 0, 0.08 s apart, 900 ms, once the fonts are in. Once per page.',
    stage: `<p class="br-mo-h"><span class="br-line"><span>Sell the <em>reopen</em>,</span></span><span class="br-line"><span>not the asset.</span></span></p>`,
    play: 'Play',
    mount(fig) {
      if (prefersReducedMotion()) return null;
      return () =>
        fig.querySelectorAll<HTMLElement>('.br-line > span').forEach((s, i) =>
          s.animate([{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }], {
            duration: ms(DUR.reveal),
            delay: ms(STAGGER_LINES) * i,
            easing: CSS_EASE.curb,
            fill: 'backwards',
          }),
        );
    },
  },
  {
    id: 'window',
    title: 'Page transition',
    caption:
      'The masthead stays put and its amber arc steps 30° once; the old page leaves in 200 ms and the new one rises ' +
      '24 px in 560 ms. Play steps this mark and the one in the masthead.',
    stage:
      `<div class="br-mo-row"><span class="br-mo-mark">${markSVG({ layer: 'c', className: 'br-mo-c' })}${markSVG({ layer: 'arc', className: 'br-mo-arc' })}</span>` +
      `<span class="br-mo-pages"><span class="br-mo-page is-old">/clock</span><span class="br-mo-page is-new">/scorecard</span></span></div>`,
    play: 'Play',
    mount(fig, shell) {
      if (prefersReducedMotion()) return null;
      const arc = q<SVGElement>(fig, '.br-mo-arc');
      const [old, neu] = Array.from(fig.querySelectorAll<HTMLElement>('.br-mo-page'));
      return () => {
        shell.masthead.stepArc();
        arc.animate([{ transform: 'rotate(-30deg)' }, { transform: 'rotate(0deg)' }], { duration: 560, easing: CSS_EASE.curb });
        old!.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: ms(DUR.exit), easing: CSS_EASE.exit, fill: 'forwards' });
        neu!.animate([{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay: 60, easing: CSS_EASE.curb, fill: 'both' });
        setTimeout(() => {
          [old!.textContent, neu!.textContent] = [neu!.textContent, old!.textContent];
          old!.getAnimations().forEach((a) => a.cancel());
          neu!.getAnimations().forEach((a) => a.cancel());
        }, 1400);
      };
    },
  },
  {
    id: 'regime',
    title: 'Paper and ink',
    caption:
      'While Hong Kong is open the whole site turns to paper; when it shuts, back to Street ink, in a 1.2 s crossfade. ' +
      'This button is the masthead’s preview: it flips this page.',
    stage: `<p class="br-mo-regime" aria-live="polite"></p>`,
    mount(fig, shell) {
      const out = q<HTMLElement>(fig, '.br-mo-regime');
      const btn = q<HTMLButtonElement>(fig, '.br-play');
      const words = { open: 'paper hours: Hong Kong is open', shut: 'ink hours: Hong Kong is shut', unknown: 'ink hours: the clock is stale' };
      shell.regime.subscribe((s) => {
        out.textContent = `Showing ${words[s.shown]}${s.preview ? ' (preview)' : ''}.`;
        btn.textContent = s.preview ? 'Back to the live hours' : 'Preview the other hours';
      });
      return () => shell.regime.setPreview(!shell.regime.get().preview);
    },
  },
];
