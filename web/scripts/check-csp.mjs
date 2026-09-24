#!/usr/bin/env node
// Verifies vercel.json's Content-Security-Policy: the exact connect-src from the spec, frame-ancestors
// 'none', and the sha256 of the one inline script (src/shell/early-inline.js) in script-src.
// `--fix` rewrites the hash in place after the early script changes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const early = readFileSync(join(root, 'src/shell/early-inline.js'), 'utf8').trim();
const hash = `'sha256-${createHash('sha256').update(early).digest('base64')}'`;
const vercelPath = join(root, 'vercel.json');
let raw = readFileSync(vercelPath, 'utf8');

const CONNECT =
  "connect-src 'self' https://api.curb.markets https://rpc.xlayer.tech https://xlayer.drpc.org https://archive.curb.markets";

const failures = [];
const config = JSON.parse(raw);
const csp = config.headers
  ?.flatMap((h) => h.headers ?? [])
  .find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;

if (!csp) failures.push('no Content-Security-Policy header in vercel.json');
else {
  const directives = csp.split(';').map((d) => d.trim());
  if (!directives.includes(CONNECT)) failures.push(`connect-src must be exactly:\n    ${CONNECT}`);
  if (!directives.includes("frame-ancestors 'none'")) failures.push("frame-ancestors 'none' missing");
  const scriptSrc = directives.find((d) => d.startsWith('script-src ')) ?? '';
  if (!scriptSrc.includes(hash)) {
    if (process.argv.includes('--fix')) {
      const next = scriptSrc.replace(/'sha256-[^']+'/, hash);
      raw = raw.replace(scriptSrc, next.includes(hash) ? next : `${scriptSrc} ${hash}`);
      writeFileSync(vercelPath, raw);
      console.log(`check-csp: wrote ${hash} into script-src`);
    } else {
      failures.push(`script-src is missing the early-script hash ${hash} (run with --fix)`);
    }
  }
  if (/'unsafe-eval'/.test(csp)) failures.push("'unsafe-eval' is not allowed");
}

if (!config.cleanUrls) failures.push('cleanUrls must be true');
const www = (config.redirects ?? []).some((r) => (r.has ?? []).some((h) => h.type === 'host' && /^www\./.test(h.value)));
if (!www) failures.push('www → apex redirect missing');

if (failures.length) {
  console.error('check-csp: FAIL\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('check-csp: ok (connect-src exact, frame-ancestors none, early-script hash present)');
