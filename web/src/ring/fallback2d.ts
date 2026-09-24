/**
 * Canvas2D Week Ring, for no WebGL / Save-Data / low memory / reduced motion. Same 2,016 slots, same colours,
 * same handle as ring.ts, drawn face-on (the rest camera) so it registers exactly with the poster:
 *  - the poster (the rendered logo) is drawn into the canvas and wiped away in time order as a wedge,
 *  - blades grow in time order from Mon 00:00 HKT behind the wipe,
 *  - the needle extends at three o'clock.
 * Under reduced motion it draws the final state once and ignores setProgress.
 */
import {
  CAMERA,
  MARK,
  PAST_VALUE,
  SLOTS,
  UNROLL,
  captionAt,
  easeInOut,
  easeOut,
  isNarrow,
  readPalette,
  slotAngle,
  span,
  weekCaptions,
} from './layout';
import type { Caption, Palette, Regime, Rgb, WeekInput } from './layout';
import type { RingHandle } from './ring';

export interface Fallback2dOptions extends WeekInput {
  reducedMotion?: boolean;
  palette?: Palette;
  progress?: number;
  /** The poster <img>; drawn into the canvas so the wipe can remove it in time order. */
  poster?: HTMLImageElement | null;
}

export type Fallback2dHandle = Omit<RingHandle, 'debug'> & { debug: { frames(): number } };

const RISE = 96;
const EDGE = 36;
const TAU = Math.PI * 2;

