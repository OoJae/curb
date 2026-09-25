import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import type { AppDeps } from "./app.ts";
import { makeCaches, TOOLS } from "./tools.ts";
import { RateLimiter } from "./rateLimit.ts";
import { TimelineCache } from "./closureCalendar.ts";
import { IssuerCache } from "./issuer.ts";
import { ASSETS, CONTRACTS } from "./assets.ts";
import { silentLog } from "./log.ts";
import type { JsonFetch } from "./asp.ts";
import { BLOCK, clockAnswer, fakeChain } from "./fixtures/fakeChain.ts";

/** The whole HTTP surface against an in-memory chain: nothing here touches the network. */
function start(opts: { burst?: number; fetchJson?: JsonFetch } = {}) {
  const chain = fakeChain(clockAnswer(Object.fromEntries(ASSETS.map((a) => [a.wrapper, { regime: 1, cap: 0n }])), CONTRACTS.marketClock));
  const noNetwork = async () => { throw new Error("no network in this test"); };
  const deps: AppDeps = {
    tools: {
      chain, issuer: new IssuerCache(noNetwork), timelines: new TimelineCache(), fetchJson: opts.fetchJson ?? noNetwork,
      commitTxs: new Map(), now: Date.now, log: silentLog, toolTimeoutMs: 5_000,
    },
    caches: makeCaches(Date.now),
    limiter: new RateLimiter({ burst: opts.burst ?? 100, perMinute: 1 }),
    trustProxyHops: 0,
    publicUrl: "https://mcp.curb.markets",
    state: { bootMs: Date.now(), requests: 0, mcpRequests: 0, rateLimited: 0 },
    now: Date.now,
    log: silentLog,
    lastHead: () => ({ block: BLOCK.number, timestamp: BLOCK.timestamp }),
  };
  const server = createServer(createApp(deps)).listen(0, "127.0.0.1");
  after(() => server.close());
  const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, deps, ready: new Promise((r) => server.once("listening", r)) };
}

const rpc = (base: string, method: string, params: unknown = {}, id = 1) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

test("GET / describes the server from the same table tools/list serves", async () => {
  const s = start();
  await s.ready;
  const res = await fetch(`${s.base()}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json() as { tools: { name: string }[]; mcp: { url: string }; connect: { claudeCode: string }; contracts: Record<string, unknown> };
  assert.deepEqual(body.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepEqual(body.tools.map((t) => t.name), ["curb_regime", "curb_next_reopen", "curb_scorecard", "curb_credit", "curb_corporate_actions", "curb_paid_services"]);
  assert.equal(body.mcp.url, "https://mcp.curb.markets/mcp");
  assert.equal(body.connect.claudeCode, "claude mcp add --transport http curb https://mcp.curb.markets/mcp");
  assert.equal(body.contracts.marketClock, CONTRACTS.marketClock);
});

test("GET /healthz answers without any upstream call", async () => {
  const s = start();
  await s.ready;
  const res = await fetch(`${s.base()}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; lastHead: { block: number } };
  assert.equal(body.ok, true);
  assert.equal(body.lastHead.block, BLOCK.number);
});

test("CORS preflight, 405 for GET/DELETE /mcp (stateless), 404 elsewhere", async () => {
  const s = start();
  await s.ready;
  const pre = await fetch(`${s.base()}/mcp`, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Mcp-Protocol-Version/);
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(`${s.base()}/mcp`, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get("allow"), "POST, OPTIONS");
    assert.equal((await r.json() as { jsonrpc: string }).jsonrpc, "2.0");
  }
  assert.equal((await fetch(`${s.base()}/nope`)).status, 404);
  assert.equal((await fetch(`${s.base()}/`, { method: "POST" })).status, 405);
});

test("tools/list over Streamable HTTP: six read-only tools, with CORS on the transport's own response", async () => {
  const s = start();
  await s.ready;
  const res = await rpc(s.base(), "tools/list");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("mcp-session-id"), null, "stateless: no session");
  const body = await res.json() as { result: { tools: { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties?: Record<string, unknown> } }[] } };
  assert.equal(body.result.tools.length, 6);
  assert.ok(body.result.tools.every((t) => t.annotations.readOnlyHint === true));
  const regime = body.result.tools.find((t) => t.name === "curb_regime")!;
  assert.deepEqual(Object.keys(regime.inputSchema.properties ?? {}), ["symbol"]);
});

test("tools/call curb_regime answers from the chain; bad input is refused before any upstream read", async () => {
  const s = start();
  await s.ready;
  const ok = await (await rpc(s.base(), "tools/call", { name: "curb_regime", arguments: { symbol: "tcentx" } })).json() as { result: { isError?: boolean; structuredContent: { assets: { symbol: string; status: string }[] }; content: { text: string }[] } };
  assert.equal(ok.result.isError, undefined);
  assert.deepEqual(ok.result.structuredContent.assets.map((a) => [a.symbol, a.status]), [["wTCENTx", "SHUT"]]);
  assert.deepEqual(JSON.parse(ok.result.content[0].text), ok.result.structuredContent, "the text is the same answer, as JSON");

  const unknown = await (await rpc(s.base(), "tools/call", { name: "curb_regime", arguments: { symbol: "GME" } })).json() as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /unknown symbol "GME"\. Curb tracks: wTCENTx/);

  for (const args of [{ symbol: "../x" }, { symbol: "a".repeat(65) }, { symbol: 7 }]) {
    const bad = await (await rpc(s.base(), "tools/call", { name: "curb_regime", arguments: args })).json() as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(bad.result.isError, true, JSON.stringify(args));
    assert.match(bad.result.content[0].text, /Input validation error/);
  }
  const limit = await (await rpc(s.base(), "tools/call", { name: "curb_scorecard", arguments: { limit: 51 } })).json() as { result: { isError: boolean } };
  assert.equal(limit.result.isError, true);
});

