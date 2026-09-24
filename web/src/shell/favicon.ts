/**
 * Favicon + theme-color follow the regime: the open glyph (closed ring) in paper hours, the mark
 * (C + amber arc) otherwise. The icon hrefs come from the <link data-favicon> the shell plugin
 * writes (lane F's /favicon-{open,shut}.svg once they exist, inline SVG before that).
 */
import type { SiteRegime } from './regime';

export function setFavicon(regime: SiteRegime): void {
  const link = document.querySelector<HTMLLinkElement>('link[data-favicon]');
  if (link) {
    const href = regime === 'open' ? link.dataset.open : link.dataset.shut;
    if (href && link.getAttribute('href') !== href) link.setAttribute('href', href);
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    const token = regime === 'open' ? '--ivory' : '--ink';
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (value) meta.content = value;
  }
}
