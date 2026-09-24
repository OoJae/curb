// LAB STUB for lane A's motion/lenis.ts: Lenis on the GSAP ticker, ScrollTrigger updated on scroll (spec §4).
// Off for reduced motion and touch.
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { prefersReducedMotion } from './reduced';

let lenis: Lenis | null = null;

export function initLenis(): Lenis | null {
  if (lenis || prefersReducedMotion() || matchMedia('(pointer: coarse)').matches) return lenis;
  gsap.registerPlugin(ScrollTrigger);
  lenis = new Lenis({ autoRaf: false });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis?.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  return lenis;
}

export const getLenis = () => lenis;
