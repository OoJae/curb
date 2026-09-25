/**
 * One JSON line per event, the same shape as the keeper and attestor logs, so one query covers all three.
 * Passed around as a value rather than imported as a global so tests can silence or capture it.
 */
export type Log = (event: string, fields?: Record<string, unknown>) => void;

export function makeLog(host: string): Log {
  return (event, fields = {}) =>
    console.log(JSON.stringify(
      { t: new Date().toISOString(), host, event, ...fields },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    ));
}

export const silentLog: Log = () => {};

/**
 * At most one line per `windowMs` for an event any caller can trigger for free (a junk payment header),
 * carrying how many occurrences were folded into it. The first occurrence always logs, so a real client
 * sending a header we cannot decode is visible at once; a flood of them costs one line a minute.
 */
export function throttledLog(log: Log, event: string, windowMs: number, now: () => number = Date.now): (fields?: Record<string, unknown>) => void {
  let lastMs = Number.NEGATIVE_INFINITY;
  let folded = 0;
  return (fields = {}) => {
    const t = now();
    if (t - lastMs < windowMs) { folded++; return; }
    log(event, { ...fields, foldedSinceLastLine: folded });
    lastMs = t;
    folded = 0;
  };
}
