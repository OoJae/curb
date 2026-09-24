// Rendered-ivory check: sample the C band at rest along its centreline and report ΔE2000 vs the ivory token.
import { LAB, launch, waitReady } from './browser.mjs';

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function lab([r, g, b]) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function de2000(a, b) {
  const [L1, a1, b1] = a, [L2, a2, b2] = b, rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (x, y) => { const t = Math.atan2(y, x) / rad; return t < 0 ? t + 360 : t; };
  const h1 = h(a1p, b1), h2 = h(a2p, b2);
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = h2 - h1; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hm = h1 + h2; if (C1p * C2p !== 0) hm = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cpm, SH = 1 + 0.015 * Cpm * T;
  const RT = -2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${LAB}/?p=0`);
await waitReady(page);
const ivory = hexToRgb('#F4EFE6');
const amber = hexToRgb('#F5A524');
// Face-on at rest: 1 world unit = (h/2)/(6.2·tan 14°) px. The centreline is R = 1; the arc's is R = 1.00 (shell/mark.ts).
const unit = 0.5 / (6.2 * Math.tan((14 * Math.PI) / 180));
const rows = [];
for (const deg of [90, 120, 150, 180, 210, 240, 270]) {
  const u = 0.5 + Math.cos((deg * Math.PI) / 180) * unit;
  const v = 0.5 + Math.sin((deg * Math.PI) / 180) * unit;
  const px = await page.evaluate(([u, v]) => window.__lab.probe(u, v), [u, v]);
  rows.push(['band', deg, px.slice(0, 3).map(Math.round), de2000(lab(ivory), lab(px))]);
}
for (const deg of [-30, 0, 30]) {
  const u = 0.5 + Math.cos((deg * Math.PI) / 180) * unit;
  const v = 0.5 + Math.sin((deg * Math.PI) / 180) * unit * 1.0;
  const px = await page.evaluate(([u, v]) => window.__lab.probe(u, v), [u, v]);
  rows.push(['arc', deg, px.slice(0, 3).map(Math.round), de2000(lab(amber), lab(px))]);
}
for (const r of rows) console.log(r[0].padEnd(5), String(r[1]).padStart(4) + '°', JSON.stringify(r[2]).padEnd(16), 'ΔE2000', r[3].toFixed(2));
const band = rows.filter((r) => r[0] === 'band').map((r) => r[3]);
console.log('band ΔE2000 median', band.sort((a, b) => a - b)[band.length >> 1].toFixed(2), 'max', Math.max(...band).toFixed(2));

// Final state: blade colours (future/past × open/shut), sampled on the ring at R = 1 through the dial camera.
await page.goto(`${LAB}/?p=1&now=1120`);
await waitReady(page);
const res = await page.evaluate(() => {
  const L = window.__lab;
  const { slots, nowIndex } = L.week;
  const pick = (past, shut) => {
    for (let i = past ? 20 : nowIndex + 200; i < (past ? nowIndex - 20 : 2000); i += 3) {
      if ([...Array(9)].every((_, j) => slots[i - 4 + j] === (shut ? 1 : 0))) return i;
    }
    return -1;
  };
  const out = {};
  L.probeWorld(1, 0, 0.02, 1); // warm-up: the first read after load can precede the first composited frame
  for (const [name, past, shut] of [['future shut', 0, 1], ['future open', 0, 0], ['past shut', 1, 1], ['past open', 1, 0]]) {
    const i = pick(past, shut);
    const a = (-(i - nowIndex) * 2 * Math.PI) / 2016;
    out[name] = [i, L.probeWorld(Math.cos(a), Math.sin(a), 0.02, 1).slice(0, 3).map(Math.round)];
  }
  return out;
});
for (const [name, [i, px]] of Object.entries(res)) {
  const base = hexToRgb(name.endsWith('shut') ? '#F5A524' : '#F4EFE6').map((c) => (name.startsWith('past') ? c * 0.7 : c));
  console.log(name.padEnd(12), `slot ${i}`.padEnd(10), JSON.stringify(px).padEnd(16), 'ref', JSON.stringify(base.map(Math.round)).padEnd(16), 'ΔE2000', de2000(lab(base), lab(px)).toFixed(2));
}
// The rule as seen: rendered past value / rendered present value (HSV value = max channel).
for (const kind of ['shut', 'open']) {
  const v = (px) => Math.max(...px);
  console.log(`${kind}: rendered past/present value = ${(v(res[`past ${kind}`][1]) / v(res[`future ${kind}`][1])).toFixed(3)} (target 0.700)`);
}
await browser.close();
