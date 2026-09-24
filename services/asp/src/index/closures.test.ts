/**
 * The RegimeChanged indexer against stubbed endpoints, offline. The lagging endpoint behaves the way a
 * real one does -- it answers eth_getLogs for blocks it has not indexed with an empty list, not an error --
 * so a missing head guard would lose transitions here exactly as it would in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import { ClosureIndex, closureStartOf, decodeRegimeChanged, MARKETCLOCK_FIRST_BLOCK, REGIME_INDEX_SCHEMA } from "./closures.ts";
import type { EndpointRpc, RegimeTransition } from "./closures.ts";
import { clockAbi, endpointLabel } from "../sources/chain.ts";
import { Regime } from "../regime.ts";
import { hex32 } from "../fixtures/scorecard.ts";

const CLOCK = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
const W = getAddress("0x41333df9e7639188bbfca5522dc4844398af9f9e");
const V = getAddress("0x076cf393e701839fc7a5832d2c68aafa235682ae");
const EVENT = clockAbi.getEvent("RegimeChanged")!;

const tr = (block: number, from: number, to: number, wrapper = W, logIndex = 0): RegimeTransition =>
  ({ wrapper, from, to, at: 1_790_000_000 + block, block, logIndex, tx: hex32(block * 10 + logIndex) });

function logOf(t: RegimeTransition) {
  const { data, topics } = clockAbi.encodeEventLog(EVENT, [t.wrapper, t.from, t.to, t.at]);
  return { address: CLOCK.toLowerCase(), blockNumber: "0x" + t.block.toString(16), logIndex: "0x" + t.logIndex.toString(16), transactionHash: t.tx, topics, data };
}

interface Endpoint { head: number; fail?: (from: number, to: number) => boolean; gate?: Promise<void> }
type GetLogsCall = { url: string; from: number; to: number };

/** Endpoints over one chain of transitions. Each answers only what it has indexed: blocks <= its head. */
function stubRpc(chain: RegimeTransition[], endpoints: Record<string, Endpoint>, calls: GetLogsCall[]): EndpointRpc {
  return async (url, method, params) => {
    const e = endpoints[url];
    if (method === "eth_blockNumber") return "0x" + e.head.toString(16);
    assert.equal(method, "eth_getLogs");
    const f = (params as Array<{ address: string; topics: string[]; fromBlock: string; toBlock: string }>)[0];
    assert.equal(f.address, CLOCK);
    assert.deepEqual(f.topics, [EVENT.topicHash]);
    const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
    calls.push({ url, from, to });
    if (e.gate) await e.gate;
    if (e.fail?.(from, to)) throw new Error("over rate limit");
    return chain.filter((t) => t.block >= from && t.block <= to && t.block <= e.head).map(logOf);
  };
}

const tmp = () => join(mkdtempSync(join(tmpdir(), "curb-asp-index-")), "index", "regime-changes.json");

test("decodes MarketClock's first live RegimeChanged (block 70,617,365) by position, `at` included", () => {
  // Verbatim from eth_getLogs on X Layer, 24 Sep 2026. Decoding by name read `at` as Array.prototype.at.
  const t = decodeRegimeChanged({
    topics: [EVENT.topicHash, "0x000000000000000000000000076cf393e701839fc7a5832d2c68aafa235682ae"],
    data: "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006aa7dea1",
    blockNumber: "0x4358915",
    logIndex: "0x5a",
    transactionHash: "0x8e87d0f08af4025a742c377dce985449b3b131b3a61e64b0bb793b822fcd47e1",
  });
  assert.deepEqual(t, {
    wrapper: V, from: Regime.UNKNOWN, to: Regime.CLOSED,
    at: Date.parse("2026-09-14T11:46:41Z") / 1000, block: MARKETCLOCK_FIRST_BLOCK, logIndex: 90,
    tx: "0x8e87d0f08af4025a742c377dce985449b3b131b3a61e64b0bb793b822fcd47e1",
  });
});

test("a chunk is only asked of an endpoint whose head has reached its end; a lagging node's [] is never trusted", async () => {
  const chain = [tr(950, Regime.MARKET, Regime.CLOSED), tr(1010, Regime.CLOSED, Regime.MARKET), tr(1150, Regime.MARKET, Regime.CLOSED)];
  const calls: GetLogsCall[] = [];
  // A has indexed only to 1050. Listed first, so it is the preferred endpoint for chunks 0 and 2.
  const rpc = stubRpc(chain, { a: { head: 1050 }, b: { head: 1300 } }, calls);
  const idx = new ClosureIndex({ path: tmp(), clock: CLOCK, rpcs: ["a", "b"], startBlock: 900, rpc, concurrency: 1 });

  const r = await idx.step();
  assert.deepEqual(r, { caughtUp: true, scannedTo: 1295, added: 3, error: null }, "target = best head 1300 - 5 confirmations");
  assert.deepEqual(idx.status().transitions, 3, "including 1150, which A would have answered with []");
  for (const c of calls) {
    assert.ok(c.to - c.from + 1 <= 100, `chunk ${c.from}..${c.to} exceeds the 100-block cap`);
    if (c.url === "a") assert.ok(c.to <= 1050, `A was asked for ${c.from}..${c.to}, past its head`);
  }
  assert.deepEqual(calls.map((c) => `${c.url}:${c.from}-${c.to}`), ["a:900-999", "b:1000-1099", "b:1100-1199", "b:1200-1295"]);
  assert.equal(idx.status().caughtUp, true);
  assert.equal(idx.status().progressPct, 100);
});

