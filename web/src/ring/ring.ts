/**
 * The Week Ring. At rest it is the logo; unrolled it is the truth.
 *
 *   const { createRing } = await import('../ring/ring');   // three.js lives only in this lazy chunk
 *   const ring = createRing(canvas, { slots, nowIndex, regime, reducedMotion });
 *   await ring.ready;          // first frame is on the canvas: fade the poster out now
 *   ring.setProgress(0..1);    // the 250vh unroll (see UNROLL in layout.ts for the thresholds)
 *   ring.setSlots(slots, now); // every five minutes, or when lane B's schedule changes
 *   ring.pulse();              // an attestation landed
 *   ring.dispose();
 *
 * Renders on demand only (progress change, resize, pulse), pauses while off screen, ≤5 draw calls
 * (blades, band, arc, needle), no post-processing.
 */
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyDissolve, capsuleArc } from './cband';
import type { SweepUniforms } from './cband';
import { createBlades, layoutBlades } from './blades';
import type { BladeUniforms } from './blades';
import {
  CAMERA,
  MARK,
  SLOTS,
  UNROLL,
  captionAt,
  easeInOut,
  easeOut,
  isNarrow,
  readPalette,
  span,
  weekCaptions,
} from './layout';
import type { Caption, Palette, Regime, WeekInput } from './layout';

export interface RingOptions extends WeekInput {
  /** Render the final (unrolled) state once and ignore setProgress. */
  reducedMotion?: boolean;
  /** Colours; read from CSS custom properties on the canvas when omitted. */
  palette?: Palette;
  /** Starting progress (0 = the logo). */
  progress?: number;
}

export interface RingHandle {
  setProgress(p: number): void;
  setSlots(slots: Uint8Array, nowIndex: number, regime?: Regime): void;
  setRegime(regime: Regime): void;
  /** Re-read colours (e.g. after a theme flip). */
  setPalette(palette?: Palette): void;
  pulse(): void;
  dispose(): void;
  /** Resolves once the first frame is on the canvas. */
  readonly ready: Promise<void>;
  readonly thresholds: typeof UNROLL;
  /** Lab/diagnostics only. */
  readonly debug: { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; renderNow(): void; frames(): number };
}

const EDGE = 36; // crumbling front, in slots (≈6.4°)
/**
 * Streetlamp sits in NeutralToneMapping's compression range (linear R 0.91), so lit at the gain that renders ivory
 * true it would bleach toward peach. Amber surfaces take 0.75× albedo and less specular: rendered ≈ #F4A738 vs
 * #F5A524 (ivory stays ΔE2000 ≈ 1).
 */
const AMBER_GAIN = 0.75;
const RISE = 96; // slots over which each blade grows
const TILT = Math.atan2(-CAMERA.dial[1], CAMERA.dial[2]); // ≈ 39.3°
const DIST0 = Math.hypot(...CAMERA.rest);
const DIST1 = Math.hypot(...CAMERA.dial);

