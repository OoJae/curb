/**
 * Alarms that can never sit on the commit or settle path (deploy 2, W10.1).
 *
 * HEAD awaited every alarm inline: up to two 5 s POSTs per alarm, between building a plan and sending it, and
 * a first night with many keys firing would page once per key (CO M5). Here the two halves are split:
 *
 * - `raise(sev, key, message)` is synchronous and never touches the network. It logs `alarm` (as HEAD did),
 *   skips a key delivered less than 15 minutes ago at the same or a higher severity (a sev-1 is never
 *   silenced by a delivered sev-2), and puts the alarm in a queue keyed by `key`: raising a queued key again
 *   updates it in place, so a condition that fires every tick is queued once. It cannot throw.
 * - `flush(budgetMs)` runs once per tick, after the commit and settle passes, and delivers the queue within
 *   its budget:
 *   1. every queued sev-1 is coalesced into ONE `POST <url>/fail` (one line per alarm, at most 9,000
 *      characters; what does not fit stays queued). healthchecks.io notifies only on a state change, so a check
 *      that may be down is re-armed first (`POST <url>` body `re-arm`); the re-arm must be accepted or the
 *      flush stops and retries next tick. The check is assumed down at boot (the previous process may have
 *      left it failing, SFS B5) and after any /fail that was not cleanly refused, because re-arming an up
 *      check costs nothing while a /fail on a down check pages nobody. One flush is therefore at most one
 *      up/down notification pair, however many keys fired.
 *   2. every queued sev-2 is coalesced into one `POST <url>/log` and removed whatever the answer (not
 *      retried; its cooldown starts, so a failing endpoint cannot turn a per-tick sev-2 into a log storm).
 *   3. every POST's timeout is min(5 s, budget left) and nothing starts with less than 500 ms left; each POST
 *      is aborted through its signal AND raced against its timeout, so even a fetch that ignores the signal
 *      cannot hold the tick past the budget.
 *   4. an alarm still undelivered an hour after it was first queued is dropped with `alarm-dropped`.
 * - Accepted means HTTP OK and a body of exactly `OK`: healthchecks answers "OK (rate limited)" with a 200
 *   and records nothing.
 * - No URL: log only, exactly as HEAD (the cooldown still applies to the log line).
 *
 * Nothing here is persisted: a restart loses the queue, and the boot re-arm makes the next sev-1 page.
 */

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;
export type Sev = 1 | 2;

export const ALARM_COOLDOWN_MS = 15 * 60_000;
export const ALARM_DROP_AFTER_MS = 60 * 60_000;
export const ALARM_BODY_MAX = 9_000;
export const ALARM_POST_TIMEOUT_MS = 5_000;
export const ALARM_MIN_START_MS = 500;
export const ALARM_FLUSH_BUDGET_MS = 5_000;
/** At most one `alarm-flush-failed` log line per this interval, so a dead endpoint is visible but not noisy. */
const FLUSH_FAILED_LOG_EVERY_MS = 15 * 60_000;

export interface AlarmsHealth {
  /** HC_ALARM_URL is set: sev-1 alarms page, sev-2 alarms are logged on the check. */
  paging: boolean;
  /** The next sev-1 delivery re-arms the check first. */
  checkDown: boolean;
  /** Alarms raised but not yet delivered (one entry per key). */
  queued: number;
  /** Alarms given up on after an hour undelivered, since boot. */
  dropped: number;
  /** The last sev-1 raised (logged), delivered or not. */
  lastSev1: { key: string; atMs: number } | null;
}

export interface Alarms {
  raise(sev: Sev, key: string, message: string): void;
  flush(budgetMs?: number): Promise<void>;
  health(): AlarmsHealth;
}

interface Queued {
  sev: Sev;
  key: string;
  message: string;
  firstQueuedMs: number;
}

/** healthchecks.io records a ping only when it answers exactly "OK". */
async function accepted(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  try { return (await res.text()).trim() === "OK"; } catch { return false; }
}

/** A real clock for budgets, independent of the injectable wall clock used for ages and cooldowns. */
const mono = () => performance.now();

