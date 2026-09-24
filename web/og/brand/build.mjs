#!/usr/bin/env node
// Builds every vector brand asset from geometry.mjs and outlined type.
//
//   npm i --prefix /tmp/curb-brand-tools opentype.js svgo      # tools live outside web/package.json
//   BRAND_TOOLS=/tmp/curb-brand-tools node web/og/brand/build.mjs
//
// Writes web/public/brand/*.svg and web/public/favicon*.svg. Rasters come from raster.mjs; patterns from patterns.mjs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLORS as C, MARK, MARK_SMALL, markPaths, dots, fmt } from './geometry.mjs';
import { staticTTF, readFont, WEB } from '../fonts.mjs';

const TOOLS = process.env.BRAND_TOOLS || join(tmpdir(), 'curb-brand-tools');
const req = createRequire(join(TOOLS, 'noop.js'));
let opentype, optimize;
try {
  opentype = req('opentype.js');
  ({ optimize } = req('svgo'));
} catch {
  console.error(`missing tools: npm i --prefix ${TOOLS} opentype.js svgo`);
  process.exit(1);
}

const BRAND = join(WEB, 'public', 'brand');
const PUBLIC = join(WEB, 'public');

const svgoConfig = (keepStyle) => ({
  multipass: true,
  floatPrecision: 2,
  plugins: [
    {
      name: 'preset-default',
      params: { overrides: keepStyle ? { inlineStyles: false, minifyStyles: false, mergeStyles: false } : {} },
    },
    { name: 'sortAttrs' },
  ],
});

const written = [];
async function out(path, svg, { keepStyle = false } = {}) {
  if (process.env.RAW) await writeFile(path + ".raw", svg);
  const { data } = optimize(svg, { path, ...svgoConfig(keepStyle) });
  await writeFile(path, data + '\n');
  written.push([path.replace(WEB + '/', ''), data.length]);
  return data;
}

const svg = (w, h, body, label, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}" role="img" aria-label="${label}"${extra}>${body}</svg>`;

// ── Mark ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Standalone mark: the circle's bounding square (outer radius 1.21 R). For ink grounds: ivory C, Streetlamp arc.
const MR = 100;
const MS = 2 * MR * (1 + MARK.stroke / 2); // 242
const m = markPaths(MS / 2, MS / 2, MR);
const markBody = (c, a) => `<path fill="${c}" d="${m.c}"/><path fill="${a}" d="${m.arc}"/>`;

// Tile = the avatar: 512 square, R 144.
const TS = 512;
const tR = TS / MARK.tile;
const t = markPaths(TS / 2, TS / 2, tR);
const tileBody = `<path fill="${C.ink}" d="M0 0h${TS}v${TS}H0z"/><path fill="${C.ivory}" d="${t.c}"/><path fill="${C.amber}" d="${t.arc}"/>`;

// ── Glyphs (16 grid; optical small variant) ─────────────────────────────────────────────────────────────────────────
// Figure is currentColor so the glyph follows the text colour when inlined; the amber arc carries class "glyph-arc"
// so paper mode can re-colour it (Law 2: amber never touches ivory — on paper use Bell brass or an ink tile).
const G = 16;
const gR = 5.5;
const g = markPaths(G / 2, G / 2, gR, MARK_SMALL);
const gStroke = MARK_SMALL.stroke * gR;

// ── Favicons (32 grid; optical small variant) ───────────────────────────────────────────────────────────────────────
const F = 32;
const fR = 11;
const fv = markPaths(F / 2, F / 2, fR, MARK_SMALL);
const fStroke = MARK_SMALL.stroke * fR;
// Light browser chrome: ink tile. Dark chrome: no tile — the ivory figure and the arc sit on the dark tab.
const favStyle = `<style>.t{fill:${C.ink}}@media (prefers-color-scheme:dark){.t{fill:none}}</style>`;
const favTile = `<rect class="t" width="${F}" height="${F}" rx="3"/>`;
const favicon = (figure) => svg(F, F, favStyle + favTile + figure, 'Curb');

// ── Type ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const bodoni = opentype.parse(await readFont(await staticTTF('Bodoni Moda', { opsz: 96, wght: 500 })));
const franklin = opentype.parse(await readFont(await staticTTF('Libre Franklin', { wght: 400 })));

/**
 * Outline `text` with its baseline at y and pen origin at x; font size set by cap height. `kern` adds optical pair
 * adjustments in em on top of the font's own kerning, e.g. { rb: -0.025 }.
 */
