/**
 * The swap scan against stubbed endpoints that answer with real mainnet logs (F1: every Swap log of the five price
 * pools in blocks 75773020..75773120) or with the exact refusals measured on the two public X Layer RPCs
 * (nov/reports/rpc-behaviour.md 2.4, 2.6, 5.4). Nothing here leaves the machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanRange, readHeads, rpcRaw, classifyRpcError } from "./logscan.ts";
import type { ScanOptions, ScanResult, RpcKind } from "./logscan.ts";
import type { PoolSpec, RawSwapLog } from "./pools.ts";

type RawLog = RawSwapLog & { blockHash?: string; removed?: boolean };
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/swaplogs-75773020-75773120.json", import.meta.url), "utf8")) as { fromBlock: number; toBlock: number; logs: RawLog[] };
const FROM = FIXTURE.fromBlock, TO = FIXTURE.toBlock;     // 75773020..75773120: two chunks, [..119] and [120]

const spec = (wrapper: string, symbol: string, pool: string, equityIsToken0: boolean): PoolSpec =>
  ({ wrapper, symbol, pool, equityIsToken0, equityDecimals: 18, stableDecimals: 6 });
const TCENT = spec("0x41333Df9E7639188BBfca5522dC4844398Af9f9E", "wTCENTx", "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f", true);
const XIAO = spec("0x076CF393E701839FC7a5832D2c68AaFA235682AE", "wXIAOx", "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", true);
const MEIT = spec("0xad1b65C8556957cf23d1B5e9accdc449b415fA97", "wMEITx", "0x54E89e9acaFb073e7fd8471312E753A661b470C7", false);
const NVDA = spec("0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5", "wNVDAx", "0x2a2B11730C2b6d99a58034A869dd810D7300a7b2", false);
const AAPL = spec("0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f", "wAAPLx", "0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2", false);
const ALL = [TCENT, XIAO, MEIT, NVDA, AAPL];
const RPCS = ["https://rpc.one.test", "https://rpc.two.test"];
const HIGH = TO + 1_000;

interface Filter { address: string[]; topics: string[]; fromBlock: string; toBlock: string }
interface Call { url: string; method: string; filter?: Filter }
type Reply = { status?: number; body: unknown } | "hang" | Promise<{ status?: number; body: unknown }>;

/** The logs a correct node returns for a filter. */
function serve(logs: RawLog[], f: Filter): RawLog[] {
  const want = new Set(f.address.map((a) => a.toLowerCase()));
  return logs.filter((l) => want.has(l.address.toLowerCase()) && Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock));
}

/** A fetch that dispatches to `handler(endpointIndex, filter, method)`; records every call; "hang" never answers but honours the signal. */
function stub(handler: (ep: number, f: Filter | undefined, method: string) => Reply, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const ep = RPCS.indexOf(String(url));
    const filter = req.method === "eth_getLogs" ? (req.params[0] as Filter) : undefined;
    calls.push({ url: String(url), method: req.method, filter });
    if (filter) {
      assert.ok(Number(filter.toBlock) >= Number(filter.fromBlock), "never from > to");
      assert.ok(Number(filter.toBlock) - Number(filter.fromBlock) <= 99, "never wider than 100 blocks");
      assert.ok(filter.address.length > 0, "never an empty address list");
    }
    let r = handler(ep, filter, req.method);
    if (r === "hang") {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) reject(s.reason);
        s?.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    }
    const a = await r;
    const body = a.body !== null && typeof a.body === "object" && "error" in (a.body as object)
      ? { jsonrpc: "2.0", id: req.id, ...(a.body as object) }
      : { jsonrpc: "2.0", id: req.id, result: a.body };
    return new Response(JSON.stringify(body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const node = (logs: RawLog[] = FIXTURE.logs) => (_ep: number, f: Filter | undefined) => ({ body: f ? serve(logs, f) : "0x" + HIGH.toString(16) });
const opts = (fetchImpl: typeof fetch, o: Partial<ScanOptions> = {}): ScanOptions =>
  ({ maxChunks: 10, deadlineMs: 10_000, heads: [HIGH, HIGH], endpointOrder: "first", fetchImpl, ...o });
const counts = (r: ScanResult) => Object.fromEntries(ALL.map((s) => [s.symbol, r.rows.get(s.pool)!.length]));
const total = (r: ScanResult) => [...r.rows.values()].reduce((n, x) => n + x.length, 0);
const CLEAN = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node())));

