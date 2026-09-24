// usage: node cls.mjs <url> [width]  → prints every layout shift with its sources
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
const root = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(root, 'noop.js'))('@playwright/test');
const [url, w = '1440'] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: +w, height: 900 } });
await ctx.addInitScript(() => {
  window.__shifts = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__shifts.push({
        t: Math.round(e.startTime), v: +e.value.toFixed(4), input: e.hadRecentInput,
        src: (e.sources || []).map((s) => {
          const n = s.node;
          const d = n && n.nodeType === 1 ? `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}.${String(n.className).split(' ').slice(0, 2).join('.')}` : n ? n.nodeName : '?';
          return `${d} ${JSON.stringify(s.previousRect)}→${JSON.stringify(s.currentRect)}`;
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const s = await page.evaluate(() => window.__shifts);
for (const x of s) console.log(x.t, x.v, x.input, '\n   ' + x.src.join('\n   '));
await browser.close();
