// LAB STUB for lane A's motion/reduced.ts. `?reduced=1` forces it in the lab.
export const prefersReducedMotion = (): boolean =>
  new URLSearchParams(location.search).has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
