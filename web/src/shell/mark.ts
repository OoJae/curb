/**
 * The Curb mark and the three regime glyphs, as SVG strings built from the construction in the
 * spec (§1 "Mark and iconography"). Pure functions, no DOM: used at build time by the HTML
 * plugin in vite.config.ts and at runtime by the shell.
 *
 * Construction, measured from the published avatar (script/asp/curb-avatar.png; web/og/brand/
 * measure-avatar.py, 0.06 px rms), in units of the C's centreline radius R (= 100 user units here):
 *   C       = 236° of arc, 124° gap centred due east (ends radial at ±62°), stroke 0.434 R
 *   amber   = concentric arc at radius 1.00 R, thickness 0.191 R, spanning 92° (±46°) centred east
 *   ink gap = 16° between the amber arc and each end of the C (62° − 46°)
 * The gap always faces east (forward in time); the whole mark is never rotated.
 */

export const MARK = {
  R: 100,
  cHalfGapDeg: 62,
  cStroke: 0.434,
  arcRadius: 1.0,
  arcThickness: 0.191,
  arcHalfSpanDeg: 46,
} as const;

/** Outer radius of the mark (the C's outer edge) in user units. */
export const MARK_OUTER = MARK.R * (1 + MARK.cStroke / 2);

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(2).replace(/\.?0+$/, ''));
const rad = (deg: number) => (deg * Math.PI) / 180;
/** Point at angle θ (degrees, counter-clockwise from east) and radius r, in SVG (y-down) space. */
const pt = (r: number, deg: number) => `${f(r * Math.cos(rad(deg)))} ${f(-r * Math.sin(rad(deg)))}`;

/**
 * Annular sector with radial ends, drawn counter-clockwise from `fromDeg` to `toDeg` (degrees,
 * counter-clockwise from east; `toDeg` > `fromDeg`).
 */
export function sectorPath(rIn: number, rOut: number, fromDeg: number, toDeg: number): string {
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  // outer: from → to counter-clockwise on screen (sweep 0); inner: back clockwise (sweep 1)
  return `M${pt(rOut, fromDeg)}A${f(rOut)} ${f(rOut)} 0 ${large} 0 ${pt(rOut, toDeg)}L${pt(rIn, toDeg)}A${f(rIn)} ${f(rIn)} 0 ${large} 1 ${pt(rIn, fromDeg)}Z`;
}

/** Symmetric sector about the east axis: through the east (the arc) or through the west (the C). */
function sector(rIn: number, rOut: number, halfDeg: number, throughEast: boolean): string {
  return throughEast ? sectorPath(rIn, rOut, -halfDeg, halfDeg) : sectorPath(rIn, rOut, halfDeg, 360 - halfDeg);
}

const C_IN = MARK.R * (1 - MARK.cStroke / 2);
const C_OUT = MARK.R * (1 + MARK.cStroke / 2);

/** Upper and lower halves of the C (split due west), for the tx "confirmed" close. */
/** A closed ring at the C's radii: the "open" glyph, and what a confirmed transaction resolves to. */
export const RING_PATH = sectorPath(C_IN, C_OUT, 0, 180) + ' ' + sectorPath(C_IN, C_OUT, 180, 360);
export const C_TOP_PATH = sectorPath(C_IN, C_OUT, MARK.cHalfGapDeg, 180);
export const C_BOTTOM_PATH = sectorPath(C_IN, C_OUT, 180, 360 - MARK.cHalfGapDeg);

/** SVG path data for the C (236°, gap east). */
export const C_PATH = sector(C_IN, C_OUT, MARK.cHalfGapDeg, false);

/** SVG path data for the amber arc (92°, centred east). */
export const ARC_PATH = sector(
  MARK.R * (MARK.arcRadius - MARK.arcThickness / 2),
  MARK.R * (MARK.arcRadius + MARK.arcThickness / 2),
  MARK.arcHalfSpanDeg,
  true,
);

export const MARK_VIEWBOX = `${f(-MARK_OUTER)} ${f(-MARK_OUTER)} ${f(2 * MARK_OUTER)} ${f(2 * MARK_OUTER)}`;

