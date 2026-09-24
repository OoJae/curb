/**
 * The corporate-actions feed, offline: the sweep (paging, retries, versions, append-only), the lineage matcher
 * against HONx's real 2025-26 history, and the two free routes and /healthz through the real app.
 *
 * Every record below is the issuer's own node, copied verbatim from a sweep of
 * /corporate-actions/history on 24 Sep 2026. The chain values are the ones getCurrentMultiplier() returned at
 * the blocks named beside them (test/fork/ReplayHONx.t.sol pins the same ones).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";

import {
  CorporateActionsFeed, buildLineage, parseDec, matchDec, splitCheck, fromWei, decString, toWei, versionFileName,
  CA_SCHEMA, CA_LINEAGE_SCHEMA,
} from "./corporateActions.ts";
import type { CaRecord, ChainState, PageSource, Lineage } from "./corporateActions.ts";
import { CorporateActionsClient } from "./sources/corporateActions.ts";
import type { CaPage, ChainMultipliers } from "./sources/corporateActions.ts";
import type { RawTokenState } from "./sources/chain.ts";
import { createApp } from "./app.ts";
import type { AppState } from "./app.ts";
import type { Asset } from "./cohort.ts";
import { VenueStore } from "./venue.ts";
import { Payments } from "./pay/server.ts";
import { loadConfig } from "./main.ts";
import { silentLog } from "./log.ts";

const T0 = Date.parse("2026-09-24T12:00:00Z");
const ISSUER = "https://issuer.test/api/v2/public";

// ---------------------------------------------------------------------------------------------
// fixtures: the issuer's own nodes
// ---------------------------------------------------------------------------------------------

const HON: CaRecord[] = [
  { eventId: "7d20da53-6639-4781-bfa3-806ffa86f5cb", version: 2, xstockSymbol: "HONx", spvSymbol: "HON", caType: "CashDividend", effectiveTimeUtc: "2026-08-14T00:30:00.000Z", multiplierOld: "0.9990655067370947", multiplierNew: "1.0011576563945983", grossCashflowUsd: "0.7", netCashflowUsd: "0.49", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-08-13T20:21:52.675Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "ca3da1bc-04d2-4c6a-a23e-51f7c58ee06d", version: 2, xstockSymbol: "HONx", spvSymbol: "HON", caType: "SpinOff", effectiveTimeUtc: "2026-06-29T23:55:00.000Z", multiplierOld: "0.5120473566533945", multiplierNew: "0.9990655067370947", grossCashflowUsd: "216.6649884", netCashflowUsd: "216.6649884", withholdingTaxRate: "0", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-06-29T23:16:13.809Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "ccb423a2-6045-4d1c-9a94-1f37f0ab8d63", version: 2, xstockSymbol: "HONx", spvSymbol: "HON", caType: "ReverseSplit", effectiveTimeUtc: "2026-06-29T15:30:00.000Z", multiplierOld: "1.024094713306789", multiplierNew: "0.5120473566533945", grossCashflowUsd: null, netCashflowUsd: null, withholdingTaxRate: null, fromUnits: "2", toUnits: "1", redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-06-29T15:09:01.930Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "a1d6c16c-fcc1-418b-b7f9-1e36cd541ac9", version: 2, xstockSymbol: "HONx", spvSymbol: "HON", caType: "CashDividend", effectiveTimeUtc: "2026-05-15T00:30:00.000Z", multiplierOld: "1.0201914454672472", multiplierNew: "1.024094713306789", grossCashflowUsd: "1.19", netCashflowUsd: "0.833", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-05-15T00:02:44.461Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "006e4c1f-910c-4598-bd68-8080d8857a13", version: 1, xstockSymbol: "HONx", spvSymbol: "HON", caType: "CashDividend", effectiveTimeUtc: "2026-02-27T01:30:00.000Z", multiplierOld: "1.016675625159786636", multiplierNew: "1.0201914454672472", grossCashflowUsd: "1.19", netCashflowUsd: "0.833", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-02-27T01:21:06.683Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "a914bc61-0257-4a3f-96d7-751464ea584d", version: 1, xstockSymbol: "HONx", spvSymbol: "HON", caType: "CashDividend", effectiveTimeUtc: "2025-12-05T23:55:00.000Z", multiplierOld: "1.012691839669843441", multiplierNew: "1.016675625159786636", grossCashflowUsd: "1.19", netCashflowUsd: "0.833", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2025-12-05T21:28:09.027Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "13e01fd9-ce80-42bf-b1f1-c1ac4f145536", version: 1, xstockSymbol: "HONx", spvSymbol: "HON", caType: "SpinOff", effectiveTimeUtc: "2025-10-30T23:55:00.000Z", multiplierOld: "1.00165535414", multiplierNew: "1.012691839669843441", grossCashflowUsd: null, netCashflowUsd: null, withholdingTaxRate: null, fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2025-10-30T21:16:18.400Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
  { eventId: "ed7d5080-04d3-4581-b979-d58f037b63b3", version: 1, xstockSymbol: "HONx", spvSymbol: "HON", caType: "CashDividend", effectiveTimeUtc: "2025-09-05T23:55:00.000Z", multiplierOld: "1", multiplierNew: "1.00165535414", grossCashflowUsd: "1.13", netCashflowUsd: "0.791", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2025-09-05T20:38:33.904Z", status: "Initial", xstockIsin: "CH1436219583", spvIsin: "US4385161066" },
];

/** NVDAx's April dividend: v2 issued, cancelled by a no-op v3 (new == old), re-issued as v4 with another multiplier. */
const NVDA: CaRecord[] = [
  { eventId: "41ed2bba-fff2-4296-8f98-9ed2224d2f9e", version: 2, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: "2026-09-10T00:30:00.000Z", multiplierOld: "1.0009180758490996", multiplierNew: "1.001701196801074", grossCashflowUsd: "0.25", netCashflowUsd: "0.175", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-09-09T20:29:47.657Z", status: "Initial", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
  { eventId: "39fa160a-1d73-4876-a545-efc99772d2f3", version: 2, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: "2026-06-04T00:30:00.000Z", multiplierOld: "1.000103090792305", multiplierNew: "1.0009180758490996", grossCashflowUsd: "0.25", netCashflowUsd: "0.175", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-06-03T23:46:42.783Z", status: "Initial", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
  { eventId: "a31ad19b-492b-4144-bedd-7b8716fa12c1", version: 4, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: "2026-04-02T11:20:00.000Z", multiplierOld: "1.000065821833435198", multiplierNew: "1.000103090792305", grossCashflowUsd: "0.01", netCashflowUsd: null, withholdingTaxRate: null, fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: "Event executed at the payable date (2026-04-01). Typo error delayed the execution. Dividend per share being processed as $0.006549588415", createdTimeUtc: "2026-04-02T11:14:30.191Z", status: "Initial", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
  { eventId: "a31ad19b-492b-4144-bedd-7b8716fa12c1", version: 3, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: null, multiplierOld: "1.000065821833435198", multiplierNew: "1.000065821833435198", grossCashflowUsd: "0.01", netCashflowUsd: "0.007", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: "[CANCELLED v2] Typo error on the increasing factor", createdTimeUtc: "2026-04-02T10:38:40.015Z", status: "Cancelled", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
  { eventId: "a31ad19b-492b-4144-bedd-7b8716fa12c1", version: 2, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: "2026-04-01T23:55:00.000Z", multiplierOld: "1.000065821833435198", multiplierNew: "1.0001029207653542", grossCashflowUsd: "0.01", netCashflowUsd: "0.007", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2026-04-01T23:41:45.618Z", status: "Initial", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
  { eventId: "e3d78023-3221-40eb-8bfc-b453a7a53814", version: 1, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: "2025-12-26T23:55:00.000Z", multiplierOld: "1.00003086642674", multiplierNew: "1.000065821833435198", grossCashflowUsd: "0.01", netCashflowUsd: "0.007", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2025-12-26T21:46:30.606Z", status: "Initial", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
  { eventId: "5d8366b9-c13e-448e-8e14-218be1841cdd", version: 1, xstockSymbol: "NVDAx", spvSymbol: "NVDA", caType: "CashDividend", effectiveTimeUtc: "2025-10-02T23:55:00.000Z", multiplierOld: "1", multiplierNew: "1.00003086642674", grossCashflowUsd: "0.01", netCashflowUsd: "0.007", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: null, createdTimeUtc: "2025-10-02T21:09:52.766Z", status: "Initial", xstockIsin: "CH1436219195", spvIsin: "US67066G1040" },
];

/** FEZx: one event as Initial v2, a Cancelled no-op v3, and a Corrected v4. */
const FEZ: CaRecord[] = [
  { eventId: "e20ca763-776e-48f1-b20b-5248c9ebafc7", version: 4, xstockSymbol: "FEZx", spvSymbol: "FEZ", caType: "CashDividend", effectiveTimeUtc: "2026-09-23T23:55:00.000Z", multiplierOld: "1.01110672995", multiplierNew: "1.012259090573938", grossCashflowUsd: "0.111007", netCashflowUsd: "0.0777049", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: "Processing on Payable date", createdTimeUtc: "2026-09-23T20:37:21.553Z", status: "Corrected", xstockIsin: "CH1564487226", spvIsin: "US78463X2027" },
  { eventId: "e20ca763-776e-48f1-b20b-5248c9ebafc7", version: 3, xstockSymbol: "FEZx", spvSymbol: "FEZ", caType: "CashDividend", effectiveTimeUtc: null, multiplierOld: "1.01110672995", multiplierNew: "1.01110672995", grossCashflowUsd: "0.111007", netCashflowUsd: "0.0777049", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: "[CANCELLED v2] Cancelling to correct the multiplier", createdTimeUtc: "2026-09-23T20:36:11.250Z", status: "Cancelled", xstockIsin: "CH1564487226", spvIsin: "US78463X2027" },
  { eventId: "e20ca763-776e-48f1-b20b-5248c9ebafc7", version: 2, xstockSymbol: "FEZx", spvSymbol: "FEZ", caType: "CashDividend", effectiveTimeUtc: "2026-09-23T23:55:00.000Z", multiplierOld: "1.01110672995", multiplierNew: "1.0122628209938507", grossCashflowUsd: "0.111007", netCashflowUsd: "0.0777049", withholdingTaxRate: "0.3", fromUnits: null, toUnits: null, redemptionPriceUsd: null, notes: "Processed on Payable date.", createdTimeUtc: "2026-09-23T20:32:29.129Z", status: "Initial", xstockIsin: "CH1564487226", spvIsin: "US78463X2027" },
];

// Chain values, 18 decimals, as getCurrentMultiplier() returns them.
const HON_RAW = getAddress("0x62a48560861b0b451654bfffdb5be6e47aa8ff1b");
const HON_WRAPPER = getAddress("0xd762788960c607109151ef84efccb19c3ad18012");
const M_BEFORE = 1_024_094_713_306_789_000n;   // nonce 5, block 63,977,900
const M_REVERSE = 512_047_356_653_394_500n;    // nonce 6, from 15:30:00Z on 29 Jun 2026
const M_NOW = 1_001_157_656_394_598_300n;      // nonce 8, block 71,488,416 (24 Sep 2026)

const COHORT: Asset[] = [
  {
    wrapper: getAddress("0x41333df9e7639188bbfca5522dc4844398af9f9e"), symbol: "wTCENTx", rawSymbol: "TCENTx",
    raw: getAddress("0xfa15e42c18cf57aeef4b1bac1cee7754af7cfe42"), micOnChain: "XHKG",
    pool: getAddress("0xc89d8b547cea7cdeaa7474e7a90b6bad01fe992f"), equityIsToken0: true, equityDecimals: 18, stableDecimals: 6,
  },
  // HONx is not registered in MarketClock; it stands in here because its history has every kind of step.
  {
    wrapper: HON_WRAPPER, symbol: "wHONx", rawSymbol: "HONx", raw: HON_RAW, micOnChain: "XNAS",
    pool: null, equityIsToken0: null, equityDecimals: null, stableDecimals: null,
  },
];

const chainState = (nonce: bigint, multiplier: bigint, pending: Partial<ChainState> = {}): ChainState => ({
  nonce, multiplier, newNonce: nonce, newMultiplier: multiplier, newActivationTime: 0n,
  block: 71_488_416, blockTimestamp: 1_790_257_452, readAtMs: T0, ...pending,
});

const lineage = (versions: readonly CaRecord[], chain: ChainState | null, observed?: Map<number, { nonce: number; multiplier: string; block: number; blockTimestamp: number; readAtMs: number }>): Lineage =>
  buildLineage({ symbol: "HONx", wrapper: HON_WRAPPER, raw: HON_RAW, versions, chain, observed });

// ---------------------------------------------------------------------------------------------
// a stub issuer and a stub chain
// ---------------------------------------------------------------------------------------------

/** The issuer's paging exactly: `pageSize` per page, `totalPages`, `hasNextPage`, and nodes past the end are an empty page. */
class StubIssuer implements PageSource {
  readonly base = ISSUER;
  nodes: unknown[];
  size: number;
  calls: number[] = [];
  /** Throw on these page numbers (every attempt). */
  failPages = new Set<number>();
  /** Called before a page is served: lets a test insert a node mid-sweep. */
  beforePage: ((n: number) => void) | null = null;
  constructor(nodes: unknown[], size = 100) { this.nodes = nodes; this.size = size; }
  async page(n: number): Promise<CaPage> {
    this.calls.push(n);
    this.beforePage?.(n);
    if (this.failPages.has(n)) throw new Error(`corporate-actions page ${n}: http 503`);
    const total = this.nodes.length;
    const totalPages = Math.max(1, Math.ceil(total / this.size));
    return {
      url: `${ISSUER}/corporate-actions/history?pageSize=${this.size}&page=${n}`, page: n, totalPages, totalNodes: total,
      hasNextPage: n < totalPages, nodes: this.nodes.slice((n - 1) * this.size, n * this.size), bodyHash: "0x" + "00".repeat(32),
    };
  }
}

function stubChain(states: Record<string, Partial<RawTokenState>>) {
  const calls: string[][] = [];
  const read = async (raws: string[]): Promise<ChainMultipliers> => {
    calls.push(raws);
    return {
      block: { number: 71_488_416, hash: "0x" + "11".repeat(32), timestamp: 1_790_257_452, rpc: "stub" },
      tokens: raws.map((raw) => ({
        raw, multiplier: 10n ** 18n, middle: 0n, nonce: 0n, newMultiplier: 10n ** 18n, newActivationTime: 0n, newNonce: 0n, readFailed: false,
        ...states[raw.toLowerCase()],
      })),
    };
  };
  return { read, calls };
}

const HON_NOW = { [HON_RAW.toLowerCase()]: { multiplier: M_NOW, nonce: 8n, newMultiplier: M_NOW, newNonce: 8n } };

/** Synthetic filler nodes, so paging has more than one page to walk. */
const filler = (n: number): CaRecord[] => Array.from({ length: n }, (_, i) => ({
  eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, version: 1, xstockSymbol: `F${i}x`, caType: "CashDividend",
  status: "Initial", effectiveTimeUtc: "2026-01-01T00:00:00.000Z", createdTimeUtc: "2025-12-31T00:00:00.000Z",
  multiplierOld: "1", multiplierNew: "1.001", fromUnits: null, toUnits: null,
}));

function feedWith(issuer: PageSource, o: { dir?: string; chain?: ReturnType<typeof stubChain>; cohort?: Asset[]; now?: () => number; log?: (e: string, f?: Record<string, unknown>) => void } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "curb-ca-"));
  const chain = o.chain ?? stubChain(HON_NOW);
  const feed = new CorporateActionsFeed({
    dir, client: issuer, readChain: chain.read, cohort: () => o.cohort ?? COHORT, now: o.now ?? (() => T0), log: o.log ?? silentLog,
  });
  feed.load();
  return { feed, dir, chain };
}

type VersionsBody = { schema: string; symbol: string; resolvedVia: string; inCohort: boolean; events: number; versions: (CaRecord & { firstSeenMs: number; recordHash: string })[] };

// ---------------------------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------------------------

test("a sweep walks every page until hasNextPage is false, and keeps every node", async () => {
  const issuer = new StubIssuer([...HON, ...filler(230)]);
  const { feed, dir } = feedWith(issuer);
  const r = await feed.sweep();
  assert.equal(r.ok, true);
  assert.deepEqual(issuer.calls, [1, 2, 3], "238 nodes at 100 a page is three pages, and page 4 is never asked for");
  assert.equal(r.pages, 3);
  assert.equal(r.records, 238);
  assert.equal(r.added, 238);
  assert.equal(readdirSync(join(dir, "versions")).length, 238);
  const h = feed.health(T0);
  assert.equal(h.pages, 3);
  assert.equal(h.records, 238);
  assert.equal(h.versions, 238);
  assert.equal(h.lastSweepMs, T0);
  assert.equal(h.stale, false);

  // A second sweep of the same history adds nothing and rewrites nothing.
  const again = await feed.sweep();
  assert.equal(again.added, 0);
  assert.equal(readdirSync(join(dir, "versions")).length, 238);
});

test("the real client asks for pageSize=100 page by page, never `limit`, and retries a 503 with backoff", async () => {
  const urls: string[] = [];
  const agents: string[] = [];
  const sleeps: number[] = [];
  let failuresLeft = 2;
  const nodes = [...HON, ...filler(120)];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url.search);
    agents.push(String((init?.headers as Record<string, string>)["user-agent"]));
    const page = Number(url.searchParams.get("page"));
    if (page === 2 && failuresLeft-- > 0) return new Response("upstream", { status: 503 });
    const size = Number(url.searchParams.get("pageSize"));
    const body = { page: { currentPage: page, pageSize: size, totalPages: 2, totalNodes: nodes.length, hasNextPage: page < 2, hasPreviousPage: page > 1 }, nodes: nodes.slice((page - 1) * size, page * size) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new CorporateActionsClient({ base: ISSUER, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, backoffMs: 1_000 });
  const { feed } = feedWith(client);
  const r = await feed.sweep();
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.records, 128);
  assert.deepEqual(urls, ["?pageSize=100&page=1", "?pageSize=100&page=2", "?pageSize=100&page=2", "?pageSize=100&page=2"]);
  assert.deepEqual(sleeps, [1_000, 2_000], "exponential backoff between attempts");
  assert.ok(agents.every((a) => a.startsWith("Mozilla/5.0")), "a browser-style User-Agent: the issuer's Cloudflare zone refuses bare clients");
});

test("a page that never answers fails the sweep, keeps what was read, and says why; a 404 is not retried", async () => {
  const issuer = new StubIssuer([...HON, ...filler(150)]);
  issuer.failPages.add(2);
  const { feed, dir } = feedWith(issuer);
  const r = await feed.sweep();
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /page 2: http 503/);
  assert.equal(r.records, 100, "page 1 was read");
  assert.equal(readdirSync(join(dir, "versions")).length, 100, "and kept: each version is a fact on its own");
  const h = feed.health(T0);
  assert.equal(h.lastSweepMs, null, "no complete sweep yet");
  assert.equal(h.pages, null);
  assert.equal(h.versions, 100);
  assert.match(h.lastError ?? "", /page 2/);
  assert.equal(h.stale, true);

  let asked = 0;
  const notFound = new CorporateActionsClient({
    base: ISSUER, sleep: async () => {}, fetchImpl: (async () => { asked++; return new Response("no", { status: 404 }); }) as typeof fetch,
  });
  await assert.rejects(notFound.page(1), /page 1: http 404/);
  assert.equal(asked, 1);
});

test("a node inserted mid-sweep shifts the pages; the short sweep is run again and misses nothing", async () => {
  const nodes: unknown[] = [...filler(200)];
  const issuer = new StubIssuer(nodes);
  const logs: string[] = [];
  let inserted = false;
  // Between page 1 and page 2 a new action lands at the top: everything moves down one place, so the
  // node that was first on page 2 is now last on page 1, already read, and would be skipped.
  issuer.beforePage = (n) => { if (n === 2 && !inserted) { inserted = true; nodes.unshift(HON[0]); } };
  const { feed } = feedWith(issuer, { log: (e) => logs.push(e) });
  const r = await feed.sweep();
  assert.equal(r.ok, true);
  assert.ok(logs.includes("corporate-actions-short-sweep"));
  assert.deepEqual(issuer.calls, [1, 2, 3, 1, 2, 3]);
  assert.equal(r.records, 201);
  assert.equal(feed.health(T0).versions, 201);
});

test("every version is kept: Initial, Cancelled and Corrected, newest first by the version's own creation time", async () => {
  const { feed } = feedWith(new StubIssuer([...FEZ].reverse()));
  await feed.sweep();
  const r = feed.versionsRoute("fezx", [], T0);
  assert.equal(r.status, 200);
  const b = r.body as VersionsBody;
  assert.equal(b.schema, CA_SCHEMA);
  assert.equal(b.symbol, "FEZx", "the issuer's spelling");
  assert.equal(b.events, 1);
  assert.deepEqual(b.versions.map((v) => [v.version, v.status]), [[4, "Corrected"], [3, "Cancelled"], [2, "Initial"]]);
  // Served verbatim, plus when we first saw it and the hash it is stored under.
  const { firstSeenMs, recordHash, ...rest } = b.versions[0];
  assert.deepEqual(rest, FEZ[0]);
  assert.equal(firstSeenMs, T0);
  assert.match(recordHash, /^0x[0-9a-f]{64}$/);
});

test("append-only: a version the issuer later drops or rewrites is never lost or overwritten", async () => {
  const nodes: CaRecord[] = FEZ.map((r) => ({ ...r }));
  const issuer = new StubIssuer(nodes);
  let nowMs = T0;
  const { feed, dir } = feedWith(issuer, { now: () => nowMs });
  await feed.sweep();
  const file = join(dir, "versions", versionFileName(FEZ[2].eventId, 2));
  const before = readFileSync(file, "utf8");

  // Thirty minutes later the issuer drops v2 and rewrites v3's note in place.
  nowMs += 30 * 60_000;
  issuer.nodes = [nodes[0], { ...nodes[1], notes: "rewritten" }];
  const r = await feed.sweep();
  assert.equal(r.ok, true);
  assert.equal(r.conflicts, 1);
  assert.equal(readFileSync(file, "utf8"), before, "v2's file is untouched");
  const b = feed.versionsRoute("FEZx", [], nowMs).body as VersionsBody;
  assert.deepEqual(b.versions.map((v) => v.version), [4, 3, 2], "the dropped v2 is still served");
  assert.equal(b.versions[1].notes, FEZ[1].notes, "the first copy of v3 stands");
  assert.equal(b.versions[1].firstSeenMs, T0);
  assert.equal(feed.health(nowMs).conflicts, 1);
  const kept = readdirSync(join(dir, "conflicts"));
  assert.equal(kept.length, 1, "the rewritten copy is kept beside it");
  assert.equal(JSON.parse(readFileSync(join(dir, "conflicts", kept[0]), "utf8")).record.notes, "rewritten");

  // The same rewrite on the next sweep is not a second conflict.
  await feed.sweep();
  assert.equal(feed.health(nowMs).conflicts, 1);

  // A new process loads exactly what this one kept.
  const { feed: reborn } = feedWith(new StubIssuer([]), { dir });
  const again = reborn.versionsRoute("FEZx", [], nowMs).body as VersionsBody;
  assert.deepEqual(again.versions, b.versions);
  assert.equal(reborn.health(nowMs).conflicts, 1);
});

test("a node without the fields a version needs is refused, and an eventId off the network cannot name a path", async () => {
  const evil = { ...FEZ[0], eventId: "../../../etc/passwd", version: 1 };
  const issuer = new StubIssuer([{ ...FEZ[0], eventId: undefined }, { ...FEZ[0], version: "4" }, "junk", evil, FEZ[1]]);
  const { feed, dir } = feedWith(issuer);
  const r = await feed.sweep();
  assert.equal(r.malformed, 3);
  assert.equal(r.added, 2);
  const files = readdirSync(join(dir, "versions"));
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => /^[A-Za-z0-9-]+\.v\d+\.json$/.test(f)), files.join(","));
  assert.ok(!existsSync(join(dir, "versions", "../../../etc/passwd.v1.json")), "nothing escaped the directory");
  // The hashed name still loads back to the eventId the issuer sent.
  const { feed: reborn } = feedWith(new StubIssuer([]), { dir });
  const b = reborn.versionsRoute("FEZx", [], T0).body as VersionsBody;
  assert.ok(b.versions.some((v) => v.eventId === "../../../etc/passwd"));
});

