/** Display formatters shared by the shell and pages. Plain functions, no DOM. */

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 71484120 → "71,484,120". */
export function fmtBlock(n: number | bigint): string {
  return grouped.format(n);
}

/** Integer with thousands separators. */
export function fmtInt(n: number | bigint): string {
  return grouped.format(n);
}

/** USD with no cents for whole numbers: 0 → "$0", 1234.5 → "$1,234.50". */
export function fmtUsd(n: number): string {
  const whole = Number.isInteger(n);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Signed basis points, words not colour: 12 → "+12 bp", -3.5 → "−3.5 bp", 0 → "0 bp". */
export function fmtBp(bp: number): string {
  const abs = Math.abs(bp);
  const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  if (bp > 0) return `+${s} bp`;
  if (bp < 0) return `−${s} bp`;
  return '0 bp';
}

/** 65 h 35 m / 12 m / 3 d 4 h (thin spaces avoided on purpose: Martian has no U+2009). */
export function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} m`;
  return `${h} h ${String(m).padStart(2, '0')} m`;
}

/** "just now", "1 min ago", "14 min ago", "3 h ago". */
export function fmtAgo(thenMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** 0xe8740458…4de7 */
export function shortHash(hash: string, head = 8, tail = 4): string {
  if (hash.length <= head + tail + 2) return hash;
  return `${hash.slice(0, head + 2)}…${hash.slice(-tail)}`;
}

/** 0x160D…B09b */
export function shortAddress(addr: string): string {
  return shortHash(addr, 4, 4);
}
