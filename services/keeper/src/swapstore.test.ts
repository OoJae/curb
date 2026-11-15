/**
 * The closure swap store, on a temp directory: what reaches the file, what coverage may claim, and what happens
 * after a torn write, a lost file, a garbled line or a reorg. Real rows come from F1 (every Swap log of the five
 * price pools in blocks 75773020..75773120, the 13 Nov 2026 HK recess cut block 75773120).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAddress } from "ethers";
import { MARK_METHODS, MARK_METHOD_VERSION } from "./mark.ts";
import { CLOSING_BLOCKS, ClosureSwapStore, backfillJob, domainFrom, fillForCommit, ingest } from "./swapstore.ts";
import { addRange, gapsWithin, subtractRange } from "./ranges.ts";
import type { ClosureState, Tracked, StoreIo } from "./swapstore.ts";
import { decodeSwapLog } from "./sources/pools.ts";
import type { PoolSpec, RawSwapLog, SwapRow } from "./sources/pools.ts";
import { newScanStats } from "./sources/logscan.ts";
import type { ScanResult, ScanRow } from "./sources/logscan.ts";

type RawLog = RawSwapLog & { blockHash: string };
const FIXTURE = JSON.parse(readFileSync(new URL("./sources/fixtures/swaplogs-75773020-75773120.json", import.meta.url), "utf8")) as { fromBlock: number; toBlock: number; logs: RawLog[] };
const CUT = 75773120;

const spec = (wrapper: string, symbol: string, pool: string, equityIsToken0: boolean): PoolSpec =>
  ({ wrapper, symbol, pool, equityIsToken0, equityDecimals: 18, stableDecimals: 6 });
const TCENT = spec("0x41333Df9E7639188BBfca5522dC4844398Af9f9E", "wTCENTx", "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f", true);
const XIAO = spec("0x076CF393E701839FC7a5832D2c68AaFA235682AE", "wXIAOx", "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", true);
const MEIT = spec("0xad1b65C8556957cf23d1B5e9accdc449b415fA97", "wMEITx", "0x54E89e9acaFb073e7fd8471312E753A661b470C7", false);
const NVDA = spec("0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5", "wNVDAx", "0x2a2B11730C2b6d99a58034A869dd810D7300a7b2", false);
const AAPL = spec("0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f", "wAAPLx", "0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2", false);
const ALL = [TCENT, XIAO, MEIT, NVDA, AAPL];
const RPCS = ["https://rpc.one.test", "https://rpc.two.test"];

const tmp = () => mkdtempSync(join(tmpdir(), "curb-swapstore-"));
function harness(io?: StoreIo) {
  const dir = tmp();
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const store = new ClosureSwapStore(dir, (event, fields) => events.push({ event, fields }), io);
  return { dir, events, store, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const closure = (s: PoolSpec, cutBlock = CUT, extra: Partial<ClosureState> = {}): ClosureState =>
  ({ wrapper: s.wrapper, symbol: s.symbol, cutBlock, witnessedCut: true, ...extra });
const row = (b: number, i: number, p = 1_000n, q = 5n): SwapRow => ({ blockNumber: b, logIndex: i, equityAbs: q, priceE18: p });
const line = (r: SwapRow) => JSON.stringify({ b: r.blockNumber, i: r.logIndex, q: r.equityAbs.toString(), p: r.priceE18.toString() }) + "\n";
const lines = (path: string) => readFileSync(path, "utf8").split("\n").slice(0, -1);
const allValid = (path: string) => lines(path).every((l) => { try { const v = JSON.parse(l); return Number.isInteger(v.b) && Number.isInteger(v.i); } catch { return false; } });
function write(path: string, content: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

/** F1 decoded, as one scan of [from, to] would return it. */
function scanOf(from: number, to: number, opts: { logs?: RawLog[]; specs?: PoolSpec[]; servedTo?: number } = {}): ScanResult {
  const specs = opts.specs ?? ALL;
  const servedTo = opts.servedTo ?? to;
  const rows = new Map<string, ScanRow[]>(specs.map((s) => [getAddress(s.pool), []]));
  for (const l of opts.logs ?? FIXTURE.logs) {
    const b = Number(l.blockNumber);
    const s = specs.find((x) => x.pool.toLowerCase() === l.address.toLowerCase());
    if (!s || b < from || b > servedTo) continue;
    rows.get(getAddress(s.pool))!.push({ ...decodeSwapLog(l, s)!, blockHash: l.blockHash });
  }
  return { from, to, servedTo, rows, holes: new Map(), stats: newScanStats(), stopReason: null };
}

