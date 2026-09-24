// Lane E review: /notes and /depth at 375/768/1440 × shut/open (+ reduced motion, + ?mock=1).
// Run it against `vite build && vite preview` (dev mode injects CSS late, which reads as a layout shift).
// usage: AXE=/path/to/axe.min.js node review.mjs <baseUrl> <outDir> [pages=notes,depth] [--quick]
// Companions: wallet-test.mjs (mocked EIP-6963 wallet + mocked RPC: confirmed / reverted / Refusal),
// live-test.mjs + mockchain.mjs (the pages in live mode against a mock chain), keys.mjs, cls.mjs.
// wallet-test and live-test need the W3/W4 addresses set to 0x…a1–a6 in a local, uncommitted edit.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const root = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(root, 'noop.js'))('@playwright/test');
const [base, outDir, pagesArg = 'notes,depth', flag] = process.argv.slice(2);
const AXE = readFileSync(process.env.AXE ?? new URL('./axe.min.js', import.meta.url), 'utf8');
mkdirSync(outDir, { recursive: true });
const pages = pagesArg.split(',');
const widths = flag === '--quick' ? [1440] : [375, 768, 1440];
const combos = [];
for (const p of pages) {
  for (const w of widths) for (const regime of ['shut', 'open']) combos.push({ p, w, regime, rm: false, mock: false });
  combos.push({ p, w: 390, regime: 'shut', rm: true, mock: false });
  combos.push({ p, w: 1440, regime: 'shut', rm: false, mock: true });
}
const browser = await chromium.launch();
const results = [];
for (const c of combos) {
  const ctx = await browser.newContext({ viewport: { width: c.w, height: c.w < 500 ? 844 : 900 }, reducedMotion: c.rm ? 'reduce' : 'no-preference' });
  await ctx.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const q = new URLSearchParams({ regime: c.regime });
  if (c.mock) q.set('mock', '1');
  await page.goto(`${base}/${c.p}?${q}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const cls = await page.evaluate(() => window.__cls);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  const name = `${c.p}-${c.w}-${c.regime}${c.rm ? '-reduced' : ''}${c.mock ? '-mock' : ''}.jpg`;
  await page.screenshot({ path: join(outDir, name), fullPage: true, type: 'jpeg', quality: 72 });
  results.push({ ...c, name, cls: Number(cls.toFixed(4)), overflow, errors, axe });
  console.log(`${name}  cls=${cls.toFixed(4)} overflowX=${overflow} errors=${errors.length} axe=${axe.map((a) => `${a.id}(${a.n})`).join(',') || 'none'}`);
  for (const e of errors) console.log(`   err: ${e.slice(0, 200)}`);
  for (const a of axe) console.log(`   axe ${a.id}: ${a.target.join(' | ')}`);
  await ctx.close();
}
writeFileSync(join(outDir, 'lane-e-review.json'), JSON.stringify(results, null, 2));
await browser.close();
