#!/usr/bin/env node
// Rasterises the brand SVGs (run build.mjs first):
//   brand/avatar-{512,1024}.png, apple-touch-icon.png (180), icon-{192,512}.png, icon-maskable-512.png, favicon.ico
// Chromium via Playwright; no image libraries.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WEB } from '../fonts.mjs';
import { chromium, svgToPng } from '../browser.mjs';
import { COLORS as C, markPaths } from './geometry.mjs';

const PUBLIC = join(WEB, 'public');
const BRAND = join(PUBLIC, 'brand');
const read = (p) => readFile(p, 'utf8');

// Maskable: the whole mark inside the 40 % safe circle (outer radius 155 of 256 → 30 %).
function maskable(size = 512) {
  const R = 128;
  const m = markPaths(size / 2, size / 2, R);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><path fill="${C.ink}" d="M0 0h${size}v${size}H0z"/><path fill="${C.ivory}" d="${m.c}"/><path fill="${C.amber}" d="${m.arc}"/></svg>`;
}

/** ICO container holding PNG images (supported by every browser and Windows since Vista). */
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.png)]);
}

const browser = await (await chromium()).launch();
const page = await (await browser.newContext({ colorScheme: 'light', deviceScaleFactor: 1 })).newPage();

const tile = await read(join(BRAND, 'mark-tile.svg'));
const jobs = [
  [join(BRAND, 'avatar-512.png'), tile, 512],
  [join(BRAND, 'avatar-1024.png'), tile, 1024],
  [join(PUBLIC, 'apple-touch-icon.png'), tile, 180],
  [join(PUBLIC, 'icon-192.png'), tile, 192],
  [join(PUBLIC, 'icon-512.png'), tile, 512],
  [join(PUBLIC, 'icon-maskable-512.png'), maskable(), 512],
];
for (const [path, svg, size] of jobs) {
  await writeFile(path, await svgToPng(page, svg, size));
  console.log('wrote', path.replace(WEB + '/', ''));
}

// For _check/: the spec §1 numbers taken literally (C 250°/110° gap, arc 96° centred on radius 1.09), same tile.
{
  const R = 144;
  const m = markPaths(256, 256, R, { stroke: 0.42, cHalfGap: 55, arcR: 1.09, arcT: 0.2, arcHalf: 48 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="${C.ink}" d="M0 0h512v512H0z"/><path fill="${C.ivory}" d="${m.c}"/><path fill="${C.amber}" d="${m.arc}"/></svg>`;
  await writeFile(join(BRAND, '_check', 'spec-literal-512.png'), await svgToPng(page, svg, 512));
}

// favicon.ico from the adaptive favicon rendered in a light scheme (ink tile present).
const fav = await read(join(PUBLIC, 'favicon.svg'));
const sizes = [16, 32, 48];
const pngs = [];
for (const size of sizes) pngs.push({ size, png: await svgToPng(page, fav, size) });
await writeFile(join(PUBLIC, 'favicon.ico'), ico(pngs));
console.log('wrote public/favicon.ico', sizes.join('/'));

await browser.close();
