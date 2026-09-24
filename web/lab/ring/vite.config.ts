/**
 * Week Ring lab (lane C): the ring alone, with a progress slider, for tuning, screenshots, the poster render and
 * fps traces. `npx vite web/lab/ring` (from curb/) or `npm run dev` here. Modules and dependencies come from
 * web/ itself (web/node_modules); this folder only adds Playwright and sharp for the scripts.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const lab = dirname(fileURLToPath(import.meta.url));
const web = resolve(lab, '../..');

export default defineConfig({
  root: lab,
  publicDir: join(web, 'public'),
  server: { port: 5178, strictPort: false, fs: { allow: [web] } },
  build: { outDir: join(lab, 'dist'), emptyOutDir: true, target: 'es2022' },
});
