#!/usr/bin/env node
// Contact sheets for review: every brand SVG on its intended ground, glyphs and favicons at 16/24/32/48 px and
// magnified 8x (nearest neighbour) to judge 16 px crispness. Writes web/og/previews/*.png (not deployed).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WEB } from '../fonts.mjs';
import { chromium, svgToPng } from '../browser.mjs';
import { COLORS as C } from './geometry.mjs';

const PUB = join(WEB, 'public');
const OUT = join(WEB, 'og', 'previews');
await mkdir(OUT, { recursive: true });
const uri = async (p) => 'data:image/svg+xml;base64,' + (await readFile(join(PUB, p))).toString('base64');

const browser = await (await chromium()).launch();

async function sheet(name, html, width, scheme = 'light') {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width, height: 400 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await page.screenshot({ path: join(OUT, name), fullPage: true });
  await ctx.close();
  console.log('wrote og/previews/' + name);
}

const css = `
  body{margin:0;font:13px/1.4 ui-monospace,Menlo,monospace;color:${C.slate};background:#1b232d}
  .row{display:flex;flex-wrap:wrap;gap:16px;padding:16px}
  .cell{padding:40px;display:flex;flex-direction:column;gap:16px;align-items:flex-start;justify-content:center}
  .ink{background:${C.ink}} .ivory{background:${C.ivory};color:${C.graphite}}
  img{display:block} .px{image-rendering:pixelated}
  .glyphs{display:flex;gap:18px;align-items:center}
`;

// Main sheet: marks, wordmark, lockups.
const cells = [
  ['mark.svg', 'ink', 200],
  ['mark-tile.svg', 'ivory', 200],
  ['mark-mono-ink.svg', 'ivory', 200],
  ['mark-mono-ivory.svg', 'ink', 200],
  ['wordmark.svg', 'ink', 120],
  ['wordmark-ink.svg', 'ivory', 120],
  ['lockup-horizontal.svg', 'ink', 110],
  ['lockup-horizontal-tile.svg', 'ivory', 190],
  ['lockup-horizontal-paper.svg', 'ivory', 110],
  ['lockup-stacked-tagline.svg', 'ink', 360],
];
let html = `<style>${css}</style><div class="row">`;
for (const [f, bg, h] of cells) html += `<div class="cell ${bg}"><img src="${await uri('brand/' + f)}" style="height:${h}px">${f}</div>`;
html += `</div>`;
await sheet('brand-sheet.png', html, 1600);

// Small sizes: glyphs + favicons at native sizes and 8x magnified renders of the 16 px raster.
const page = await (await browser.newContext({ colorScheme: 'light' })).newPage();
const small = async (file, size, scheme = 'light', color = C.ivory) => {
  let svg = await readFile(join(PUB, file), 'utf8');
  svg = svg.replace(/currentColor/g, color);
  if (scheme === 'dark') svg = svg.replace(/\.t\{fill:[^}]+\}/, '.t{fill:none}');
  return 'data:image/png;base64,' + (await svgToPng(page, svg, size)).toString('base64');
};
let s = `<style>${css}</style>`;
for (const [bg, color] of [['ink', C.ivory], ['ivory', C.ink]]) {
  s += `<div class="row ${bg}">`;
  for (const g of ['glyph-open.svg', 'glyph-shut.svg', 'glyph-unknown.svg']) {
    s += `<div class="cell"><div class="glyphs">`;
    for (const z of [16, 24, 48]) s += `<img src="${await small('brand/' + g, z, 'light', color)}" width="${z}" height="${z}">`;
    s += `<img class="px" src="${await small('brand/' + g, 16, 'light', color)}" width="128" height="128"></div>${g} on ${bg}</div>`;
  }
  s += `</div>`;
}
for (const [scheme, bg] of [['light', '#dee1e6'], ['dark', '#35363a']]) {
  s += `<div class="row" style="background:${bg}">`;
  for (const f of ['favicon.svg', 'favicon-open.svg', 'favicon-unknown.svg']) {
    s += `<div class="cell"><div class="glyphs">`;
    for (const z of [16, 32, 48]) s += `<img src="${await small(f, z, scheme)}" width="${z}" height="${z}">`;
    s += `<img class="px" src="${await small(f, 16, scheme)}" width="128" height="128"><img class="px" src="${await small(f, 32, scheme)}" width="128" height="128"></div>${f} (${scheme} chrome)</div>`;
  }
  s += `</div>`;
}
await sheet('small-sizes.png', s, 1600);
await browser.close();
