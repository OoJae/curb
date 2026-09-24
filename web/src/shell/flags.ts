/**
 * URL flags, read once per page load:
 *   ?regime=open|shut   force the displayed regime (captures, reviews). Also skips the chip toggle.
 *   ?mock=1             pages and lane B's data layer render from fixtures (no network)
 *   ?capture=1          video capture: hides the chip popover, cursor and hover effects; exposes
 *                       window.__curb for scripted scrolling (lenis.scrollTo)
 * Internal links built with `withFlags()` carry these flags across navigations.
 */

export type ForcedRegime = 'open' | 'shut';

export interface Flags {
  regime: ForcedRegime | null;
  mock: boolean;
  capture: boolean;
}

function truthy(v: string | null): boolean {
  return v !== null && v !== '0' && v !== 'false';
}

export function parseFlags(search: string): Flags {
  const q = new URLSearchParams(search);
  const r = q.get('regime');
  return {
    regime: r === 'open' || r === 'shut' ? r : null,
    mock: truthy(q.get('mock')),
    capture: truthy(q.get('capture')),
  };
}

export const flags: Flags = typeof location === 'undefined' ? { regime: null, mock: false, capture: false } : parseFlags(location.search);

/** Append the active flags to an internal href ("/clock" → "/clock?mock=1"). External hrefs pass through. */
export function withFlags(href: string, f: Flags = flags): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const [pathAndQuery = '', hash = ''] = href.split('#');
  const [path = '', query = ''] = pathAndQuery.split('?');
  const q = new URLSearchParams(query);
  if (f.regime && !q.has('regime')) q.set('regime', f.regime);
  if (f.mock && !q.has('mock')) q.set('mock', '1');
  if (f.capture && !q.has('capture')) q.set('capture', '1');
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`;
}
