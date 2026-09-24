/**
 * Lab driver. URL params:
 *   ?p=0.5            initial progress
 *   ?now=1260         slot index for "now" (default: the real HK now)
 *   ?regime=open      open | shut | unknown
 *   ?mode=2d          force the Canvas2D fallback
 *   ?reduced=1        reducedMotion (final state once)
 *   ?capture=1&size=1600   bare canvas at a fixed CSS size, transparent page (poster/screenshot capture)
 * window.__lab exposes the handle for Playwright.
 */
import { UNROLL, captionAt, stubWeek, weekCaptions } from '../../src/ring/layout';
import type { Regime } from '../../src/ring/layout';
import { createFallback2d } from '../../src/ring/fallback2d';
import type { RingHandle } from '../../src/ring/ring';

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('ring');
const fig = $('fig');

if (q.has('capture')) {
  document.body.classList.add('capture');
  document.documentElement.style.setProperty('--capture-size', `${Number(q.get('size') ?? 1600)}px`);
}

const week = stubWeek();
if (q.has('now')) week.nowIndex = Number(q.get('now'));
const regime = (q.get('regime') as Regime) ?? (week.slots[week.nowIndex] ? 'shut' : 'open');
const reducedMotion = q.has('reduced');
const captions = weekCaptions(week.slots);

type Handle = Pick<RingHandle, 'setProgress' | 'setSlots' | 'setRegime' | 'pulse' | 'dispose' | 'ready'> & {
  debug: { frames(): number; renderer?: RingHandle['debug']['renderer']; renderNow?(): void };
};
let ring: Handle;
const t0 = performance.now();
if (q.get('mode') === '2d') {
  ring = createFallback2d(canvas, { slots: week.slots, nowIndex: week.nowIndex, regime, reducedMotion, poster: fig.querySelector('img') });
} else {
  const { createRing } = await import('../../src/ring/ring');
  ring = createRing(canvas, { slots: week.slots, nowIndex: week.nowIndex, regime, reducedMotion });
}
await ring.ready;
const readyMs = performance.now() - t0;
fig.classList.add('live');

const p0 = Number(q.get('p') ?? 0);
const slider = $<HTMLInputElement>('p');
const nowSlider = $<HTMLInputElement>('now');
const regimeSel = $<HTMLSelectElement>('regime');
nowSlider.value = String(week.nowIndex);
regimeSel.value = regime;

function setP(p: number) {
  ring.setProgress(p);
  slider.value = String(p);
  $('pv').textContent = p.toFixed(3);
  const k = captionAt(p);
  $('caption').textContent = k >= 0 && captions[k] ? captions[k].text : '';
  info();
}
function info() {
  const r = ring.debug?.renderer;
  const gl = r?.getContext();
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  $('info').textContent = [
    `ready in ${readyMs.toFixed(0)} ms`,
    r ? `draw calls ${r.info.render.calls} · tris ${r.info.render.triangles}` : 'Canvas2D fallback',
    r ? `dpr ${r.getPixelRatio()} · ${canvas.width}×${canvas.height}` : `${canvas.width}×${canvas.height}`,
    gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '',
    `frames ${ring.debug?.frames() ?? '-'}`,
    `now ${week.nowIndex} · ${regime}`,
    `thresholds ${JSON.stringify(UNROLL)}`,
  ].join('\n');
}
slider.addEventListener('input', () => setP(Number(slider.value)));
nowSlider.addEventListener('input', () => {
  week.nowIndex = Number(nowSlider.value);
  $('nv').textContent = nowSlider.value;
  ring.setSlots(week.slots, week.nowIndex);
});
regimeSel.addEventListener('change', () => ring.setRegime(regimeSel.value as Regime));
$('pulse').addEventListener('click', () => ring.pulse());
$('play').addEventListener('click', () => play(4500));

function play(ms: number): Promise<void> {
  return new Promise((done) => {
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setP(p);
      if (p < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
}

/** Read the rendered sRGB colour at canvas-relative (u, v) ∈ [0,1]², averaged over a (2k+1)² block. */
function probe(u: number, v: number, k = 2): number[] | null {
  const r = ring.debug.renderer;
  if (!r) return null;
  ring.debug.renderNow?.();
  const gl = r.getContext();
  const x = Math.round(u * canvas.width);
  const y = Math.round(v * canvas.height); // GL rows are bottom-up; v is bottom-up too
  const n = 2 * k + 1;
  const buf = new Uint8Array(n * n * 4);
  gl.readPixels(x - k, y - k, n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const acc = [0, 0, 0, 0];
  for (let i = 0; i < n * n; i++) for (let c = 0; c < 4; c++) acc[c] += buf[i * 4 + c];
  return acc.map((a) => a / (n * n));
}

/** Probe at a world-space point, projected with the ring's camera. */
function probeWorld(x: number, y: number, z: number, k = 1): number[] | null {
  const cam = (ring.debug as Partial<RingHandle['debug']>).camera;
  if (!cam) return null;
  const v = cam.position.clone().set(x, y, z).project(cam);
  return probe((v.x + 1) / 2, (v.y + 1) / 2, k);
}

setP(p0);
Object.assign(window, { __lab: { ring, setP, play, week, readyMs, captions, probe, probeWorld } });
document.documentElement.dataset.ready = '1';