test("CLOSING_BLOCKS is mark/2's window", () => {
  assert.equal(CLOSING_BLOCKS, Math.ceil(MARK_METHODS[MARK_METHOD_VERSION].closingVwapWindowMs / 1000));
  assert.equal(domainFrom({ cutBlock: CUT }), 75772220);
  assert.equal(domainFrom({ cutBlock: 10 }), 0);
});

test("append and read round trip, filtered and deduplicated", () => {
  const h = harness();
  try {
    const c = closure(XIAO, 1_000);                                    // domain [100, ∞)
    h.store.ensure(c);
    h.store.append(c, [row(1_001, 0), row(99, 1), row(1_000, 2), row(100, 3)]);
    appendFileSync(h.store.path(c), line(row(1_000, 2)));             // the same row twice in the file
    assert.equal(h.store.count(c), 3, "domainFrom - 1 is outside the domain");
    const fresh = new ClosureSwapStore(h.dir, () => {});
    const r = fresh.read({ ...c, coverage: { ranges: [], rows: 3 } }, Number.MAX_SAFE_INTEGER);
    assert.equal(r.reset, false);
    assert.deepEqual(r.rows.map((x) => [x.blockNumber, x.logIndex]), [[100, 3], [1_000, 2], [1_001, 0]]);
    assert.deepEqual(r.rows[0], row(100, 3));
    assert.deepEqual(fresh.read({ ...c, coverage: { ranges: [], rows: 3 } }, 1_000).rows.length, 2, "toBlock is inclusive");
    // A row already in the file is never appended again; the old reader's format is kept.
    h.store.append(c, [row(1_001, 0), row(1_002, 0), row(1_002, 0)]);
    assert.equal(lines(h.store.path(c)).length, 6);
    assert.equal(lines(h.store.path(c))[0], '{"b":1001,"i":0,"q":"5","p":"1000"}');
    assert.ok(h.store.has(c, "1002:0"));
    assert.equal(h.store.has(c, "1003:0"), false);
  } finally { h.done(); }
});

test("a torn tail is truncated before the next append", () => {
  const h = harness();
  try {
    const c = closure(XIAO, 1_000);
    write(h.store.path(c), line(row(101, 0)) + '{"b":102,"i":3,"q":"12');
    const e = h.store.ensure(c);
    assert.deepEqual(e, { reset: false, repaired: true, rows: 1 });
    h.store.append(c, [row(102, 3), row(103, 0)]);
    const ls = lines(h.store.path(c));
    assert.equal(ls.length, 3);
    assert.ok(allValid(h.store.path(c)));
    assert.deepEqual(ls.map((l) => JSON.parse(l).b), [101, 102, 103], "each row once");
    const ev = h.events.find((x) => x.event === "swap-file-repaired");
    assert.equal(ev?.fields?.tornTail, true);
  } finally { h.done(); }
});

test("a NUL-filled tail is torn too", () => {
  const h = harness();
  try {
    const c = closure(XIAO, 1_000);
    write(h.store.path(c), Buffer.concat([Buffer.from(line(row(101, 0))), Buffer.alloc(64, 0)]));
    assert.equal(h.store.ensure(c).repaired, true);
    assert.equal(readFileSync(h.store.path(c), "utf8"), line(row(101, 0)));
  } finally { h.done(); }
});

