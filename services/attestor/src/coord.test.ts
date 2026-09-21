import { test } from "node:test";
import assert from "node:assert/strict";
import { TakeoverPlanner, readChainStates, isCalendarForcedClose, DEFAULT_STANDBY } from "./coord.ts";
import type { ChainState, StandbyClaim } from "./coord.ts";
import { clockAbi, rawToken } from "./sources/chain.ts";
import { Regime } from "./regime.ts";

const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const W2 = "0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5";
const X = "0x" + "ab".repeat(20);
const RAW = "0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42";
const T0 = 1_791_000_000_000; // ms
const S0 = T0 / 1000;

function state(over: Partial<ChainState> = {}): ChainState {
  return { wrapper: W, symbol: "TCENTx", readable: true, regime: Regime.MARKET, cap: 100_000n, observedAt: S0, storedNonce: 0, halted: false, rawNonce: 0, ...over };
}
function claim(over: Partial<StandbyClaim> = {}): StandbyClaim {
  return { wrapper: W, symbol: "TCENTx", regime: Regime.MARKET, capUsd: 100_000n, halted: false, disagreement: false, degraded: [], reason: "period=market cap=10000000", ...over };
}
const CAL_CLOSE = claim({ regime: Regime.CLOSED, capUsd: 0n, disagreement: true, reason: "period=market cap=10000000 | DISAGREEMENT venueOpen=false assetOpen=true" });
const API_CLOSE = claim({ regime: Regime.CLOSED, capUsd: 0n, reason: "period=closed cap=0" });
const BLIND = claim({ regime: Regime.CLOSED, capUsd: 0n, degraded: ["source-unavailable"], reason: "asset body missing" });
const nv = (over: Partial<ChainState> = {}) => state({ wrapper: W2, symbol: "NVDAx", regime: Regime.EXTENDED, cap: 1_000_000n, ...over });
const nvClaim = (over: Partial<StandbyClaim> = {}) => claim({ wrapper: W2, symbol: "NVDAx", regime: Regime.EXTENDED, capUsd: 1_000_000n, ...over });
/** Primary heartbeat that is always fresh relative to `t` (ms after T0). */
const fresh = (t: number) => S0 + Math.floor(t / 1000) - 5;

test("in agreement and fresh, standby does nothing", () => {
  const p = new TakeoverPlanner().plan({ nowMs: T0 + 60_000, states: [state()], claims: [claim()] });
  assert.equal(p.send, false);
  assert.equal(p.primaryAlive, true);
  assert.deepEqual(p.alarms, []);
});

test("primary silent: no takeover at heartbeat+89s, takeover at heartbeat+90s", () => {
  const pl = new TakeoverPlanner();
  const limit = (DEFAULT_STANDBY.heartbeatS + DEFAULT_STANDBY.staleGraceS) * 1000;
  assert.equal(pl.plan({ nowMs: T0 + limit - 1_000, states: [state()], claims: [claim()] }).send, false);
  const p = pl.plan({ nowMs: T0 + limit, states: [state()], claims: [claim()] });
  assert.equal(p.send, true);
  assert.equal(p.kind, "heartbeat");
  assert.ok(p.reasons.some((r) => r.includes("primary-silent")));
});

test("calendar-forced close with the primary alive: waits 25s from first sight, then takes over once", () => {
  assert.equal(isCalendarForcedClose(CAL_CLOSE), true);
  assert.equal(isCalendarForcedClose(API_CLOSE), false);
  const pl = new TakeoverPlanner();
  assert.equal(pl.plan({ nowMs: T0 + 1_000, states: [state({ observedAt: S0 - 10 })], claims: [CAL_CLOSE] }).send, false);
  assert.equal(pl.plan({ nowMs: T0 + 25_000, states: [state({ observedAt: S0 - 10 })], claims: [CAL_CLOSE] }).send, false);
  const p = pl.plan({ nowMs: T0 + 26_000, states: [state({ observedAt: S0 - 10 })], claims: [CAL_CLOSE] });
  assert.equal(p.send, true);
  assert.equal(p.kind, "diff");
  assert.equal(p.coveredKeys.length, 1);
});

