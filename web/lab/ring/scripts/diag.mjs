// Layout diagnostics for the home hero: element rects at the top of the pin, and CLS entries with their sources.
import { LAB, launch } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  window.__shifts = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__shifts.push({
        t: Math.round(e.startTime),
        v: +e.value.toFixed(4),
        input: e.hadRecentInput,
        src: (e.sources || []).map((s) => `${s.node?.className || s.node?.nodeName || '?'} ${JSON.stringify(s.previousRect)}→${JSON.stringify(s.currentRect)}`),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});
await page.goto(`${LAB}/home.html`);
await page.waitForFunction(() => document.querySelector('.hm-ring.is-live'));
await page.waitForTimeout(2500);
const rects = await page.evaluate(() =>
  Object.fromEntries(
    ['.hm-stage', '.hm-copy', '.hm-ledger', '.hm-now', '.hm-ring', '.hm-title'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [s, [Math.round(r.top), Math.round(r.bottom), Math.round(r.height)]];
    }),
  ),
);
console.log(rects);
console.log(JSON.stringify(await page.evaluate(() => window.__shifts), null, 1));
await browser.close();
