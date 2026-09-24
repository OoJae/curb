// Screenshots of the lab at several progress values → shots/ring-p{NNN}.png (+ a 2D-fallback set with --2d).
// Usage: node scripts/shots.mjs [0 0.4 1] [--2d] [--now=1260]
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB, launch, waitReady } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'shots');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const values = args.filter((a) => !a.startsWith('--')).map(Number);
const ps = values.length ? values : [0, 0.4, 1];
const two = args.includes('--2d');
const now = args.find((a) => a.startsWith('--now='))?.slice(6);
const clipArg = args.find((a) => a.startsWith('--clip='))?.slice(7);
const clip = clipArg ? Object.fromEntries(clipArg.split(',').map(Number).map((v, i) => [['x', 'y', 'width', 'height'][i], v])) : undefined;
const tag = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? '';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
page.on('pageerror', (e) => console.error('pageerror:', e.message));
const qs = new URLSearchParams();
if (two) qs.set('mode', '2d');
if (now) qs.set('now', now);
await page.goto(`${LAB}/?${qs}`);
await waitReady(page);
const renderer = await page.evaluate(() => document.getElementById('info')?.textContent);
console.log(renderer);
for (const p of ps) {
  await page.evaluate((p) => window.__lab.setP(p), p);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const file = join(out, `ring${two ? '-2d' : ''}${tag}-p${String(Math.round(p * 100)).padStart(3, '0')}.png`);
  await page.screenshot({ path: file, clip });
  console.log('wrote', file);
}
await browser.close();