export function createRing(canvas: HTMLCanvasElement, opts: RingOptions): RingHandle {
  const reduced = !!opts.reducedMotion;
  let slots = opts.slots;
  let nowIndex = opts.nowIndex;
  let regime = opts.regime;
  let progress = reduced ? 1 : (opts.progress ?? 0);
  let palette = opts.palette ?? readPalette(canvas);
  let captions: Caption[] = weekCaptions(slots);

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  const coarse = isNarrow() || matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 1.75));

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.6;
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(-2.2, 3.4, 5.6);
  scene.add(key);

  const camera = new PerspectiveCamera(CAMERA.fov, 1, 0.1, 50);

  // ── meshes ──
  const sweep: SweepUniforms = { uSweep: { value: -EDGE }, uNow: { value: nowIndex }, uEdge: { value: EDGE } };
  const still: SweepUniforms = { uSweep: { value: -1e4 }, uNow: { value: 0 }, uEdge: { value: 0 } };
  const bladeU: BladeUniforms = {
    uSweep: sweep.uSweep,
    uRise: { value: RISE },
    uFocus: { value: [0, 0, 0] },
    uFocusAmt: { value: 0 },
    uPitchPx: { value: 1 },
  };

  const bandMat = new MeshPhysicalMaterial({ roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const amberCoat = { roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.1, specularIntensity: 0.3 };
  const arcMat = new MeshPhysicalMaterial({ ...amberCoat, emissiveIntensity: 0.03 });
  const needleMat = new MeshPhysicalMaterial({ ...amberCoat, emissiveIntensity: 0.25 });
  applyDissolve(bandMat, sweep);
  applyDissolve(arcMat, sweep);
  applyDissolve(needleMat, still); // same program, never dissolves

  const halfGap = (360 - MARK.bandArcDeg) / 2;
  const band = new Mesh(
    capsuleArc({
      radius: MARK.bandRadius,
      tube: MARK.bandTube,
      radialSegments: 32,
      tubularSegments: 320,
      startDeg: halfGap,
      arcDeg: MARK.bandArcDeg,
      flatten: MARK.bandFlatten,
    }),
    bandMat,
  );
  const arc = new Mesh(
    capsuleArc({
      radius: MARK.arcRadius,
      tube: MARK.arcTube,
      radialSegments: 20,
      tubularSegments: 128,
      startDeg: -MARK.arcSpanDeg / 2,
      arcDeg: MARK.arcSpanDeg,
      flatten: MARK.bandFlatten,
    }),
    arcMat,
  );
  const N = MARK.needle;
  const needleGeo = new BoxGeometry(N.outer - N.inner, N.width, N.depth);
  needleGeo.translate((N.outer - N.inner) / 2, 0, N.depth / 2); // grows outward from its inner end, up from the face
  const needle = new Mesh(needleGeo, needleMat);
  needle.position.x = N.inner;
  const blades = createBlades(bladeU);
  scene.add(blades, band, arc, needle);

  function applyPalette() {
    const col = (rgb: [number, number, number]) => new Color().setRGB(rgb[0], rgb[1], rgb[2], 'srgb');
    bandMat.color.copy(col(palette.ivory));
    arcMat.color.copy(col(palette.amber)).multiplyScalar(AMBER_GAIN);
    arcMat.emissive.copy(col(palette.amber));
    const n = regime === 'open' ? palette.ivory : regime === 'unknown' ? palette.slate : palette.amber;
    needleMat.color.copy(col(n)).multiplyScalar(regime === 'shut' ? AMBER_GAIN : 1);
    needleMat.emissive.copy(col(n));
    layoutBlades(blades, slots, nowIndex, palette, AMBER_GAIN);
  }
  applyPalette();

  // ── progress → scene ──
  let pulseT = -1;
  function applyProgress() {
    const p = progress;
    const lie = easeInOut(span(p, UNROLL.lieDown));
    const a = lie * TILT;
    const d = DIST0 + (DIST1 - DIST0) * lie;
    camera.position.set(0, -Math.sin(a) * d, Math.cos(a) * d);
    camera.lookAt(0, 0, 0);
    const pxPerUnit = (canvas.height || 1) / (2 * d * Math.tan((CAMERA.fov * Math.PI) / 360));
    bladeU.uPitchPx.value = ((2 * Math.PI) / SLOTS) * pxPerUnit;

    const s = easeInOut(span(p, UNROLL.sweep));
    sweep.uSweep.value = -EDGE + s * (SLOTS + 2 * EDGE + RISE);

    // Caption focus: each caption lights its slots, with a breath between captions; the last holds, then
    // lets go as the needle rises.
    const k = captionAt(p);
    const [c0, c1] = UNROLL.captions;
    let amt = 0;
    if (k >= 0 && captions[k]) {
      const f = captions[k].focus;
      bladeU.uFocus.value = f === 'shut' ? [0, 0, 2] : [f[0], f[1], 1];
      const w = (c1 - c0) / 4;
      const t = (p - (c0 + k * w)) / w;
      const inn = Math.min(1, t / 0.22);
      const out = k === 3 ? 1 - span(p, [UNROLL.needle[0], UNROLL.needle[0] + 0.1]) : Math.min(1, (1 - t) / 0.18);
      amt = Math.max(0, Math.min(inn, out));
    }
    bladeU.uFocusAmt.value = amt;

    const n = easeOut(span(p, UNROLL.needle));
    const bump = pulseT >= 0 ? Math.sin(Math.PI * pulseT) : 0;
    needle.visible = n > 0.001;
    needle.scale.set(n, 1, n * (1 + 0.6 * bump));
    needleMat.emissiveIntensity = 0.55 + 1.4 * bump;
  }
  applyProgress();

  // ── on-demand rendering ──
  let raf = 0;
  let dirty = true;
  let visible = true;
  let alive = true;
  let frames = 0;
  let pulseStart = 0;
  let firstFrame!: () => void;
  const ready = new Promise<void>((r) => (firstFrame = r));
  let compiled = false;

  function renderNow() {
    renderer.render(scene, camera);
    frames++;
    dirty = false;
  }
  function frame(t: number) {
    raf = 0;
    if (!alive || !compiled) return;
    if (pulseT >= 0) {
      pulseT = (t - pulseStart) / 1100;
      if (pulseT >= 1) pulseT = -1;
      applyProgress();
      dirty = true;
    }
    if (!visible) return;
    if (dirty) renderNow();
    if (pulseT >= 0) raf = requestAnimationFrame(frame);
  }
  function invalidate() {
    dirty = true;
    if (!raf && visible && alive) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyProgress();
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && dirty) invalidate();
  });
  io.observe(canvas);

  const onLost = (e: Event) => e.preventDefault();
  const onRestored = () => {
    envTex.dispose();
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    invalidate();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // Compile off the critical path (KHR_parallel_shader_compile where available), then paint once.
  renderer.compileAsync(scene, camera).then(() => {
    if (!alive) return;
    compiled = true;
    resize();
    renderNow();
    firstFrame();
  });

  return {
    ready,
    thresholds: UNROLL,
    setProgress(p: number) {
      if (reduced) return;
      const q = Math.min(1, Math.max(0, p));
      if (q === progress) return;
      progress = q;
      applyProgress();
      invalidate();
    },
    setSlots(next, now, r) {
      slots = next;
      nowIndex = now;
      if (r) regime = r;
      sweep.uNow.value = now;
      captions = weekCaptions(slots);
      applyPalette();
      applyProgress();
      invalidate();
    },
    setRegime(r) {
      if (r === regime) return;
      regime = r;
      applyPalette();
      invalidate();
    },
    setPalette(p) {
      palette = p ?? readPalette(canvas);
      applyPalette();
      invalidate();
    },
    pulse() {
      if (reduced || !alive) return;
      pulseStart = performance.now();
      pulseT = 0;
      invalidate();
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      for (const o of [blades, band, arc, needle]) o.geometry.dispose();
      for (const m of [blades.material as MeshPhysicalMaterial, bandMat, arcMat, needleMat]) m.dispose();
      blades.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
    debug: { renderer, scene, camera, renderNow, frames: () => frames },
  };
}
