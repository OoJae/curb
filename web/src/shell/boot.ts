/**
 * boot({ page }): the one call every page makes first.
 *
 *   import { boot } from '../../shell/boot';
 *   import './page.css';
 *   const shell = boot({ page: 'clock' });
 *   shell.regime.subscribe((s) => …);
 *   await shell.ready;            // fonts ready + incoming view transition finished
 *
 * Sets up: styles, masthead (mark, nav, regime chip), footer ledger, grain, favicon swap, the
 * regime store (read + poll, ink/paper flip as a 1.2 s view-transition crossfade), Lenis, and
 * line reveals for every [data-reveal] present at boot.
 */
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/type.css';
import '../styles/grid.css';
import '../styles/ui.css';
import '../styles/transitions.css';

import type Lenis from 'lenis';
import { flags, withFlags, type Flags } from './flags';
import { setFavicon } from './favicon';
import { ensureGrain } from './grain';
import { mountFooterLedger } from './footer-ledger';
import { mountMasthead, type Masthead } from './masthead';
import type { PageId } from './markup';
import { mountRegimeChip } from './regime-chip';
import {
  getRegimeState,
  refreshRegime,
  setPreview,
  setRegimeSource,
  startRegime,
  subscribeRegime,
  type RegimeSource,
  type RegimeState,
  type SiteRegime,
} from './regime';
import { whenFontsReady } from '../motion/fonts';
import { isTouch, prefersReducedMotion } from '../motion/reduced';
import { nativeScrollTo, type ScrollToOptions } from '../motion/scroll';

export type { PageId } from './markup';
export type { Flags } from './flags';
export type { RegimeReading, RegimeSource, RegimeState, SiteRegime } from './regime';
export { flags, withFlags };

export interface BootOptions {
  page: PageId;
  /** Override the regime source (default: lane B's data/regime.ts, else a 'shut' fallback). */
  getRegime?: RegimeSource;
  /** Reveal every [data-reveal] in <main> once ready (default true). */
  autoReveal?: boolean;
  /** Start Lenis smooth scroll (default true; always off for reduced motion and touch). */
  smoothScroll?: boolean;
}

export interface ShellRegime {
  get(): RegimeState;
  /** Called immediately with the current state unless `immediate` is false. Returns unsubscribe. */
  subscribe(fn: (state: RegimeState, prev: RegimeState) => void, immediate?: boolean): () => void;
  refresh(): Promise<RegimeState>;
  setPreview(on: boolean): void;
}

export interface Shell {
  page: PageId;
  flags: Flags;
  main: HTMLElement;
  masthead: Masthead;
  regime: ShellRegime;
  /** Lenis instance once loaded, or null under native scroll (reduced motion / touch / disabled / not yet loaded). */
  readonly lenis: Lenis | null;
  /** Resolves with the Lenis instance (or null) once motion/lenis.ts has loaded; GSAP + ScrollTrigger are wired. */
  whenLenis: Promise<Lenis | null>;
  /** Fonts ready and the incoming cross-document view transition (if any) finished. */
  ready: Promise<void>;
  /** Scroll with Lenis when active, natively otherwise. */
  scrollTo(target: number | string | HTMLElement, opts?: ScrollToOptions): void;
}

interface RevealRecord {
  at: number;
  vt: ViewTransition | null;
}

declare global {
  interface Window {
    __curbReveal?: RevealRecord;
    __curb?: Shell;
  }
}

function settle(vt: ViewTransition | null | undefined): Promise<void> {
  return vt ? vt.finished.then(
      () => undefined,
      () => undefined,
    ) : Promise.resolve();
}

/** Resolves when the incoming cross-document view transition has finished (or there is none). */
function incomingTransitionDone(): Promise<void> {
  if (window.__curbReveal) return settle(window.__curbReveal.vt);
  const active = (document as Document & { activeViewTransition?: ViewTransition | null }).activeViewTransition;
  if (active) return settle(active);
  if (!('onpagereveal' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 1200);
    window.addEventListener(
      'pagereveal',
      (e) => {
        clearTimeout(t);
        void settle((e as Event & { viewTransition?: ViewTransition | null }).viewTransition).then(resolve);
      },
      { once: true },
    );
  });
}

