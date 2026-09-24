// "Live" mode against the mock chain (addresses temporarily set to 0x…a1–a6): reads decode, pages render.
// usage: node live-test.mjs <baseUrl> <repo> <outDir> [lotStatus]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeChain } from './mockchain.mjs';
const root = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(root, 'noop.js'))('@playwright/test');
const [base, repo, outDir, lotStatus = '1'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const chain = await makeChain(repo, { lotStatus: Number(lotStatus) });
const browser = await chromium.launch();
for (const path of ['/notes', '/depth']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.route(/https:\/\/(rpc\.xlayer\.tech|xlayer\.drpc\.org).*/, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const out = Array.isArray(body) ? body.map(chain.answer) : chain.answer(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await ctx.route(/https:\/\/api\.curb\.markets.*/, (route) => route.fulfill({ status: 503, body: '{}' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  await page.goto(`${base}${path}?regime=shut`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(outDir, `live${path.replace('/', '-')}-1440${lotStatus === '2' ? '-sold' : ''}.png`), fullPage: true });
  const text = await page.evaluate((p) => {
    const q = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    return p === '/notes'
      ? { status: q('[data-nt-status]'), cert: q('.crt__face'), price: q('[data-nt-price]'), lotstatus: q('[data-nt-lotstatus]'), pointer: q('[data-nt-pointer]'), lots: q('[data-nt-lots]'), realised: q('[data-nt-realised]'), gate: q('[data-nt-gate]'), asset: q('[data-nt-asset-state]') }
      : { status: q('[data-dp-status]'), ltv: q('[data-dp-ltv-now]'), readout: q('[data-dp-readout]'), stats: q('[data-dp-stats]'), book: q('[data-dp-book]'), honoured: q('[data-dp-honoured]'), pos: q('[data-dp-position]'), cure: q('[data-dp-cure-state]'), legend: q('[data-dp-cure-legend]') };
  }, path);
  console.log(path, JSON.stringify(text, null, 1));
  console.log(path, 'errors:', errors.length ? errors.map((e) => e.slice(0, 200)).join('\n   ') : 'none');
  await ctx.close();
}
console.log('calls served:', [...new Set(chain.calls)].sort().join(', '));
await browser.close();