test("a chunk no covering endpoint can serve stops the cursor there: re-asked next step, never skipped", async () => {
  const chain = [tr(950, Regime.MARKET, Regime.CLOSED), tr(1150, Regime.CLOSED, Regime.MARKET), tr(1250, Regime.MARKET, Regime.CLOSED)];
  const calls: GetLogsCall[] = [];
  let bDown = true;
  const rpc = stubRpc(chain, {
    a: { head: 1050 },
    b: { head: 1300, fail: (from) => bDown && from === 1100 },
  }, calls);
  const path = tmp();
  const idx = new ClosureIndex({ path, clock: CLOCK, rpcs: ["a", "b"], startBlock: 900, rpc, concurrency: 4 });

  const r1 = await idx.step();
  assert.equal(r1.scannedTo, 1099, "stopped before the hole");
  // Endpoints are named by position (and origin, when they are URLs), never by the string they were configured as.
  assert.match(r1.error!, /no RPC could serve RegimeChanged logs for 1100\.\.1199: rpc\[0\] head 1050 < 1199 \| rpc\[1\]: over rate limit/);
  assert.equal(idx.status().transitions, 1, "1250 was fetched, but lies past the hole, so it waits");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).lastScannedBlock, 1099, "the contiguous prefix is persisted");
  assert.equal(idx.closureStart(W, 1_790_000_000 + 1200, 1200).status, "pending-index");

  bDown = false;
  const r2 = await idx.step();
  assert.deepEqual(r2, { caughtUp: true, scannedTo: 1295, added: 2, error: null });
  assert.equal(idx.status().transitions, 3, "no duplicates from the chunk fetched twice");
  assert.equal(idx.status().lastError, null);
});

test("{lastScannedBlock, transitions} is persisted and resumed; a file for another clock is discarded", async () => {
  const chain = [tr(950, Regime.UNKNOWN, Regime.CLOSED), tr(990, Regime.CLOSED, Regime.MARKET), tr(1020, Regime.MARKET, Regime.CLOSED, W, 3)];
  const calls: GetLogsCall[] = [];
  const endpoints = { a: { head: 1105 } };
  const rpc = stubRpc(chain, endpoints, calls);
  const path = tmp();
  const first = new ClosureIndex({ path, clock: CLOCK, rpcs: ["a"], startBlock: 900, rpc });
  await first.step();
  assert.equal(first.status().lastScannedBlock, 1100);

  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.schema, REGIME_INDEX_SCHEMA);
  assert.equal(onDisk.clock, CLOCK);
  assert.equal(onDisk.startBlock, 900);
  assert.deepEqual(onDisk.transitions, chain);

  // A restart: nothing re-scanned, and the next chunk starts right after the cursor.
  chain.push(tr(1180, Regime.CLOSED, Regime.MARKET));
  endpoints.a.head = 1205;
  calls.length = 0;
  const second = new ClosureIndex({ path, clock: CLOCK, rpcs: ["a"], startBlock: 900, rpc });
  second.load();
  assert.equal(second.status().lastScannedBlock, 1100);
  assert.equal(second.status().transitions, 3);
  assert.deepEqual(second.closureStart(W, 1_790_000_000 + 1050, 1050), { status: "known", transition: chain[2] });
  await second.step();
  assert.deepEqual(calls.map((c) => c.from), [1101], "resumed at lastScannedBlock + 1");
  assert.equal(second.status().transitions, 4);

  // The same file under a different MarketClock is not this index: start over rather than trust it.
  const other = new ClosureIndex({ path, clock: "0x0000000000000000000000000000000000000001", rpcs: ["a"], startBlock: 900, rpc });
  other.load();
  assert.equal(other.status().lastScannedBlock, 899);
  assert.equal(other.status().transitions, 0);
  writeFileSync(path, "{ torn");
  const torn = new ClosureIndex({ path, clock: CLOCK, rpcs: ["a"], startBlock: 900, rpc });
  torn.load();
  assert.equal(torn.status().lastScannedBlock, 899, "an unreadable file is rebuilt from the chain, not fatal");
});

