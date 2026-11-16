/**
 * Swap logs through the keeper's own decoder, on real mainnet bytes.
 *
 * Why this file has to exist. From 21 Sep to 14 Nov 2026 `swapsInRange` and `scanSwaps` decoded every Swap
 * log with `poolAbi.decodeEventLog("Swap", l.data, [])`. ethers 6.17 checks topics[0] whenever a topics
 * array is passed, so an EMPTY array throws "fragment/topic mismatch"; a bare `catch {}` swallowed it; and
 * 233 Scorecard rows were committed with `swaps=0`, `no-drift` and `no-closing-vwap` while the pools traded.
 * Nothing tested the scan against a log the node actually returns. These tests do.
 *
 * The fixture is real `eth_getLogs` output (X Layer mainnet, blocks 75773020..75773120: the 101 blocks up to
 * and including the keeper's cut block for the 13 Nov 2026 Hong Kong lunch recess). Two of its numbers are
 * pinned to the chain: the price after wXIAOx's last swap before the cut is the lastPrint that row committed
 * (inputRoot 0x06a92e82...1b75), and the price after wTCENTx's swap IN the cut block is the midAtCut of its row
 * (inputRoot 0x63d4a265...dc61). The network is a stubbed `fetch`; nothing here leaves the machine.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanSwaps, swapsInRange, vwap, poolAbi, newSwapScanStats, SWAP_TOPIC0 } from "./pools.ts";
import type { PoolSpec, RawSwapLog, SwapRow } from "./pools.ts";

type RawLog = RawSwapLog;
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/swaplogs-75773020-75773120.json", import.meta.url), "utf8")) as { fromBlock: number; toBlock: number; logs: RawLog[] };
const FROM = FIXTURE.fromBlock, TO = FIXTURE.toBlock;
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const spec = (wrapper: string, symbol: string, pool: string, equityIsToken0: boolean): PoolSpec =>
  ({ wrapper, symbol, pool, equityIsToken0, equityDecimals: 18, stableDecimals: 6 });
const TCENT = spec("0x41333Df9E7639188BBfca5522dC4844398Af9f9E", "wTCENTx", "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f", true);
const XIAO = spec("0x076CF393E701839FC7a5832D2c68AaFA235682AE", "wXIAOx", "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", true);
const MEIT = spec("0xad1b65C8556957cf23d1B5e9accdc449b415fA97", "wMEITx", "0x54E89e9acaFb073e7fd8471312E753A661b470C7", false);
const NVDA = spec("0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5", "wNVDAx", "0x2a2B11730C2b6d99a58034A869dd810D7300a7b2", false);
const AAPL = spec("0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f", "wAAPLx", "0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2", false);
const ALL = [TCENT, XIAO, MEIT, NVDA, AAPL];
const RPCS = ["https://rpc.one.test", "https://rpc.two.test"];

/** A node: answers eth_blockNumber and eth_getLogs from `logs`, exactly as the two public RPCs do. `extra` is
 *  appended to every eth_getLogs answer whatever the filter says (a misbehaving node). */