test("serves every chunk from the first endpoint whose head covers it", async () => {
  const calls: Call[] = [];
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node(), calls)));
  assert.equal(r.servedTo, 75773120);
  assert.deepEqual(counts(r), { wTCENTx: 2, wXIAOx: 4, wMEITx: 0, wNVDAx: 12, wAAPLx: 0 });
  assert.equal(r.stats.logs, 18);
  assert.equal(r.stats.decoded, 18);
  assert.equal(r.stopReason, null);
  assert.deepEqual(r.holes, new Map());
  assert.deepEqual(r.stats.servedBy, { [RPCS[0]]: 2 });
  assert.ok(calls.every((c) => c.url === RPCS[0] && c.method === "eth_getLogs"), "no head reads inside the scan, endpoint 0 only");
  assert.deepEqual(calls.map((c) => [Number(c.filter!.fromBlock), Number(c.filter!.toBlock)]), [[75773020, 75773119], [75773120, 75773120]]);
  assert.deepEqual(calls[0].filter!.topics, ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"]);
  const x = r.rows.get(XIAO.pool)!;
  assert.deepEqual(x.map((w) => [w.blockNumber, w.logIndex]), [[75773038, 38], [75773040, 97], [75773042, 3], [75773077, 68]]);
  assert.equal(x[3].priceE18, 3_705_883_235_022_724_078n);
  assert.match(x[3].blockHash!, /^0x[0-9a-f]{64}$/, "the block hash rides along for the reorg check");
});

test("never asks an endpoint above its reported head", async () => {
  const calls: Call[] = [];
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node(), calls), { heads: [75773119, 75774120] }));
  assert.ok(calls.filter((c) => c.url === RPCS[0]).every((c) => Number(c.filter!.toBlock) < 0x48434c0), "endpoint 0 never asked for 75773120");
  assert.equal(r.servedTo, 75773120);
  assert.deepEqual(r.stats.servedBy, { [RPCS[0]]: 1, [RPCS[1]]: 1 });
  assert.equal(total(r), 18);
  // An unknown head (-1) is never asked at all; a missing entry is unknown too.
  const c2: Call[] = [];
  const r2 = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node(), c2), { heads: [-1] }));
  assert.equal(c2.length, 0);
  assert.equal(r2.stopReason, "unserved");
  assert.equal(r2.servedTo, FROM - 1);
});

test("an unserved chunk stops the scan and keeps the progress before it", async () => {
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => {
    if (f && Number(f.fromBlock) === 75773120) {
      return ep === 0
        ? { status: 429, body: { error: { code: -32016, message: "over rate limit" } } }
        : { status: 429, body: { error: { code: 15, message: "You reached Public endpoint rate limit, please upgrade to paid plan" } } };
    }
    return node()(ep, f);
  })));
  assert.equal(r.servedTo, 75773119);
  assert.equal(r.stopReason, "unserved");
  assert.deepEqual(r.stats.refusals.map((x) => x.kind), ["rate-limit", "rate-limit"]);
  assert.deepEqual(r.stats.refusals.map((x) => x.code), [-32016, 15]);
  assert.equal(total(r), 17, "the first chunk's rows are kept; nothing past servedTo is reported");
  assert.deepEqual(r.rows.get(TCENT.pool)!.map((w) => w.blockNumber), [75773105]);
});

test("an out-of-chunk block or removed:true rejects that answer and the other endpoint is used", async () => {
  const mutations: Array<(l: RawLog[]) => RawLog[]> = [
    (l) => [...l, { ...l[0], blockNumber: "0x" + (75773200).toString(16) }],   // a block outside the chunk
    (l) => l.map((x, i) => (i === 0 ? { ...x, removed: true } : x)),           // a removed log
  ];
  for (const mutate of mutations) {
    const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => {
      if (f && ep === 0 && Number(f.fromBlock) === FROM) return { body: mutate(serve(FIXTURE.logs, f)) };
      return node()(ep, f);
    })));
    assert.equal(r.stats.anomalies, 1);
    assert.deepEqual(r.rows, CLEAN.rows);
    assert.equal(r.stats.servedBy[RPCS[1]], 1, "chunk 1 came from endpoint 1");
    assert.equal(r.servedTo, TO);
  }
  // Not an array at all is an anomaly too.
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => (ep === 0 && f ? { body: null } : node()(ep, f)))));
  assert.equal(r.stats.anomalies, 2);
  assert.deepEqual(r.rows, CLEAN.rows);
});

