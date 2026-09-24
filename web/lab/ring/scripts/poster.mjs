// Render the ring at rest (the logo) straight off the WebGL canvas and encode web/public/posters/ring-logo.avif.
// The canvas is square and uses the same camera, so the poster registers pixel for pixel with the first frame.
// Budget: ≤ 60 KB. Usage: node scripts/poster.mjs [size=1600]
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { LAB, launch, waitReady } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const size = Number(process.argv[2] ?? 1600);
const outDir = join(here, '../../../public/posters');
mkdirSync(outDir, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
await page.goto(`${LAB}/?capture=1&size=${size}&p=0`);
await waitReady(page);
const dataUrl = await page.evaluate(() => {
  const L = window.__lab;
  L.ring.debug.renderNow();
  return document.getElementById('ring').toDataURL('image/png');
});
const dims = await page.evaluate(() => [document.getElementById('ring').width, document.getElementById('ring').height]);
await browser.close();
if (dims[0] !== size || dims[1] !== size) throw new Error(`canvas is ${dims}, expected ${size}²`);

const png = Buffer.from(dataUrl.split(',')[1], 'base64');
writeFileSync(join(here, '../shots/poster-source.png'), png);
const avifPath = join(outDir, 'ring-logo.avif');
for (const quality of [80, 74, 68, 62, 56, 50, 44]) {
  await sharp(png).avif({ quality, effort: 9, chromaSubsampling: '4:4:4' }).toFile(avifPath);
  const kb = statSync(avifPath).size / 1024;
  console.log(`q${quality}: ${kb.toFixed(1)} KB`);
  if (kb <= 56) break;
}
const meta = await sharp(avifPath).metadata();
console.log('wrote', avifPath, `${meta.width}×${meta.height}`, meta.hasAlpha ? 'alpha' : 'opaque');
