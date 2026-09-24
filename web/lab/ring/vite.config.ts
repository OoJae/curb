/**
 * Week Ring lab (lane C). Standalone: `npx vite web/lab/ring` (from curb/), or `npm run dev` in this folder.
 *
 * Two resolver rules keep it independent of lane A's web/package.json:
 *  1. Bare imports from web/src/** (three, gsap, lenis) resolve from this lab's node_modules.
 *  2. Relative imports from web/src/** into lane A/B modules that do not exist yet (shell/, motion/, data/, ui/)
 *     fall through to ./stubs/src/<same path>. Once the real module exists, it wins automatically.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const lab = dirname(fileURLToPath(import.meta.url));
const web = resolve(lab, '../..');
const webSrc = join(web, 'src');
const findFile = (base: string) =>
  [base, `${base}.ts`, join(base, 'index.ts')].find((f) => existsSync(f) && statSync(f).isFile());

function labResolve(): Plugin {
  return {
    name: 'curb-lab-resolve',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(webSrc)) return null;
      if (/^[a-z@]/i.test(source) && !source.startsWith('/')) {
        return this.resolve(source, join(lab, 'index.html'), { ...options, skipSelf: true });
      }
      if (source.startsWith('.')) {
        const abs = resolve(dirname(importer), source);
        if (!abs.startsWith(webSrc) || findFile(abs)) return null;
        return findFile(join(lab, 'stubs/src', relative(webSrc, abs))) ?? null;
      }
      return null;
    },
  };
}

export default defineConfig({
  root: lab,
  publicDir: join(web, 'public'),
  plugins: [labResolve()],
  server: { port: 5178, strictPort: false, fs: { allow: [web] } },
  preview: { port: 5179 },
  build: {
    outDir: join(lab, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: {
        lab: join(lab, 'index.html'),
        home: join(lab, 'home.html'),
      },
    },
  },
});