test("an append that throws is repaired before the next", () => {
  let fail = true;
  const io: StoreIo = {
    appendData(fd, data) {
      if (fail) { fail = false; writeSync(fd, data.slice(0, Math.floor(data.length * 0.75))); throw new Error("ENOSPC: no space left on device"); }
      writeSync(fd, data);
    },
  };
  const h = harness(io);
  try {
    const c = closure(XIAO, 1_000, { coverage: { ranges: [[100, 150]], rows: 0 } });
    h.store.ensure(c);
    assert.throws(() => h.store.append(c, [row(160, 0), row(161, 0)]), /ENOSPC/);
    assert.deepEqual(c.coverage, { ranges: [[100, 150]], rows: 0 }, "coverage unchanged");
    assert.equal(h.store.has(c, "161:0"), false, "key set unchanged by the failed append");
    h.store.append(c, [row(160, 0), row(161, 0)]);
    assert.ok(allValid(h.store.path(c)), "0 invalid lines");
    assert.deepEqual(lines(h.store.path(c)).map((l) => JSON.parse(l).b), [160, 161], "each row once");
    assert.equal(h.store.count(c), 2);
  } finally { h.done(); }
});

test("a garbled middle line resets the closure", () => {
  const h = harness();
  try {
    const c = closure(XIAO, 1_000, { coverage: { ranges: [[100, 300]], rows: 2 } });
    write(h.store.path(c), line(row(101, 0)) + '{"b":1x2,"i":0}\n' + line(row(103, 0)));
    assert.equal(h.store.ensure(c).reset, true);
    assert.equal(existsSync(h.store.path(c)), false, "file removed");
    assert.deepEqual(c.coverage, { ranges: [], rows: 0 });
    assert.ok(h.events.some((x) => x.event === "swap-file-reset" && x.fields?.reason === "corrupt"));
    // Two different rows under one (b, i) is corruption too.
    const d = closure(TCENT, 1_000, { coverage: { ranges: [[100, 300]], rows: 1 } });
    write(h.store.path(d), line(row(101, 0, 1n)) + line(row(101, 0, 2n)));
    assert.equal(h.store.ensure(d).reset, true);
  } finally { h.done(); }
});

test("coverage without its rows is reset", () => {
  const h = harness();
  try {
    const cov = () => ({ ranges: [[CUT - 900, CUT + 500]] as Array<[number, number]>, rows: 7 });
    const absent = closure(XIAO, CUT, { coverage: cov() });
    assert.equal(h.store.ensure(absent).reset, true);
    assert.deepEqual(absent.coverage, { ranges: [], rows: 0 });
    const empty = closure(TCENT, CUT, { coverage: cov() });
    write(h.store.path(empty), "");
    assert.equal(h.store.ensure(empty).reset, true);
    assert.deepEqual(empty.coverage, { ranges: [], rows: 0 });
    const full = closure(NVDA, CUT, { coverage: cov() });
    write(h.store.path(full), Array.from({ length: 7 }, (_, k) => line(row(CUT + k, 0))).join(""));
    assert.deepEqual(h.store.ensure(full), { reset: false, repaired: false, rows: 7 });
    assert.deepEqual(full.coverage, cov(), "coverage kept");
    // Old state: no coverage at all starts empty, without a reset.
    const old = closure(MEIT);
    assert.equal(h.store.ensure(old).reset, false);
    assert.deepEqual(old.coverage, { ranges: [], rows: 0 });
  } finally { h.done(); }
});

test("read() notices a file deleted while running", () => {
  const h = harness();
  try {
    const c = closure(XIAO, 1_000);
    h.store.ensure(c);
    h.store.append(c, [row(200, 0), row(201, 0)]);
    c.coverage = { ranges: [[100, 300]], rows: h.store.count(c) };
    rmSync(h.store.path(c));
    const r = h.store.read(c, 1_000);
    assert.equal(r.reset, true);
    assert.deepEqual(r.rows, []);
    assert.deepEqual(c.coverage, { ranges: [], rows: 0 });
  } finally { h.done(); }
});