function outline(font, text, x, y, capHeight, kern = {}) {
  const size = (capHeight * font.unitsPerEm) / font.tables.os2.sCapHeight;
  const glyphs = font.stringToGlyphs(text);
  const path = new opentype.Path();
  let pen = x;
  glyphs.forEach((glyph, i) => {
    path.extend(glyph.getPath(pen, y, size));
    pen += (glyph.advanceWidth / font.unitsPerEm) * size;
    const next = glyphs[i + 1];
    if (next) {
      pen += (font.getKerningValue(glyph, next) / font.unitsPerEm) * size;
      pen += (kern[text[i] + text[i + 1]] ?? 0) * size;
    }
  });
  return { d: pathData(path.commands), bb: path.getBoundingBox(), size, advance: pen - x };
}

// opentype.js 2.0.0's toPathData(decimals) emits NaN for some coordinates, so serialise the commands ourselves.
function pathData(cmds) {
  let d = '';
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') d += `${c.type}${fmt(c.x)} ${fmt(c.y)}`;
    else if (c.type === 'Q') d += `Q${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x)} ${fmt(c.y)}`;
    else if (c.type === 'C') d += `C${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x2)} ${fmt(c.y2)} ${fmt(c.x)} ${fmt(c.y)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  if (/NaN/.test(d)) throw new Error('NaN in outlined path');
  return d;
}

// Wordmark: cap height 100 units, tight to the ink.
const WCAP = 100;
const WKERN = { rb: -0.03 }; // the r's open shoulder leaves a hole before the b's stem
const wm0 = outline(bodoni, 'Curb', 0, 0, WCAP, WKERN);
const wPad = 0;
const wX = -wm0.bb.x1 + wPad;
const wY = -wm0.bb.y1 + wPad;
const wm = outline(bodoni, 'Curb', wX, wY, WCAP, WKERN);
const wW = wm0.bb.x2 - wm0.bb.x1 + 2 * wPad;
const wH = wm0.bb.y2 - wm0.bb.y1 + 2 * wPad;

// ── Lockups ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Horizontal: mark height 1.36 × cap height, centred on the cap-height midline; gap 0.5 × cap height to the C's ink.
function horizontal({ cap = 100, pad = 0, figure = C.ivory, markFill = C.ivory, arc = C.amber, word = C.ivory, bg = null, markTile = false }) {
  const D = cap * 1.36; // mark outer diameter
  const R = D / 2 / (1 + MARK.stroke / 2);
  const gap = cap * 0.5;
  let body = '';
  let markRight;
  let cx, cy;
  if (markTile) {
    // Paper: the mark sits inside its own ink tile (tile side = MARK.tile × R).
    const side = D * 1.18;
    const r2 = side / MARK.tile;
    cx = pad + side / 2;
    cy = pad + Math.max(side, cap) / 2 + (side < cap ? 0 : 0);
    const mp = markPaths(cx, cy, r2);
    body += `<path fill="${C.ink}" d="M${fmt(pad)} ${fmt(cy - side / 2)}h${fmt(side)}v${fmt(side)}h${fmt(-side)}z"/>`;
    body += `<path fill="${markFill}" d="${mp.c}"/><path fill="${arc}" d="${mp.arc}"/>`;
    markRight = pad + side;
  } else {
    cx = pad + D / 2;
    cy = pad + D / 2;
    const mp = markPaths(cx, cy, R);
    body += `<path fill="${markFill}" d="${mp.c}"/><path fill="${arc}" d="${mp.arc}"/>`;
    markRight = pad + D;
  }
  const baseline = cy + cap / 2;
  const w0 = outline(bodoni, 'Curb', 0, 0, cap, WKERN);
  const x = markRight + gap - w0.bb.x1;
  const w = outline(bodoni, 'Curb', x, baseline, cap, WKERN);
  body += `<path fill="${word}" d="${w.d}"/>`;
  const width = w.bb.x2 + pad;
  const height = Math.max(cy + (markTile ? D * 1.18 : D) / 2, w.bb.y2) + pad;
  const top = Math.min(cy - (markTile ? D * 1.18 : D) / 2, w.bb.y1) - pad;
  const bgRect = bg ? `<path fill="${bg}" d="M0 ${fmt(top)}h${fmt(width)}v${fmt(height - top)}H0z"/>` : '';
  return { body: bgRect + body, width, top, height: height - top, D };
}

function translateSvg(l, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${fmt(l.top)} ${fmt(l.width)} ${fmt(l.height)}" width="${fmt(l.width)}" height="${fmt(l.height)}" role="img" aria-label="${label}">${l.body}</svg>`;
}