// ---------------------------------------------------------------------------------------------
// exact decimals
// ---------------------------------------------------------------------------------------------

test("decimals are exact: the feed's strings against the chain's 18-decimal integers", () => {
  assert.deepEqual(parseDec("0.5120473566533945"), { int: 5120473566533945n, scale: 16 });
  for (const junk of ["1e5", "-1", "", " ", "1.", ".5", "0x10", null, 1.5]) assert.equal(parseDec(junk), null, String(junk));
  assert.equal(matchDec(fromWei(M_NOW), parseDec("1.0011576563945983")!), "exact");
  assert.equal(matchDec(fromWei(M_NOW + 1n), parseDec("1.0011576563945983")!), "feed-precision", "a 16-place string stands for an 18-place value");
  assert.equal(matchDec(fromWei(M_NOW + 100n), parseDec("1.0011576563945983")!), null, "but not one unit further off");
  assert.equal(matchDec(fromWei(2_400_000_000_000_000_000n), parseDec("2")!), null, "a coarse string never stands for a different value");
  assert.equal(matchDec(fromWei(2n * 10n ** 18n), parseDec("2")!), "exact");
  assert.equal(decString(fromWei(M_REVERSE)), "0.5120473566533945");
  assert.equal(toWei(parseDec("1.016675625159786636")!), 1_016_675_625_159_786_636n);
  assert.equal(toWei(parseDec("1.0000000000000000001")!), null, "19 places cannot be on chain");

  // The split check is integer arithmetic: 0.5120473566533945 * 2 == 1.024094713306789 * 1.
  const rs = HON[2];
  assert.deepEqual(splitCheck(rs, fromWei(M_REVERSE), parseDec(rs.multiplierOld)), { fromUnits: "2", toUnits: "1", exact: true });
  assert.equal(splitCheck(rs, fromWei(M_REVERSE + 1n), parseDec(rs.multiplierOld))!.exact, false, "one wei off is not a 2:1 split");
  assert.equal(splitCheck(HON[0], fromWei(M_NOW), parseDec(HON[0].multiplierOld)), null, "a dividend declares no units");
});

