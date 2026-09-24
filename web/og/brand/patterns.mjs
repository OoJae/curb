#!/usr/bin/env node
// Pattern files:
//   brand/patterns/guilloche-specimen.svg — the rosette for a real seed: the first paid call's settlement tx hash
//   brand/patterns/slot-strip-week.svg    — the 2,016-slot HK week: ivory open, Streetlamp shut, on ink
// guilloche.ts is loaded with node:module stripTypeScriptTypes (Node ≥ 23.2).
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WEB } from '../fonts.mjs';
import { COLORS as C, fmt } from './geometry.mjs';
import { runs, SLOTS, SLOTS_PER_DAY, isOpen } from './week.mjs';
import { importTs } from '../ts.mjs';
const { guilloche } = await importTs(join(WEB, 'src', 'certificate', 'guilloche.ts'));

const DIR = join(WEB, 'public', 'brand', 'patterns');
await mkdir(DIR, { recursive: true });

// ── Guilloche specimen ──────────────────────────────────────────────────────────────────────────────────────────────
export const SPECIMEN_SEED = '0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7';
{
  const g = guilloche(SPECIMEN_SEED, { size: 200 });
  const S = 240; // ink margin around the ±100 rosette
  const layers = g.layers
    .map((l) => `<path vector-effect="non-scaling-stroke" d="${l.path}"/>`)
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-S / 2} ${-S / 2} ${S} ${S}" width="720" height="720" role="img" ` +
    `aria-label="Guilloche rosette seeded from settlement ${SPECIMEN_SEED}">` +
    `<rect x="${-S / 2}" y="${-S / 2}" width="${S}" height="${S}" fill="${C.ink}"/>` +
    `<g fill="none" stroke="${C.ivory}" stroke-width="0.4" data-seed="${g.seed}">${layers}</g></svg>`;
  await writeFile(join(DIR, 'guilloche-specimen.svg'), svg + '\n');
  console.log(
    'guilloche-specimen.svg',
    svg.length,
    'bytes;',
    g.layers.map((l) => `R${l.R} r${l.r} d${l.d} (${l.lobes} lobes)`).join(', '),
  );
}

// ── Slot strip ──────────────────────────────────────────────────────────────────────────────────────────────────────
// One unit per slot. Every run is inset 1 unit at each end so ink always separates ivory from Streetlamp (Law 2) and
// the seven days read as seven blocks.
{
  const H = 48;
  const PAD = 0;
  let ivory = '';
  let amber = '';
  for (const r of runs()) {
    const x = r.start + 1;
    const w = r.end - r.start - 2;
    if (w <= 0) continue;
    const seg = `M${fmt(x)} 0h${fmt(w)}v${H}h${fmt(-w)}z`;
    if (r.open) ivory += seg;
    else amber += seg;
  }
  const open = Array.from({ length: SLOTS }, (_, i) => isOpen(i)).filter(Boolean).length;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SLOTS} ${H + 2 * PAD}" width="${SLOTS / 2}" height="${(H + 2 * PAD) / 2}" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges" role="img" ` +
    `aria-label="The Hong Kong week in 2,016 five-minute slots: ${open} open (ivory), ${SLOTS - open} shut but trading (amber)">` +
    `<rect width="${SLOTS}" height="${H}" fill="${C.ink}"/>` +
    `<path fill="${C.amber}" d="${amber}"/><path fill="${C.ivory}" d="${ivory}"/></svg>`;
  await writeFile(join(DIR, 'slot-strip-week.svg'), svg + '\n');
  console.log(`slot-strip-week.svg ${svg.length} bytes; open ${open}/${SLOTS} slots (${((100 * (SLOTS - open)) / SLOTS).toFixed(1)} % shut), ${SLOTS_PER_DAY}/day`);
}