test("an API-driven change is NEVER written while the primary is alive: one sev-2 page after 150s", () => {
  const pl = new TakeoverPlanner();
  let alarms = 0;
  for (let t = 0; t <= 1_800_000; t += 30_000) {
    const p = pl.plan({ nowMs: T0 + t, states: [state({ observedAt: fresh(t) })], claims: [API_CLOSE] });
    assert.equal(p.send, false, `t=${t}`);
    alarms += p.alarms.length;
    if (p.alarms.length) assert.equal(p.alarms[0].sev, 2);
  }
  assert.equal(alarms, 1);
});

test("once B is the writer (primary down), B follows an API change after the full 150s, not a shortcut", () => {
  const pl = new TakeoverPlanner();
  const s = [state()];
  pl.plan({ nowMs: T0, states: s, claims: [API_CLOSE], lastWriterIsSelf: true });
  assert.equal(pl.plan({ nowMs: T0 + 149_000, states: s, claims: [API_CLOSE], lastWriterIsSelf: true }).send, false);
  const p = pl.plan({ nowMs: T0 + 150_000, states: s, claims: [API_CLOSE], lastWriterIsSelf: true });
  assert.equal(p.send, true);
  assert.equal(p.primaryAlive, false);
});

test("B never takes over on its own blindness, and a stale takeover waits while B is blind (up to 20 min)", () => {
  const pl = new TakeoverPlanner();
  for (let t = 0; t <= 300_000; t += 30_000) {
    assert.equal(pl.plan({ nowMs: T0 + t, states: [state({ observedAt: fresh(t) })], claims: [BLIND] }).send, false, `t=${t}`);
  }
  const p1 = new TakeoverPlanner().plan({ nowMs: T0 + 600_000, states: [state()], claims: [BLIND] });
  assert.equal(p1.send, false);
  assert.ok(p1.reasons.some((r) => r.startsWith("stale-deferred")));
  const p2 = new TakeoverPlanner().plan({ nowMs: T0 + 20 * 60_000, states: [state()], claims: [BLIND] });
  assert.equal(p2.send, true, "at 20 minutes the fail-closed policy applies anyway");
});

test("nonce activation: waits 45s, then an activation round", () => {
  const pl = new TakeoverPlanner();
  const s = [state({ storedNonce: 4, rawNonce: 5, observedAt: S0 - 5 })];
  pl.plan({ nowMs: T0 + 1_000, states: s, claims: [claim()] });
  assert.equal(pl.plan({ nowMs: T0 + 45_000, states: s, claims: [claim()] }).send, false);
  const p = pl.plan({ nowMs: T0 + 46_000, states: s, claims: [claim()] });
  assert.equal(p.send, true);
  assert.equal(p.kind, "activation");
});

test("a registered asset the live primary does not attest pages sev-1; B does not become its second writer", () => {
  const pl = new TakeoverPlanner();
  const claims = [claim(), claim({ wrapper: X, symbol: "NEWx" })];
  let pages = 0;
  for (let t = 0; t <= 3_600_000; t += 30_000) {
    const p = pl.plan({ nowMs: T0 + t, states: [state({ observedAt: fresh(t) }), state({ wrapper: X, symbol: "NEWx", observedAt: 0 })], claims, primaryCoverage: [W] });
    assert.equal(p.send, false, `t=${t}`);
    pages += p.alarms.filter((x) => x.sev === 1).length;
  }
  assert.equal(pages, 1);
});

test("an asset only B ever wrote cannot make B a permanent second writer (staleness is over the primary's coverage)", () => {
  const pl = new TakeoverPlanner();
  // X was attested long ago by B only; the primary keeps W fresh and covers only W.
  for (let t = 0; t <= 3_600_000; t += 30_000) {
    const p = pl.plan({ nowMs: T0 + t, states: [state({ observedAt: fresh(t) }), state({ wrapper: X, symbol: "NEWx", observedAt: S0 - 4000 })], claims: [claim(), claim({ wrapper: X, symbol: "NEWx" })], primaryCoverage: [W] });
    assert.equal(p.send, false, `t=${t}`);
  }
});

