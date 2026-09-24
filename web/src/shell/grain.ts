/**
 * Grain: a static 256 px tile at 4% on ink and 3% on paper (opacity from --grain-opacity).
 * Never animated. The element is written by the shell plugin; this makes sure it exists and lets a
 * page switch it off (e.g. an OG capture that composites its own texture).
 */
export function ensureGrain(): HTMLElement {
  let el = document.querySelector<HTMLElement>('body > .grain');
  if (!el) {
    el = document.createElement('div');
    el.className = 'grain';
    el.setAttribute('aria-hidden', 'true');
    document.body.append(el);
  }
  return el;
}

export function setGrain(on: boolean): void {
  if (on) document.documentElement.removeAttribute('data-grain');
  else document.documentElement.setAttribute('data-grain', 'off');
}
