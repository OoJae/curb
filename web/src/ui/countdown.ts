/**
 * Countdown in fixed-width Martian Mono digit cells: [1][2]:[4][8]:[0][2]. A changing digit swaps
 * with the old one leaving to −100% and the new one arriving from +100% (280 ms, "curb").
 * No layout shift: cell count only changes when the hour field gains a digit.
 * Screen readers get a minute-resolution label (role="timer", not live-announced).
 *
 *   const cd = countdown(el, { target: reopenMs, onDone: () => … });
 *   cd.set(nextTargetMs);
 */
import { CSS_EASE, DUR } from '../motion/timing';
import { prefersReducedMotion } from '../motion/reduced';

export interface CountdownOptions {
  /** target time, epoch ms */
  target: number;
  /** 'hms' → HH:MM:SS (hours may exceed 99); 'hm' → HH:MM */
  format?: 'hms' | 'hm';
  /** boxed cells as in the hero now-line */
  boxed?: boolean;
  /** called once when the countdown reaches zero */
  onDone?: () => void;
  /** accessible prefix, e.g. "Reopens in" */
  label?: string;
}

export interface CountdownHandle {
  el: HTMLElement;
  set(target: number): void;
  stop(): void;
}

function fields(msLeft: number, format: 'hms' | 'hm'): string[] {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const out = [String(h).padStart(2, '0'), String(m).padStart(2, '0')];
  if (format === 'hms') out.push(String(sec).padStart(2, '0'));
  return out;
}

function spoken(msLeft: number, prefix?: string): string {
  const totalMin = Math.max(0, Math.ceil(msLeft / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const parts = [h ? `${h} hour${h === 1 ? '' : 's'}` : '', `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean);
  return `${prefix ? `${prefix} ` : ''}${parts.join(' ')}`;
}

export function countdown(el: HTMLElement, opts: CountdownOptions): CountdownHandle {
  const format = opts.format ?? 'hms';
  let target = opts.target;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let doneFired = false;
  let cells: HTMLElement[] = [];
  let shape = '';

  el.classList.add('countdown');
  el.classList.toggle('countdown--boxed', !!opts.boxed);
  el.setAttribute('role', 'timer');

  const build = (parts: string[]) => {
    const nextShape = parts.map((p) => p.length).join(':');
    if (nextShape === shape) return;
    shape = nextShape;
    el.textContent = '';
    cells = [];
    parts.forEach((p, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'countdown__sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = ':';
        el.append(sep);
      }
      for (const ch of p) {
        const cell = document.createElement('span');
        cell.className = 'countdown__cell';
        cell.setAttribute('aria-hidden', 'true');
        const d = document.createElement('span');
        d.className = 'countdown__digit';
        d.textContent = ch;
        cell.append(d);
        el.append(cell);
        cells.push(cell);
      }
    });
  };

  const swap = (cell: HTMLElement, next: string) => {
    const old = cell.lastElementChild as HTMLElement | null;
    if (old && old.textContent === next) return;
    const d = document.createElement('span');
    d.className = 'countdown__digit';
    d.textContent = next;
    if (!old || prefersReducedMotion() || document.hidden) {
      cell.replaceChildren(d);
      return;
    }
    // Drop any digit still leaving from a previous swap.
    while (cell.childElementCount > 1) cell.firstElementChild?.remove();
    cell.append(d);
    const timing = { duration: DUR.digit * 1000, easing: CSS_EASE.curb, fill: 'both' as const };
    old.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], timing).finished.then(
      () => old.remove(),
      () => old.remove(),
    );
    d.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], timing);
  };

  let lastSpokenMinute = -1;
  const tick = () => {
    const left = target - Date.now();
    const parts = fields(left, format);
    const before = shape;
    build(parts);
    const digits = parts.join('');
    if (before === shape) cells.forEach((c, i) => swap(c, digits[i]!));
    const minute = Math.ceil(Math.max(0, left) / 60_000);
    if (minute !== lastSpokenMinute) {
      lastSpokenMinute = minute;
      el.setAttribute('aria-label', spoken(left, opts.label));
    }
    if (left <= 0) {
      if (!doneFired) {
        doneFired = true;
        opts.onDone?.();
      }
      return;
    }
    const step = format === 'hms' ? 1000 : 60_000;
    timer = setTimeout(tick, (left % step) + 20);
  };

  const onVisible = () => {
    if (!document.hidden) {
      clearTimeout(timer);
      tick();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  tick();

  return {
    el,
    set(next: number) {
      target = next;
      doneFired = false;
      clearTimeout(timer);
      tick();
    },
    stop() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