test("a call that omits `arguments` works for the tools whose arguments are all optional", async () => {
  const s = start();
  await s.ready;
  const regime = await (await rpc(s.base(), "tools/call", { name: "curb_regime" })).json() as { result: { isError?: boolean; content: { text: string }[]; structuredContent: { assets: unknown[] } } };
  assert.equal(regime.result.isError, undefined, regime.result.content[0].text);
  assert.equal(regime.result.structuredContent.assets.length, 6);
  // No network here, so the terms come from the fallback, and the answer says so.
  const paid = await (await rpc(s.base(), "tools/call", { name: "curb_paid_services" })).json() as { result: { isError?: boolean; content: { text: string }[]; structuredContent: { termsSource: { read: string } } } };
  assert.equal(paid.result.isError, undefined, paid.result.content[0].text);
  assert.equal(paid.result.structuredContent.termsSource.read, "fallback");
  const scorecard = await (await rpc(s.base(), "tools/call", { name: "curb_scorecard" })).json() as { result: { content: { text: string }[] } };
  assert.doesNotMatch(scorecard.result.content[0].text, /Input validation error/);
});

test("identical calls within a tool's cache window share one set of chain reads", async () => {
  const s = start();
  await s.ready;
  const chain = s.deps.tools.chain as ReturnType<typeof fakeChain>;
  const before = chain.calls;
  await Promise.all(["wNVDAx", "NVDAx", "nvdax"].map((sym, i) => rpc(s.base(), "tools/call", { name: "curb_regime", arguments: { symbol: sym } }, i + 10).then((r) => r.json())));
  assert.equal(chain.calls - before, 1, "three spellings of one asset, one aggregate3");
});

test("calls for one asset share one upstream read whatever `limit` they ask for, and each gets its own cut", async () => {
  const seen: string[] = [];
  const versions = [5, 4, 3, 2, 1].map((n) => ({ eventId: `e${n}`, version: 1, caType: "CashDividend", effectiveTimeUtc: `2026-0${n}-01T00:00:00.000Z`, status: "Initial" }));
  const fetchJson: JsonFetch = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ symbol: "AAPLx", events: 5, versions }) };
  };
  const s = start({ fetchJson });
  await s.ready;
  const shown: number[] = [];
  for (const [i, limit] of [1, 3, 2, 100].entries()) {
    const r = await (await rpc(s.base(), "tools/call", { name: "curb_corporate_actions", arguments: { symbol: "wAAPLx", limit } }, i + 1)).json() as { result: { structuredContent: { versionsShown: number; versionsTotal: number; feed: { versions: unknown[] } } } };
    assert.equal(r.result.structuredContent.versionsTotal, 5);
    assert.equal(r.result.structuredContent.feed.versions.length, r.result.structuredContent.versionsShown);
    shown.push(r.result.structuredContent.versionsShown);
  }
  assert.deepEqual(shown, [1, 3, 2, 5]);
  assert.deepEqual(seen, ["https://api.curb.markets/v1/corporate-actions?symbol=AAPLx"], "four limits, one read");
});

test("the rate limit refuses with 429 and Retry-After, as a JSON-RPC error on /mcp; /healthz is exempt", async () => {
  const s = start({ burst: 2 });
  await s.ready;
  assert.equal((await rpc(s.base(), "tools/list")).status, 200);
  assert.equal((await fetch(`${s.base()}/`)).status, 200);
  const limited = await rpc(s.base(), "tools/list");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const body = await limited.json() as { jsonrpc: string; error: { message: string } };
  assert.equal(body.jsonrpc, "2.0");
  assert.match(body.error.message, /rate limited: retry after 60 s/);
  assert.equal((await fetch(`${s.base()}/`)).status, 429);
  assert.equal((await fetch(`${s.base()}/healthz`)).status, 200);
  assert.equal(s.deps.state.rateLimited, 2);
});

test("a JSON-RPC batch takes one token per message, so it cannot multiply a client's rate", async () => {
  const s = start({ burst: 5 });
  await s.ready;
  const batch = (n: number) => fetch(`${s.base()}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list", params: {} }))),
  });
  const three = await batch(3);
  assert.equal(three.status, 200);
  assert.equal((await three.json() as unknown[]).length, 3);
  // Two tokens left: a batch of three is refused whole, and the refusal is a JSON-RPC error.
  const refused = await batch(3);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json() as { jsonrpc: string }).jsonrpc, "2.0");
  assert.equal(s.deps.state.rateLimited, 1);
  // A batch far larger than the bucket (20,000 messages in 60 KB, under the body cap) stops at the first refusal.
  const t = start({ burst: 5 });
  await t.ready;
  const flood = await fetch(`${t.base()}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: `[${Array(20_000).fill("{}").join(",")}]`,
  });
  assert.equal(flood.status, 429);
  assert.equal(t.deps.state.rateLimited, 1);
});

test("an oversized body is refused before it is parsed", async () => {
  const s = start();
  await s.ready;
  const res = await fetch(`${s.base()}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } }),
  });
  assert.equal(res.status, 413);
  const junk = await fetch(`${s.base()}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" });
  assert.equal(junk.status, 400);
  assert.equal((await junk.json() as { error: { code: number } }).error.code, -32700);
});
