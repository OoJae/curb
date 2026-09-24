/**
 * The data layer's pure rules, checked against the real ABIs from forge out/ (abi/*.ts) and bytes
 * captured from mainnet on 24 Sep 2026. No network.
 *   node --test --experimental-strip-types web/src/data/data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, stringToBytes } from "viem";
import { marketClockAbi } from "./abi/marketClock.ts";
import { HERO_WRAPPER } from "./addresses.ts";
import { decodePaymentRequired, formatUsd6 } from "./api.ts";
import { ltvBpsAt, minBond, notional, refusalName, regimeCapBps } from "./depth.ts";
import { fixture, setMock } from "./mock.ts";
import { discountBps, lotPriceAt, valueUsdg } from "./notes.ts";
import { rpcSlot, RPC_PER_SECOND } from "./ratelimit.ts";
import { getRegime, pollDelayMs, toRegimeState } from "./regime.ts";
import { decodeStateOf, stateOfCalldata, STATE_OF_SELECTOR } from "./rpc-lite.ts";
import { methodName, outcome } from "./scorecard.ts";
import { DATA_SUFFIX } from "./suffix.ts";

/** eth_call stateOf(wTCENTx) as rpc.xlayer.tech answered it, 24 Sep 2026 13:03Z. */
const LIVE_STATE =
  "0x0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000006ab5c790" +
  "000000000000000000000000000000000000000000000000000000006ab51eda" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000";

test("rpc-lite: selector and calldata equal viem's encoding against the forge ABI", () => {
  const viem = encodeFunctionData({ abi: marketClockAbi, functionName: "stateOf", args: [HERO_WRAPPER] });
  assert.equal(viem.slice(0, 10), STATE_OF_SELECTOR);
  assert.equal(stateOfCalldata(HERO_WRAPPER), viem.toLowerCase());
});

test("rpc-lite: hand decode equals viem's decode (live bytes and a synthetic MARKET state)", () => {
  const live = decodeStateOf(LIVE_STATE);
  assert.deepEqual(live, { regime: 1, cap: 0n, nextTransitionAt: 1790298000, observedAt: 1790254810, multiplierNonce: 0, halted: false });
  const synthetic = encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint128" }, { type: "uint64" }, { type: "uint64" }, { type: "uint32" }, { type: "bool" }],
    [4, 1_000_000n, 1790330400n, 1790312700n, 7, true],
  );
  const v = decodeFunctionResult({ abi: marketClockAbi, functionName: "stateOf", data: synthetic });
  const h = decodeStateOf(synthetic);
  assert.equal(h.regime, v.regime);
  assert.equal(h.cap, v.primaryCapUsd);
  assert.equal(BigInt(h.nextTransitionAt), v.nextTransitionAt);
  assert.equal(BigInt(h.observedAt), v.observedAt);
  assert.equal(h.multiplierNonce, v.multiplierNonce);
  assert.equal(h.halted, v.halted);
  assert.throws(() => decodeStateOf("0x"), /expected 192 bytes/);
});

const raw = (regime: number, cap: bigint, observedAt: number) => ({ regime, cap, nextTransitionAt: 0, observedAt, multiplierNonce: 0, halted: false, block: 1 });

test("regime: paper only when MARKET && cap > 0 and fresh; stale after 30 min reads UNKNOWN", () => {
  const now = 1_790_312_700_000;
  const t = now / 1000;
  const open = toRegimeState(raw(4, 1_000_000n, t - 60), HERO_WRAPPER, now);
  assert.equal(open.paper, true);
  assert.equal(open.glyph, "open");
  assert.equal(open.attestedAgoMin, 1);
  assert.equal(toRegimeState(raw(4, 0n, t - 60), HERO_WRAPPER, now).paper, false, "MARKET with a zero cap is not paper");
  const ext = toRegimeState(raw(3, 500n, t - 60), HERO_WRAPPER, now);
  assert.equal(ext.paper, false, "EXTENDED with capacity is open but not paper");
  assert.equal(ext.glyph, "open");
  const shut = toRegimeState(raw(1, 0n, t - 60), HERO_WRAPPER, now);
  assert.equal(shut.glyph, "shut");
  const at30 = toRegimeState(raw(4, 1_000_000n, t - 1800), HERO_WRAPPER, now);
  assert.equal(at30.stale, false, "exactly 30 min is still fresh (block.timestamp > observedAt + 1800 is stale)");
  const stale = toRegimeState(raw(4, 1_000_000n, t - 1801), HERO_WRAPPER, now);
  assert.equal(stale.stale, true);
  assert.equal(stale.regime, "UNKNOWN");
  assert.equal(stale.attestedRegime, "MARKET");
  assert.equal(stale.cap, 0);
  assert.equal(stale.paper, false);
  assert.equal(stale.glyph, "unknown");
  assert.equal(toRegimeState(raw(0, 0n, 0), HERO_WRAPPER, now).attestedAgoMin, null);
});

test("regime: polling = clamp((transitionAt − now)/10, 5 s, 60 s)", () => {
  const now = 1_000_000;
  assert.equal(pollDelayMs(null, now), 60_000);
  assert.equal(pollDelayMs(now + 3_600_000, now), 60_000);
  assert.equal(pollDelayMs(now + 100_000, now), 10_000);
  assert.equal(pollDelayMs(now + 20_000, now), 5_000);
  assert.equal(pollDelayMs(now - 60_000, now), 5_000, "just overdue: the flip is imminent");
  assert.equal(pollDelayMs(now - 11 * 60_000, now), 60_000, "long overdue: stop hammering");
});