export function createFallback2d(canvas: HTMLCanvasElement, opts: Fallback2dOptions): Fallback2dHandle {
  const reduced = !!opts.reducedMotion;
  let { slots, nowIndex, regime } = opts;
  let progress = reduced ? 1 : (opts.progress ?? 0);
  let palette = opts.palette ?? readPalette(canvas);
  let captions: Caption[] = weekCaptions(slots);
  const ctx = canvas.getContext('2d', { alpha: true })!;
  const poster = opts.poster ?? null;
  let posterOk = false;
  let raf = 0;
  let alive = true;
  let frames = 0;
  let pulseStart = -1;

  const css = (c: Rgb, k = 1, a = 1) =>
    `rgba(${Math.round(c[0] * k * 255)},${Math.round(c[1] * k * 255)},${Math.round(c[2] * k * 255)},${a})`;

  function draw() {
    raf = 0;
    if (!alive) return;
    const dpr = Math.min(devicePixelRatio || 1, isNarrow() ? 1.5 : 1.75);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const cx = w / 2;
    const cy = h / 2;
    const unit = h / 2 / (CAMERA.rest[2] * Math.tan((CAMERA.fov * Math.PI) / 360)); // px per world unit at z = 0
    ctx.clearRect(0, 0, w, h);

    const p = progress;
    const sweep = -EDGE + easeInOut(span(p, UNROLL.sweep)) * (SLOTS + 2 * EDGE + RISE);
    const toCanvas = (theta: number) => -theta; // world CCW → canvas (y down)

    // 1 · the logo, wiped away in time order (unswept slots are [sweep, 2016)).
    const remaining = Math.max(0, SLOTS - Math.max(0, sweep));
    if (remaining > 0) {
      ctx.save();
      if (remaining < SLOTS) {
        const a0 = toCanvas(slotAngle(Math.max(0, sweep), nowIndex));
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, 2 * unit, a0, a0 + (remaining / SLOTS) * TAU, false);
        ctx.closePath();
        ctx.clip();
      }
      if (posterOk && poster) ctx.drawImage(poster, 0, 0, w, h);
      else drawFlatMark(cx, cy, unit);
      ctx.restore();
    }

    // 2 · blades, grouped into one path per colour.
    const k = captionAt(p);
    const focus = k >= 0 ? captions[k]?.focus : undefined;
    const [c0, c1] = UNROLL.captions;
    let amt = 0;
    if (focus) {
      const wdt = (c1 - c0) / 4;
      const t = (p - (c0 + k * wdt)) / wdt;
      const out = k === 3 ? 1 - span(p, [UNROLL.needle[0], UNROLL.needle[0] + 0.1]) : Math.min(1, (1 - t) / 0.18);
      amt = Math.max(0, Math.min(Math.min(1, t / 0.22), out));
    }
    // Anti-moiré, as in the WebGL blades: while a blade pitch is under ~4 device px the 0.0005 hairline between
    // blades can only alias, so fully risen runs of one colour are filled as a single annular sector and rising
    // blades are stroked a full pitch wide. From 4 px up, every blade is its own 0.0026-wide stroke.
    const [bw, bl] = MARK.blade;
    const pitch = TAU / SLOTS;
    const fine = pitch * unit < 4;
    const fills = new Map<string, Path2D>();
    const strokes = new Map<string, Path2D>();
    const pathFor = (m: Map<string, Path2D>, key: string) => {
      let path = m.get(key);
      if (!path) m.set(key, (path = new Path2D()));
      return path;
    };
    const rIn = (MARK.bladeRadius - bl / 2) * unit;
    const rOut = (MARK.bladeRadius + bl / 2) * unit;
    let runStart = -1;
    let runKey = '';
    const flush = (end: number) => {
      if (runStart < 0) return;
      const a0 = toCanvas(slotAngle(runStart, nowIndex)) - pitch / 2;
      const a1 = toCanvas(slotAngle(end - 1, nowIndex)) + pitch / 2;
      const path = pathFor(fills, runKey);
      path.moveTo(cx + Math.cos(a0) * rOut, cy + Math.sin(a0) * rOut);
      path.arc(cx, cy, rOut, a0, a1, false);
      path.arc(cx, cy, rIn, a1, a0, true);
      path.closePath();
      runStart = -1;
    };
    let i = 0;
    for (; i < SLOTS; i++) {
      const r = Math.min(1, Math.max(0, (sweep - i) / RISE));
      if (r <= 0) break;
      const rise = 1 - (1 - r) ** 3;
      const shut = slots[i] === 1;
      let inFocus = 1;
      if (focus === 'shut') inFocus = shut ? 1 : 0;
      else if (focus) inFocus = (i - focus[0] + SLOTS) % SLOTS < focus[1] ? 1 : 0;
      const dim = (i < nowIndex ? PAST_VALUE : 1) * (1 - 0.72 * amt * (1 - inFocus));
      const key = `${shut ? 'a' : 'i'}${dim.toFixed(3)}`;
      if (fine && r >= 1) {
        if (key !== runKey || runStart < 0) {
          flush(i);
          runStart = i;
          runKey = key;
        }
        continue;
      }
      flush(i);
      const th = toCanvas(slotAngle(i, nowIndex));
      const r0 = (MARK.bladeRadius - (bl / 2) * rise) * unit;
      const r1 = (MARK.bladeRadius + (bl / 2) * rise) * unit;
      const path = pathFor(strokes, key);
      path.moveTo(cx + Math.cos(th) * r0, cy + Math.sin(th) * r0);
      path.lineTo(cx + Math.cos(th) * r1, cy + Math.sin(th) * r1);
    }
    flush(i);
    const colour = (key: string) => css(key[0] === 'a' ? palette.amber : palette.ivory, Number(key.slice(1)));
    for (const [key, path] of fills) {
      ctx.fillStyle = colour(key);
      ctx.fill(path);
    }
    ctx.lineWidth = fine ? pitch * unit : Math.max(0.75, bw * unit);
    ctx.lineCap = 'butt';
    for (const [key, path] of strokes) {
      ctx.strokeStyle = colour(key);
      ctx.stroke(path);
    }

    // 3 · the needle at three o'clock.
    const n = easeOut(span(p, UNROLL.needle));
    if (n > 0.001) {
      const N = MARK.needle;
      const col = regime === 'open' ? palette.ivory : regime === 'unknown' ? palette.slate : palette.amber;
      const bump = pulseStart >= 0 ? Math.sin(Math.PI * Math.min(1, (performance.now() - pulseStart) / 1100)) : 0;
      ctx.save();
      ctx.strokeStyle = css(col);
      ctx.lineWidth = Math.max(1, N.width * unit * (1 + bump));
      if (bump > 0) {
        ctx.shadowColor = css(col, 1, 0.8);
        ctx.shadowBlur = 18 * bump * dpr;
      }
      ctx.beginPath();
      ctx.moveTo(cx + N.inner * unit, cy);
      ctx.lineTo(cx + (N.inner + (N.outer - N.inner) * n) * unit, cy);
      ctx.stroke();
      ctx.restore();
    }
    frames++;
    if (pulseStart >= 0) {
      if (performance.now() - pulseStart >= 1100) pulseStart = -1;
      else raf = requestAnimationFrame(draw);
    }
  }

  function drawFlatMark(cx: number, cy: number, unit: number) {
    const ring = (radius: number, tube: number, fromDeg: number, arcDeg: number, col: Rgb) => {
      ctx.beginPath();
      const a0 = (-fromDeg * Math.PI) / 180;
      const a1 = (-(fromDeg + arcDeg) * Math.PI) / 180;
      ctx.arc(cx, cy, (radius + tube) * unit, a0, a1, true);
      ctx.arc(cx, cy, (radius - tube) * unit, a1, a0, false);
      ctx.closePath();
      ctx.fillStyle = css(col);
      ctx.fill();
    };
    const half = (360 - MARK.bandArcDeg) / 2;
    ring(MARK.bandRadius, MARK.bandTube, half, MARK.bandArcDeg, palette.ivory);
    ring(MARK.arcRadius, MARK.arcTube, -MARK.arcSpanDeg / 2, MARK.arcSpanDeg, palette.amber);
  }

  const invalidate = () => {
    if (!raf && alive) raf = requestAnimationFrame(draw);
  };
  const ro = new ResizeObserver(invalidate);
  ro.observe(canvas);

  const ready = (async () => {
    if (poster) {
      try {
        if (!poster.complete) await poster.decode();
        posterOk = poster.naturalWidth > 0;
      } catch {
        posterOk = false;
      }
    }
    draw();
  })();

  return {
    ready,
    thresholds: UNROLL,
    setProgress(p) {
      if (reduced) return;
      const q = Math.min(1, Math.max(0, p));
      if (q === progress) return;
      progress = q;
      invalidate();
    },
    setSlots(next, now, r) {
      slots = next;
      nowIndex = now;
      if (r) regime = r;
      captions = weekCaptions(slots);
      invalidate();
    },
    setRegime(r) {
      regime = r;
      invalidate();
    },
    setPalette(p) {
      palette = p ?? readPalette(canvas);
      invalidate();
    },
    pulse() {
      if (reduced) return;
      pulseStart = performance.now();
      invalidate();
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
    debug: { frames: () => frames },
  };
}
