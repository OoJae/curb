/**
 * Guilloche — an epitrochoid rosette seeded from 32 bytes, the fingerprint engraved on every Curb certificate.
 *
 *   const g = guilloche(keccak256(toHex(tokenId, { size: 32 })));   // or the round's inputRoot
 *   el.innerHTML = guillocheSvg(seed, { stroke: 'var(--ivory)' });
 *
 * Pure: no DOM, no clock, no randomness. The same seed gives the same path data byte for byte, so a certificate can be
 * re-drawn from its tokenId anywhere. Every layer's parameters are read straight from the seed bytes:
 *
 *   byte 0              layers = 3 + b % 3                       (3–5)
 *   bytes 1+5i … 5+5i   R = 40 + b % 21   r = 3 + b % 7   d = 2 + b % 11   phase   band jitter
 *
 * Epitrochoid:  x = (R + r)·cos t − d·cos((R + r)/r · t),  y = (R + r)·sin t − d·sin((R + r)/r · t)
 * With integer R and r the curve closes after t = 2π·r/gcd(R, r) and has R/gcd(R, r) lobes. Each layer is scaled into
 * its own concentric band so the layers overlap into a moiré, as on a share certificate. Curves are emitted as cubic
 * Béziers built from the exact derivative (Hermite form), 8 per lobe.
 *
 * Strokes are 0.4 px: guillocheSvg() sets vector-effect="non-scaling-stroke" so they stay 0.4 px at any size.
 */

export interface GuillocheLayer {
  /** SVG path data centred on (0, 0), within ±size/2. */
  path: string;
  /** Fixed-circle radius, 40–60. */
  R: number;
  /** Rolling-circle radius, 3–9. */
  r: number;
  /** Pen distance from the rolling circle's centre, 2–12. */
  d: number;
  /** Number of lobes, R / gcd(R, r). */
  lobes: number;
  /** Rotation of the layer, radians. */
  phase: number;
  /** Outer radius the layer was scaled to, in path units. */
  outer: number;
}

export interface Guilloche {
  /** The 32-byte seed as 0x-prefixed lowercase hex. */
  seed: string;
  /** viewBox string for the rosette: `-size/2 -size/2 size size`. */
  viewBox: string;
  size: number;
  /** Stroke width in CSS px (use with vector-effect: non-scaling-stroke). */
  strokeWidth: number;
  layers: GuillocheLayer[];
}

export interface GuillocheOptions {
  /** Box size in path units (default 200: the rosette spans −100…100). */
  size?: number;
  /** Cubic segments per lobe (default 8). */
  segmentsPerLobe?: number;
  /** Decimal places in the path data (default 1). */
  precision?: number;
}

export const GUILLOCHE_STROKE = 0.4;

/** Parse a 0x-prefixed (or bare) hex string of at least 32 bytes into its first 32 bytes. */
export function seedBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(h) || h.length < 64) throw new Error('guilloche: seed must be 32 bytes of hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function num(n: number, p: number): string {
  let s = n.toFixed(p);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s.replace(/^(-?)0\./, '$1.');
}

/** Join numbers SVG-style: a minus sign or a leading "." after a fractional number needs no separator. */
function joinNums(parts: string[]): string {
  let out = '';
  let prev = '';
  for (const p of parts) {
    out += !out || p.startsWith('-') || (p.startsWith('.') && prev.includes('.')) ? p : ' ' + p;
    prev = p;
  }
  return out;
}