// Stacked with tagline, centred: mark, wordmark, two-line tagline (Libre Franklin 400, Window slate).
function stacked({ cap = 100 }) {
  const D = cap * 2.1;
  const R = D / 2 / (1 + MARK.stroke / 2);
  const w0 = outline(bodoni, 'Curb', 0, 0, cap, WKERN);
  const tagCap = cap * 0.2;
  const lines = ['The market that trades', 'when the exchange is shut.'];
  const t0 = lines.map((s) => outline(franklin, s, 0, 0, tagCap));
  const width = Math.max(D, w0.bb.x2 - w0.bb.x1, ...t0.map((t) => t.bb.x2 - t.bb.x1));
  const cx = width / 2;
  let body = '';
  const mp = markPaths(cx, D / 2, R);
  body += `<path fill="${C.ivory}" d="${mp.c}"/><path fill="${C.amber}" d="${mp.arc}"/>`;
  const wordBase = D + cap * 0.62 + cap;
  const wx = cx - (w0.bb.x1 + w0.bb.x2) / 2;
  const w = outline(bodoni, 'Curb', wx, wordBase, cap, WKERN);
  body += `<path fill="${C.ivory}" d="${w.d}"/>`;
  const lead = tagCap * 1.95;
  let base = wordBase + cap * 0.62 + tagCap;
  let bottom = w.bb.y2;
  lines.forEach((s, i) => {
    const tx = cx - (t0[i].bb.x1 + t0[i].bb.x2) / 2;
    const tt = outline(franklin, s, tx, base + i * lead, tagCap);
    body += `<path fill="${C.slate}" d="${tt.d}"/>`;
    bottom = Math.max(bottom, tt.bb.y2);
  });
  return { body, width, top: 0, height: bottom };
}

// ── Write ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await mkdir(BRAND, { recursive: true });

await out(join(BRAND, 'mark.svg'), svg(MS, MS, markBody(C.ivory, C.amber), 'Curb'));
await out(join(BRAND, 'mark-tile.svg'), svg(TS, TS, tileBody, 'Curb'));
await out(join(BRAND, 'mark-mono-ink.svg'), svg(MS, MS, markBody(C.ink, C.ink), 'Curb'));
await out(join(BRAND, 'mark-mono-ivory.svg'), svg(MS, MS, markBody(C.ivory, C.ivory), 'Curb'));

await out(join(BRAND, 'glyph-open.svg'), svg(G, G, `<path fill="currentColor" d="${g.ring}"/>`, 'Open'));
await out(
  join(BRAND, 'glyph-shut.svg'),
  svg(G, G, `<path fill="currentColor" d="${g.c}"/><path class="glyph-arc" fill="${C.amber}" d="${g.arc}"/>`, 'Shut, still trading'),
);
await out(join(BRAND, 'glyph-unknown.svg'), svg(G, G, `<path fill="currentColor" d="${dots(G / 2, G / 2, gR, 8, gStroke / 2)}"/>`, 'Unknown'));

await out(join(PUBLIC, 'favicon.svg'), favicon(`<path fill="${C.ivory}" d="${fv.c}"/><path fill="${C.amber}" d="${fv.arc}"/>`), { keepStyle: true });
await out(join(PUBLIC, 'favicon-shut.svg'), favicon(`<path fill="${C.ivory}" d="${fv.c}"/><path fill="${C.amber}" d="${fv.arc}"/>`), { keepStyle: true });
await out(join(PUBLIC, 'favicon-open.svg'), favicon(`<path fill="${C.ivory}" d="${fv.ring}"/>`), { keepStyle: true });
await out(join(PUBLIC, 'favicon-unknown.svg'), favicon(`<path fill="${C.ivory}" d="${dots(F / 2, F / 2, fR, 8, fStroke / 2)}"/>`), { keepStyle: true });

await out(join(BRAND, 'wordmark.svg'), svg(wW, wH, `<path fill="${C.ivory}" d="${wm.d}"/>`, 'Curb'));
await out(join(BRAND, 'wordmark-ink.svg'), svg(wW, wH, `<path fill="${C.ink}" d="${wm.d}"/>`, 'Curb'));

const lh = horizontal({});
await out(join(BRAND, 'lockup-horizontal.svg'), translateSvg(lh, 'Curb'));
const lhTile = horizontal({ pad: lh.D * 0.5, bg: C.ink });
await out(join(BRAND, 'lockup-horizontal-tile.svg'), translateSvg(lhTile, 'Curb'));
const lhPaper = horizontal({ markTile: true, word: C.ink });
await out(join(BRAND, 'lockup-horizontal-paper.svg'), translateSvg(lhPaper, 'Curb'));
await out(join(BRAND, 'lockup-stacked-tagline.svg'), translateSvg(stacked({}), 'Curb — The market that trades when the exchange is shut.'));

for (const [p, n] of written) console.log(`${String(n).padStart(6)}  ${p}`);
