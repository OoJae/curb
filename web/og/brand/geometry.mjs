// Curb mark geometry — the single source for every mark, glyph, favicon and icon file.
//
// Measured from script/asp/curb-avatar.png (512 px; C centred at 256,256, centreline radius 143.94 px):
//   C      outer 174.75  inner 113.13  → stroke 61.6 px = 0.428 R; ends cut radially at ±62.0° → 236° of arc, 124° gap
//   amber  130.0 … 157.6 px about the C's centre (concentric) → centreline 1.00 R, thickness 0.19 R, ends at ±46.05° → 92°
//   ink between the amber arc and each end of the C: 16°
// Where the frozen spec's numbers agree with the avatar to ≤2 px they are used as written (stroke 0.42, amber 0.20 thick).
// Where they do not (C 250°/110° gap, amber 96° at radius 1.09) the avatar wins: those would move the C's ends by ~21 px
// and the arc by ~13 px on the 512 px avatar. See _check/ and the lane F report.
//
// Units: R = the C's centreline radius. Angles in degrees, 0 = due east, counter-clockwise positive (y up).

export const COLORS = {
  ink: '#0F1720', // Street ink
  ivory: '#F4EFE6', // Certificate ivory
  amber: '#F5A524', // Streetlamp
  slate: '#8A96A3', // Window slate
  brass: '#8A5A00', // Bell brass
  graphite: '#5B6470', // Graphite
};

export const MARK = {
  stroke: 0.42, // C stroke ÷ R (0.79 R … 1.21 R)
  cHalfGap: 62, // C ends at ±62° → 236° of arc, 124° gap centred due east
  arcR: 1.0, // amber arc centreline ÷ R (rides the C's centreline)
  arcT: 0.2, // amber thickness ÷ R
  arcHalf: 46, // amber spans ±46° → 92° centred due east (16° of ink to each end of the C)
  tile: 512 / 144, // ink tile side ÷ R (the avatar: 512 px tile, R 144)
};

// Optical variant for 16–48 px (glyphs, favicons), tuned on the 16 px grid at R = 5.5: C 4.5…6.5 (2 px stroke),
// amber 5.0…6.5 so its east face lands on whole pixels at 16 and 32 px, and the arc shortened to ±40° so 22° of ink
// separates it from the C's ends (at 16 px the full-size 16° closes up).
export const MARK_SMALL = { ...MARK, stroke: 2 / 5.5, arcR: 5.75 / 5.5, arcT: 1.5 / 5.5, arcHalf: 40 };

const f = (n) => {
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const pt = (cx, cy, r, deg) => {
  const t = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(t), cy - r * Math.sin(t)];
};

/** Annular sector from angle a0 to a1 (CCW, a1 > a0), radii ri < ro, as SVG path data. */
export function sector(cx, cy, ri, ro, a0, a1) {
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = pt(cx, cy, ro, a0);
  const [x1, y1] = pt(cx, cy, ro, a1);
  const [x2, y2] = pt(cx, cy, ri, a1);
  const [x3, y3] = pt(cx, cy, ri, a0);
  return (
    `M${f(x0)} ${f(y0)}A${f(ro)} ${f(ro)} 0 ${large} 0 ${f(x1)} ${f(y1)}` +
    `L${f(x2)} ${f(y2)}A${f(ri)} ${f(ri)} 0 ${large} 1 ${f(x3)} ${f(y3)}Z`
  );
}

/** Full ring (annulus) as one path; the inner circle winds the other way, so it is a hole under either fill rule. */
export function ring(cx, cy, ri, ro) {
  const c = (r, s) =>
    `M${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${s} ${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${s} ${f(cx + r)} ${f(cy)}Z`;
  return c(ro, 0) + c(ri, 1);
}

/** The C and the amber arc for a mark centred at (cx, cy) with centreline radius R. */
export function markPaths(cx, cy, R, m = MARK) {
  const h = (m.stroke * R) / 2;
  const a = (m.arcT * R) / 2;
  return {
    c: sector(cx, cy, R - h, R + h, m.cHalfGap, 360 - m.cHalfGap),
    arc: sector(cx, cy, m.arcR * R - a, m.arcR * R + a, -m.arcHalf, m.arcHalf),
    ring: ring(cx, cy, R - h, R + h),
    outer: R + h,
  };
}

/** Dotted ring: n dots on the centreline, diameter = stroke. */
export function dots(cx, cy, R, n, dotR, startDeg = 90) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(cx, cy, R, startDeg + (360 / n) * i);
    d += `M${f(x - dotR)} ${f(y)}a${f(dotR)} ${f(dotR)} 0 1 0 ${f(2 * dotR)} 0a${f(dotR)} ${f(dotR)} 0 1 0 ${f(-2 * dotR)} 0Z`;
  }
  return d;
}

export { f as fmt };