test("ingest claims coverage only after the append succeeded", () => {
  const broken = harness({ appendData() { throw new Error("EIO: i/o error, write"); } });
  const h = harness();
  try {
    const c = closure(NVDA);
    const t: Tracked = { c, pool: NVDA.pool };
    const scan = scanOf(FIXTURE.fromBlock, FIXTURE.toBlock);
    const bad = ingest(broken.store, [t], scan, new Map());
    assert.deepEqual(c.coverage!.ranges, []);
    assert.deepEqual(bad.appendErrors.map((e) => e.symbol), ["wNVDAx"]);
    assert.match(bad.appendErrors[0].error, /EIO/);
    assert.equal(bad.claimed, 0);
    const ok = ingest(h.store, [t], scan, new Map());
    assert.equal(ok.appended, 12);
    assert.deepEqual(c.coverage!.ranges, [[75773020, 75773120]]);
    assert.equal(c.coverage!.rows, h.store.count(c));
    assert.equal(c.coverage!.rows, 12);
    assert.equal(lines(h.store.path(c)).length, 12, "rows appended once");
  } finally { broken.done(); h.done(); }
});

test("ingest leaves holes out of coverage", () => {
  const h = harness();
  try {
    const c = closure(XIAO);
    const scan = scanOf(75773020, 75773120);
    scan.holes.set(getAddress(XIAO.pool), [75773050]);
    ingest(h.store, [{ c, pool: XIAO.pool }], scan, new Map());
    assert.deepEqual(c.coverage!.ranges, [[75773020, 75773049], [75773051, 75773120]]);
    // A later scan that decodes the hole's block covers it; a hole in a block an earlier scan covered stops being covered.
    const again = scanOf(75773020, 75773120);
    again.holes.set(getAddress(XIAO.pool), [75773060]);
    ingest(h.store, [{ c, pool: XIAO.pool }], again, new Map());
    assert.deepEqual(c.coverage!.ranges, [[75773020, 75773059], [75773061, 75773120]]);
    // The scan's range is clipped to the closure's domain; nothing past servedTo is claimed.
    const early = closure(TCENT, 75773100);                                 // domain starts at 75772200
    ingest(h.store, [{ c: early, pool: TCENT.pool }], scanOf(75772000, 75773120, { servedTo: 75773110 }), new Map());
    assert.deepEqual(early.coverage!.ranges, [[75772200, 75773110]]);
    assert.deepEqual(h.store.read(early, 75773120).rows.map((r) => r.blockNumber), [75773105]);
  } finally { h.done(); }
});

test("ingest counts late logs and duplicates; skips closures with a plan", () => {
  const h = harness();
  try {
    const c = closure(NVDA);
    const t: Tracked = { c, pool: NVDA.pool };
    const without = FIXTURE.logs.filter((l) => !(Number(l.blockNumber) === 75773083 && Number(l.logIndex) === 6));
    const first = ingest(h.store, [t], scanOf(75773020, 75773120, { logs: without }), new Map());
    assert.equal(first.appended, 11);
    const again = ingest(h.store, [t], scanOf(75773020, 75773120), new Map());
    assert.equal(again.dupes, 11);
    assert.equal(again.late, 1, "a row inside an already-covered block");
    assert.equal(again.appended, 1);
    assert.equal(h.store.count(c), 12);
    const planned = closure(XIAO, CUT, { plan: { root: "0x" } });
    const committed = closure(TCENT, CUT, { committed: { id: "0x" } });
    const unwitnessed = closure(MEIT, CUT, { witnessedCut: false });
    const r = ingest(h.store, [{ c: planned, pool: XIAO.pool }, { c: committed, pool: TCENT.pool }, { c: unwitnessed, pool: MEIT.pool }], scanOf(75773020, 75773120), new Map());
    assert.equal(r.appended, 0);
    for (const x of [planned, committed, unwitnessed]) assert.equal(existsSync(h.store.path(x)), false, `${x.symbol}: no file written`);
    assert.equal(planned.coverage, undefined, "a frozen closure's state is not touched");
  } finally { h.done(); }
});

