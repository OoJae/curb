#!/usr/bin/env node
// Fails on a raw hex colour or a px font size anywhere outside src/styles/tokens.css.
// Scans src/**/*.{css,ts,js} and the page entry HTML. A line ending in a
// `lint-tokens-ignore` comment is skipped (use sparingly, with a reason).
// Also warns (does not fail) when a page's page.css uses a class without its prefix.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(root, 'src/styles/tokens.css');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = [
  ...walk(join(root, 'src')).filter((f) => /\.(css|ts|js|mjs|html)$/.test(f) && !/\.d\.ts$/.test(f)),
  ...['index.html', '404.html', ...['clock', 'scorecard', 'api', 'notes', 'depth', 'brand'].map((p) => `${p}/index.html`)]
    .map((f) => join(root, f))
    .filter((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    }),
].filter((f) => f !== TOKENS && !f.includes(`${join('src', 'data', 'fixtures')}`));

// A CSS hex colour: # + 3/4/6/8 hex digits, not part of a longer word, not a TS private field (#x after '.'),
// not an HTML entity (&#…;), not a URL fragment in an href/src/xlink attribute.
const HEX = /(?<![\w&.])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const FRAGMENT_ATTR = /(?:href|src|xlink:href|popovertarget|for|aria-\w+)=["']#[0-9a-fA-F]{3,8}["']/g;
const PX_FONT = [
  /font-size\s*:\s*-?[\d.]+px/gi,
  /\bfont\s*:[^;{}]*?\b[\d.]+px/gi,
  /fontSize\s*[:=]\s*['"`]?[\d.]+px/g,
  /fontSize\s*[:=]\s*\d+(?![\d.]*\s*(?:rem|em|%|vw|ch))\s*[,}]/g,
];

const failures = [];
const warnings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  const lines = text.split('\n');
  let inBlockComment = false;
  lines.forEach((line, i) => {
    if (/lint-tokens-ignore/.test(line)) return;
    // Strip CSS/JS block comments and line comments so documentation can mention hex values.
    let code = '';
    let rest = line;
    while (rest.length) {
      if (inBlockComment) {
        const end = rest.indexOf('*/');
        if (end < 0) {
          rest = '';
          break;
        }
        rest = rest.slice(end + 2);
        inBlockComment = false;
      } else {
        const start = rest.indexOf('/*');
        if (start < 0) {
          code += rest;
          break;
        }
        code += rest.slice(0, start);
        rest = rest.slice(start + 2);
        inBlockComment = true;
      }
    }
    if (/\.(ts|js|mjs)$/.test(file)) code = code.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    if (/\.html$/.test(file)) code = code.replace(/<!--.*?-->/g, '');
    const scrubbed = code.replace(FRAGMENT_ATTR, '');
    for (const m of scrubbed.matchAll(HEX)) {
      failures.push(`${rel}:${i + 1}  raw hex colour ${m[0]} (use a token from tokens.css)`);
    }
    for (const re of PX_FONT) {
      for (const m of code.matchAll(re)) {
        failures.push(`${rel}:${i + 1}  px font size "${m[0].trim()}" (use a --t-* token)`);
      }
    }
  });

  // Page CSS prefix convention (warning only).
  const pm = rel.match(/^src\/pages\/([^/]+)\/page\.css$/);
  if (pm) {
    const prefix = { home: 'hm-', clock: 'clk-', scorecard: 'sc-', api: 'api-', notes: 'nt-', depth: 'dp-', brand: 'br-', '404': 'nf-' }[pm[1]];
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = new Set([...stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    for (const c of classes) {
      if (prefix && !c.startsWith(prefix) && !/^(page|vt-|t-|is-|has-)/.test(c) && !/^\d/.test(c)) {
        warnings.push(`${rel}  .${c} lacks the page prefix .${prefix}`);
      }
    }
  }
}

for (const w of warnings) console.warn(`lint-tokens: warn  ${w}`);
if (failures.length) {
  console.error(`lint-tokens: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`lint-tokens: ok (${files.length} files, no raw hex or px font sizes outside tokens.css)`);
