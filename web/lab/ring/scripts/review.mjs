// Review matrix for / against a running build (npm run build && npx vite preview --port 4173 in web/):
// 375 / 768 / 1440 × ?regime=shut|open, reduced motion, ?mock=1. Per page: console errors, page errors, CLS;
// at 1440 the pinned unroll is scrolled through while rAF cadence is measured. PNGs → web/review/home-*.png.
// Usage: node scripts/review.mjs [--base=http://localhost:4173]
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../review');
mkdirSync(out, { recursive: true });
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://localhost:4173';
const VIEW = {
  375: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  768: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2 },
  1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
};

const browser = await launch();
const results = [];

async function open(width, qs, extra = {}) {
  const ctx = await browser.newContext({ ...VIEW[width], ...extra });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(`${BASE}/?${qs}`, { waitUntil: 'load' });
  await page.waitForSelector('.hm-ring.is-live', { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}
const shot = (page, name) => page.screenshot({ path: join(out, `home-${name}.png`), scale: 'css' });
const pinPx = (page) => page.evaluate(() => document.querySelector('.hm-unroll').offsetHeight - innerHeight);
async function scrollTo(page, y, settle = 1300) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(settle);
}
async function finish(label, { ctx, page, errors }, extra = {}) {
  const cls = await page.evaluate(() => window.__cls);
  const ring = await page.evaluate(() => document.querySelector('.hm-ring')?.dataset.ring ?? 'poster');
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  results.push({ label, ring, cls: +cls.toFixed(4), hScroll: scrollW, errors: errors.length, ...extra });
  if (errors.length) console.log(`  ${label} errors:\n    ${errors.join('\n    ')}`);
  await ctx.close();
}

// 1440 × shut: top, the pin (fps while scrolling it), the finished unroll, the record.
{
  const s = await open(1440, 'regime=shut');
  await shot(s.page, '1440-shut-top');
  const pin = await pinPx(s.page);
  const fps = await s.page.evaluate(async (pin) => {
    const times = [];
    await new Promise((done) => {
      let t0 = 0;
      const tick = (t) => {
        if (!t0) t0 = t;
        const k = Math.min(1, (t - t0) / 5000);
        window.scrollTo(0, k * pin);
        times.push(t);
        if (k < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const d = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    return { fps: +((1000 * d.length) / (times.at(-1) - times[0])).toFixed(1), p95: d[Math.floor(0.95 * d.length)], over20: d.filter((x) => x > 20).length };
  }, pin);
  await scrollTo(s.page, Math.round(0.4 * pin));
  await shot(s.page, '1440-shut-unroll-40');
  await scrollTo(s.page, Math.round(0.72 * pin));
  await shot(s.page, '1440-shut-unroll-72');
  await scrollTo(s.page, pin);
  await shot(s.page, '1440-shut-unroll-100');
  await s.page.evaluate(() => document.querySelector('.hm-record').scrollIntoView());
  await s.page.waitForTimeout(1500);
  await shot(s.page, '1440-shut-record');
  await finish('1440 shut', s, { scrollFps: fps });
}
// 1440 × open (paper hours: the ring in its ink window).
{
  const s = await open(1440, 'regime=open');
  await shot(s.page, '1440-open-top');
  await scrollTo(s.page, await pinPx(s.page));
  await shot(s.page, '1440-open-unroll-100');
  await finish('1440 open', s);
}
// 768 × shut / open.
for (const r of ['shut', 'open']) {
  const s = await open(768, `regime=${r}`);
  await shot(s.page, `768-${r}-top`);
  await scrollTo(s.page, await pinPx(s.page));
  await shot(s.page, `768-${r}-unroll-100`);
  await finish(`768 ${r}`, s);
}
// 375 × shut / open: no pin; the unroll plays once on a timer at 40% in view.
for (const r of ['shut', 'open']) {
  const s = await open(375, `regime=${r}`);
  await shot(s.page, `375-${r}-top`);
  await scrollTo(s.page, 200, 6800);
  await shot(s.page, `375-${r}-after-timer`);
  await finish(`375 ${r}`, s);
}
// Reduced motion: final state, 2D ring, no three.js.
for (const w of [1440, 375]) {
  const s = await open(w, 'regime=shut', { reducedMotion: 'reduce' });
  const three = await s.page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/ring-[\w-]+\.js$/.test(e.name)));
  await shot(s.page, `${w}-reduced`);
  await finish(`${w} reduced`, s, { threeLoaded: three });
}
// ?mock=1: fixtures everywhere; press "Ask without paying".
{
  const s = await open(1440, 'mock=1');
  await s.page.evaluate(() => document.querySelector('.hm-agents').scrollIntoView());
  await s.page.waitForTimeout(800);
  await s.page.click('[data-ask]');
  await s.page.waitForFunction(() => /Fixture at|Live at|did not answer/.test(document.querySelector('[data-term="note"]').textContent), null, { timeout: 10_000 });
  await shot(s.page, '1440-mock-agents');
  await s.page.evaluate(() => document.querySelector('.hm-record').scrollIntoView());
  await s.page.waitForTimeout(800);
  await shot(s.page, '1440-mock-record');
  await finish('1440 mock', s);
}

console.table(results.map((r) => ({ ...r, scrollFps: r.scrollFps ? `${r.scrollFps.fps} fps, p95 ${r.scrollFps.p95} ms, >20ms ${r.scrollFps.over20}` : '' })));
await browser.close();
