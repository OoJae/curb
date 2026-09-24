// Bundle sizes that matter for the budgets (spec §4): the lazy three chunk, and the home page's own JS with the
// libraries lane A's shell already ships (gsap, ScrollTrigger, lenis) left external. Usage: node scripts/size.mjs
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const lab = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  configFile: join(lab, 'vite.config.ts'),
  logLevel: 'silent',
  build: {
    write: false,
    rolldownOptions: {
      input: { home: join(lab, '../../src/pages/home/page.ts') },
      external: [/^gsap/, /^lenis/],
    },
  },
});
const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
let initial = 0;
for (const o of outputs) {
  if (o.type !== 'chunk' && !o.fileName.endsWith('.css')) continue;
  const code = o.type === 'chunk' ? o.code : o.source;
  const gz = gzipSync(code).length / 1024;
  const lazy = o.type === 'chunk' && !o.isEntry && !outputs.some((c) => c.type === 'chunk' && c.isEntry && c.imports.includes(o.fileName));
  if (!lazy) initial += gz;
  console.log(`${(lazy ? 'lazy   ' : 'initial').padEnd(8)} ${o.fileName.padEnd(40)} ${(code.length / 1024).toFixed(1).padStart(7)} KB  ${gz.toFixed(1).padStart(6)} KB gz`);
}
console.log(`home page's own initial JS+CSS (gsap/lenis external): ${initial.toFixed(1)} KB gz`);