// ---------------------------------------------------------------------------------------------
// the lineage matcher
// ---------------------------------------------------------------------------------------------

test("HONx today: all eight nonce steps link to a version, the reverse split holds as 2:1, and the walk ends at 1.0", () => {
  const l = lineage(HON, chainState(8n, M_NOW));
  assert.equal(l.complete, true);
  assert.deepEqual(l.unexplained, []);
  assert.deepEqual(l.origin, { nonce: 0, multiplier: "1", unity: true });
  assert.deepEqual(l.steps.map((s) => [s.nonce, s.version?.caType, s.match]), [
    [8, "CashDividend", "exact"], [7, "SpinOff", "exact"], [6, "ReverseSplit", "exact"], [5, "CashDividend", "exact"],
    [4, "CashDividend", "exact"], [3, "CashDividend", "exact"], [2, "SpinOff", "exact"], [1, "CashDividend", "exact"],
  ]);
  assert.deepEqual(l.steps.map((s) => s.source), ["chain", "feed", "feed", "feed", "feed", "feed", "feed", "feed"]);
  const rs = l.steps[2];
  assert.equal(rs.multiplier, M_REVERSE.toString());
  assert.equal(rs.version?.eventId, "ccb423a2-6045-4d1c-9a94-1f37f0ab8d63");
  assert.deepEqual(rs.split, { fromUnits: "2", toUnits: "1", exact: true });
  assert.equal(l.chain?.nonce, 8);
  assert.equal(l.chain?.pending, null);
});