export function createAlarms(d: { url: string; hostId: string; log: LogFn; fetch?: typeof fetch; now?: () => number }): Alarms {
  const url = d.url.trim().replace(/\/+$/, "");
  const now = d.now ?? Date.now;
  const doFetch: typeof fetch = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sentAt = new Map<string, { at: number; sev: Sev }>();
  const queue = new Map<string, Queued>();     // insertion order = first-queued order
  let checkDown = true;                        // unknown after a restart: assume down, re-arm before the first page
  let dropped = 0;
  let lastSev1: { key: string; atMs: number } | null = null;
  let lastFlushFailedLogMs = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const safeLog = (event: string, fields: Record<string, unknown>) => {
    try { d.log(event, fields); } catch { /* logging must never break the caller */ }
  };
  const lineOf = (a: Queued) => `[${d.hostId}] sev-${a.sev} ${a.message.replace(/[\r\n]+/g, " ")}`;

  function raise(sev: Sev, key: string, message: string): void {
    try {
      const t = now();
      const msg = String(message);
      const prev = sentAt.get(key);
      if (prev !== undefined && t - prev.at < ALARM_COOLDOWN_MS && prev.sev <= sev) return;
      for (const [k, v] of sentAt) if (t - v.at >= ALARM_COOLDOWN_MS) sentAt.delete(k);   // bounded
      const q = queue.get(key);
      if (q) {
        // Already waiting for delivery: never a second entry. A more severe raise upgrades it (and is logged);
        // the same severity refreshes the message; a milder one leaves the queued alarm as it is.
        if (sev < q.sev) {
          q.sev = sev; q.message = msg;
          safeLog("alarm", { sev, key, message: msg });
          if (sev === 1) lastSev1 = { key, atMs: t };
        } else if (sev === q.sev) {
          q.message = msg;
        }
        return;
      }
      safeLog("alarm", { sev, key, message: msg });
      if (sev === 1) lastSev1 = { key, atMs: t };
      if (url === "") { sentAt.set(key, { at: t, sev }); return; }   // log only, as HEAD
      queue.set(key, { sev, key, message: msg, firstQueuedMs: t });
    } catch { /* an alarm must never throw into the commit or settle path */ }
  }

  /** One POST bounded by `ms`: aborted through its signal AND raced, so a stub that ignores the signal cannot hang. */
  async function post(target: string, body: string, ms: number): Promise<boolean> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { ctrl.abort(); resolve(false); }, ms);
    });
    try {
      const attempt = (async () => {
        const res = await doFetch(target, { method: "POST", body, signal: ctrl.signal });
        return await accepted(res);
      })().catch(() => false);
      return await Promise.race([attempt, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function flushFailed(stage: string) {
    const t = now();
    if (t - lastFlushFailedLogMs < FLUSH_FAILED_LOG_EVERY_MS) return;
    lastFlushFailedLogMs = t;
    safeLog("alarm-flush-failed", { stage, queued: queue.size, checkDown });
  }

  async function deliver(budgetMs: number): Promise<void> {
    const start = mono();
    const left = () => budgetMs - (mono() - start);
    const t0 = now();

    // 4. drop what has waited too long (both severities: the queue must stay bounded while the URL is dead).
    for (const [k, a] of queue) {
      if (t0 - a.firstQueuedMs > ALARM_DROP_AFTER_MS) {
        queue.delete(k);
        dropped++;
        safeLog("alarm-dropped", { key: k, sev: a.sev, queuedForMs: t0 - a.firstQueuedMs });
      }
    }
    if (url === "" || queue.size === 0) return;

    // 1. sev-1, coalesced.
    const sev1 = [...queue.values()].filter((a) => a.sev === 1);
    if (sev1.length > 0) {
      if (checkDown) {
        if (left() < ALARM_MIN_START_MS) return;
        if (!(await post(url, "re-arm", Math.min(ALARM_POST_TIMEOUT_MS, left())))) { flushFailed("re-arm"); return; }
        checkDown = false;
      }
      const batch: Queued[] = [];
      let size = 0;
      for (const a of sev1) {
        const line = lineOf(a);
        const add = (batch.length ? 1 : 0) + line.length;
        if (batch.length > 0 && size + add > ALARM_BODY_MAX) break;
        batch.push(a);
        size += add;
      }
      if (left() < ALARM_MIN_START_MS) return;
      const body = batch.map(lineOf).join("\n").slice(0, ALARM_BODY_MAX);
      const ok = await post(`${url}/fail`, body, Math.min(ALARM_POST_TIMEOUT_MS, left()));
      // Delivered or not, the check may now be down (a timed-out POST can still have landed): re-arm next time.
      checkDown = true;
      if (ok) {
        const t = now();
        for (const a of batch) {
          // A raise while the POST was in flight may have refreshed the entry; it was sent either way.
          queue.delete(a.key);
          sentAt.set(a.key, { at: t, sev: 1 });
        }
      } else {
        flushFailed("fail");
      }
    }

    // 2. sev-2, coalesced, never retried.
    const sev2 = [...queue.values()].filter((a) => a.sev === 2);
    if (sev2.length > 0 && left() >= ALARM_MIN_START_MS) {
      const batch: Queued[] = [];
      let size = 0;
      for (const a of sev2) {
        const line = lineOf(a);
        const add = (batch.length ? 1 : 0) + line.length;
        if (batch.length > 0 && size + add > ALARM_BODY_MAX) break;
        batch.push(a);
        size += add;
      }
      const body = batch.map(lineOf).join("\n").slice(0, ALARM_BODY_MAX);
      const t = now();
      for (const a of batch) { queue.delete(a.key); sentAt.set(a.key, { at: t, sev: 2 }); }
      if (!(await post(`${url}/log`, body, Math.min(ALARM_POST_TIMEOUT_MS, left())))) flushFailed("log");
    }
  }

  function flush(budgetMs: number = ALARM_FLUSH_BUDGET_MS): Promise<void> {
    if (inFlight) return inFlight;
    const run = (async () => {
      try { await deliver(Math.max(0, budgetMs)); } catch { /* monitoring never breaks the keeper */ }
    })();
    inFlight = run.finally(() => { inFlight = null; });
    return inFlight;
  }

  function health(): AlarmsHealth {
    return { paging: url !== "", checkDown, queued: queue.size, dropped, lastSev1 };
  }

  return { raise, flush, health };
}