function layerPath(R: number, r: number, d: number, phase: number, scale: number, perLobe: number, p: number): { path: string; lobes: number } {
  const g = gcd(R, r);
  const lobes = R / g;
  const T = (2 * Math.PI * r) / g;
  const k = (R + r) / r;
  const n = lobes * perLobe;
  const cp = Math.cos(phase);
  const sp = Math.sin(phase);
  // position and derivative, rotated by phase and scaled
  const at = (t: number): [number, number, number, number] => {
    const x = (R + r) * Math.cos(t) - d * Math.cos(k * t);
    const y = (R + r) * Math.sin(t) - d * Math.sin(k * t);
    const dx = -(R + r) * Math.sin(t) + d * k * Math.sin(k * t);
    const dy = (R + r) * Math.cos(t) - d * k * Math.cos(k * t);
    return [scale * (x * cp - y * sp), scale * (x * sp + y * cp), scale * (dx * cp - dy * sp), scale * (dx * sp + dy * cp)];
  };
  const h = T / n;
  let [x0, y0, dx0, dy0] = at(0);
  let path = 'M' + joinNums([num(x0, p), num(y0, p)]);
  for (let i = 1; i <= n; i++) {
    const [x1, y1, dx1, dy1] = at(i * h);
    path +=
      'C' +
      joinNums([
        num(x0 + (dx0 * h) / 3, p),
        num(y0 + (dy0 * h) / 3, p),
        num(x1 - (dx1 * h) / 3, p),
        num(y1 - (dy1 * h) / 3, p),
        num(x1, p),
        num(y1, p),
      ]);
    [x0, y0, dx0, dy0] = [x1, y1, dx1, dy1];
  }
  return { path: path + 'Z', lobes };
}

/** Build the rosette for a 32-byte seed (keccak256 of a tokenId or an inputRoot). */
export function guilloche(seedHex: string, opts: GuillocheOptions = {}): Guilloche {
  const size = opts.size ?? 200;
  const perLobe = opts.segmentsPerLobe ?? 8;
  const p = opts.precision ?? 1;
  const b = seedBytes(seedHex);
  const byte = (i: number) => b[i] ?? 0; // seedBytes always returns 32
  const count = 3 + (byte(0) % 3);
  const half = size / 2;
  const layers: GuillocheLayer[] = [];
  for (let i = 0; i < count; i++) {
    const o = 1 + 5 * i;
    const R = 40 + (byte(o) % 21);
    const r = 3 + (byte(o + 1) % 7);
    const d = 2 + (byte(o + 2) % 11);
    const lobes = R / gcd(R, r);
    const phase = (byte(o + 3) / 256) * ((2 * Math.PI) / lobes);
    // concentric bands from the rim inwards, each nudged by up to ±3 % of the radius
    const jitter = (byte(o + 4) / 255 - 0.5) * 0.06;
    const outer = half * (1 - i * (0.5 / count) + (i === 0 ? Math.min(0, jitter) : jitter));
    const scale = outer / (R + r + d);
    const lp = layerPath(R, r, d, phase, scale, perLobe, p);
    layers.push({ path: lp.path, R, r, d, lobes: lp.lobes, phase, outer });
  }
  const seed = '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return { seed, viewBox: `${-half} ${-half} ${size} ${size}`, size, strokeWidth: GUILLOCHE_STROKE, layers };
}

export interface GuillocheSvgOptions extends GuillocheOptions {
  /** Stroke colour; any CSS colour or var() (default currentColor). */
  stroke?: string;
  /** Opacity of the whole rosette (default 1). */
  opacity?: number;
  /** Extra attributes on <svg>, e.g. 'class="nt-rosette" aria-hidden="true"'. */
  attrs?: string;
}

/** The rosette as standalone SVG markup (0.4 px non-scaling strokes, no fill). */
export function guillocheSvg(seedHex: string, opts: GuillocheSvgOptions = {}): string {
  const g = guilloche(seedHex, opts);
  const stroke = opts.stroke ?? 'currentColor';
  const op = opts.opacity ?? 1;
  // vector-effect is not inherited, so it goes on every path.
  const paths = g.layers.map((l) => `<path vector-effect="non-scaling-stroke" d="${l.path}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${g.viewBox}" ${opts.attrs ?? 'aria-hidden="true"'}>` +
    `<g fill="none" stroke="${stroke}" stroke-width="${g.strokeWidth}"${op === 1 ? '' : ` opacity="${op}"`} data-seed="${g.seed}">` +
    paths +
    `</g></svg>`
  );
}