/** A synthetic one-pool scan: one row per block in [from, to], hash and price chosen per block. */
function synthetic(pool: string, from: number, to: number, hashOf: (b: number) => string, priceOf: (b: number) => bigint): ScanResult {
  const rows: ScanRow[] = [];
  for (let b = from; b <= to; b++) rows.push({ blockNumber: b, logIndex: 1, equityAbs: 1n, priceE18: priceOf(b), blockHash: hashOf(b) });
  return { from, to, servedTo: to, rows: new Map([[getAddress(pool), rows]]), holes: new Map(), stats: newScanStats(), stopReason: null };
}

test("a reorg truncates from the reorged block only", () => {
  const h = harness();
  try {
    const cut = 1_000;                                                       // domain [100, ∞)
    const c = closure(XIAO, cut);
    const other = closure(NVDA, cut);
    const hashes = new Map<string, string>();
    const A = (b: number) => "0x" + "aa".repeat(31) + (b % 256).toString(16).padStart(2, "0");
    const B = (b: number) => "0x" + "bb".repeat(31) + (b % 256).toString(16).padStart(2, "0");
    ingest(h.store, [{ c, pool: XIAO.pool }], synthetic(XIAO.pool, 100, 200, A, () => 1n), hashes);
    ingest(h.store, [{ c: other, pool: NVDA.pool }], synthetic(NVDA.pool, 100, 200, A, () => 1n), hashes);
    assert.deepEqual(c.coverage!.ranges, [[cut - 900, 200]]);
    const rep = ingest(h.store, [{ c, pool: XIAO.pool }],
      synthetic(XIAO.pool, 140, 205, (b) => (b < 150 ? A(b) : B(b)), (b) => (b < 150 ? 1n : 2n)), hashes);
    assert.equal(rep.reorgAt, 150);
    const rows = h.store.read(c, 1_000).rows;
    assert.deepEqual(rows.filter((r) => r.blockNumber < 150).map((r) => [r.blockNumber, r.priceE18]),
      Array.from({ length: 50 }, (_, k) => [100 + k, 1n]), "rows below 150 untouched");
    assert.deepEqual(rows.filter((r) => r.blockNumber >= 150).map((r) => [r.blockNumber, r.priceE18]),
      Array.from({ length: 56 }, (_, k) => [150 + k, 2n]), "rows from 150 are this scan's");
    assert.deepEqual(c.coverage!.ranges, [[cut - 900, 205]]);
    assert.equal(c.coverage!.rows, 106);
    // A closure the detecting scan did not carry is truncated at its own next ingest, whatever scan that is.
    ingest(h.store, [{ c: other, pool: NVDA.pool }], synthetic(NVDA.pool, 300, 301, A, () => 1n), hashes);
    assert.deepEqual(other.coverage!.ranges, [[cut - 900, 149], [300, 301]]);
    assert.equal(h.store.read(other, 1_000).rows.filter((r) => r.blockNumber >= 150 && r.blockNumber <= 200).length, 0);
    // ...and only once: the same blocks re-read on the new chain are not a second reorg.
    const again = ingest(h.store, [{ c: other, pool: NVDA.pool }], synthetic(NVDA.pool, 150, 200, (b) => (b < 150 ? A(b) : B(b)), () => 3n), hashes);
    assert.equal(again.reorgAt, null);
    assert.deepEqual(other.coverage!.ranges, [[cut - 900, 200], [300, 301]]);
  } finally { h.done(); }
});

