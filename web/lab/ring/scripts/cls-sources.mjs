// Layout-shift entries with their sources for / at a given width (diagnostics for review.mjs).
// Usage: node scripts/cls-sources.mjs 768 [--reduced] [--base=http://localhost:4173]
import { launch } from './browser.mjs';

const width = Number(process.argv[2] ?? 768);
const reduced = process.argv.includes('--reduced');
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://localhost:4173';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 812 : width === 768 ? 1024 : 900 }, deviceScaleFactor: 2, reducedMotion: reduced ? 'reduce' : 'no-preference' });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__shifts = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__shifts.push({
        t: Math.round(e.startTime),
        v: +e.value.toFixed(4),
        src: (e.sources || []).map((s) => `${s.node?.className || s.node?.nodeName || '?'} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h ${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)} x ${Math.round(s.previousRect.x)}→${Math.round(s.currentRect.x)}`),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});
await page.goto(`${BASE}/?regime=shut`);
await page.waitForSelector('.hm-ring.is-live');
await page.waitForTimeout(2500);
console.log(JSON.stringify(await page.evaluate(() => window.__shifts), null, 1));
await browser.close();
