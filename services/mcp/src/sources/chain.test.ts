import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pinLatest } from "./chain.ts";

/** Two endpoints answering eth_getBlockByNumber from a table, through a stubbed global fetch; no network. */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function heads(table: Record<string, number | "down">) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const h = table[String(url)];
    if (h === undefined || h === "down") throw new TypeError("fetch failed");
    const hex = "0x" + h.toString(16);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: hex, hash: "0x" + h.toString(16).padStart(64, "0"), timestamp: "0x1" } }));
  }) as typeof fetch;
}

const A = "https://a.example", B = "https://b.example";

test("the first-listed endpoint is pinned while its head is within 5 blocks of the best", async () => {
  heads({ [A]: 100, [B]: 103 });
  const p = await pinLatest([A, B], 1);
  assert.equal(p.rpc, A, "RPCS order is a preference: the second endpoint is not asked for calls just for being ahead");
  assert.equal(p.number, 100);
});

test("a first-listed endpoint more than 5 blocks behind is passed over, and a dead one is skipped", async () => {
  heads({ [A]: 100, [B]: 106 });
  assert.equal((await pinLatest([A, B], 1)).rpc, B);
  heads({ [A]: "down", [B]: 50 });
  assert.equal((await pinLatest([A, B], 1)).rpc, B);
  heads({ [A]: "down", [B]: "down" });
  await assert.rejects(pinLatest([A, B], 1), /no RPC returned a head after 1 attempts/);
});