test("a foreign address is dropped, the rest of the answer kept", async () => {
  const calls: Call[] = [];
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => {
    if (f && ep === 0 && Number(f.fromBlock) === FROM) {
      const l = serve(FIXTURE.logs, f);
      return { body: [...l, { ...l[1], address: "0x000000000000000000000000000000000000dead" }] };
    }
    return node()(ep, f);
  }, calls)));
  assert.equal(r.stats.unmatched, 1);
  assert.ok(calls.every((c) => c.url === RPCS[0]), "no request to endpoint 1");
  assert.deepEqual(r.rows, CLEAN.rows);
  assert.equal(r.stats.anomalies, 0);
});

// Review F1: the request filters on topic0 = Swap, so a requested pool's log without it is an endpoint fault.
const XIAO_LOG = FIXTURE.logs.findIndex((l) => l.address.toLowerCase() === XIAO.pool.toLowerCase() && Number(l.logIndex) === 97);
const garbles: Array<[string, (l: RawLog) => RawLog]> = [
  ["topics removed", (l) => { const { topics: _t, ...rest } = l; return rest as RawLog; }],
  ["topic0 garbled", (l) => ({ ...l, topics: ["0x" + "11".repeat(32), ...l.topics.slice(1)] })],
  ["topics empty", (l) => ({ ...l, topics: [] })],
];
const garbled = (g: (l: RawLog) => RawLog) => FIXTURE.logs.map((l, i) => (i === XIAO_LOG ? g(l) : l));

test("a requested pool's log with missing or wrong topics is asked of the other endpoint, never dropped", async () => {
  for (const [name, g] of garbles) {
    const calls: Call[] = [];
    const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => (ep === 0 ? node(garbled(g)) : node())(ep, f), calls)));
    assert.equal(r.stats.unmatched, 0, name);
    assert.equal(r.stats.decodeRetries, 1, name);
    assert.equal(r.stats.servedBy[RPCS[1]], 1, `${name}: chunk 1 served by endpoint 1`);
    assert.equal(r.holes.size, 0, name);
    assert.deepEqual(r.rows, CLEAN.rows, `${name}: wXIAOx keeps all 4 swaps`);
  }
});

test("a requested pool's log no endpoint returns with a Swap topic0 is a hole, not a covered block", async () => {
  for (const [name, g] of garbles) {
    const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node(garbled(g)))));
    assert.equal(r.servedTo, TO, name);
    assert.deepEqual(r.holes.get(XIAO.pool), [Number(FIXTURE.logs[XIAO_LOG].blockNumber)], name);
    assert.equal(r.stats.decodeFailed.length, 1, name);
    assert.match(r.stats.decodeFailed[0].error, /topic|topics/, name);
    assert.equal(r.rows.get(XIAO.pool)!.length, 3, name);
  }
});

const truncated = (logs: RawLog[]) => logs.map((l, i) => (i === 0 ? { ...l, data: l.data.slice(0, 2 + 64 * 3) } : l));

test("an undecodable log is asked of the other endpoint", async () => {
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => (ep === 0 ? node(truncated(FIXTURE.logs)) : node())(ep, f))));
  assert.equal(r.stats.servedBy[RPCS[1]], 1, "chunk 1 served by endpoint 1");
  assert.equal(r.stats.decodeRetries, 1);
  assert.deepEqual(r.stats.decodeFailed, []);
  assert.equal(r.holes.size, 0);
  assert.deepEqual(r.rows, CLEAN.rows);
});

test("a log no endpoint decodes becomes a hole", async () => {
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node(truncated(FIXTURE.logs)))));
  assert.equal(r.servedTo, 75773120);
  assert.equal(r.stats.decodeFailed.length, 1);
  assert.deepEqual({ ...r.stats.decodeFailed[0], error: "" }, { pool: NVDA.pool, blockNumber: 75773023, logIndex: 60, error: "" });
  assert.ok(r.stats.decodeFailed[0].error.length > 0);
  assert.deepEqual(r.holes.get(NVDA.pool), [75773023]);
  assert.equal(total(r), 17);
  assert.deepEqual(r.rows.get(NVDA.pool), CLEAN.rows.get(NVDA.pool)!.slice(1), "the other 17 rows are present");
  assert.equal(r.stats.logs, 18);
  assert.equal(r.stats.decoded, 17);
});

test("a range error is a programming error", async () => {
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(() => ({ status: 400, body: { error: { code: -32602, message: "block range greater than 100 max" } } }))));
  assert.equal(r.stats.programmingErrors, 2);
  assert.equal(r.stopReason, "unserved");
  assert.equal(r.servedTo, FROM - 1);
  assert.deepEqual(r.stats.refusals.map((x) => x.kind), ["malformed-request", "malformed-request"]);
});