test("when the primary is down, a never-attested asset is B's to write after 90s", () => {
  const pl = new TakeoverPlanner();
  const s = [state({ wrapper: X, symbol: "NEWx", observedAt: 0 }), state()];
  const c = [claim({ wrapper: X, symbol: "NEWx" }), claim()];
  pl.plan({ nowMs: T0 + 1_000, states: s, claims: c, lastWriterIsSelf: true });
  assert.equal(pl.plan({ nowMs: T0 + 90_000, states: s, claims: c, lastWriterIsSelf: true }).send, false);
  assert.equal(pl.plan({ nowMs: T0 + 91_000, states: s, claims: c, lastWriterIsSelf: true }).send, true);
});

test("an in-flight primary write restarts the grace once; a second contradicting write stands B down with one sev-1", () => {
  const pl = new TakeoverPlanner();
  pl.plan({ nowMs: T0 + 1_000, states: [state()], claims: [CAL_CLOSE] });
  let p = pl.plan({ nowMs: T0 + 20_000, states: [state({ observedAt: S0 + 19 })], claims: [CAL_CLOSE] });
  assert.equal(p.send, false);
  assert.deepEqual(p.alarms, []);
  p = pl.plan({ nowMs: T0 + 44_000, states: [state({ observedAt: S0 + 19 })], claims: [CAL_CLOSE] });
  assert.equal(p.send, false, "grace restarted at 20s");
  p = pl.plan({ nowMs: T0 + 50_000, states: [state({ observedAt: S0 + 49 })], claims: [CAL_CLOSE] });
  assert.equal(p.send, false);
  assert.equal(p.alarms.length, 1);
  assert.equal(p.alarms[0].sev, 1);
  for (let t = 60_000; t < 900_000; t += 30_000) {
    const q = pl.plan({ nowMs: T0 + t, states: [state({ observedAt: fresh(t) })], claims: [CAL_CLOSE] });
    assert.equal(q.send, false, `t=${t}`);
    assert.deepEqual(q.alarms, []);
  }
});

test("a primary that then goes silent is still covered by the silent-primary rule", () => {
  const pl = new TakeoverPlanner();
  pl.plan({ nowMs: T0 + 1_000, states: [state()], claims: [CAL_CLOSE] });
  pl.plan({ nowMs: T0 + 20_000, states: [state({ observedAt: S0 + 19 })], claims: [CAL_CLOSE] });
  pl.plan({ nowMs: T0 + 50_000, states: [state({ observedAt: S0 + 49 })], claims: [CAL_CLOSE] });
  const p = pl.plan({ nowMs: T0 + 49_000 + 390_000, states: [state({ observedAt: S0 + 49 })], claims: [CAL_CLOSE] });
  assert.equal(p.send, true);
  assert.ok(p.reasons.some((r) => r.includes("primary-silent")));
});

test("no flap loop: a primary reverting B's write stands B down, and the stand-down survives blind ticks and restarts", () => {
  const pl = new TakeoverPlanner();
  pl.plan({ nowMs: T0, states: [state({ observedAt: S0 - 5 })], claims: [CAL_CLOSE] });
  const p1 = pl.plan({ nowMs: T0 + 26_000, states: [state({ observedAt: S0 - 5 })], claims: [CAL_CLOSE] });
  assert.equal(p1.send, true);
  pl.markWrote(p1.coveredKeys, T0 + 27_000);
  const closed = [state({ regime: Regime.CLOSED, cap: 0n, observedAt: S0 + 27 })];
  assert.equal(pl.plan({ nowMs: T0 + 35_000, states: closed, claims: [CAL_CLOSE], lastWriterIsSelf: true }).send, false);
  // Primary writes the old state back.
  const reverted = (t: number) => [state({ observedAt: fresh(t) })];
  const p2 = pl.plan({ nowMs: T0 + 60_000, states: reverted(60_000), claims: [CAL_CLOSE] });
  assert.equal(p2.send, false);
  assert.equal(p2.alarms.length, 1);
  assert.match(p2.alarms[0].message, /reverted/);
  // A blind tick must not clear the stand-down...
  assert.equal(pl.plan({ nowMs: T0 + 90_000, states: reverted(90_000), claims: [BLIND] }).send, false);
  assert.equal(pl.plan({ nowMs: T0 + 200_000, states: reverted(200_000), claims: [CAL_CLOSE] }).send, false);
  // ...and neither may a restart.
  const restarted = new TakeoverPlanner({}, JSON.parse(JSON.stringify(pl.snapshot())));
  for (let t = 210_000; t < 900_000; t += 30_000) {
    const q = restarted.plan({ nowMs: T0 + t, states: reverted(t), claims: [CAL_CLOSE] });
    assert.equal(q.send, false, `t=${t}`);
    assert.deepEqual(q.alarms, [], "no fresh page for a divergence already stood down");
  }
});