test("closure start: the last RegimeChanged into CLOSED strictly before committedAt, and every way it can be unknown", () => {
  const at = (b: number) => 1_790_000_000 + b;
  const log = [
    tr(10, Regime.UNKNOWN, Regime.CLOSED, V),        // V's first attestation
    tr(20, Regime.UNKNOWN, Regime.MARKET),           // W's first attestation
    tr(30, Regime.MARKET, Regime.CLOSED),            // W cut
    tr(31, Regime.MARKET, Regime.CLOSED, V, 1),      // never happens for V (it is CLOSED), but must not leak into W
    tr(40, Regime.CLOSED, Regime.MARKET),            // W reopen
    tr(50, Regime.MARKET, Regime.CLOSED),            // W cut again
  ].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  assert.deepEqual(closureStartOf(log, 60, W, at(55), 55), { status: "known", transition: log[5] });
  assert.deepEqual(closureStartOf(log, 60, W, at(35), 35), { status: "known", transition: log[2] });
  // Committed in the same second as the cut is not "strictly before": the latest earlier transition is the
  // reopen at 40, so the index says the market was open at the commit -- reported, not guessed.
  assert.deepEqual(closureStartOf(log, 60, W, at(50), 50), { status: "not-closed-at-commit", transition: log[2] });
  assert.deepEqual(closureStartOf(log, 60, W, at(45), 45), { status: "not-closed-at-commit", transition: log[2] });
  assert.deepEqual(closureStartOf(log, 60, W, at(25), 25), { status: "no-closed-transition", transition: null });
  assert.deepEqual(closureStartOf(log, 54, W, at(55), 55), { status: "pending-index", transition: null }, "index behind the commit block");
  assert.deepEqual(closureStartOf(log, 60, V, at(15), 15), { status: "first-attestation", transition: log[0] });
  assert.equal(closureStartOf(log, 60, V.toLowerCase(), at(35), 35).transition, log[3], "wrapper match ignores case");
  assert.deepEqual(closureStartOf([], 60, W, at(55), 55), { status: "no-closed-transition", transition: null });
});

test("the backfill runs on its own loop: lookups answer while a step is in flight, and abort stops it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: GetLogsCall[] = [];
  const rpc = stubRpc([tr(950, Regime.MARKET, Regime.CLOSED)], { a: { head: 1005, gate } }, calls);
  const idx = new ClosureIndex({ path: tmp(), clock: CLOCK, rpcs: ["a"], startBlock: 900, rpc });
  const ctl = new AbortController();
  const loop = idx.run({ signal: ctl.signal, idleMs: 5, busyGapMs: 0 });

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
    assert.ok(cond(), "timed out waiting");
  };
  await until(() => calls.length > 0);
  // A step is blocked inside eth_getLogs; the index still answers, from what it has.
  assert.equal(idx.closureStart(W, 1_790_000_960, 960).status, "pending-index");
  assert.equal(idx.status().lastScannedBlock, 899);
  assert.equal(idx.status().caughtUp, false);

  release();
  await until(() => idx.status().caughtUp);
  assert.equal(idx.closureStart(W, 1_790_000_960, 960).status, "known");
  ctl.abort();
  await loop;
});

test("an endpoint is named by position and origin only: a key in its path, query or userinfo never reaches lastError", async () => {
  assert.equal(endpointLabel("https://xlayer-mainnet.g.alchemy.com/v2/KEY_IN_PATH", 0), "rpc[0] https://xlayer-mainnet.g.alchemy.com");
  assert.equal(endpointLabel("https://lb.drpc.org/ogrpc?network=xlayer&dkey=KEY_IN_QUERY", 1), "rpc[1] https://lb.drpc.org");
  assert.equal(endpointLabel("https://user:KEY_IN_USERINFO@rpc.example:8545/", 2), "rpc[2] https://rpc.example:8545");
  assert.equal(endpointLabel("xlayer.example/v2/KEY_NO_SCHEME", 3), "rpc[3]", "not a URL: position alone, never the string");

  const keyed = ["https://rpc.one.test/v2/KEY_ONE", "https://rpc.two.test/?apikey=KEY_TWO"];
  const rpc: EndpointRpc = async (url, method) => {
    if (method === "eth_blockNumber") return url.includes("one") ? "0x" + (1_000).toString(16) : "0x" + (2_000).toString(16);
    throw new Error("429 over rate limit");
  };
  const idx = new ClosureIndex({ path: tmp(), clock: CLOCK, rpcs: keyed, startBlock: 900, rpc, concurrency: 1, maxChunksPerStep: 1 });
  await idx.step();
  const err = idx.status().lastError ?? "";
  assert.equal(err, "no RPC could serve RegimeChanged logs for 900..999: rpc[0] https://rpc.one.test: 429 over rate limit | rpc[1] https://rpc.two.test: 429 over rate limit");
  assert.ok(!/KEY_ONE|KEY_TWO|v2|apikey/.test(err), err);
});
