// Keyboard pass: tab order through <main>, range input by arrows, the wallet dialog by Enter/Escape.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
const root = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(root, 'noop.js'))('@playwright/test');
const [base] = process.argv.slice(2);
const browser = await chromium.launch();
for (const path of ['/notes', '/depth']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const seen = [];
  let noRing = 0;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const inMain = !!e.closest('main');
      const label = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('data-nt-in') || e.getAttribute('data-dp-in') || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
      return { tag: e.tagName.toLowerCase(), label, ring, inMain };
    });
    if (!d) continue;
    if (d.inMain) {
      seen.push(`${d.tag}:${d.label}${d.ring ? '' : ' [NO RING]'}`);
      if (!d.ring) noRing++;
    }
  }
  console.log(path, `focusables in main (first ${seen.length}):`, seen.slice(0, 40).join(' | '));
  console.log(path, 'without a visible ring:', noRing);
  if (path === '/depth') {
    const r = page.locator('[data-dp-range]');
    await r.focus();
    const before = await page.locator('[data-dp-readout]').innerText();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
    const after = await page.locator('[data-dp-readout]').innerText();
    console.log('range by keyboard:', before === after ? 'NO CHANGE' : `ok → ${after.slice(0, 80)}`);
  }
  const c = page.locator('[data-wallet-connect]');
  await c.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const open = await page.evaluate(() => !!document.querySelector('dialog[open]'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => !document.querySelector('dialog[open]'));
  const back = await page.evaluate(() => document.activeElement?.hasAttribute('data-wallet-connect'));
  console.log(path, `dialog: opens=${open} escapeCloses=${closed} focusReturns=${back}`);
  await page.close();
}
await browser.close();
