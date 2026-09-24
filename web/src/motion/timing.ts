/**
 * Motion constants with no GSAP dependency (import these where you only need numbers or CSS
 * easings; import motion/ease.ts when you need the registered GSAP "curb" ease).
 *   entrances cubic-bezier(0.16, 1, 0.3, 1); exits cubic-bezier(0.7, 0, 0.84, 0) 200 ms;
 *   scrub 0.6; micro 120–180 ms; UI 320–480 ms; reveals 900 ms. Numbers never count up.
 */

/** Durations in seconds (GSAP units). CSS equivalents live in tokens.css (--dur-*). */
export const DUR = {
  press: 0.09,
  micro: 0.15,
  ui: 0.4,
  reveal: 0.9,
  exit: 0.2,
  digit: 0.28,
  copied: 1.2,
  flip: 1.2,
  spin: 1.6,
} as const;

export const STAGGER_LINES = 0.08;
export const SCRUB = 0.6;

/** CSS easing strings for WAAPI / element.animate(). */
export const CSS_EASE = {
  curb: 'cubic-bezier(0.16, 1, 0.3, 1)',
  exit: 'cubic-bezier(0.7, 0, 0.84, 0)',
} as const;
