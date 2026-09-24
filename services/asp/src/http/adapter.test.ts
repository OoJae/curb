import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { NodeHttpAdapter } from "./adapter.ts";

const req = (url: string, headers: Record<string, string | string[]> = {}, method = "GET") =>
  ({ url, method, headers }) as unknown as IncomingMessage;

test("the URL is always re-rooted on the public origin, whatever the request line or Host says", () => {
  const a = new NodeHttpAdapter(req("/v1/closure-calendar?symbol=wTCENTx", { host: "evil.example" }), Buffer.alloc(0), "https://api.curb.markets");
  assert.equal(a.getUrl(), "https://api.curb.markets/v1/closure-calendar?symbol=wTCENTx");
  assert.equal(a.getPath(), "/v1/closure-calendar");
  const abs = new NodeHttpAdapter(req("http://evil.example/v1/closure-calendar"), Buffer.alloc(0), "https://api.curb.markets");
  assert.equal(abs.getUrl(), "https://api.curb.markets/", "absolute-form request lines are not trusted");
  const proto = new NodeHttpAdapter(req("//evil.example/x"), Buffer.alloc(0), "https://api.curb.markets");
  assert.equal(new URL(proto.getUrl()).host, "api.curb.markets");
});

test("headers, query parameters and body read the way the SDK expects", () => {
  const a = new NodeHttpAdapter(
    req("/p?symbol=a&symbol=b&h=7", { "payment-signature": "abc", accept: "application/json", "user-agent": "agent", "content-type": "application/json", "x-multi": ["1", "2"] }, "get"),
    Buffer.from('{"k":1}'), "https://api.curb.markets",
  );
  assert.equal(a.getMethod(), "GET");
  assert.equal(a.getHeader("PAYMENT-SIGNATURE"), "abc");
  assert.equal(a.getHeader("x-multi"), "1, 2");
  assert.equal(a.getHeader("absent"), undefined);
  assert.equal(a.getAcceptHeader(), "application/json");
  assert.equal(a.getUserAgent(), "agent");
  assert.deepEqual(a.getQueryParams(), { symbol: ["a", "b"], h: "7" });
  assert.deepEqual(a.getQueryParam("symbol"), ["a", "b"]);
  assert.equal(a.getQueryParam("h"), "7");
  assert.equal(a.getQueryParam("none"), undefined);
  assert.deepEqual(a.getBody(), { k: 1 });
  assert.equal(new NodeHttpAdapter(req("/"), Buffer.alloc(0), "https://x.test").getBody(), undefined);
});