test("a reorg that renumbers a block's logs is detected (review F3)", () => {
  const h = harness();
  try {
    const X = 75773100;
    const c = closure(NVDA, 75773000);
    const pool = getAddress(NVDA.pool);
    const one = (rows: ScanRow[]): ScanResult => ({ from: X - 50, to: X + 50, servedTo: X + 50, rows: new Map([[pool, rows]]), holes: new Map(), stats: newScanStats(), stopReason: null });
    const r = (i: number, hash: string, p: bigint): ScanRow => ({ blockNumber: X, logIndex: i, equityAbs: 5n, priceE18: p, blockHash: hash });
    const hashes = new Map<string, string>();
    ingest(h.store, [{ c, pool }], one([r(5, "0x" + "aa".repeat(32), 1_000n)]), hashes);
    // Block X re-mined: the swap that was at logIndex 5 is now at 3, a new one at 7. No (b, i) key is shared.
    const rep = ingest(h.store, [{ c, pool }], one([r(3, "0x" + "bb".repeat(32), 1_001n), r(7, "0x" + "bb".repeat(32), 1_002n)]), hashes);
    assert.equal(rep.reorgAt, X);
    assert.deepEqual(h.store.read(c, X + 50).rows.filter((x) => x.blockNumber === X).map((x) => x.logIndex), [3, 7], "the stale (X, 5) is gone");
    assert.deepEqual(c.coverage!.ranges, [[X - 50, X + 50]]);
    // A block seen by another pool's row counts too: the hash is the block's, whichever pool's log carried it.
    const t2 = closure(XIAO, 75773000);
    const xpool = getAddress(XIAO.pool);
    const other: ScanResult = { from: X - 50, to: X + 50, servedTo: X + 50, rows: new Map([[xpool, [{ ...r(9, "0x" + "cc".repeat(32), 9n) }]]]), holes: new Map(), stats: newScanStats(), stopReason: null };
    assert.equal(ingest(h.store, [{ c: t2, pool: xpool }], other, hashes).reorgAt, X);
  } finally { h.done(); }
});

/** A node with no swaps, recording each eth_getLogs range; `delayMs` delays every answer. */
function emptyNode(calls: Array<[number, number]>, delayMs = 0): typeof fetch {
  return (async (_u: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ fromBlock: string; toBlock: string }> };
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (req.method === "eth_getLogs") calls.push([Number(req.params[0].fromBlock), Number(req.params[0].toBlock)]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }), { status: 200 });
  }) as typeof fetch;
}

test("fillForCommit scans the tail first, then the lowest gap", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 10_000);
    const d = domainFrom(c), p = 10_400;
    c.coverage = { ranges: [[d, d + 99], [d + 200, p - 5]], rows: 0 };
    const calls: Array<[number, number]> = [];
    const r = await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, p,
      { rpcs: RPCS, heads: [p, p], maxChunks: 20, deadlineMs: 10_000, recentHashes: new Map(), fetchImpl: emptyNode(calls) });
    assert.deepEqual(calls, [[p - 4, p], [d + 100, d + 199]]);
    assert.deepEqual(r.gapsLeft, []);
    assert.equal(r.chunks, 2);
    assert.equal(r.reset, false);
    assert.deepEqual(c.coverage!.ranges, [[d, p]]);
  } finally { h.done(); }
});

test("fillForCommit hands every scan and its ingest report to onScan", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 10_000);
    const d = domainFrom(c), p = 10_400;
    c.coverage = { ranges: [[d, d + 99], [d + 200, p - 5]], rows: 0 };
    const seen: Array<[number, number, number]> = [];
    await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, p, {
      rpcs: RPCS, heads: [p, p], maxChunks: 20, deadlineMs: 10_000, recentHashes: new Map(), fetchImpl: emptyNode([]),
      onScan: (scan, rep) => { seen.push([scan.from, scan.servedTo, rep.claimed]); throw new Error("ignored"); },
    });
    assert.deepEqual(seen, [[p - 4, p, 1], [d + 100, d + 199, 1]]);
    assert.deepEqual(c.coverage!.ranges, [[d, p]], "a throwing hook does not stop the fill");
  } finally { h.done(); }
});

