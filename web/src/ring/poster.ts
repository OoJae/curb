/**
 * The poster, and progressive enhancement over it.
 *
 * The poster is the ring at rest (the logo), rendered from the lab at the canvas's exact framing and aspect (1:1),
 * so the first WebGL frame registers with it pixel for pixel and the swap is invisible. It is the LCP-safe paint:
 * the canvas and three.js arrive later, lazily, or never.
 *
 *   <figure class="ring" style="aspect-ratio: 1">
 *     ${posterMarkup()}                      ← <img> first, so it paints before any JS
 *     <canvas aria-hidden="true"></canvas>
 *   </figure>
 *   const ring = mountWeekRing(figure, { slots, nowIndex, regime, reducedMotion });
 *   ring.setProgress(p) ...                  ← safe immediately; buffered until the renderer is up
 */
import { UNROLL } from './layout';
import type { Palette, Regime, WeekInput } from './layout';
import type { RingHandle } from './ring';

export const POSTER_SRC = '/posters/ring-logo.avif';
/** Intrinsic size of the poster; the canvas is square, so any square size registers. */
export const POSTER_SIZE = 1600;

export function posterMarkup(className = 'ring-poster'): string {
  return `<img class="${className}" src="${POSTER_SRC}" width="${POSTER_SIZE}" height="${POSTER_SIZE}" alt="" aria-hidden="true" decoding="async" fetchpriority="high">`;
}

export type RendererKind = 'webgl' | '2d';

/** WebGL2 unless the device asks us not to spend: Save-Data, ≤2 GB memory, reduced motion, or no WebGL2. */
export function chooseRenderer(reducedMotion: boolean): RendererKind {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (reducedMotion) return '2d';
  if (nav.connection?.saveData) return '2d';
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2) return '2d';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) return '2d';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    return '2d';
  }
  return 'webgl';
}

export interface MountOptions extends WeekInput {
  reducedMotion: boolean;
  palette?: Palette;
  /** Force a renderer (lab, `?ring=2d`). */
  renderer?: RendererKind;
  /** Called once the live canvas has replaced the poster. */
  onLive?(kind: RendererKind): void;
}

export interface MountedRing {
  readonly kind: RendererKind;
  readonly thresholds: typeof UNROLL;
  /** Resolves when the canvas is live (or rejects if WebGL failed and the 2D fallback took over — never). */
  readonly live: Promise<void>;
  setProgress(p: number): void;
  setSlots(slots: Uint8Array, nowIndex: number, regime?: Regime): void;
  setRegime(r: Regime): void;
  setPalette(p?: Palette): void;
  pulse(): void;
  dispose(): void;
}

type Inner = Pick<RingHandle, 'setProgress' | 'setSlots' | 'setRegime' | 'setPalette' | 'pulse' | 'dispose' | 'ready'>;

export function mountWeekRing(figure: HTMLElement, opts: MountOptions): MountedRing {
  const canvas = figure.querySelector('canvas') ?? figure.appendChild(document.createElement('canvas'));
  canvas.setAttribute('aria-hidden', 'true');
  const img = figure.querySelector<HTMLImageElement>('img');
  const kind = opts.renderer ?? chooseRenderer(opts.reducedMotion);
  let inner: Inner | null = null;
  let disposed = false;
  let progress = 0;
  let week: [Uint8Array, number, Regime] = [opts.slots, opts.nowIndex, opts.regime];
  let pulses = 0;

  const start2d = async () => {
    const { createFallback2d } = await import('./fallback2d');
    return createFallback2d(canvas, { ...opts, slots: week[0], nowIndex: week[1], regime: week[2], progress, poster: img });
  };
  const startGl = async (): Promise<Inner> => {
    const { createRing } = await import('./ring');
    return createRing(canvas, { ...opts, slots: week[0], nowIndex: week[1], regime: week[2], progress });
  };

  const live = (async () => {
    let h: Inner;
    try {
      h = kind === 'webgl' ? await startGl() : await start2d();
      await h.ready;
    } catch {
      h = await start2d();
      await h.ready;
    }
    if (disposed) return h.dispose();
    inner = h;
    h.setProgress(progress);
    for (; pulses > 0; pulses--) h.pulse();
    figure.dataset.ring = kind;
    figure.classList.add('is-live'); // CSS fades the poster out; the canvas already shows the same frame
    opts.onLive?.(kind);
  })();

  return {
    kind,
    thresholds: UNROLL,
    live,
    setProgress(p) {
      progress = p;
      inner?.setProgress(p);
    },
    setSlots(s, n, r) {
      week = [s, n, r ?? week[2]];
      inner?.setSlots(s, n, r);
    },
    setRegime(r) {
      week[2] = r;
      inner?.setRegime(r);
    },
    setPalette(p) {
      inner?.setPalette(p);
    },
    pulse() {
      if (inner) inner.pulse();
      else pulses = 1;
    },
    dispose() {
      disposed = true;
      inner?.dispose();
    },
  };
}
