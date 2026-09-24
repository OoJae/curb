/** Colour reading and WCAG 2 contrast for the /brand colour sheet. Values are read live from the page's tokens. */

export type RGB = [number, number, number];

let ctx: CanvasRenderingContext2D | null = null;

/** Resolve any CSS colour (hex, rgb, oklch, color-mix …) to sRGB bytes by painting one pixel. */
export function toRGB(css: string): RGB | null {
  if (!css) return null;
  ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillStyle = css; // an invalid colour leaves the transparent sentinel, read back as null
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 0 ? null : [r, g, b];
}

/** Read a custom property from :root and resolve it. */
export function tokenRGB(prop: string): RGB | null {
  return toRGB(getComputedStyle(document.documentElement).getPropertyValue(prop).trim());
}

export const hex = ([r, g, b]: RGB): string => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function lum([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG verdict for normal-size text. */
export function grade(r: number): 'AAA' | 'AA' | 'AA large' | 'Fails' {
  return r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA large' : 'Fails';
}
