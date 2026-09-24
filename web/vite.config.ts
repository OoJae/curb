import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { faviconSVG } from './src/shell/mark.ts';
import { footerHTML, isPageId, mastheadHTML } from './src/shell/markup.ts';

const root = dirname(fileURLToPath(import.meta.url));

/** Every page entry, registered up front (spec §4). Page lanes own the contents, A owns this list. */
const pages = {
  home: 'index.html',
  clock: 'clock/index.html',
  scorecard: 'scorecard/index.html',
  api: 'api/index.html',
  notes: 'notes/index.html',
  depth: 'depth/index.html',
  brand: 'brand/index.html',
  notFound: '404.html',
} as const;

/** The only inline script: sets data-regime / data-capture before first paint. Its hash is in the CSP. */
const EARLY = readFileSync(resolve(root, 'src/shell/early-inline.js'), 'utf8').trim();
export const EARLY_HASH = `'sha256-${createHash('sha256').update(EARLY).digest('base64')}'`;

const SPECULATION = JSON.stringify({
  prefetch: [{ where: { and: [{ href_matches: '/*' }, { not: { href_matches: '/*\\?*' } }] }, eagerness: 'moderate' }],
});

function publicFile(p: string): boolean {
  return existsSync(resolve(root, 'public', p));
}

/** Dev/preview parity with Vercel `cleanUrls` + `trailingSlash: false`: /clock serves clock/index.html. */
const CLEAN = new Set(['/clock', '/scorecard', '/api', '/notes', '/depth', '/brand', '/404']);
type Next = () => void;
function cleanUrls(req: { url?: string }, _res: unknown, next: Next): void {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q);
  if (CLEAN.has(path)) req.url = path === '/404' ? `/404.html${query}` : `${path}/${query}`;
  next();
}

/**
 * curb-shell: writes the static shell (head tags, masthead, footer ledger, grain) into every page
 * so it is present on first paint. Pages mark themselves with <body data-page="…">.
 */
function curbShell(): Plugin {
  return {
    name: 'curb-shell',
    configureServer(server) {
      server.middlewares.use(cleanUrls);
    },
    configurePreviewServer(server) {
      server.middlewares.use(cleanUrls);
    },
    configResolved(config) {
      if (config.command !== 'build') return;
      const vercel = readFileSync(resolve(root, 'vercel.json'), 'utf8');
      if (!vercel.includes(EARLY_HASH)) {
        throw new Error(
          `curb-shell: vercel.json CSP is missing the hash of src/shell/early-inline.js.\n` +
            `  Put ${EARLY_HASH} in script-src (or run: node scripts/check-csp.mjs --fix).`,
        );
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const m = html.match(/<body[^>]*\sdata-page="([^"]+)"/);
        const page = m?.[1];
        if (!isPageId(page)) {
          throw new Error(`curb-shell: ${ctx.filename} needs <body data-page="home|clock|scorecard|api|notes|depth|brand|404">`);
        }
        // Favicons: lane F's files when present, otherwise inline SVG built from the mark.
        const shutIcon = publicFile('favicon-shut.svg') ? '/favicon-shut.svg' : faviconSVG('shut');
        const openIcon = publicFile('favicon-open.svg') ? '/favicon-open.svg' : faviconSVG('open');
        const baseIcon = publicFile('favicon.svg') ? '/favicon.svg' : shutIcon;
        const head = [
          `<script>${EARLY}</script>`,
          `<meta name="color-scheme" content="dark light">`,
          `<meta name="theme-color" content="#0F1720">`, // lint-tokens-ignore (Street ink)
          `<link rel="preload" href="/fonts/bodoni-moda.woff2" as="font" type="font/woff2" crossorigin>`,
          `<link rel="preload" href="/fonts/libre-franklin.woff2" as="font" type="font/woff2" crossorigin>`,
          `<link rel="icon" type="image/svg+xml" href="${baseIcon}" data-favicon data-open="${openIcon}" data-shut="${shutIcon}">`,
          publicFile('favicon.ico') ? `<link rel="icon" href="/favicon.ico" sizes="32x32">` : '',
          publicFile('apple-touch-icon.png') ? `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` : '',
          publicFile('site.webmanifest') ? `<link rel="manifest" href="/site.webmanifest">` : '',
          `<link rel="expect" href="#main" blocking="render">`,
          `<script type="speculationrules">${SPECULATION}</script>`,
        ]
          .filter(Boolean)
          .join('\n    ');

        let out = html.replace(/<head>/i, `<head>\n    ${head}`);
        const masthead = mastheadHTML(page);
        const footer = footerHTML(page);
        out = out.includes('<!--shell:masthead-->')
          ? out.replace('<!--shell:masthead-->', masthead)
          : out.replace(/(<body[^>]*>)/i, `$1\n${masthead}`);
        out = out.includes('<!--shell:footer-->')
          ? out.replace('<!--shell:footer-->', footer)
          : out.replace(/<\/main>/i, `</main>\n${footer}`);
        return out;
      },
    },
  };
}

export default defineConfig({
  appType: 'mpa',
  plugins: [curbShell()],
  build: {
    target: 'es2022',
    cssTarget: ['chrome111', 'safari16.4', 'firefox128'],
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, resolve(root, v)])),
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