let flipping = false;

/** Apply a regime to <html>; after first paint the change is a 1.2 s view-transition crossfade. */
function applyRegime(next: SiteRegime, animate: boolean): void {
  const html = document.documentElement;
  if (html.getAttribute('data-regime') === next) {
    setFavicon(next);
    return;
  }
  const update = () => {
    html.setAttribute('data-regime', next);
    setFavicon(next);
  };
  if (!animate || flipping || prefersReducedMotion() || document.hidden || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  flipping = true;
  html.classList.add('vt-regime');
  const vt = document.startViewTransition(update);
  void vt.finished.finally(() => {
    html.classList.remove('vt-regime');
    flipping = false;
  });
}

const ANNOUNCE: Record<SiteRegime, string> = {
  open: 'Hong Kong is open. The site has turned to paper.',
  shut: 'Hong Kong is shut. The site has turned to street ink.',
  unknown: 'The clock is stale: no recent attestation.',
};

let current: Shell | null = null;

export function boot(opts: BootOptions): Shell {
  if (current) return current;
  const { page } = opts;
  if (opts.getRegime) setRegimeSource(opts.getRegime);

  const masthead = mountMasthead(page);
  ensureGrain();
  mountRegimeChip();
  mountFooterLedger();

  const main = document.getElementById('main') ?? document.querySelector('main') ?? document.body;
  const transitionDone = incomingTransitionDone();
  const ready = Promise.all([whenFontsReady(), transitionDone]).then(() => undefined);

  // Regime → <html data-regime>, favicon, announcer. Flips wait for the incoming page transition.
  const announcer = document.querySelector<HTMLElement>('[data-shell="announcer"]');
  let transitionFinished = false;
  void transitionDone.then(() => {
    transitionFinished = true;
    applyRegime(getRegimeState().shown, true);
  });
  subscribeRegime((s, prev) => {
    if (transitionFinished) applyRegime(s.shown, s.shown !== prev.shown);
    else setFavicon(s.shown);
    if (prev.settled && prev.live !== s.live) {
      if (announcer) announcer.textContent = ANNOUNCE[s.live];
      masthead.stepArc();
    }
  });
  void startRegime();

  // Motion is loaded lazily so GSAP, ScrollTrigger, SplitText and Lenis stay out of the initial JS.
  let lenisMod: typeof import('../motion/lenis') | null = null;
  const wantLenis = opts.smoothScroll !== false && !prefersReducedMotion() && !isTouch();
  const whenLenis: Promise<Lenis | null> = wantLenis
    ? import('../motion/lenis').then(
        (m) => {
          lenisMod = m;
          return m.startLenis();
        },
        () => null,
      )
    : Promise.resolve(null);

  if (opts.autoReveal !== false) {
    const targets = main.querySelectorAll('[data-reveal]:not([data-revealed])');
    if (targets.length) {
      if (prefersReducedMotion()) targets.forEach((el) => el.setAttribute('data-revealed', ''));
      else {
        const mod = import('../motion/reveal');
        void Promise.all([mod, ready]).then(([m]) => m.revealLines(targets));
      }
    }
  }

  const shell: Shell = {
    page,
    flags,
    main,
    masthead,
    regime: {
      get: getRegimeState,
      subscribe: subscribeRegime,
      refresh: refreshRegime,
      setPreview,
    },
    get lenis() {
      return lenisMod?.getLenis() ?? null;
    },
    whenLenis,
    ready,
    scrollTo(target, o) {
      if (lenisMod) lenisMod.scrollToTarget(target, o);
      else nativeScrollTo(target, o);
    },
  };
  current = shell;
  if (flags.capture || flags.mock) window.__curb = shell;
  return shell;
}

/** The booted shell, if boot() has run. */
export function getShell(): Shell | null {
  return current;
}
