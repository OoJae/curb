// LAB STUB for lane B's data/clock.ts (stateOf(wTCENTx) via rpc-lite). Assumed: readClock(symbol) → ClockReading.
// Returns null unless `?fixture=1`, so the lab shows the honest "clock unavailable" state by default; the fixture
// exists only to see the full now-line layout and is labelled as such in the lab URL.
import { stubWeek } from '../../../../../src/ring/layout';

export async function readClock(symbol: string) {
  if (!new URLSearchParams(location.search).has('fixture')) return null;
  const w = stubWeek();
  const open = w.slots[w.nowIndex] === 0;
  return {
    symbol,
    regime: open ? ('MARKET' as const) : ('CLOSED' as const),
    capUsd: open ? 250_000 : 0,
    attestedAt: Date.now() - 2 * 60_000,
    block: 71_484_120,
  };
}
