/**
 * Read design tokens at runtime (the ring, canvases and /brand read colours from tokens.css
 * instead of repeating hex values).
 *
 *   cssVar('--streetlamp')            → "#F5A524"
 *   cssVar('--ground')                → the current regime's ground
 *   cssVar('--figure', inkWindowEl)   → resolved on a specific element (e.g. inside .surface-ink)
 */

export interface ColourToken {
  token: '--ink' | '--ivory' | '--streetlamp' | '--slate' | '--brass' | '--graphite';
  name: string;
  role: string;
}

/** The six colours, in spec order (values live only in tokens.css). */
export const COLOUR_TOKENS: readonly ColourToken[] = [
  { token: '--ink', name: 'Street ink', role: 'Ground when shut; figure in paper mode' },
  { token: '--ivory', name: 'Certificate ivory', role: 'Figure on ink; ground in paper mode' },
  { token: '--streetlamp', name: 'Streetlamp', role: 'Trading while the exchange is shut. Only on ink' },
  { token: '--slate', name: 'Window slate', role: 'Secondary text on ink' },
  { token: '--brass', name: 'Bell brass', role: 'Signal text, links and focus in paper mode' },
  { token: '--graphite', name: 'Graphite', role: 'Secondary text in paper mode' },
];

/** The computed value of a custom property (var() references substituted), trimmed. */
export function cssVar(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** A token as a number for WebGL (e.g. three.js Color): "#F5A524" → 0xf5a524. Hex tokens only. */
export function cssHex(name: string, el: Element = document.documentElement): number {
  const v = cssVar(name, el);
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) throw new Error(`cssHex: ${name} is "${v}", not a 6-digit hex token`);
  return parseInt(m[1]!, 16);
}
