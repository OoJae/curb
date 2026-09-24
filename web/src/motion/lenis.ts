/**
 * Smooth scroll: Lenis driven by the GSAP ticker, feeding ScrollTrigger. Off for reduced motion
 * and for touch devices (native scroll there). Idempotent; boot() starts it.
 */
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { isTouch, onReducedMotionChange, prefersReducedMotion } from './reduced';
import { nativeScrollTo, type ScrollToOptions } from './scroll';

export type { ScrollToOptions };

gsap.registerPlugin(ScrollTrigger);

let lenis: Lenis | null = null;
let unwatch: (() => void) | null = null;

function tick(time: number): void {
  lenis?.raf(time * 1000);
}

/** Start Lenis unless reduced motion or touch. Returns the instance, or null when native scroll is used. */
export function startLenis(): Lenis | null {
  if (!unwatch) {
    unwatch = onReducedMotionChange((reduced) => (reduced ? stopLenis() : startLenis()));
  }
  if (lenis) return lenis;
  if (prefersReducedMotion() || isTouch()) return null;
  lenis = new Lenis({ autoRaf: false, lerp: 0.1, anchors: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);
  return lenis;
}

export function stopLenis(): void {
  if (!lenis) return;
  gsap.ticker.remove(tick);
  lenis.destroy();
  lenis = null;
}

export function getLenis(): Lenis | null {
  return lenis;
}

/** Scroll to a target (px, selector or element) with Lenis when active, natively otherwise. */
export function scrollToTarget(target: number | string | HTMLElement, opts: ScrollToOptions = {}): void {
  if (lenis) {
    lenis.scrollTo(target, {
      offset: opts.offset ?? 0,
      ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
      immediate: opts.immediate ?? false,
    });
    return;
  }
  nativeScrollTo(target, opts);
}