function node(logs: RawLog[], opts: { head?: number; calls?: unknown[]; extra?: RawLog[] } = {}) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    opts.calls?.push(req);
    let result: unknown;
    if (req.method === "eth_blockNumber") result = "0x" + (opts.head ?? TO + 1_000).toString(16);
    else if (req.method === "eth_getLogs") {
      const f = req.params[0] as { address: string | string[]; topics: string[]; fromBlock: string; toBlock: string };
      const want = new Set((Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase()));
      assert.deepEqual(f.topics, [SWAP_TOPIC], "the scan filters on the Swap topic");
      assert.ok(Number(f.toBlock) - Number(f.fromBlock) < 100, "never wider than the public RPCs' 100-block cap");
      result = [
        ...logs.filter((l) => want.has(l.address.toLowerCase()) && Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock)),
        ...(opts.extra ?? []).filter((l) => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock)),
      ];
    } else throw new Error(`unexpected ${req.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function withNode<T>(logs: RawLog[], fn: () => Promise<T>, opts: { head?: number; calls?: unknown[]; extra?: RawLog[] } = {}): Promise<T> {
  const m = mock.method(globalThis, "fetch", node(logs, opts));
  try { return await fn(); } finally { m.mock.restore(); }
}

test("the fixture is what the node returned: 18 Swap logs on three of the five pools", () => {
  assert.equal(SWAP_TOPIC0, SWAP_TOPIC);
  assert.equal(poolAbi.getEvent("Swap")!.topicHash, SWAP_TOPIC0);
  assert.equal(FIXTURE.logs.length, 18);
  assert.ok(FIXTURE.logs.every((l) => l.topics.length === 3 && l.topics[0] === SWAP_TOPIC0), "sender and recipient are indexed: three topics");
});

test("scanSwaps turns EVERY log the node returns into a row, pool by pool", async () => {
  const byPool = await withNode(FIXTURE.logs, () => scanSwaps(RPCS, ALL, FROM, TO));
  const count = (s: { pool: string }) => byPool.get(s.pool)!.length;
  assert.deepEqual({ wTCENTx: count(TCENT), wXIAOx: count(XIAO), wMEITx: count(MEIT), wNVDAx: count(NVDA), wAAPLx: count(AAPL) },
    { wTCENTx: 2, wXIAOx: 4, wMEITx: 0, wNVDAx: 12, wAAPLx: 0 });
  // The invariant that was broken for seven weeks: rows out == logs in.
  assert.equal([...byPool.values()].reduce((n, r) => n + r.length, 0), FIXTURE.logs.length, "no log may vanish between the node and the closure file");
});

test("swapsInRange: the price after the last swap before the cut is the lastPrint that row committed on chain", async () => {
  const rows = await withNode(FIXTURE.logs, () => swapsInRange(RPCS, XIAO, FROM, TO));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.blockNumber), [...rows.map((r) => r.blockNumber)].sort((a, b) => a - b), "ascending, so the last element is the last print");
  const last = rows[rows.length - 1];
  assert.deepEqual({ blockNumber: last.blockNumber, logIndex: last.logIndex }, { blockNumber: 75773077, logIndex: 68 });
  assert.equal(last.equityAbs, 8_200_000_000_000_000_000n, "8.2 wXIAOx: the equity leg is token0 in this pool");
  // Scorecard row for wXIAOx, 13 Nov 2026 recess: lastPrintE18 = midAtCutE18 = 3705883235022724078 (inputRoot 0x06a92e82...).
  assert.equal(last.priceE18, 3_705_883_235_022_724_078n);
  assert.equal(vwap(rows), 3_706_718_459_187_780_951n, "sum(price x size) / sum(size) over the four swaps");
});

test("swapsInRange: a swap IN the cut block is in the closing window, and its price is the mid at the cut", async () => {
  const rows = await withNode(FIXTURE.logs, () => swapsInRange(RPCS, TCENT, FROM, TO));
  assert.deepEqual(rows.map((r) => [r.blockNumber, r.logIndex]), [[75773105, 29], [75773120, 35]]);
  // Scorecard row for wTCENTx, same recess: midAtCutE18 = 49931913585409677182 (inputRoot 0x63d4a265...).
  assert.equal(rows[1].priceE18, 49_931_913_585_409_677_182n);
  assert.equal(vwap(rows), 49_931_922_021_995_547_562n);
});

test("a pool with the stable as token0 reads the equity leg from amount1 and inverts the price", async () => {
  const rows = await withNode(FIXTURE.logs, () => swapsInRange(RPCS, NVDA, FROM, TO));
  assert.equal(rows.length, 12);
  assert.deepEqual({ ...rows[0] }, { blockNumber: 75773023, logIndex: 60, equityAbs: 397_393_673_387_561_253n, priceE18: 164_133_425_934_190_481_847n });
  assert.equal(rows.reduce((n, r) => n + r.equityAbs, 0n), 19_119_652_048_577_850_273n);
  assert.equal(vwap(rows), 164_245_706_791_675_400_450n);
});

test("a range wider than 100 blocks is paged, and a pool the caller did not ask for is never returned", async () => {
  const calls: Array<{ method: string; params: Array<{ fromBlock: string; toBlock: string }> }> = [];
  const byPool = await withNode(FIXTURE.logs, () => scanSwaps(RPCS, [XIAO, TCENT], FROM, TO), { calls });
  const pages = calls.filter((c) => c.method === "eth_getLogs").map((c) => [Number(c.params[0].fromBlock), Number(c.params[0].toBlock)]);
  assert.deepEqual(pages, [[75773020, 75773119], [75773120, 75773120]]);
  assert.deepEqual([...byPool.keys()].sort(), [XIAO.pool, TCENT.pool].sort());
  assert.equal(byPool.get(TCENT.pool)!.length, 2, "the swap in the last, one-block page is not lost");
});

test("an endpoint whose head has not reached the chunk is not asked, and if none has, the scan throws", async () => {
  await assert.rejects(withNode(FIXTURE.logs, () => scanSwaps(RPCS, ALL, FROM, TO), { head: TO - 1 }), /no RPC could serve Swap logs/);
  await assert.rejects(withNode(FIXTURE.logs, () => swapsInRange(RPCS, XIAO, FROM, TO), { head: TO - 1 }), /no RPC could serve Swap logs/);
});

// --- a log that will not decode is counted and surfaced, never silently skipped ------------------

test("an undecodable log is reported with its pool, block and log index, and the others still decode", async () => {
  const bad: RawLog[] = FIXTURE.logs.map((l) => ({ ...l }));
  bad[0] = { ...bad[0], data: bad[0].data.slice(0, 2 + 64 * 3) };                 // truncated: no liquidity, no tick
  bad[5] = { ...bad[5], topics: ["0x" + "00".repeat(32), ...bad[5].topics.slice(1)] }; // not a Swap at all
  const stats = newSwapScanStats();
  const byPool = await withNode(bad, () => scanSwaps(RPCS, ALL, FROM, TO, stats));
  const rows = [...byPool.values()].reduce((n: number, r: SwapRow[]) => n + r.length, 0);
  assert.equal(stats.logs, 18);
  assert.equal(stats.decoded, rows);
  assert.equal(stats.undecodable.length, 2);
  assert.equal(stats.decoded + stats.undecodable.length, stats.logs, "every log is either a row or a named failure");
  assert.deepEqual(stats.undecodable.map((u) => [Number(u.blockNumber), Number(u.logIndex)]).sort(),
    [[Number(bad[0].blockNumber), Number(bad[0].logIndex)], [Number(bad[5].blockNumber), Number(bad[5].logIndex)]].sort());
  assert.ok(stats.undecodable.every((u) => u.error.length > 0 && /^0x[0-9a-fA-F]{40}$/.test(u.pool)));
});

test("on clean logs the statistics say so: 18 seen, 18 decoded, none undecodable, none unmatched", async () => {
  const stats = newSwapScanStats();
  await withNode(FIXTURE.logs, () => scanSwaps(RPCS, ALL, FROM, TO, stats));
  assert.deepEqual(stats, { logs: 18, decoded: 18, undecodable: [], unmatched: 0 });
  const one = newSwapScanStats();
  await withNode(FIXTURE.logs, () => swapsInRange(RPCS, NVDA, FROM, TO, one));
  assert.deepEqual(one, { logs: 12, decoded: 12, undecodable: [], unmatched: 0 });
});

test("a log for an address the scan did not ask for is counted as unmatched and never becomes a row", async () => {
  const foreign: RawLog = { ...FIXTURE.logs[0], address: "0x000000000000000000000000000000000000dEaD" };
  const clean = await withNode(FIXTURE.logs, () => scanSwaps(RPCS, ALL, FROM, TO));
  const stats = newSwapScanStats();
  const byPool = await withNode(FIXTURE.logs, () => scanSwaps(RPCS, ALL, FROM, TO, stats), { extra: [foreign] });
  assert.equal(stats.unmatched, 1);
  assert.equal(stats.logs, 18, "an unmatched log is not a pool's log");
  assert.deepEqual(byPool, clean, "rows unchanged");
});

test("the source never decodes a log against an empty topics array, and never swallows a decode in a bare catch", () => {
  const src = readFileSync(new URL("./pools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /decodeEventLog\([^)]*,\s*\[\s*\]\s*\)/, "an empty topics array makes ethers 6 refuse every log");
  assert.doesNotMatch(src, /catch\s*\{\s*\/\*[^*]*(malformed|skip)[^*]*\*\/\s*\}/, "a decode failure must be counted, not dropped");
});
