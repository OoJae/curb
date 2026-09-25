/**
 * End to end against X Layer mainnet: the real server, a standard MCP client (the SDK's own Streamable HTTP
 * client), tools/list, then curb_regime checked against a direct eth_call of MarketClock.regime() at the block
 * the answer names. Skipped, not failed, when no RPC answers (offline, or CURB_MCP_OFFLINE=1): the unit tests
 * cover the logic, and this covers the wiring.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Interface } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp, loadConfig } from "./main.ts";
import { CONTRACTS, requireAsset } from "./assets.ts";
import { DEFAULT_RPCS } from "./sources/chain.ts";
import { silentLog } from "./log.ts";

async function reachable(): Promise<string | null> {
  if (process.env.CURB_MCP_OFFLINE === "1") return null;
  for (const url of DEFAULT_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST", signal: AbortSignal.timeout(4_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const j = await res.json() as { result?: string };
      if (j.result && Number(j.result) === 196) return url;
    } catch { /* next */ }
  }
  return null;
}

const rpcUrl = await reachable();

test("live: tools/list and curb_regime over MCP, checked against MarketClock directly", { skip: rpcUrl ? false : "no X Layer RPC reachable (offline, or CURB_MCP_OFFLINE=1)", timeout: 60_000 }, async () => {
  const { cfg, errors } = loadConfig({ PUBLIC_URL: "http://localhost" });
  assert.deepEqual(errors, []);
  const { handler } = buildApp(cfg, silentLog);
  const server = createServer(handler).listen(0, "127.0.0.1");
  after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;

  const client = new Client({ name: "curb-mcp-integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  after(() => client.close());
  assert.equal(client.getServerVersion()?.name, "curb");

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["curb_corporate_actions", "curb_credit", "curb_next_reopen", "curb_paid_services", "curb_regime", "curb_scorecard"]);

  const res = await client.callTool({ name: "curb_regime", arguments: { symbol: "wTCENTx" } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const answer = res.structuredContent as { asOf: { block: number; blockHash: string }; source: { marketClock: string }; assets: { symbol: string; status: string; regime: { code: number }; primaryCapUsd: string }[] };
  assert.equal(answer.source.marketClock, CONTRACTS.marketClock);
  assert.ok(answer.asOf.block > 71_500_000, `a current block, got ${answer.asOf.block}`);
  const a = answer.assets[0];
  assert.equal(a.symbol, "wTCENTx");
  assert.ok(["OPEN", "SHUT", "UNKNOWN"].includes(a.status));

  // The same question asked of the contract directly, at the block the answer names.
  const abi = new Interface(["function regime(address) view returns (uint8)", "function primaryCapNow(address) view returns (uint128)"]);
  const call = async (fn: string) => {
    const r = await fetch(rpcUrl!, {
      method: "POST", signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.marketClock, data: abi.encodeFunctionData(fn, [requireAsset("wTCENTx").wrapper]) }, { blockHash: answer.asOf.blockHash }] }),
    });
    const j = await r.json() as { result?: string; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message ?? "empty eth_call");
    return abi.decodeFunctionResult(fn, j.result)[0];
  };
  assert.equal(Number(await call("regime")), a.regime.code);
  assert.equal(String(await call("primaryCapNow")), a.primaryCapUsd);
});
