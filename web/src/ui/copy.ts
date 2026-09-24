/**
 * Copy to clipboard. The label swaps to "Copied" for 1.2 s in the same grid cell (no width change).
 *
 *   <button class="copy" data-copy="0x160D…">Copy address</button>
 *   enhanceCopyButtons(document);             // or copyButton(el, () => text)
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts / denied permission.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export interface CopyButtonOptions {
  /** label shown after copying (default "Copied") */
  copiedLabel?: string;
  /** ms (default 1200) */
  holdMs?: number;
}

/** Wire a button to copy `text` (string or getter). Returns a cleanup function. */
export function copyButton(el: HTMLButtonElement, text: string | (() => string), opts: CopyButtonOptions = {}): () => void {
  el.classList.add('copy');
  el.type = 'button';
  if (!el.querySelector('.copy__label')) {
    const label = document.createElement('span');
    label.className = 'copy__label';
    label.append(...Array.from(el.childNodes));
    const done = document.createElement('span');
    done.className = 'copy__done';
    done.setAttribute('aria-hidden', 'true');
    done.textContent = opts.copiedLabel ?? 'Copied';
    el.append(label, done);
  }
  let status = el.parentElement?.querySelector<HTMLElement>(':scope > .copy__status') ?? null;
  if (!status) {
    status = document.createElement('span');
    status.className = 'copy__status visually-hidden';
    status.setAttribute('role', 'status');
    el.after(status);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onClick = async () => {
    const value = typeof text === 'function' ? text() : text;
    const ok = await copyText(value);
    if (!ok) return;
    el.setAttribute('data-copied', '');
    if (status) status.textContent = opts.copiedLabel ?? 'Copied';
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.removeAttribute('data-copied');
      if (status) status.textContent = '';
    }, opts.holdMs ?? 1200);
  };
  el.addEventListener('click', onClick);
  return () => {
    clearTimeout(timer);
    el.removeEventListener('click', onClick);
  };
}

/** Enhance every button[data-copy] under `root` (value = the attribute). Idempotent. */
export function enhanceCopyButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-copy]:not([data-copy-ready])').forEach((b) => {
    b.setAttribute('data-copy-ready', '');
    copyButton(b, () => b.dataset.copy ?? '');
  });
}
