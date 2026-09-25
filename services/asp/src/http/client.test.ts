import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { clientKey, clientKeyOf } from "./client.ts";

test("client keys: IPv4 as is, an IPv4-mapped address as its IPv4, IPv6 by its /64 however it is written", () => {
  const cases: Array<[string, string | null]> = [
    ["198.51.100.7", "198.51.100.7"],
    [" 198.51.100.7 ", "198.51.100.7"],
    ["::ffff:198.51.100.7", "198.51.100.7"],
    ["::ffff:c633:6407", "198.51.100.7"],
    ["2001:db8:1:2::10", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:0000:0000:0000:0010", "2001:db8:1:2::/64"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["64:ff9b::198.51.100.7", "64:ff9b:0:0::/64"],
    ["", null],
    ["unknown", null],
    ["198.51.100.7, 203.0.113.9", null],
    ["198.51.100.256", null],
    ["2001:db8::1::2", null],
  ];
  for (const [input, key] of cases) assert.equal(clientKeyOf(input), key, JSON.stringify(input));
});

test("clientKey reads X-Real-IP only: X-Forwarded-For and the socket never decide a key", () => {
  const req = (headers: Record<string, string | string[]>) => ({ headers, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;
  assert.equal(clientKey(req({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(clientKey(req({ "x-forwarded-for": "203.0.113.9" })), null);
  assert.equal(clientKey(req({})), null);
});
