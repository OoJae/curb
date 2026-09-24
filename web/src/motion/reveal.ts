/**
 * Headline reveals: SplitText lines, masked, yPercent 110 → 0, stagger 0.08, 900 ms "curb",
 * after document.fonts.ready, fired once (spec §1 Motion 5).
 *
 * Mark text with `data-reveal` in HTML: base.css keeps it hidden until it is split (with a 2.5 s
 * fail-safe), so there is no flash of unsplit text. boot() reveals every [data-reveal] present at
 * boot; call revealLines() yourself for headlines you render later.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { EASE } from './ease';
import { DUR, STAGGER_LINES } from './timing';
import { whenFontsReady } from './fonts';
import { prefersReducedMotion } from './reduced';

export { whenFontsReady };

gsap.registerPlugin(ScrollTrigger, SplitText);

export interface RevealOptions {
  /** seconds between lines (default 0.08) */
  stagger?: number;
  /** seconds (default 0.9) */
  duration?: number;
  /** seconds before the first line moves */
  delay?: number;
  /** wait until the element scrolls into view (default true); false plays immediately */
  onScroll?: boolean;
  /** ScrollTrigger start (default "top 88%") */
  start?: string;
}

const done = new WeakSet<Element>();

function toElements(targets: string | Element | ArrayLike<Element>): Element[] {
  if (typeof targets === 'string') return Array.from(document.querySelectorAll(targets));
  if (targets instanceof Element) return [targets];
  return Array.from(targets);
}

function markRevealed(el: Element): void {
  el.setAttribute('data-revealed', '');
}

/**
 * Keep punctuation with the inline element it follows ("<em>shut</em>." or "<em>reopen</em>,"): SplitText
 * treats the trailing mark as its own word and can wrap it onto a line by itself. Wrap the pair in a
 * nowrap span first. Idempotent.
 */
function gluePunctuation(root: Element): void {
  for (const inline of Array.from(root.querySelectorAll('em, i, strong, b, a, span:not(.glue)'))) {
    const next = inline.nextSibling;
    if (!next || next.nodeType !== Node.TEXT_NODE) continue;
    const m = /^[.,;:!?)\]…’”]+/.exec(next.textContent ?? '');
    if (!m) continue;
    const glue = document.createElement('span');
    glue.className = 'glue';
    glue.style.whiteSpace = 'nowrap';
    inline.replaceWith(glue);
    glue.append(inline, document.createTextNode(m[0]));
    next.textContent = (next.textContent ?? '').slice(m[0].length);
  }
}

/** Reveal each target's lines once. Resolves when every animation has finished (or immediately under reduced motion). */
export async function revealLines(targets: string | Element | ArrayLike<Element>, opts: RevealOptions = {}): Promise<void> {
  const els = toElements(targets).filter((el) => !done.has(el));
  if (!els.length) return;
  els.forEach((el) => done.add(el));
  if (prefersReducedMotion()) {
    els.forEach(markRevealed);
    return;
  }
  await whenFontsReady();
  els.forEach(gluePunctuation);
  await Promise.all(
    els.map(
      (el) =>
        new Promise<void>((resolve) => {
          let finished = false;
          const finish = () => {
            if (!finished) {
              finished = true;
              resolve();
            }
          };
          SplitText.create(el, {
            type: 'lines',
            mask: 'lines',
            linesClass: 'split-line',
            autoSplit: true,
            aria: 'auto',
            onSplit(self: SplitText) {
              const tween = gsap.from(self.lines, {
                yPercent: 110,
                duration: opts.duration ?? DUR.reveal,
                ease: EASE,
                stagger: opts.stagger ?? STAGGER_LINES,
                delay: opts.delay ?? 0,
                onComplete: finish,
                ...(opts.onScroll === false
                  ? {}
                  : { scrollTrigger: { trigger: el, start: opts.start ?? 'top 88%', once: true } }),
              });
              markRevealed(el);
              return tween;
            },
          });
        }),
    ),
  );
}

/** Reveal every [data-reveal] inside `root` that has not been revealed yet. */
export function revealAll(root: ParentNode = document, opts: RevealOptions = {}): Promise<void> {
  return revealLines(root.querySelectorAll('[data-reveal]:not([data-revealed])'), opts);
}
