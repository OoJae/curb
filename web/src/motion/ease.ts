/**
 * Registers the GSAP eases (spec §1 Motion):
 *   "curb"     = cubic-bezier(0.16, 1, 0.3, 1)  entrances
 *   "curbExit" = cubic-bezier(0.7, 0, 0.84, 0)  exits, 200 ms
 * Importing this module pulls in gsap; for plain numbers use motion/timing.ts.
 */
import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';

gsap.registerPlugin(CustomEase);

export const EASE = 'curb';
export const EASE_EXIT = 'curbExit';

CustomEase.create(EASE, 'M0,0 C0.16,1 0.3,1 1,1');
CustomEase.create(EASE_EXIT, 'M0,0 C0.7,0 0.84,0 1,1');

export { DUR, STAGGER_LINES, SCRUB, CSS_EASE } from './timing';
export { gsap };