test("ratelimit: never more than RPC_PER_SECOND slots in any second", async () => {
  const stamps: number[] = [];
  await Promise.all(Array.from({ length: 12 }, () => rpcSlot(1).then(() => stamps.push(Date.now()))));
  await rpcSlot(2).then(() => stamps.push(Date.now(), Date.now()));
  for (const t of stamps) assert.ok(stamps.filter((x) => x >= t && x < t + 1000).length <= RPC_PER_SECOND);
});

test("api: PAYMENT-REQUIRED decodes (UTF-8, x402 v2)", () => {
  const header =
    "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjE5NiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDc3OWRlZDBjOWUxMDIyMjI1ZjhlMDYzMGIzNWE5YjU0YmU3MTM3MzYiLCJwYXlUbyI6IjB4Mjc3Y0E5MTI3NkEzODAxNjY3Qjc2Qzk3RGEzODcyQ2NiNkU5NjA2OCIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0Tigq4wIiwidmVyc2lvbiI6IjEifX1dfQ==";
  const pr = decodePaymentRequired(header);
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.accepts[0].amount, "10000");
  assert.equal(pr.accepts[0].network, "eip155:196");
  assert.equal(pr.accepts[0].extra?.name, "USD₮0");
  assert.equal(formatUsd6("10000"), "$0.01");
  assert.equal(formatUsd6("100000"), "$0.10");
});

test("scorecard: strict grading (a tie is not a win) and method names", () => {
  assert.equal(outcome(0, 0), "tie");
  assert.equal(outcome(3, 5), "win");
  assert.equal(outcome(5, 3), "loss");
  assert.equal(outcome(null, 3), null);
  assert.equal(methodName(keccak256(stringToBytes("curb.scorecard.mark/1"))), "curb.scorecard.mark/1");
  assert.equal(methodName("0x" + "00".repeat(32)), null);
});

test("depth: bond, notional and the published LTV (demo: 0.028 @ 52 vs 0.05 @ 55.78 ≈ 52%)", () => {
  const size = 28n * 10n ** 15n;
  assert.equal(notional(size, 52_000_000n), 1_456_000n);
  assert.equal(minBond(size, 52_000_000n), 145_600n);
  assert.equal(minBond(1n, 1n), 0n, "zero notional");
  assert.equal(regimeCapBps("MARKET", 1), 6000);
  assert.equal(regimeCapBps("CLOSED", 0), 3000);
  assert.equal(regimeCapBps("UNKNOWN", 0), 0);
  const base = { depthShares: 0.028, totalCollateral: 0.05, minBidPx: 52, price: 55.78 };
  assert.equal(ltvBpsAt({ ...base, regimeCapBps: 6000 }), 5220);
  assert.equal(ltvBpsAt({ ...base, regimeCapBps: 3000 }), 3000);
  assert.equal(ltvBpsAt({ ...base, regimeCapBps: 0 }), 0);
  assert.equal(ltvBpsAt({ ...base, depthShares: 0, regimeCapBps: 6000 }), 0, "no depth, no loan");
  assert.equal(ltvBpsAt({ ...base, price: null, regimeCapBps: 6000 }), 0);
  assert.equal(refusalName("0x00000000"), null);
});

test("notes: descending clock is linear then flat; value and discount", () => {
  const lot = { startPrice: 5_600_000n, floorPrice: 5_430_000n, startAt: 1000, decaySeconds: 1200 };
  assert.equal(lotPriceAt(lot, 1000), 5_600_000n);
  assert.equal(lotPriceAt(lot, 1600), 5_515_000n);
  assert.equal(lotPriceAt(lot, 2200), 5_430_000n);
  assert.equal(lotPriceAt(lot, 9999), 5_430_000n);
  let prev = lotPriceAt(lot, 0);
  for (let t = 0; t < 3000; t += 7) {
    const p = lotPriceAt(lot, t);
    assert.ok(p <= prev);
    prev = p;
  }
  assert.equal(valueUsdg(10n ** 17n, 55_780_000_000_000_000_000n), 5_578_000n);
  assert.equal(discountBps(5_578_000n, 5_430_000n), 265);
  assert.equal(discountBps(5_000_000n, 5_430_000n), 0);
});

test("suffix: Builder Code dd7u50nckt5e729f, ERC-8021 schema 0, 34 bytes", () => {
  const hex = DATA_SUFFIX.slice(2);
  assert.equal(hex.length, 68);
  assert.equal(Buffer.from(hex.slice(0, 32), "hex").toString("utf8"), "dd7u50nckt5e729f");
  assert.equal(hex.slice(32, 36), "1000");
  assert.equal(hex.slice(36), "8021".repeat(8));
});

test("mock: ?mock=1 serves fixtures in the live shapes", async () => {
  setMock(true);
  try {
    const r = await getRegime();
    assert.equal(r.source, "fixture");
    assert.equal(r.symbol, "wTCENTx");
    const board = await fixture("board");
    assert.equal(board.rows.length, 6);
    const sc = await fixture("scorecard");
    assert.equal(sc.skill.closureCount, sc.rows.length);
    const unpaid = await fixture("unpaid");
    assert.equal(unpaid["/v1/closure-calendar"].status, 402);
    for (const k of ["notes", "lots", "certs", "credit", "depth"] as const) {
      const v = (await fixture(k)) as { specimen: boolean }[];
      assert.ok(v.length > 0 && v.every((x) => x.specimen), `${k} fixtures are specimens`);
    }
  } finally {
    setMock(null);
  }
});