test("budgets stop the scan cleanly", async () => {
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(node()), { maxChunks: 1 }));
  assert.equal(r.servedTo, 75773119);
  assert.equal(r.stopReason, "chunk-budget");
  // Nothing starts with less than 500 ms left. Every answer takes 600 ms; deadline 1,500 ms. Chunk 1: endpoint 0 may
  // wait 750 ms (half, endpoint 1 could still answer) and is served at 600 ms. Chunk 2: it may wait 500 ms, times
  // out, and the 400 ms left are too few to ask endpoint 1.
  const calls: Call[] = [];
  const slow = stub((ep, f) => new Promise((res) => setTimeout(() => res(node()(ep, f)), 600)), calls);
  const r2 = await scanRange(RPCS, ALL, FROM, TO, opts(slow, { deadlineMs: 1_500 }));
  assert.equal(r2.servedTo, 75773119);
  assert.equal(r2.stopReason, "time-budget");
  assert.deepEqual(calls.map((c) => RPCS.indexOf(c.url)), [0, 0]);
});

test("a hanging request never outlives the deadline", async () => {
  const t0 = performance.now();
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub(() => "hang"), { deadlineMs: 900 }));
  const took = performance.now() - t0;
  assert.ok(took < 1_400, `returned after ${Math.round(took)} ms`);
  assert.ok(r.stopReason === "time-budget" || r.stopReason === "unserved", String(r.stopReason));
  assert.equal(r.servedTo, FROM - 1);
  assert.equal(r.stats.refusals[0]?.kind, "transport");
});

test("a slow first endpoint gets about half the time left, and is not asked again once it timed out (review F2)", async () => {
  const calls: Call[] = [];
  const t0 = performance.now();
  // Endpoint 0 never answers (it honours its abort signal); endpoint 1 answers at once. Before the fix endpoint 0
  // took min(8 s, time left), the whole budget, and endpoint 1 was never asked.
  const r = await scanRange(RPCS, ALL, FROM, TO, opts(stub((ep, f) => (ep === 0 ? "hang" : node()(ep, f)), calls), { deadlineMs: 4_000 }));
  const took = performance.now() - t0;
  assert.equal(r.servedTo, TO);
  assert.equal(r.stopReason, null);
  assert.deepEqual(calls.map((c) => RPCS.indexOf(c.url)), [0, 1, 1], "chunk 1: 0 then 1; chunk 2: 1 only");
  assert.ok(took > 1_900 && took < 2_600, `endpoint 0 was given about half of 4 s (took ${Math.round(took)} ms)`);
  assert.deepEqual(r.rows, CLEAN.rows);
  // With only one eligible endpoint the request may take all the time left, still bounded by the deadline.
  const one: Call[] = [];
  const t1 = performance.now();
  const r1 = await scanRange(RPCS, ALL, FROM, TO, opts(stub(() => "hang", one), { deadlineMs: 1_200, heads: [HIGH, -1] }));
  assert.equal(one.length, 1);
  assert.ok(performance.now() - t1 < 1_300);
  assert.equal(r1.stopReason, "unserved", "the only endpoint timed out and is not asked again");
});

test("round-robin for historical chunks", async () => {
  const calls: Call[] = [];
  const r = await scanRange(RPCS, ALL, 1_000_000, 1_000_399, opts(stub(() => ({ body: [] }), calls), { heads: [2_000_000, 2_000_000], endpointOrder: "roundRobin" }));
  assert.equal(r.servedTo, 1_000_399);
  assert.deepEqual(calls.map((c) => RPCS.indexOf(c.url)), [0, 1, 0, 1]);
  // Near the head (within 200 blocks of the lower head) the order stays "first".
  const near: Call[] = [];
  await scanRange(RPCS, ALL, 1_999_700, 1_999_999, opts(stub(() => ({ body: [] }), near), { heads: [2_000_000, 2_000_050], endpointOrder: "roundRobin" }));
  assert.deepEqual(near.map((c) => [Number(c.filter!.fromBlock), RPCS.indexOf(c.url)]), [[1_999_700, 0], [1_999_800, 0], [1_999_900, 0]]);
});

