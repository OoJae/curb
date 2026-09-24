/**
 * ADAPTER — every assumption the /brand page makes about lane A lives in this file (and in the ADAPTER block at the
 * top of page.css). Written against the frozen spec before lane A's shell landed; reconcile names here on merge.
 *
 *   - src/shell/boot.ts exports `boot({ page })`, which mounts the masthead, regime chip, footer ledger, grain and
 *     favicon, and may return a promise.
 *   - The page's HTML entry (web/brand/index.html, lane A's stub) has a <main> element for the page body.
 *   - src/styles/tokens.css defines the colour tokens named in TOKENS below, the type scale --t-* and the font stacks.
 */
import { boot } from '../../shell/boot';

export async function startShell(): Promise<void> {
  await boot({ page: 'brand' });
}

/** Where the page renders. */
export function pageRoot(): HTMLElement {
  return (document.querySelector('main#main') ?? document.querySelector('main') ?? document.body) as HTMLElement;
}

/** The six brand colours: display name, the CSS custom property that holds it, and its role (spec §1). */
export const TOKENS = [
  { id: 'ink', name: 'Street ink', prop: '--ink', role: 'Ground when shut (the default); figure in paper mode.' },
  { id: 'ivory', name: 'Certificate ivory', prop: '--ivory', role: 'Figure on ink; ground in paper mode.' },
  { id: 'amber', name: 'Streetlamp', prop: '--streetlamp', role: 'One meaning only: trading while the exchange is shut. The arc, shut slots, the live “now”, focus on ink.' },
  { id: 'slate', name: 'Window slate', prop: '--slate', role: 'Secondary text on ink.' },
  { id: 'brass', name: 'Bell brass', prop: '--brass', role: 'Streetlamp’s twin in paper mode: signal text, links, focus.' },
  { id: 'graphite', name: 'Graphite', prop: '--graphite', role: 'Secondary text in paper mode.' },
] as const;

export type TokenId = (typeof TOKENS)[number]['id'];

/** The type scale (spec §1), largest first. */
export const TYPE_SCALE = [
  { prop: '--t-hero', use: 'Hero headline · Bodoni 400' },
  { prop: '--t-numeral', use: 'Static numerals · Bodoni' },
  { prop: '--t-h1', use: 'Page headline · Bodoni' },
  { prop: '--t-h2', use: 'Section headline · Bodoni' },
  { prop: '--t-lede', use: 'Lede · Franklin 400' },
  { prop: '--t-body', use: 'Body · Franklin 400' },
  { prop: '--t-small', use: 'Small · Franklin' },
  { prop: '--t-data', use: 'Data · Martian Mono 400' },
] as const;
