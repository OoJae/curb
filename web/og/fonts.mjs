// Font sourcing for the brand build and the OG renderer.
//
// - Outlining (wordmark, tagline) needs static TTF instances: Google Fonts' CSS API serves a static instance per axis
//   value when asked without a woff2-capable user agent, e.g. Bodoni Moda at opsz 96 / wght 500.
// - Rendering (OG templates) uses the site's own latin woff2 files from web/public/fonts/ (lane A) when present, and
//   otherwise the Google Fonts latin woff2 subsets, cached outside the repo.
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB = join(HERE, '..');
const CACHE = process.env.CURB_FONT_CACHE || join(tmpdir(), 'curb-brand-fonts');

const exists = (p) => access(p).then(() => true, () => false);

async function fetchCached(url, name) {
  await mkdir(CACHE, { recursive: true });
  const p = join(CACHE, name);
  if (await exists(p)) return p;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  await writeFile(p, Buffer.from(await res.arrayBuffer()));
  return p;
}

/** Static TTF instance from Google Fonts, e.g. staticTTF('Bodoni Moda', { opsz: 96, wght: 500 }). */
export async function staticTTF(family, axes, italic = false) {
  const tags = Object.keys(axes).sort();
  const spec = (italic ? ['ital', ...tags] : tags).join(',') + '@' + (italic ? ['1', ...tags.map((t) => axes[t])] : tags.map((t) => axes[t])).join(',');
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:${spec}`)).text();
  const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
  if (!url) throw new Error(`no TTF for ${family} ${spec}`);
  return fetchCached(url, `${family.replace(/ /g, '-')}-${spec.replace(/[^a-z0-9]+/gi, '_')}.ttf`);
}

const MODERN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// The site's font files (spec §2) and the Google Fonts request that yields the same latin variable subset.
export const WEB_FONTS = [
  { file: 'bodoni-moda.woff2', family: 'Bodoni Moda', style: 'normal', weight: '400 900', q: 'Bodoni+Moda:opsz,wght@6..96,400..900' },
  { file: 'bodoni-moda-italic.woff2', family: 'Bodoni Moda', style: 'italic', weight: '400 900', q: 'Bodoni+Moda:ital,opsz,wght@1,6..96,400..900' },
  { file: 'libre-franklin.woff2', family: 'Libre Franklin', style: 'normal', weight: '100 900', q: 'Libre+Franklin:wght@100..900' },
  { file: 'martian-mono.woff2', family: 'Martian Mono', style: 'normal', weight: '100 800', stretch: '75% 112.5%', q: 'Martian+Mono:wdth,wght@75..112.5,100..800' },
];

/** Resolve each web font to a local file: lane A's web/public/fonts first, else a cached Google Fonts latin subset. */
export async function webFonts() {
  const out = [];
  for (const f of WEB_FONTS) {
    const local = join(WEB, 'public', 'fonts', f.file);
    if (await exists(local)) {
      out.push({ ...f, path: local, source: 'web/public/fonts' });
      continue;
    }
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${f.q}&display=block`, { headers: { 'user-agent': MODERN_UA } })).text();
    // Google splits by unicode-range; the block commented "latin" is the one the site ships.
    const block = css.split('/* ').find((b) => b.startsWith('latin */'));
    const url = block?.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (!url) throw new Error(`no latin woff2 for ${f.family}`);
    out.push({ ...f, path: await fetchCached(url, f.file), source: 'fonts.gstatic.com (fallback)' });
  }
  return out;
}

export async function readFont(p) {
  const b = await readFile(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
