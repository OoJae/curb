// Home page in the lab: desktop at several points of the pinned unroll, the sections below, 375 px, reduced motion.
// Also reports CLS and console errors. Usage: node scripts/home-shots.mjs [--fixture] [--regime=open]
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB, launch } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'shots');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const qs = new URLSearchParams();
if (args.includes('--fixture')) qs.set('fixture', '1');
const reg = args.find((a) => a.startsWith('--regime='))?.slice(9);
if (reg) qs.set('regime', reg);
const tag = reg ? `-${reg}` : '';

const browser = await launch();
const errors = [];
async function open(opts, extra = '') {
  const page = await browser.newPage(opts);
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(`${LAB}/home.html?${qs}${extra}`);
  await page.waitForFunction(() => document.querySelector('.hm-ring.is-live'), null, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const settle = (page, ms = 1400) => page.waitForTimeout(ms);

// Desktop, pinned.
const d = await open({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const pinPx = await d.evaluate(() => document.querySelector('.hm-unroll').offsetHeight - innerHeight);
for (const p of [0, 0.4, 0.7, 1]) {
  await d.evaluate((y) => window.scrollTo(0, y), Math.round(p * pinPx));
  await settle(d);
  await d.screenshot({ path: join(out, `home${tag}-desktop-p${String(p * 100).padStart(3, '0')}.png`) });
}
for (const sel of ['.hm-cut', '.hm-record', '.hm-agents']) {
  await d.evaluate((s) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + scrollY - 64), sel);
  await settle(d, 900);
  if (sel === '.hm-agents') {
    await d.click('[data-ask]');
    await d.waitForFunction(() => /Live at|did not answer/.test(document.querySelector('[data-term="note"]').textContent), null, { timeout: 15_000 }).catch(() => {});
  }
  await d.screenshot({ path: join(out, `home${tag}-desktop${sel.replace('.hm', '')}.png`) });
}
console.log('desktop CLS', await d.evaluate(() => window.__cls.toFixed(4)));

// 375 px: no pin, the unroll plays once on a timer when the ring is 40% in view.
const m = await open({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await m.screenshot({ path: join(out, `home${tag}-375-top.png`) });
await m.evaluate(() => window.scrollTo(0, 180));
await settle(m, 6500);
await m.screenshot({ path: join(out, `home${tag}-375-after-timer.png`) });
console.log('375 CLS', await m.evaluate(() => window.__cls.toFixed(4)), 'scrollWidth', await m.evaluate(() => document.documentElement.scrollWidth));

// Reduced motion, desktop.
const r = await open({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
await settle(r, 600);
await r.screenshot({ path: join(out, `home${tag}-reduced.png`) });
console.log('reduced ring renderer', await r.evaluate(() => document.querySelector('.hm-ring').dataset.ring));

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
