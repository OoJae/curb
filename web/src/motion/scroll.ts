/** Native scrolling helpers (no GSAP / Lenis). motion/lenis.ts uses these when Lenis is off. */
import { prefersReducedMotion } from './reduced';

export interface ScrollToOptions {
  offset?: number;
  /** seconds; Lenis only */
  duration?: number;
  immediate?: boolean;
}

export function nativeScrollTo(target: number | string | HTMLElement, opts: ScrollToOptions = {}): void {
  const behavior: ScrollBehavior = opts.immediate || prefersReducedMotion() ? 'auto' : 'smooth';
  if (typeof target === 'number') {
    window.scrollTo({ top: target + (opts.offset ?? 0), behavior });
    return;
  }
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY + (opts.offset ?? 0);
  window.scrollTo({ top, behavior });
}