test("HONx at the replay fork (block 63,977,900): nonce 5 on chain, the reverse split published and pending", () => {
  // Only what the issuer had published by then.
  const published = HON.filter((r) => Date.parse(r.createdTimeUtc!) <= Date.parse("2026-06-29T15:24:31Z"));
  const l = lineage(published, chainState(5n, M_BEFORE, { newNonce: 6n, newMultiplier: M_REVERSE, newActivationTime: 1_782_747_000n }));
  assert.equal(l.complete, true);
  assert.deepEqual(l.unexplained, []);
  assert.equal(l.steps.length, 5);
  assert.deepEqual(l.chain?.pending, {
    nonce: 6, multiplier: M_REVERSE.toString(), activationTime: 1_782_747_000, activationIso: "2026-06-29T15:30:00.000Z",
    match: "exact", version: l.chain?.pending?.version, followsCurrent: true,
  });
  assert.equal(l.chain?.pending?.version?.caType, "ReverseSplit");
});

test("a Cancelled no-op version never explains a step; the re-issued version does, and a superseded match says so", () => {
  const nv = (nonce: bigint, m: bigint) => buildLineage({ symbol: "NVDAx", wrapper: COHORT[0].wrapper, raw: COHORT[0].raw, versions: NVDA, chain: chainState(nonce, m) });
  const l = nv(5n, 1_001_701_196_801_074_000n);
  assert.equal(l.complete, true);
  assert.deepEqual(l.unexplained, []);
  const s3 = l.steps.find((s) => s.nonce === 3)!;
  assert.deepEqual([s3.version?.eventId.slice(0, 8), s3.version?.version, s3.supersededBy], ["a31ad19b", 4, null]);
  const s2 = l.steps.find((s) => s.nonce === 2)!;
  assert.equal(s2.version?.eventId.slice(0, 8), "e3d78023", "not the Cancelled v3, whose new == old == this multiplier");

  // Had the chain applied v2 before it was cancelled, the step matches v2 and names v4 as its successor.
  const early = nv(3n, 1_000_102_920_765_354_200n);
  assert.equal(early.steps[0].version?.version, 2);
  assert.equal(early.steps[0].supersededBy, 4);
});

