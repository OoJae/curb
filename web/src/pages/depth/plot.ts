/**
 * The LTV function plot for /depth: honoured depth (shares) → loan-to-value (%), drawn from the
 * published formula (data/depth.ts ltvBpsAt / ltvPoints), with the regime caps as ruled lines at 60%
 * (open) and 30% (shut), a "you are here" marker at ltvFor(asset) today, and a drag handle for a
 * hypothetical depth. The handle is maths only: it never sends anything.
 *
 * The SVG is drawn at its box's pixel size so its type stays at CSS size; the accessible control is
 * the <input type="range"> under it, which the pointer drag keeps in step.
 */
import { LTV_OPEN_BPS, LTV_SHUT_BPS, ltvBpsAt, ltvForBps, ltvPoints } from '../../data/depth';
import type { LtvCurve } from '../../data/types';
import { fmtPct, fmtShares } from '../notes/instrument';

const Y_MAX = 7000;
const PAD = { l: 44, r: 12, t: 16, b: 52 };

/** 1, 2, 2.5, 5 × 10^k at or above `v`. */
function nice(v: number): number {
  if (!(v > 0)) return 1;
  const k = Math.floor(Math.log10(v));
  const base = 10 ** k;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base;
  return 10 * base;
}

export interface LtvPlot {
  update(curve: LtvCurve): void;
}

