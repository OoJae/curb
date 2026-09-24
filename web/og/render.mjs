#!/usr/bin/env node
// Renders the OG and social images from og/templates/*.html with Playwright (Chromium).
//
//   node web/og/render.mjs            # all
//   node web/og/render.mjs home clock # some
//
// A tiny static server roots at web/ and mirrors Vite: /x resolves to web/public/x first, then web/x. So templates
// load the site's own /src/styles/{tokens,fonts}.css, /fonts/*.woff2 and /brand/*.svg. Where lane A's files are missing
// it serves og/templates/*.fallback.css and the Google Fonts latin subsets instead (and says so). .ts files are
// served with their types stripped, so templates import src/certificate/guilloche.ts directly.
import { createServer } from 'node:http';
import { readFile, access, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join, extname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WEB, webFonts } from './fonts.mjs';
import { chromium } from './browser.mjs';

process.removeAllListeners('warning'); // stripTypeScriptTypes is flagged experimental

export const JOBS = [
  // template            output                                  w     h
  ['home', 'og/home.png', 1200, 630],
  ['clock', 'og/clock.png', 1200, 630],
  ['scorecard', 'og/scorecard.png', 1200, 630],
  ['api', 'og/api.png', 1200, 630],
  ['notes', 'og/notes.png', 1200, 630],
  ['depth', 'og/depth.png', 1200, 630],
  ['brand', 'og/brand.png', 1200, 630],
  ['x-header', 'social/x-header-1500x500.png', 1500, 500],
  ['square', 'social/square-1080.png', 1080, 1080],
  ['video-thumb', 'social/video-thumb-1920x1080.png', 1920, 1080],
];

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};
const exists = (p) => access(p).then(() => true, () => false);

export async function serve() {
  const fonts = await webFonts();
  const fontMap = Object.fromEntries(fonts.map((f) => ['/fonts/' + f.file, f]));
  const notes = new Set();
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = normalize(url).replace(/^(\.\.[/\\])+/, '');
    let file = null;
    for (const cand of [join(WEB, 'public', rel), join(WEB, rel)]) {
      if (cand.startsWith(WEB) && (await exists(cand)) && extname(cand)) { file = cand; break; }
    }
    if (!file && (url === '/src/styles/tokens.css' || url === '/src/styles/fonts.css')) {
      const name = url.endsWith('tokens.css') ? 'tokens' : 'fonts';
      file = join(WEB, 'og', 'templates', `${name}.fallback.css`);
      notes.add(`${name}: og/templates/${name}.fallback.css (lane A's src/styles/${name}.css not found)`);
    }
    if (!file && fontMap[url]) {
      file = fontMap[url].path;
      notes.add(`font ${fontMap[url].file}: ${fontMap[url].source}`);
    }
    if (!file) { res.writeHead(404).end(); return; }
    let body = await readFile(file);
    if (file.endsWith('.ts')) body = stripTypeScriptTypes(body.toString());
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, notes };
}

export async function render(names = []) {
  const jobs = names.length ? JOBS.filter(([n]) => names.includes(n)) : JOBS;
  const { server, origin, notes } = await serve();
  const browser = await (await chromium()).launch();
  try {
    for (const [name, out, w, h] of jobs) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`${origin}/og/templates/${name}.html`);
      await page.waitForFunction(() => window.__ogReady === true, null, { timeout: 20000 });
      const path = join(WEB, 'public', out);
      await mkdir(join(path, '..'), { recursive: true });
      await page.screenshot({ path, clip: { x: 0, y: 0, width: w, height: h } });
      console.log(`${out}  ${w}x${h}${errors.length ? '  ERRORS: ' + errors.join(' | ') : ''}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  for (const n of notes) console.log('note —', n);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await render(process.argv.slice(2));
