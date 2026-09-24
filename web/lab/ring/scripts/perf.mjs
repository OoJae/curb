// FPS of the unroll on this machine's GPU. Drives setProgress 0→1 every rAF for DURATION ms (twice: warm-up, then
// measured), records a Chromium performance trace, and reports rAF cadence, JS cost per frame and long frames.
// Usage: node scripts/perf.mjs [--headed] [--ms=4500] [--mobile]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB, launch, waitReady } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const mobile = args.includes('--mobile');
const ms = Number(args.find((a) => a.startsWith('--ms='))?.slice(5) ?? 4500);

const browser = await launch({ headless: !headed });
const context = await browser.newContext(
  mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
);
const page = await context.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${LAB}/?now=1120`);
await waitReady(page);

const run = () =>
  page.evaluate(async (ms) => {
    const ring = window.__lab.ring;
    const times = [];
    const js = [];
    const f0 = ring.debug.frames();
    await new Promise((done) => {
      let start = 0;
      const tick = (t) => {
        if (!start) start = t;
        const p = Math.min(1, (t - start) / ms);
        const a = performance.now();
        ring.setProgress(p);
        ring.debug.renderNow(); // count the render inside the frame's JS cost
        js.push(performance.now() - a);
        times.push(t);
        if (p < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const dts = times.slice(1).map((t, i) => t - times[i]);
    const sorted = [...dts].sort((a, b) => a - b);
    const q = (x) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
    const jsSorted = [...js].sort((a, b) => a - b);
    const gl = ring.debug.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?',
      canvas: `${gl.drawingBufferWidth}×${gl.drawingBufferHeight}`,
      frames: dts.length,
      fps: (1000 * dts.length) / (times.at(-1) - times[0]),
      medianMs: q(0.5),
      p95Ms: q(0.95),
      p99Ms: q(0.99),
      over20ms: dts.filter((d) => d > 20).length,
      jsMedianMs: jsSorted[jsSorted.length >> 1],
      jsP95Ms: jsSorted[Math.floor(0.95 * jsSorted.length)],
      renders: ring.debug.frames() - f0,
      drawCalls: ring.debug.renderer.info.render.calls,
    };
  }, ms);

await run(); // warm-up (shader programs, PMREM)
await browser.startTracing(page, { path: join(here, '..', `trace-unroll${mobile ? '-mobile' : ''}.json`), screenshots: false, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'gpu', 'viz'] });
const r = await run();
await browser.stopTracing();
console.log(JSON.stringify({ mode: headed ? 'headed' : 'headless', viewport: mobile ? '390×844@3' : '1440×900@2', ...r }, null, 2));
await browser.close();