test("a takeover never carries another asset's unripe divergence: it waits quietly until both are due", () => {
  const pl = new TakeoverPlanner();
  const states = [state({ observedAt: S0 - 5 }), nv({ observedAt: S0 - 5, storedNonce: 1, rawNonce: 2 })];
  const claims = [CAL_CLOSE, nvClaim()];
  pl.plan({ nowMs: T0, states, claims });
  const p30 = pl.plan({ nowMs: T0 + 30_000, states, claims });
  assert.equal(p30.send, false, "close is due at 25s but the activation is not ripe until 45s");
  assert.deepEqual(p30.alarms, []);
  const p46 = pl.plan({ nowMs: T0 + 46_000, states, claims });
  assert.equal(p46.send, true);
  assert.equal(p46.kind, "activation");
  assert.equal(p46.coveredKeys.length, 2);
});

test("a takeover that would also write a divergence B may not write is blocked and pages", () => {
  const pl = new TakeoverPlanner();
  const states = [state({ observedAt: S0 - 5 }), nv({ observedAt: S0 - 5 })];
  const claims = [CAL_CLOSE, nvClaim({ regime: Regime.CLOSED, capUsd: 0n, reason: "period=closed cap=0" })];
  pl.plan({ nowMs: T0, states, claims });
  const p = pl.plan({ nowMs: T0 + 26_000, states, claims });
  assert.equal(p.send, false);
  assert.equal(p.alarms.filter((a) => a.sev === 1).length, 1);
  const blind = pl.plan({ nowMs: T0 + 27_000, states, claims: [CAL_CLOSE, nvClaim({ regime: Regime.CLOSED, capUsd: 0n, degraded: ["source-unavailable"] })] });
  assert.equal(blind.send, false, "B's own blind divergence on another asset also blocks the write");
});

test("unreadable onchain state never triggers a write", () => {
  const p = new TakeoverPlanner().plan({ nowMs: T0 + 3_600_000, states: [state({ readable: false })], claims: [claim()] });
  assert.equal(p.send, false);
  assert.equal(p.alarms[0].sev, 2);
});

test("readChainStates decodes stateOf and the raw token nonce from multicall results", () => {
  const results = [
    { label: `stateOf:${W}`, target: W, callData: "0x", success: true, returnData: clockAbi.encodeFunctionResult("stateOf", [[4, 100_000n, 1_791_000_300n, 1_791_000_000n, 3, false]]) },
    { label: `gcm:${RAW}`, target: RAW, callData: "0x", success: true, returnData: rawToken.encodeFunctionResult("getCurrentMultiplier", [10n ** 18n, 0n, 4n]) },
  ];
  const [s] = readChainStates([{ wrapper: W, raw: RAW, symbol: "TCENTx", mic: "XHKG" }], results);
  assert.deepEqual(
    { regime: s.regime, cap: s.cap, observedAt: s.observedAt, storedNonce: s.storedNonce, rawNonce: s.rawNonce, readable: s.readable },
    { regime: 4, cap: 100_000n, observedAt: 1_791_000_000, storedNonce: 3, rawNonce: 4, readable: true },
  );
});