export interface MarkOptions {
  /** Rendered size in CSS px (width = height). Omit to size with CSS. */
  size?: number;
  /** Accessible name; omit for a decorative mark (aria-hidden). */
  title?: string;
  /** Extra class names on the <svg>. */
  className?: string;
  /** Colours; default to CSS custom properties so the mark follows the surface. */
  figure?: string;
  arc?: string;
  /** Render only one layer (the masthead splits them so the arc can step in view transitions). */
  layer?: 'both' | 'c' | 'arc';
}

function svgOpen(o: MarkOptions, extraClass: string): string {
  const cls = ['mark', extraClass, o.className].filter(Boolean).join(' ');
  const size = o.size ? ` width="${o.size}" height="${o.size}"` : '';
  const a11y = o.title ? ` role="img" aria-label="${o.title.replace(/"/g, '&quot;')}"` : ' aria-hidden="true" focusable="false"';
  return `<svg class="${cls}" viewBox="${MARK_VIEWBOX}"${size}${a11y} xmlns="http://www.w3.org/2000/svg">`;
}

/** The mark: ivory C + Streetlamp arc. Sits on ink; on paper, wrap it in an ink tile (.mark-tile). */
export function markSVG(o: MarkOptions = {}): string {
  const figure = o.figure ?? 'var(--ivory)';
  const arc = o.arc ?? 'var(--streetlamp)';
  const layer = o.layer ?? 'both';
  const c = layer !== 'arc' ? `<path class="mark__c" d="${C_PATH}" fill="${figure}"/>` : '';
  const a = layer !== 'c' ? `<path class="mark__arc" d="${ARC_PATH}" fill="${arc}"/>` : '';
  return `${svgOpen(o, layer === 'arc' ? 'mark--arc' : '')}${c}${a}</svg>`;
}

export type GlyphRegime = 'open' | 'shut' | 'unknown';

/**
 * Regime glyphs, the site's only icons:
 *   open    = closed ring O (cap > 0)
 *   shut    = C + amber arc (shut but trading)
 *   unknown = dotted ring (stale / no attestation)
 */
export function glyphSVG(regime: GlyphRegime, o: MarkOptions = {}): string {
  if (regime === 'shut') return markSVG({ ...o, className: ['glyph glyph--shut', o.className].filter(Boolean).join(' ') });
  const stroke = MARK.R * MARK.cStroke;
  const cls = ['glyph', `glyph--${regime}`, o.className].filter(Boolean).join(' ');
  const open = svgOpen({ ...o, className: cls }, '');
  if (regime === 'open') {
    return `${open}<circle cx="0" cy="0" r="${MARK.R}" fill="none" stroke="${o.figure ?? 'currentColor'}" stroke-width="${f(stroke)}"/></svg>`;
  }
  // 12 dots round the centreline: one per five minutes of an hour.
  const circumference = 2 * Math.PI * MARK.R;
  const dot = stroke * 0.62;
  return `${open}<circle cx="0" cy="0" r="${MARK.R}" fill="none" stroke="${o.figure ?? 'currentColor'}" stroke-width="${f(dot)}" stroke-linecap="round" stroke-dasharray="0 ${f(circumference / 12)}" transform="rotate(-90)"/></svg>`;
}

/** A standalone favicon SVG document for a regime (fallback until lane F's files exist). */
export function faviconSVG(regime: 'open' | 'shut'): string {
  const ink = '%230F1720'; // lint-tokens-ignore (URL-encoded token value for a data: URI)
  const ivory = '%23F4EFE6'; // lint-tokens-ignore
  const lamp = '%23F5A524'; // lint-tokens-ignore
  const pad = MARK_OUTER * 0.32;
  const s = MARK_OUTER + pad;
  const vb = `${f(-s)} ${f(-s)} ${f(2 * s)} ${f(2 * s)}`;
  const body =
    regime === 'open'
      ? `<rect x="${f(-s)}" y="${f(-s)}" width="${f(2 * s)}" height="${f(2 * s)}" rx="${f(s * 0.12)}" fill="${ivory}"/><circle r="${MARK.R}" fill="none" stroke="${ink}" stroke-width="${f(MARK.R * MARK.cStroke)}"/>`
      : `<rect x="${f(-s)}" y="${f(-s)}" width="${f(2 * s)}" height="${f(2 * s)}" rx="${f(s * 0.12)}" fill="${ink}"/><path d="${C_PATH}" fill="${ivory}"/><path d="${ARC_PATH}" fill="${lamp}"/>`;
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='${vb}'>${body.replace(/"/g, "'")}</svg>`;
}