test("unexplained: a multiplier no version moved to, a gap in the walk, a split that does not hold", () => {
  const off = lineage(HON, chainState(8n, 1_002_000_000_000_000_000n));
  assert.equal(off.complete, false);
  assert.deepEqual(off.unexplained, [{ symbol: "HONx", wrapper: HON_WRAPPER, raw: HON_RAW, nonce: 8, multiplier: "1002000000000000000", reason: "no-matching-version" }]);

  const missing = lineage(HON.filter((r) => r.eventId !== "a1d6c16c-fcc1-418b-b7f9-1e36cd541ac9"), chainState(8n, M_NOW));
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.unexplained.map((u) => [u.nonce, u.reason, u.multiplier]), [[5, "lineage-gap", M_BEFORE.toString()]]);
  assert.equal(missing.steps.at(-1)?.nonce, 5);

  const badSplit = lineage(HON.map((r) => (r.caType === "ReverseSplit" ? { ...r, fromUnits: "3" } : r)), chainState(8n, M_NOW));
  assert.deepEqual(badSplit.unexplained.map((u) => [u.nonce, u.reason]), [[6, "split-ratio-mismatch"]]);
  assert.equal(badSplit.complete, true, "the walk still links every step; the split just does not explain its own ratio");
});

test("unexplained: only a Cancelled version matches; a sighting disagrees; the multiplier moved without the nonce; a pending value nobody announced", () => {
  const cancelled = lineage(HON.map((r, i) => (i === 0 ? { ...r, status: "Cancelled" } : r)), chainState(8n, M_NOW));
  assert.deepEqual(cancelled.unexplained.map((u) => [u.nonce, u.reason]), [[8, "only-cancelled-version-matches"]]);

  const seen = new Map([
    [6, { nonce: 6, multiplier: (M_REVERSE + 10n ** 15n).toString(), block: 63_977_964, blockTimestamp: 1_782_747_000, readAtMs: 0 }],
    [8, { nonce: 8, multiplier: (M_NOW - 10n ** 15n).toString(), block: 71_000_000, blockTimestamp: 1_789_769_036, readAtMs: 0 }],
  ]);
  const sighted = lineage(HON, chainState(8n, M_NOW), seen);
  assert.deepEqual(sighted.unexplained.map((u) => [u.nonce, u.reason]), [[8, "multiplier-changed-without-nonce"], [6, "observed-step-mismatch"]]);
  assert.equal(sighted.steps.find((s) => s.nonce === 6)?.source, "chain", "a kept sighting makes the step on-chain evidence");

  const pending = lineage(HON, chainState(8n, M_NOW, { newNonce: 9n, newMultiplier: 1_010_000_000_000_000_000n, newActivationTime: 1_790_300_000n }));
  assert.deepEqual(pending.unexplained.map((u) => [u.nonce, u.reason]), [[9, "pending-without-version"]]);
  assert.equal(pending.chain?.pending?.version, null);
});

