// Shared Playwright launcher for the lab scripts: Chromium on the real GPU (ANGLE/Metal on macOS), not SwiftShader.
import { chromium } from 'playwright';

export const LAB = process.env.LAB_URL ?? 'http://localhost:5178';

export async function launch({ headless = true } = {}) {
  return chromium.launch({
    headless,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  });
}

export async function waitReady(page) {
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 30_000 });
}
