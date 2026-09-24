/**
 * Masthead behaviour. The markup is static (shell/markup.ts, written by the curb-shell plugin);
 * this only guarantees it exists, carries URL flags on internal links, and steps the mark's
 * amber arc when asked.
 */
import { flags, withFlags } from './flags';
import { footerHTML, mastheadHTML, type PageId } from './markup';
import { CSS_EASE } from '../motion/timing';
import { prefersReducedMotion } from '../motion/reduced';

/** Insert the shell markup if a page was served without the plugin (e.g. a test harness). */
export function ensureShellMarkup(page: PageId): void {
  if (!document.querySelector('[data-shell="masthead"]')) {
    document.body.insertAdjacentHTML('afterbegin', mastheadHTML(page));
  }
  if (!document.querySelector('[data-shell="footer"]')) {
    const main = document.querySelector('main');
    if (main) main.insertAdjacentHTML('afterend', footerHTML(page));
    else document.body.insertAdjacentHTML('beforeend', footerHTML(page));
  }
}

/** Carry ?regime / ?mock / ?capture across internal navigation. */
function carryFlags(): () => void {
  if (!flags.regime && !flags.mock && !flags.capture) return () => {};
  const rewrite = (a: HTMLAnchorElement) => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('/') && !href.startsWith('//')) {
      const next = withFlags(href);
      if (next !== href) a.setAttribute('href', next);
    }
  };
  document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach(rewrite);
  const onClick = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a');
    if (a instanceof HTMLAnchorElement) rewrite(a);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('focusin', onClick, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('focusin', onClick, true);
  };
}

export interface Masthead {
  el: HTMLElement;
  /** Step the mark's amber arc 30° forward and back (motion reports change). */
  stepArc(): void;
  destroy(): void;
}

export function mountMasthead(page: PageId): Masthead {
  ensureShellMarkup(page);
  const el = document.querySelector<HTMLElement>('[data-shell="masthead"]')!;
  const arc = el.querySelector<SVGElement>('.masthead__mark .mark-tile__arc');
  const uncarry = carryFlags();
  return {
    el,
    stepArc() {
      if (!arc || prefersReducedMotion()) return;
      arc.animate([{ transform: 'rotate(-30deg)' }, { transform: 'rotate(0deg)' }], { duration: 560, easing: CSS_EASE.curb });
    },
    destroy() {
      uncarry();
    },
  };
}
