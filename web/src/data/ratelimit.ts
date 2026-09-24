/**
 * One sliding-window limiter for every request this tab sends to an X Layer RPC (rpc-lite and viem).
 * rpc.xlayer.tech allows ~7 requests/s per IP and counts each JSON-RPC batch ITEM, so callers take one
 * slot per item. At most RPC_PER_SECOND slots in any 1,000 ms window — a hard bound, no bursts.
 */
export const RPC_PER_SECOND = 3;
const WINDOW_MS = 1000;
const sent: number[] = [];
let queue: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves when `items` more requests may be sent without exceeding the window. */
export function rpcSlot(items = 1): Promise<void> {
  const n = Math.min(Math.max(1, items), RPC_PER_SECOND);
  const mine = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && sent[0] <= now - WINDOW_MS) sent.shift();
      if (sent.length + n <= RPC_PER_SECOND) {
        for (let i = 0; i < n; i++) sent.push(now);
        return;
      }
      await sleep(sent[sent.length + n - RPC_PER_SECOND - 1] + WINDOW_MS - now + 1);
    }
  });
  queue = mine.catch(() => undefined);
  return mine;
}