test("a raw token that never had an action: nonce 0 at exactly 1.0, nothing to explain", () => {
  const l = lineage([], chainState(0n, 10n ** 18n));
  assert.deepEqual([l.complete, l.steps.length, l.unexplained.length], [true, 0, 0]);
  assert.deepEqual(l.origin, { nonce: 0, multiplier: "1", unity: true });
  assert.equal(lineage(HON, null).complete, false, "no chain read, no lineage");
});

// ---------------------------------------------------------------------------------------------
// the loop's rules
// ---------------------------------------------------------------------------------------------

test("nothing is flagged before a complete sweep; a NEW flag is re-checked against a fresh sweep before it is published", async () => {
  let nowMs = T0;
  const flags = () => feed.health(nowMs).unexplained.map((u) => [u.nonce, u.reason]);
  const issuer = new StubIssuer(HON.slice(1)); // without the 14 Aug dividend the chain has already applied
  issuer.failPages.add(1);
  const states: Record<string, Partial<RawTokenState>> = { ...HON_NOW };
  const chain = stubChain(states);
  const { feed } = feedWith(issuer, { chain, now: () => nowMs });

  await feed.pass();
  assert.deepEqual(chain.calls, [[COHORT[1].raw, COHORT[0].raw].sort()], "one read, of the cohort's raw tokens");
  assert.deepEqual(flags(), [], "a failed sweep flags nothing: the gap would be in our own read");

  // A complete sweep that really lacks the version: flagged.
  issuer.failPages.clear();
  nowMs += 2 * 60_000;
  await feed.pass({ sweep: true });
  assert.deepEqual(flags(), [[8, "no-matching-version"]]);

  // The issuer lists it: the next sweep clears the flag.
  nowMs += 10 * 60_000;
  issuer.nodes = HON;
  await feed.pass({ sweep: true });
  assert.deepEqual(flags(), []);

  // A new action is listed AFTER our last sweep and is already active when the chain is next read. The step
  // looks unexplained, so one fresh sweep runs before anything is published, and it explains the step.
  const next: CaRecord = {
    ...HON[0], eventId: "11111111-2222-4333-8444-555555555555", version: 1, multiplierOld: "1.0011576563945983",
    multiplierNew: "1.0031576563945983", createdTimeUtc: "2026-09-24T12:15:00.000Z", effectiveTimeUtc: "2026-09-24T12:20:00.000Z",
  };
  nowMs += 10 * 60_000;
  issuer.nodes = [next, ...HON];
  states[HON_RAW.toLowerCase()] = { multiplier: 1_003_157_656_394_598_300n, nonce: 9n, newMultiplier: 1_003_157_656_394_598_300n, newNonce: 9n };
  let before = issuer.calls.length;
  await feed.pass({ sweep: false });
  assert.equal(issuer.calls.length, before + 1, "one confirming sweep");
  assert.deepEqual(flags(), [], "which explained the step: nothing was published");
  assert.equal(feed.lineageRoute("HONx", COHORT, nowMs).status, 200);

  // A step nobody lists: confirmed by one sweep, then published, and not re-swept on every chain read.
  nowMs += 10 * 60_000;
  states[HON_RAW.toLowerCase()] = { multiplier: 1_009_000_000_000_000_000n, nonce: 10n, newMultiplier: 1_009_000_000_000_000_000n, newNonce: 10n };
  before = issuer.calls.length;
  await feed.pass({ sweep: false });
  assert.equal(issuer.calls.length, before + 1);
  assert.deepEqual(flags(), [[10, "no-matching-version"]]);
  nowMs += 10 * 60_000;
  await feed.pass({ sweep: false });
  assert.equal(issuer.calls.length, before + 1, "an already published flag does not re-sweep every chain read");
  assert.deepEqual(flags(), [[10, "no-matching-version"]]);
});

