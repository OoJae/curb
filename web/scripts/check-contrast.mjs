#!/usr/bin/env node
// Verifies the colour pairs in spec §1 against the hex values in src/styles/tokens.css (WCAG 2.x
// contrast), and that each regime's semantic roles resolve to legal pairs:
//   text roles ≥ 4.5:1, focus / non-text ≥ 3:1, and Streetlamp never on ivory.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const hex = {};
for (const m of css.matchAll(/--(ink|ivory|streetlamp|slate|brass|graphite)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) hex[m[1]] = m[2];
for (const k of ['ink', 'ivory', 'streetlamp', 'slate', 'brass', 'graphite']) {
  if (!hex[k]) {
    console.error(`check-contrast: FAIL  --${k} not found as a 6-digit hex in tokens.css`);
    process.exit(1);
  }
}

function lum(h) {
  const n = parseInt(h.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const failures = [];
const rows = [];

// Spec §1 table: [fg, bg, stated ratio, rule]
const SPEC = [
  ['ivory', 'ink', 15.7, 'text'],
  ['streetlamp', 'ink', 8.8, 'text'],
  ['streetlamp', 'ivory', 1.8, 'forbidden'],
  ['slate', 'ink', 6.0, 'text'],
  ['brass', 'ivory', 5.2, 'text'],
  ['graphite', 'ivory', 5.2, 'text'],
];
for (const [fg, bg, stated, rule] of SPEC) {
  const r = ratio(hex[fg], hex[bg]);
  const ok =
    Math.abs(r - stated) <= 0.15 && (rule === 'text' ? r >= 4.5 : r < 3);
  rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${fg.padEnd(10)} on ${bg.padEnd(6)} ${r.toFixed(2).padStart(5)}:1  (spec ${stated}:1, ${rule === 'forbidden' ? 'must stay < 3, never used' : '≥ 4.5 text'})`);
  if (!ok) failures.push(`${fg} on ${bg} is ${r.toFixed(2)}:1; spec says ${stated}:1 (${rule})`);
}

// Semantic roles per regime block.
function block(selectorStart) {
  const i = css.indexOf(selectorStart);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const map = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*var\(--(\w+)\)\s*;/g)) map[m[1]] = m[2];
  return map;
}
const modes = { ink: block(':root,\n[data-regime'), paper: block("[data-regime='open']") };
for (const [mode, map] of Object.entries(modes)) {
  if (!map) {
    failures.push(`could not find the ${mode} regime block in tokens.css`);
    continue;
  }
  const g = map.ground;
  const checks = [
    ['figure', g, 4.5],
    ['muted', g, 4.5],
    ['signal', g, 4.5],
    ['lamp', g, 4.5],
    ['focus', g, 3],
  ];
  for (const [role, bg, min] of checks) {
    const fg = map[role];
    if (!fg || !hex[fg] || !hex[bg]) {
      failures.push(`${mode}: --${role} or --ground does not resolve to one of the six colours`);
      continue;
    }
    const r = ratio(hex[fg], hex[bg]);
    const ok = r >= min;
    rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${mode.padEnd(5)} --${role.padEnd(8)} ${fg.padEnd(10)} on ${bg.padEnd(6)} ${r.toFixed(2).padStart(5)}:1  (≥ ${min})`);
    if (!ok) failures.push(`${mode}: --${role} (${fg}) on --ground (${bg}) is ${r.toFixed(2)}:1 < ${min}`);
  }
  // Accent on a --figure fill (primary button).
  if (map['signal-inverse'] && map.figure) {
    const r = ratio(hex[map['signal-inverse']], hex[map.figure]);
    const ok = r >= 3;
    rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${mode.padEnd(5)} --signal-inverse ${map['signal-inverse']} on ${map.figure} ${r.toFixed(2)}:1  (≥ 3)`);
    if (!ok) failures.push(`${mode}: --signal-inverse on --figure is ${r.toFixed(2)}:1 < 3`);
  }
  // Law 2: amber never touches ivory.
  if (g === 'ivory') {
    for (const [role, v] of Object.entries(map)) {
      // --signal-inverse is drawn on the --figure fill (ink here), not on the ground.
      if (v === 'streetlamp' && role !== 'signal-inverse') failures.push(`${mode}: --${role} resolves to Streetlamp on an ivory ground (Law 2)`);
    }
  }
  if (map.figure === 'ivory' && map['signal-inverse'] === 'streetlamp') {
    failures.push(`${mode}: --signal-inverse is Streetlamp on an ivory fill (Law 2)`);
  }
}

console.log(rows.join('\n'));
if (failures.length) {
  console.error(`check-contrast: FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('check-contrast: ok');
