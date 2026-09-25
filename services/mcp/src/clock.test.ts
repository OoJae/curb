import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRegime, statusOf, readRegimes, usd, REGIMES } from "./clock.ts";
import { ASSETS, CONTRACTS, requireAsset } from "./assets.ts";
import { BLOCK, clockAnswer, fakeChain } from "./fixtures/fakeChain.ts";

const TCENT = requireAsset("wTCENTx");
const NVDA = requireAsset("wNVDAx");

test("the regime codes are IMarketClock.Regime in order, and each is explained in words", () => {
  assert.deepEqual(REGIMES.map((r) => r.name), ["UNKNOWN", "CLOSED", "OVERNIGHT", "EXTENDED", "MARKET"]);
  assert.match(describeRegime(0).meaning, /older than 30 minutes/);
  assert.match(describeRegime(1).meaning, /capacity is zero/);
  assert.match(describeRegime(2).meaning, /US names only/);
  assert.match(describeRegime(3).meaning, /pre- or post-market/);
  assert.match(describeRegime(4).meaning, /full primary capacity/);
});

test("a code outside 0-4 is never read as open", () => {
  for (const code of [5, 7, 255, -1, 1.5]) {
    assert.equal(describeRegime(code).name, "UNRECOGNISED");
    assert.equal(statusOf({ symbol: "wTCENTx", mic: "XHKG", regime: code, capUsd: 100_000n, blackout: false, blackoutUntil: null }).status, "UNKNOWN");
  }
});

test("status: OPEN needs a known regime AND a non-zero cap; a zero cap under an open label is SHUT", () => {
  const s = (regime: number, capUsd: bigint) => statusOf({ symbol: "wTCENTx", mic: "XHKG", regime, capUsd, blackout: false, blackoutUntil: null });
  assert.equal(s(0, 0n).status, "UNKNOWN");
  assert.equal(s(1, 0n).status, "SHUT");
  // HKEX's 09:00-09:30 pre-open: the issuer labels it extended, with a zero cap.
  assert.equal(s(3, 0n).status, "SHUT");
  assert.equal(s(4, 0n).status, "SHUT");
  assert.equal(s(4, 100_000n).status, "OPEN");
  assert.equal(s(4, 100_000n).primaryMarketOpen, true);
  assert.equal(s(1, 0n).primaryMarketOpen, false);
  assert.equal(s(0, 0n).primaryMarketOpen, false);
});

test("the sentences say what the codes say", () => {
  const shut = statusOf({ symbol: "wTCENTx", mic: "XHKG", regime: 1, capUsd: 0n, blackout: false, blackoutUntil: null });
  assert.match(shut.explanation, /^wTCENTx's primary market is shut: MarketClock reads CLOSED with primary capacity \$0/);
  assert.match(shut.explanation, /Hong Kong \(HKEX\) share/);
  const open = statusOf({ symbol: "wNVDAx", mic: "XNAS", regime: 2, capUsd: 200_000n, blackout: false, blackoutUntil: null });
  assert.match(open.explanation, /is open: MarketClock reads OVERNIGHT \(reduced-cap overnight session \(US names only\)\) with the issuer's order cap at \$200,000/);
  assert.match(open.explanation, /the US \(Nasdaq\) share/);
  const unknown = statusOf({ symbol: "wAAPLx", mic: "XNAS", regime: 0, capUsd: 0n, blackout: false, blackoutUntil: null });
  assert.match(unknown.explanation, /cannot vouch for wAAPLx.*Treat its primary market as shut/);
  const blackout = statusOf({ symbol: "wAAPLx", mic: "XNAS", regime: 4, capUsd: 1n, blackout: true, blackoutUntil: 1_790_300_000 });
  assert.match(blackout.explanation, /corporate-action blackout is active until 2026-09-25T\d\d:\d\d:\d\d\.000Z/);
  assert.equal(usd(100_000n), "$100,000");
  assert.equal(usd("0"), "$0");
});

test("readRegimes: one pinned block, one aggregate3, status from regime()/primaryCapNow(), observedAt from stateOf()", async () => {
  const chain = fakeChain(clockAnswer({
    [TCENT.wrapper]: { regime: 1, cap: 0n, toNext: 838, observedAt: BLOCK.timestamp - 28 },
    [NVDA.wrapper]: { regime: 2, cap: 200_000n, toNext: 0 },
  }, CONTRACTS.marketClock));
  const r = await readRegimes(chain, [TCENT, NVDA]);
  assert.equal(chain.calls, 1);
  assert.equal(r.asOf.block, BLOCK.number);
  assert.equal(r.asOf.blockHash, BLOCK.hash);
  assert.equal(r.asOf.rpc, "rpc[0] https://rpc.example");
  assert.equal(r.source.marketClock, CONTRACTS.marketClock);
  const [t, n] = r.assets;
  assert.equal(t.status, "SHUT");
  assert.equal(t.primaryCapUsd, "0");
  assert.equal(t.secondsToNextTransition, 838);
  assert.equal(t.nextTransitionAt, new Date((BLOCK.timestamp + 838) * 1000).toISOString());
  assert.equal(t.observedAgeSeconds, 28);
  assert.equal(n.status, "OPEN");
  assert.equal(n.nextTransitionAt, null, "0 seconds means no future transition on record");
  assert.equal(r.summary, `wTCENTx SHUT (CLOSED, cap $0); wNVDAx OPEN (OVERNIGHT, cap $200,000) at block ${BLOCK.number}.`);
});

test("a stale stateOf() cannot make an asset open: regime() and primaryCapNow() decide", async () => {
  // regime() has gone UNKNOWN (attestation older than 30 min); stateOf() still holds MARKET with a cap.
  const chain = fakeChain((target, fn, args) => {
    if (fn === "stateOf") return [[4, 100_000n, 0, BLOCK.timestamp - 3600, 0, false]];
    return clockAnswer({ [TCENT.wrapper]: { regime: 0, cap: 0n } }, CONTRACTS.marketClock)(target, fn, args);
  });
  const r = await readRegimes(chain, [TCENT]);
  assert.equal(r.assets[0].status, "UNKNOWN");
  assert.equal(r.assets[0].observedAgeSeconds, 3600);
});

test("a failed status read fails the answer; it is never decoded as zero", async () => {
  const chain = fakeChain((target, fn, args) => (fn === "primaryCapNow" ? undefined : clockAnswer({ [TCENT.wrapper]: { regime: 4, cap: 1n } }, CONTRACTS.marketClock)(target, fn, args)));
  await assert.rejects(readRegimes(chain, [TCENT]), /MarketClock cap\(wTCENTx\) failed/);
});

test("all six in one call when no symbol is given", async () => {
  const states = Object.fromEntries(ASSETS.map((a) => [a.wrapper, { regime: 1, cap: 0n }]));
  const chain = fakeChain(clockAnswer(states, CONTRACTS.marketClock));
  const r = await readRegimes(chain, ASSETS);
  assert.equal(chain.calls, 1);
  assert.deepEqual(r.assets.map((a) => a.symbol), ASSETS.map((a) => a.symbol));
});