test("a sighting of each (raw, nonce) is kept write-once and reloads as on-chain evidence", async () => {
  let nowMs = T0;
  const { feed, dir } = feedWith(new StubIssuer(HON), { now: () => nowMs });
  await feed.pass({ sweep: true });
  const files = readdirSync(join(dir, "chain")).sort();
  assert.deepEqual(files, [`${COHORT[0].raw.toLowerCase()}.n0.json`, `${HON_RAW.toLowerCase()}.n8.json`].sort());
  const kept = JSON.parse(readFileSync(join(dir, "chain", `${HON_RAW.toLowerCase()}.n8.json`), "utf8"));
  assert.deepEqual([kept.raw, kept.nonce, kept.multiplier, kept.block], [HON_RAW, 8, M_NOW.toString(), 71_488_416]);
  nowMs += 60_000;
  await feed.pass({ sweep: false });
  assert.equal(JSON.parse(readFileSync(join(dir, "chain", `${HON_RAW.toLowerCase()}.n8.json`), "utf8")).readAtMs, T0, "the first sighting stands");

  // A new process reloads it, and the lineage cites it as the step's on-chain evidence.
  const { feed: reborn } = feedWith(new StubIssuer(HON), { dir, now: () => nowMs });
  await reborn.pass({ sweep: false });
  const step = (reborn.lineageRoute("HONx", COHORT, nowMs).body as Lineage).steps[0];
  assert.deepEqual([step.nonce, step.source, step.observed?.readAtMs, step.observed?.block], [8, "chain", T0, 71_488_416]);
});

// ---------------------------------------------------------------------------------------------
// the routes, through the real app
// ---------------------------------------------------------------------------------------------

