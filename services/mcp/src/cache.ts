/**
 * A short-lived, single-flight answer cache. X Layer makes a block about every second, MarketClock writes a
 * round every ~5.5 minutes and on every change, and Scorecard moves a few times a day, so an answer a few
 * seconds old is as good as a fresh one -- and every answer names the block it was read at, so its age is
 * never hidden. What this buys: a burst of identical calls (an agent retrying, ten agents asking about
 * wTCENTx at the reopen) costs one set of upstream reads. A failure is never cached.
 */
export class TtlCache<T> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, { atMs: number; p: Promise<T> }>();

  constructor(ttlMs: number, now: () => number = Date.now, maxEntries = 256) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.maxEntries = maxEntries;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.atMs < this.ttlMs) return hit.p;
    const entry = { atMs: this.now(), p: load() };
    this.entries.set(key, entry);
    entry.p.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    // Keys are drawn from a fixed table (six assets, bounded limits), so this only trims stale entries.
    if (this.entries.size > this.maxEntries) {
      for (const [k, v] of this.entries) if (this.now() - v.atMs >= this.ttlMs) this.entries.delete(k);
    }
    return entry.p;
  }
}