test("fillForCommit: a hanging first endpoint does not use the whole budget; the other fills the tail (review F2)", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 1_900_000);
    const d = domainFrom(c), p = 1_950_000;
    c.coverage = { ranges: [[d, d + 399], [d + 500, p - 5]], rows: 0 };
    const calls: Array<[number, number, number]> = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { id: number; params: Array<{ fromBlock: string; toBlock: string }> };
      const ep = RPCS.indexOf(String(u));
      calls.push([ep, Number(req.params[0].fromBlock), Number(req.params[0].toBlock)]);
      if (ep === 0) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      }
      await new Promise((r) => setTimeout(r, 300));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }), { status: 200 });
    }) as typeof fetch;
    const t0 = performance.now();
    const r = await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, p,
      { rpcs: RPCS, heads: [p, p], maxChunks: 20, deadlineMs: 4_000, recentHashes: new Map(), fetchImpl: f });
    assert.ok(performance.now() - t0 < 4_100);
    assert.deepEqual(calls, [[0, p - 4, p], [1, p - 4, p], [1, d + 400, d + 499]], "endpoint 0 asked once, then left alone");
    assert.deepEqual(r.gapsLeft, []);
  } finally { h.done(); }
});

test("fillForCommit asks nothing when the closure is covered to the pinned block", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 10_000);
    const p = 10_400;
    c.coverage = { ranges: [[domainFrom(c), p]], rows: 0 };
    const calls: Array<[number, number]> = [];
    const t0 = performance.now();
    const r = await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, p,
      { rpcs: RPCS, heads: [p, p], maxChunks: 20, deadlineMs: 10_000, recentHashes: new Map(), fetchImpl: emptyNode(calls, 2_000) });
    assert.equal(calls.length, 0);
    assert.deepEqual(r.gapsLeft, []);
    assert.ok(performance.now() - t0 < 500);
  } finally { h.done(); }
});

test("fillForCommit stops at its budgets", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 10_000);
    const d = domainFrom(c), p = d + 2_999;                                  // 30 chunks of gap
    const calls: Array<[number, number]> = [];
    const r = await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, p,
      { rpcs: RPCS, heads: [p, p], maxChunks: 20, deadlineMs: 10_000, recentHashes: new Map(), fetchImpl: emptyNode(calls) });
    assert.equal(calls.length, 20);
    assert.equal(r.chunks, 20);
    assert.equal(r.stopReason, "chunk-budget");
    assert.deepEqual(r.gapsLeft, [[d + 2_000, p]]);
  } finally { h.done(); }
});

test("fillForCommit: a closure file lost under its coverage is reported and refilled", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 10_000);
    const p = 10_050;
    c.coverage = { ranges: [[domainFrom(c), p]], rows: 3 };                // claims 3 rows; there is no file
    const calls: Array<[number, number]> = [];
    const r = await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, p,
      { rpcs: RPCS, heads: [p, p], maxChunks: 20, deadlineMs: 10_000, recentHashes: new Map(), fetchImpl: emptyNode(calls) });
    assert.equal(r.reset, true);
    assert.equal(calls.length, 10);
    assert.deepEqual(r.gapsLeft, []);
  } finally { h.done(); }
});

test("a file the store cannot read never throws out of fillForCommit or ingest", async () => {
  const h = harness();
  try {
    const c = closure(XIAO, 10_000);
    const ok = closure(NVDA, 10_000);
    mkdirSync(h.store.path(c), { recursive: true });                       // reading it fails with EISDIR
    const calls: Array<[number, number]> = [];
    const r = await fillForCommit(h.store, { c, pool: XIAO.pool }, XIAO, 10_050,
      { rpcs: RPCS, heads: [10_050, 10_050], maxChunks: 20, deadlineMs: 10_000, recentHashes: new Map(), fetchImpl: emptyNode(calls) });
    assert.match(r.error ?? "", /EISDIR/);
    assert.deepEqual(r.gapsLeft, [[domainFrom(c), 10_050]]);
    const rep = ingest(h.store, [{ c, pool: XIAO.pool }, { c: ok, pool: NVDA.pool }], synthetic(NVDA.pool, 9_200, 9_210, () => "0x" + "aa".repeat(32), () => 1n), new Map());
    assert.deepEqual(rep.appendErrors.map((e) => e.symbol), ["wXIAOx"]);
    assert.deepEqual(ok.coverage!.ranges, [[9_200, 9_210]], "the other closure is unaffected");
  } finally { h.done(); }
});