async function serve(feed: CorporateActionsFeed | null) {
  const payments = new Payments({
    network: "eip155:196", payTo: null, okx: null, syncSettle: true, publicUrl: "https://api.curb.markets",
    handlers: new Map(), now: () => T0, log: silentLog, initRetryMs: 0,
  });
  const state: AppState = { bootMs: T0, ticks: 1, lastTickOkMs: T0, cohort: COHORT, cohortAsOfMs: T0, cohortError: null };
  const server = createServer(createApp({
    state, venues: new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 }), payments,
    handlers: new Map(), dataDir: mkdtempSync(join(tmpdir(), "curb-asp-ca-")), publicUrl: "https://api.curb.markets", tickMs: 30_000,
    contracts: { chainId: 196, clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b", scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f" },
    now: () => T0, log: silentLog, corporateActions: feed,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${base}${path}`, init);
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  return { get, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("before the first sweep: the routes say unavailable rather than 'no actions', and /healthz reports it", async () => {
  const { feed } = feedWith(new StubIssuer(HON));
  const s = await serve(feed);
  try {
    const v = await s.get("/v1/corporate-actions?symbol=HONx");
    assert.equal(v.status, 503);
    assert.equal(v.body.error, "corporate-actions-unavailable");
    assert.equal(v.headers.get("access-control-allow-origin"), "*");
    assert.equal((await s.get("/v1/corporate-actions/lineage?symbol=HONx")).body.error, "lineage-unavailable");
    const h = await s.get("/healthz");
    assert.equal(h.status, 200, "the feed never decides /healthz's ok");
    assert.deepEqual(h.body.corporateActions, {
      pages: null, records: null, versions: 0, events: 0, lastSweepMs: null, lastAttemptMs: null, stale: true, lastError: null,
      conflicts: 0, chain: { asOfBlock: null, readAtMs: null, lastError: null }, unexplained: [],
    });
  } finally { await s.close(); }

  const off = await serve(null);
  try {
    assert.deepEqual((await off.get("/v1/corporate-actions?symbol=HONx")).body, { error: "corporate-actions-not-configured" });
    assert.equal((await off.get("/healthz")).body.corporateActions, null);
  } finally { await off.close(); }
});

test("GET /v1/corporate-actions: by issuer symbol, wrapper symbol or cohort address; free, CORS, cacheable", async () => {
  const { feed } = feedWith(new StubIssuer([...FEZ, ...HON, ...filler(3)]));
  await feed.pass({ sweep: true });
  const s = await serve(feed);
  try {
    const r = await s.get("/v1/corporate-actions?symbol=HONx");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("cache-control"), "public, max-age=60");
    assert.equal(r.headers.get("payment-required"), null, "free");
    assert.equal(r.body.schema, CA_SCHEMA);
    assert.equal(r.body.symbol, "HONx");
    assert.equal(r.body.inCohort, true);
    assert.equal(r.body.wrapper, HON_WRAPPER);
    assert.equal(r.body.source, `${ISSUER}/corporate-actions/history`);
    assert.equal(r.body.lastSweepMs, T0);
    assert.equal(r.body.versions.length, 8);
    assert.deepEqual(r.body.versions.map((v: CaRecord) => v.eventId), HON.map((x) => x.eventId), "newest first");

    for (const [q, via] of [["wHONx", "wrapper-symbol"], ["honx", "issuer-symbol"], [HON_WRAPPER.toLowerCase(), "wrapper-address"], [HON_RAW, "raw-address"]]) {
      const x = await s.get(`/v1/corporate-actions?symbol=${q}`);
      assert.equal(x.body.symbol, "HONx", q);
      assert.equal(x.body.resolvedVia, via, q);
      assert.equal(x.body.versions.length, 8, q);
    }
    // Not in the cohort, but known to the issuer: served, and said to be outside the cohort.
    const fez = await s.get("/v1/corporate-actions?symbol=wFEZx");
    assert.deepEqual([fez.status, fez.body.symbol, fez.body.inCohort, fez.body.versions.length], [200, "FEZx", false, 3]);
    // In the cohort and never had an action: an empty list, not an error.
    const tcent = await s.get("/v1/corporate-actions?symbol=wTCENTx");
    assert.deepEqual([tcent.status, tcent.body.symbol, tcent.body.versions], [200, "TCENTx", []]);

    assert.equal((await s.get("/v1/corporate-actions")).body.error, "symbol-required");
    assert.equal((await s.get("/v1/corporate-actions?symbol=A&symbol=B")).body.error, "symbol-repeated");
    assert.equal((await s.get(`/v1/corporate-actions?symbol=0x${"12".repeat(20)}`)).status, 404);
    assert.equal((await s.get("/v1/corporate-actions?symbol=%3Cscript%3E")).status, 404);
    assert.equal((await s.get("/v1/corporate-actions?symbol=HONx", { method: "POST" })).status, 405, "free routes answer GET only");
    assert.equal((await s.get("/v1/corporate-actions?symbol=HONx", { method: "OPTIONS" })).status, 204);
  } finally { await s.close(); }
});

test("GET /v1/corporate-actions/lineage: cohort assets only, each nonce step with its version, and /healthz carries the flags", async () => {
  const { feed } = feedWith(new StubIssuer(HON));
  await feed.pass({ sweep: true });
  const s = await serve(feed);
  try {
    const r = await s.get("/v1/corporate-actions/lineage?symbol=wHONx");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.body.schema, CA_LINEAGE_SCHEMA);
    assert.equal(r.body.symbol, "HONx");
    assert.equal(r.body.raw, HON_RAW);
    assert.deepEqual(r.body.chain, { block: 71_488_416, blockTimestamp: 1_790_257_452, readAtMs: T0, nonce: 8, multiplier: M_NOW.toString(), pending: null });
    assert.equal(r.body.steps.length, 8);
    assert.equal(r.body.steps[2].version.caType, "ReverseSplit");
    assert.deepEqual(r.body.steps[2].split, { fromUnits: "2", toUnits: "1", exact: true });
    assert.equal(r.body.complete, true);
    assert.match(r.body.method, /new \* fromUnits == old \* toUnits/);

    const hk = await s.get("/v1/corporate-actions/lineage?symbol=TCENTx");
    assert.deepEqual([hk.status, hk.body.chain.nonce, hk.body.steps, hk.body.complete], [200, 0, [], true]);
    assert.equal((await s.get("/v1/corporate-actions/lineage?symbol=FEZx")).body.error, "not-in-cohort");

    const h = await s.get("/healthz");
    assert.equal(h.body.corporateActions.pages, 1);
    assert.equal(h.body.corporateActions.records, 8);
    assert.equal(h.body.corporateActions.versions, 8);
    assert.equal(h.body.corporateActions.lastSweepMs, T0);
    assert.deepEqual(h.body.corporateActions.unexplained, []);
    assert.equal(h.body.corporateActions.chain.asOfBlock, 71_488_416);

    const home = await s.get("/");
    assert.match(home.body, /\/v1\/corporate-actions\?symbol=/);
    assert.match(home.body, /\/v1\/corporate-actions\/lineage\?symbol=/);
    const wk = await s.get("/.well-known/x402");
    assert.ok(!JSON.stringify(wk.body).includes("corporate-actions"), "discovery lists priced routes only");
  } finally { await s.close(); }

  // An unexplained rebase shows up in /healthz.
  const { feed: bad } = feedWith(new StubIssuer(HON), { chain: stubChain({ [HON_RAW.toLowerCase()]: { multiplier: M_NOW + 10n ** 16n, nonce: 9n, newMultiplier: M_NOW + 10n ** 16n, newNonce: 9n } }) });
  await bad.pass({ sweep: true });
  const s2 = await serve(bad);
  try {
    const h = await s2.get("/healthz");
    assert.deepEqual(h.body.corporateActions.unexplained, [{
      symbol: "HONx", wrapper: HON_WRAPPER, raw: HON_RAW, nonce: 9, multiplier: (M_NOW + 10n ** 16n).toString(), reason: "no-matching-version",
    }]);
  } finally { await s2.close(); }
});

test("the sweep cadence is configurable within bounds, 30 minutes by default", () => {
  assert.equal(loadConfig({}).cfg.corporateActionsSweepMs, 1_800_000);
  assert.equal(loadConfig({ CORPORATE_ACTIONS_SWEEP_MS: "600000" }).cfg.corporateActionsSweepMs, 600_000);
  assert.ok(loadConfig({ CORPORATE_ACTIONS_SWEEP_MS: "1000" }).errors.some((e) => e.startsWith("CORPORATE_ACTIONS_SWEEP_MS")));
});
