/**
 * Reduced-motion and input helpers. Reduced motion means: no Lenis, no pins, no SplitText, no
 * view-transition animation, the ring renders its final state, the tx spinner is static.
 */

const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const touchQuery = typeof matchMedia === 'function' ? matchMedia('(hover: none) and (pointer: coarse)') : null;

export function prefersReducedMotion(): boolean {
  return reducedQuery?.matches ?? false;
}

/** Full motion allowed (the inverse of prefersReducedMotion). */
export function motionAllowed(): boolean {
  return !prefersReducedMotion();
}

/** A touch-first device (no hover, coarse pointer): Lenis stays off, hovers are skipped. */
export function isTouch(): boolean {
  return touchQuery?.matches ?? false;
}

/** Narrow viewport (< 768 px): no pins; orchestrated moments play once on a timer instead. */
export function isNarrow(): boolean {
  return typeof innerWidth === 'number' && innerWidth < 768;
}

/** Run `fn` whenever the reduced-motion preference changes. Returns an unsubscribe. */
export function onReducedMotionChange(fn: (reduced: boolean) => void): () => void {
  if (!reducedQuery) return () => {};
  const handler = (e: MediaQueryListEvent) => fn(e.matches);
  reducedQuery.addEventListener('change', handler);
  return () => reducedQuery.removeEventListener('change', handler);
}

/** Pick an implementation by preference: `whenMotion(() => animate(), () => jumpToEnd())`. */
export function whenMotion<T>(full: () => T, reduced: () => T): T {
  return prefersReducedMotion() ? reduced() : full();
}

/** Seconds → 0 under reduced motion. Handy for GSAP durations. */
export function dur(seconds: number): number {
  return prefersReducedMotion() ? 0 : seconds;
}