export function mountLtvPlot(box: HTMLElement, range: HTMLInputElement, readout: HTMLElement, text: HTMLElement | null): LtvPlot {
  let curve: LtvCurve | null = null;
  let xMax = 0.1;
  let hypo = 0;
  let scale: { x: (d: number) => number; y: (b: number) => number; inv: (px: number) => number } | null = null;

  const params = (cap: number) => ({
    totalCollateral: curve?.totalCollateral ?? 0,
    minBidPx: curve?.minBidPx ?? 0,
    price: curve?.priceNow ?? null,
    regimeCapBps: cap,
  });
  const priced = () => !!curve && !!curve.priceNow && !!curve.minBidPx;

  const path = (cap: number) => {
    if (!scale) return '';
    const pts = ltvPoints(params(cap), xMax, 160);
    return pts.map((p, i) => `${i ? 'L' : 'M'}${scale!.x(p.depthShares).toFixed(1)} ${scale!.y(p.ltvBps).toFixed(1)}`).join(' ');
  };

  const draw = () => {
    if (!curve) return;
    const W = Math.max(260, Math.round(box.clientWidth || 520));
    const H = Math.max(200, Math.round(box.clientHeight || 300));
    const x = (d: number) => PAD.l + (d / xMax) * (W - PAD.l - PAD.r);
    const y = (b: number) => PAD.t + (1 - b / Y_MAX) * (H - PAD.t - PAD.b);
    const inv = (px: number) => Math.min(xMax, Math.max(0, ((px - PAD.l) / (W - PAD.l - PAD.r)) * xMax));
    scale = { x, y, inv };
    const cap = curve.regimeCapBps;
    // ltvFor is a step: zero with no honoured depth, then min(cap, minBid / P) whatever the depth.
    const stepPath = (c: number) => {
      const v = ltvForBps({ depthShares: 1, minBidPx: curve!.minBidPx ?? 0, price: curve!.priceNow, regimeCapBps: c });
      const x0 = x(xMax / 400);
      return `M${x(0).toFixed(1)} ${y(0).toFixed(1)} L${x0.toFixed(1)} ${y(0).toFixed(1)} L${x0.toFixed(1)} ${y(v).toFixed(1)} L${x(xMax).toFixed(1)} ${y(v).toFixed(1)}`;
    };
    const capLine = (bps: number, label: string, active: boolean) =>
      `<line class="dp-svg__cap${active ? ' is-active' : ''}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(bps).toFixed(1)}" y2="${y(bps).toFixed(1)}"/>` +
      `<text class="dp-svg__caplabel${active ? ' is-active' : ''}" x="${W - PAD.r}" y="${(y(bps) - 6).toFixed(1)}" text-anchor="end">${label}</text>`;
    const ticks = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => `<text class="dp-svg__tick" x="${x(f * xMax).toFixed(1)}" y="${H - 30}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${fmtShares(Number((f * xMax).toPrecision(3)))}</text>`)
      .join('');
    const yTicks = [0, 3000, 6000]
      .map((b) => `<text class="dp-svg__tick" x="${PAD.l - 8}" y="${(y(b) + 4).toFixed(1)}" text-anchor="end">${b / 100}%</text>`)
      .join('');
    const here = curve.here;
    const hereBps = here ? ltvBpsAt({ ...params(cap), depthShares: here.depthShares }) : 0;
    const hereMark =
      here && priced()
        ? `<g class="dp-svg__here" transform="translate(${x(Math.min(here.depthShares, xMax)).toFixed(1)} ${y(hereBps).toFixed(1)})"><circle r="6"/><text x="${here.depthShares > xMax * 0.6 ? -10 : 10}" y="22" text-anchor="${here.depthShares > xMax * 0.6 ? 'end' : 'start'}">you are here</text></g>`
        : '';
    box.innerHTML = `<svg class="dp-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" focusable="false" aria-hidden="true">
      <line class="dp-svg__axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}"/>
      <line class="dp-svg__axis" x1="${PAD.l}" x2="${PAD.l}" y1="${PAD.t}" y2="${y(0)}"/>
      ${capLine(LTV_OPEN_BPS, 'open cap 60%', cap === LTV_OPEN_BPS)}
      ${capLine(LTV_SHUT_BPS, 'shut cap 30%', cap === LTV_SHUT_BPS)}
      ${ticks}${yTicks}
      <text class="dp-svg__tick" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">honoured depth, shares →</text>
      ${priced() ? `<path class="dp-svg__other" d="${stepPath(cap)}"/>` : ''}
      ${priced() ? `<path class="dp-svg__curve" d="${path(cap)}"/>` : ''}      <g class="dp-svg__handle" data-dp-handle><line y1="${PAD.t}" y2="${y(0)}"/><circle r="7" data-dp-knob/></g>
      ${hereMark}
    </svg>${priced() ? '' : `<p class="dp-svg__empty t-small">No honoured depth yet, so ltvFor is 0 and every borrow refuses with <code>NoDepth()</code>. The curve appears once a maker bonds a bid naming CurbCredit.</p>`}`;
    placeHandle();
    if (text) {
      text.textContent = priced()
        ? `Plot against honoured depth for ${curve.symbol}: what the pool can borrow, as a share of its collateral, rises in a straight line until the bids cover all the collateral, capped at ${fmtPct(cap, 0)} under the current regime (${fmtPct(LTV_OPEN_BPS, 0)} open, ${fmtPct(LTV_SHUT_BPS, 0)} shut). Each position's ltvFor steps from zero to the lowest bid over the price, under the same cap, as soon as any depth is honoured.${here ? ` Today: ${fmtShares(here.depthShares)} shares of honoured depth, ltvFor ${fmtPct(here.ltvBps)}, the pool up to ${fmtPct(hereBps)}.` : ''}`
        : `No honoured depth for ${curve.symbol}: ltvFor is 0.`;
    }
  };

  const placeHandle = () => {
    if (!scale || !curve) return;
    const g = box.querySelector('[data-dp-handle]');
    const bps = priced() ? ltvBpsAt({ ...params(curve.regimeCapBps), depthShares: hypo }) : 0;
    g?.setAttribute('transform', `translate(${scale.x(hypo).toFixed(1)} 0)`);
    g?.querySelector('[data-dp-knob]')?.setAttribute('cy', scale.y(bps).toFixed(1));
    const shut = priced() ? ltvBpsAt({ ...params(LTV_SHUT_BPS), depthShares: hypo }) : 0;
    const open = priced() ? ltvBpsAt({ ...params(LTV_OPEN_BPS), depthShares: hypo }) : 0;
    const per = priced() ? ltvForBps({ ...params(curve.regimeCapBps), depthShares: hypo }) : 0;
    readout.textContent = priced()
      ? `At ${fmtShares(Number(hypo.toPrecision(4)))} shares of honoured depth the pool can borrow up to ${fmtPct(shut)} of its collateral while shut, ${fmtPct(open)} while open; each position’s ltvFor is ${fmtPct(per)} now. Maths only; nothing is sent.`
      : 'Needs at least one honoured bid to price the curve.';
  };

  const setHypo = (d: number) => {
    hypo = Math.min(xMax, Math.max(0, d));
    range.value = String(hypo);
    placeHandle();
  };

  range.addEventListener('input', () => {
    hypo = Number(range.value);
    placeHandle();
  });

  let dragging = false;
  box.addEventListener('pointerdown', (e) => {
    if (!scale || !priced()) return;
    dragging = true;
    box.setPointerCapture(e.pointerId);
    setHypo(scale.inv(e.clientX - box.getBoundingClientRect().left));
  });
  box.addEventListener('pointermove', (e) => {
    if (!dragging || !scale) return;
    setHypo(scale.inv(e.clientX - box.getBoundingClientRect().left));
  });
  const end = (e: PointerEvent) => {
    dragging = false;
    if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  let lastW = 0;
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const w = Math.round(box.clientWidth);
      if (w !== lastW) {
        lastW = w;
        draw();
      }
    }).observe(box);
  }

  return {
    update(c) {
      const first = !curve;
      curve = c;
      xMax = nice(Math.max(c.totalCollateral * 2, (c.here?.depthShares ?? 0) * 2, 0.01));
      range.max = String(xMax);
      range.step = String(xMax / 400);
      range.disabled = !priced();
      if (first) hypo = Math.min(xMax, c.here?.depthShares ?? xMax / 2);
      hypo = Math.min(hypo, xMax);
      range.value = String(hypo);
      draw();
    },
  };
}
