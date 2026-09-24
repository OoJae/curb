// Shared helpers for the OG / social templates. Served by og/render.mjs (which strips types from .ts on the fly).
import { guillocheSvg } from '/src/certificate/guilloche.ts';
import { isOpen, SLOTS, SLOTS_PER_DAY } from '/og/brand/week.mjs';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const tokens = () => ({
  ink: css('--og-ink'),
  ivory: css('--og-ivory'),
  amber: css('--og-amber'),
  slate: css('--og-slate'),
  hair: css('--og-hair'),
});

/** Decorative seed for a template: SHA-256 of "curb:og:<slug>" (certificates use keccak of tokenId / inputRoot). */
export async function seedFor(slug) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('curb:og:' + slug));
  return '0x' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function guillocheInto(el, seed) {
  el.innerHTML = guillocheSvg(seed.startsWith('0x') && seed.length >= 66 ? seed : await seedFor(seed), { stroke: 'currentColor' });
}

/** Resolve a CSS colour (including color-mix / var) to an rgb() string canvas understands. */
function resolveColor(c) {
  const probe = document.createElement('i');
  probe.style.color = c;
  document.body.append(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/**
 * The Week Ring on a canvas: 2,016 slots of the HK week; ivory = primary market open, Streetlamp = shut but still
 * trading. Now sits at three o'clock and time runs clockwise. dimPast draws past slots at 70 % value (the live ring);
 * the static images default to the whole week at full value with now = Mon 00:00 HKT.
 * At OG sizes a slot is under a pixel, so slots of one state are drawn as a single run (blades = false) with a hair of
 * ink at every change of state and at midnight — ivory never touches Streetlamp. blades = true draws the 2,016
 * separate blades (for large renders). Drawn at 2x and shown at 1x.
 */
export function weekRing(canvas, opts = {}) {
  if (opts.blades) return weekRingBlades(canvas, opts);
  const { size, now = 0, inner = 0.84, outer = 1.0, needle = true, gapPx = 1.4, dimPast = false } = opts;
  const t = tokens();
  const S = 2;
  canvas.width = canvas.height = size * S;
  canvas.style.width = canvas.style.height = size + 'px';
  const g = canvas.getContext('2d');
  g.scale(S, S);
  const c = size / 2;
  const R = (size / 2) * (needle ? 0.86 : 0.98);
  const colour = (open, past) =>
    resolveColor(past ? `color-mix(in oklab, ${open ? t.ivory : t.amber} 70%, ${t.ink})` : open ? t.ivory : t.amber);
  const step = (2 * Math.PI) / SLOTS;
  const half = gapPx / 2 / (R * (inner + outer) / 2);
  // runs split at state changes, midnights and "now"
  let start = 0;
  for (let i = 1; i <= SLOTS; i++) {
    if (i === SLOTS || isOpen(i) !== isOpen(start) || i % SLOTS_PER_DAY === 0 || i === now) {
      const a0 = (start - now - 0.5) * step + half;
      const a1 = (i - now - 0.5) * step - half;
      g.fillStyle = colour(isOpen(start), dimPast && start < now);
      g.beginPath();
      g.arc(c, c, R * outer, a0, a1);
      g.arc(c, c, R * inner, a1, a0, true);
      g.closePath();
      g.fill();
      start = i;
    }
  }
  if (needle) {
    g.fillStyle = resolveColor(t.amber);
    const len0 = R * (inner - 0.06);
    const len1 = R * (outer + 0.12);
    g.fillRect(c + len0, c - 1.25, len1 - len0, 2.5);
  }
  return { R, center: c };
}

function weekRingBlades(canvas, { size, now = 1400, inner = 0.84, outer = 1.0, needle = true, fill = 0.83 } = {}) {
  const t = tokens();
  const S = 2;
  canvas.width = canvas.height = size * S;
  canvas.style.width = canvas.style.height = size + 'px';
  const g = canvas.getContext('2d');
  g.scale(S, S);
  const c = size / 2;
  const R = (size / 2) * (needle ? 0.86 : 0.98);
  const col = {
    open: resolveColor(t.ivory),
    shut: resolveColor(t.amber),
    openPast: resolveColor(`color-mix(in oklab, ${t.ivory} 70%, ${t.ink})`),
    shutPast: resolveColor(`color-mix(in oklab, ${t.amber} 70%, ${t.ink})`),
  };
  const step = (2 * Math.PI) / SLOTS;
  const w = step * fill;
  for (let i = 0; i < SLOTS; i++) {
    const a = (i - now) * step; // clockwise on screen = forward in time; now at +X
    const past = i < now;
    g.fillStyle = isOpen(i) ? (past ? col.openPast : col.open) : past ? col.shutPast : col.shut;
    g.beginPath();
    g.arc(c, c, R * outer, a - w / 2, a + w / 2);
    g.arc(c, c, R * inner, a + w / 2, a - w / 2, true);
    g.closePath();
    g.fill();
  }
  if (needle) {
    g.fillStyle = col.shut;
    const len0 = R * (inner - 0.06);
    const len1 = R * (outer + 0.12);
    g.fillRect(c + len0, c - 1.25, len1 - len0, 2.5);
  }
  return { R, center: c };
}

/** The week as a strip of seven day blocks (SVG), with day labels underneath. */
export function slotStrip({ width, height = 36, labels = true, now = null }) {
  const t = tokens();
  const u = width / SLOTS;
  let amber = '';
  let ivory = '';
  let start = 0;
  for (let i = 1; i <= SLOTS; i++) {
    if (i === SLOTS || isOpen(i) !== isOpen(start) || i % SLOTS_PER_DAY === 0) {
      const x = (start + 1) * u;
      const w = (i - start - 2) * u;
      if (w > 0) {
        const seg = `M${x.toFixed(2)} 0h${w.toFixed(2)}v${height}h${(-w).toFixed(2)}z`;
        if (isOpen(start)) ivory += seg;
        else amber += seg;
      }
      start = i;
    }
  }
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const lab = labels
    ? days
        .map((d, i) => `<text x="${(i * SLOTS_PER_DAY * u + 2).toFixed(1)}" y="${height + 24}" fill="${t.slate}">${d}</text>`)
        .join('')
    : '';
  const nowMark =
    now == null ? '' : `<rect x="${(now * u - 1).toFixed(1)}" y="-10" width="2" height="${height + 20}" fill="${t.amber}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + (labels ? 32 : 0)}" style="display:block;overflow:visible;font:15px var(--og-data);font-stretch:87%">` +
    `<rect width="${width}" height="${height}" fill="${t.ink}"/><path fill="${t.amber}" d="${amber}"/><path fill="${t.ivory}" d="${ivory}"/>${nowMark}${lab}</svg>`
  );
}

/** Signal the renderer once fonts and images are in. */
export async function ready() {
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  window.__ogReady = true;
}