test("no request when to < from or no pools", async () => {
  const calls: Call[] = [];
  const f = stub(node(), calls);
  const a = await scanRange(RPCS, ALL, TO, FROM, opts(f));
  const b = await scanRange(RPCS, [], FROM, TO, opts(f));
  assert.equal(calls.length, 0);
  assert.equal(a.servedTo, TO - 1);
  assert.equal(a.stopReason, null);
  assert.deepEqual([...a.rows.keys()].sort(), ALL.map((s) => s.pool).sort(), "every requested pool has an entry");
  assert.equal(b.rows.size, 0);
});

test("readHeads reads in parallel with a timeout", async () => {
  const t0 = performance.now();
  const heads = await readHeads(RPCS, 300, stub((ep) => (ep === 0 ? "hang" : new Promise((res) => setTimeout(() => res({ body: "0x484345f" }), 200)))));
  const took = performance.now() - t0;
  assert.deepEqual(heads, [-1, 75773023]);
  assert.ok(took < 700, `took ${Math.round(took)} ms`);
  // Nonsense answers are unknown heads, not zero.
  assert.deepEqual(await readHeads(RPCS, 300, stub((ep) => ({ body: ep === 0 ? null : "12" }))), [-1, -1]);
});

test("classifyRpcError table", () => {
  const table: Array<[number, number | null, string, RpcKind]> = [
    [429, null, "", "rate-limit"],
    [429, -32016, "over rate limit", "rate-limit"],
    [200, -32016, "over rate limit", "rate-limit"],
    [429, 15, "You reached Public endpoint rate limit, please upgrade to paid plan", "rate-limit"],
    [400, -32019, "block is out of range", "not-yet"],
    [200, -32000, "unsupported block number", "not-yet"],
    [200, 26, "Unknown block", "not-yet"],
    [200, 19, "Temporary internal error. Please retry, trace-id: 0123", "not-yet"],
    [200, -32000, "block not found: 0xabc", "not-yet"],
    [200, -32001, "block not found: hash 0xabc", "not-yet"],
    [400, -32602, "block range greater than 100 max", "malformed-request"],
    [400, 35, "ranges over 10000 blocks are not supported on free plan", "malformed-request"],
    [400, -32700, "parse error", "malformed-request"],
    [400, -32601, "hex string without 0x prefix", "malformed-request"],
    [400, -32601, "hex number with leading zero digits", "malformed-request"],
    [200, -32000, "execution reverted", "rpc"],
    [200, -32603, "internal error", "rpc"],
    [200, 4444, "pruned history unavailable", "rpc"],
  ];
  for (const [status, code, message, kind] of table) assert.equal(classifyRpcError(status, code, message), kind, `${status} ${code} ${message}`);
  assert.equal(classifyRpcError(200, -32000, "BLOCK NOT FOUND"), "not-yet", "case-insensitive");
});

test("rpcRaw is total: transport failures, odd bodies and HTTP errors are classified, never thrown", async () => {
  const text = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const a1 = await rpcRaw("u", "eth_blockNumber", [], 1_000, text(429, "Too Many Requests"));
  assert.equal(a1.ok === false && a1.kind, "rate-limit");
  const a2 = await rpcRaw("u", "eth_blockNumber", [], 1_000, text(502, "<html>bad gateway</html>"));
  assert.equal(a2.ok === false && a2.kind, "transport");
  assert.equal(a2.ok === false && a2.httpStatus, 502);
  const a3 = await rpcRaw("u", "eth_blockNumber", [], 1_000, text(200, '{"jsonrpc":"2.0","id":1}'));
  assert.equal(a3.ok === false && a3.kind, "transport", "JSON without result");
  const a4 = await rpcRaw("u", "eth_blockNumber", [], 1_000, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
  assert.equal(a4.ok === false && a4.kind, "transport");
  const a5 = await rpcRaw("u", "eth_getLogs", [], 1_000, text(400, '{"jsonrpc":"2.0","id":1,"error":{"code":-32019,"message":"block is out of range"}}'));
  assert.deepEqual(a5.ok === false && [a5.kind, a5.code, a5.httpStatus], ["not-yet", -32019, 400]);
  const a6 = await rpcRaw<string>("u", "eth_blockNumber", [], 1_000, text(200, '{"jsonrpc":"2.0","id":1,"result":"0x10"}'));
  assert.deepEqual(a6.ok && a6.result, "0x10");
  // A fetch that ignores its abort signal still cannot hold the caller past the timeout.
  const t0 = performance.now();
  const a7 = await rpcRaw("u", "eth_blockNumber", [], 200, (() => new Promise(() => {})) as unknown as typeof fetch);
  assert.equal(a7.ok === false && a7.kind, "transport");
  assert.ok(performance.now() - t0 < 600);
});
