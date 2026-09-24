// Resolve Playwright's chromium: web/node_modules if present, else the global @playwright/test.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export async function chromium() {
  for (const name of ['playwright', '@playwright/test']) {
    try {
      const mod = await import(name);
      return mod.chromium ?? mod.default.chromium;
    } catch {}
  }
  const root = execSync('npm root -g').toString().trim();
  return createRequire(join(root, 'noop.js'))('@playwright/test').chromium;
}

/** Render an SVG string to a PNG buffer at w×h (transparent where the SVG is). */
export async function svgToPng(page, svg, w, h = w) {
  await page.setViewportSize({ width: w, height: h });
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent"><img id="i" src="${src}" width="${w}" height="${h}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.getElementById('i').complete);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}