test("backfill: a one-block hole never starves the other gaps (review F4)", () => {
  // Closure A (due first) has a persistent hole at one block and a long gap; closure B (due later) a long gap.
  const a = { c: closure(XIAO, 1_000_000), pool: XIAO.pool, dueMs: 1 };
  const b = { c: closure(NVDA, 1_003_000), pool: NVDA.pool, dueMs: 2 };
  a.c.coverage = { ranges: [[999_100, 999_149], [999_151, 1_001_999], [1_004_000, 1_020_000]], rows: 0 };
  b.c.coverage = { ranges: [[1_002_100, 1_004_099]], rows: 0 };
  const cursor = 1_020_000;
  const jobs: string[] = [];
  for (let tick = 0; tick < 12; tick++) {
    const job = backfillJob([a, b], cursor, 20);
    if (!job) break;
    jobs.push(`${job.from}..${job.to}`);
    // Serve the job: every block but the hole becomes covered.
    for (const t of [a, b]) {
      if (!job.pools.includes(getAddress(t.pool))) continue;
      const lo = Math.max(job.from, domainFrom(t.c));
      let r = addRange(t.c.coverage!.ranges, lo, job.to);
      if (t === a) r = subtractRange(r, 999_150, 999_150);
      t.c.coverage = { ranges: r, rows: 0 };
    }
  }
  assert.equal(jobs[0], "1002000..1003999", "A's long gap first, not its hole");
  const firstHole = jobs.indexOf("999150..999150");
  assert.ok(firstHole > 0, "the hole is still retried");
  assert.ok(jobs.slice(firstHole).every((j) => j === "999150..999150"), "only once every longer gap is filled");
  assert.deepEqual(gapsWithin(b.c.coverage!.ranges, domainFrom(b.c), cursor), [], "B is filled");
  assert.deepEqual(gapsWithin(a.c.coverage!.ranges, domainFrom(a.c), cursor), [[999_150, 999_150]]);
});

test("backfill job: earliest reopen first", () => {
  const hkCut = 75787526, usCut = 75848695;
  const mon0130 = Date.parse("2026-11-16T01:30:00Z"), mon0100 = Date.parse("2026-11-16T01:00:00Z");
  const hk = [TCENT, XIAO, MEIT].map((s) => ({ c: closure(s, hkCut), pool: s.pool, dueMs: mon0130 }));
  const us = [NVDA, AAPL].map((s) => ({ c: closure(s, usCut), pool: s.pool, dueMs: mon0100 }));
  const job = backfillJob([...hk, ...us], 76003700, 20);
  assert.deepEqual(job && { from: job.from, to: job.to }, { from: 75847795, to: 75849794 });
  assert.deepEqual([...job!.pools].sort(), ALL.map((s) => getAddress(s.pool)).sort(), "the HK closures share the range");
  // A job never extends past the chosen gap's end.
  us[0].c.coverage = { ranges: [[75847845, 76003700]], rows: 0 };
  us[1].c.coverage = { ranges: [[75847795, 76003700]], rows: 0 };
  const short = backfillJob([...hk, ...us], 76003700, 20);
  assert.deepEqual(short && { from: short.from, to: short.to }, { from: 75847795, to: 75847844 });
  assert.deepEqual([...short!.pools].sort(), [NVDA.pool, TCENT.pool, XIAO.pool, MEIT.pool].map((x) => getAddress(x)).sort());
  // Fully covered: the next due closure with a gap is chosen; none at all: null.
  us[0].c.coverage = { ranges: [[75847795, 76003700]], rows: 0 };
  assert.equal(backfillJob([...hk, ...us], 76003700, 20)!.from, 75786626);
  assert.equal(backfillJob(us, 76003700, 20), null);
  assert.equal(backfillJob([...hk, ...us], 76003700, 0), null, "0 chunks disables the backfill");
  assert.equal(backfillJob(hk, hkCut - 901, 20), null, "nothing below the cursor to fill");
});
