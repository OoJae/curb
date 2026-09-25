import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientIp } from "./rateLimit.ts";

test("a bucket gives `burst` at once, then refuses with a Retry-After, then refills at the rate", () => {
  let t = 0;
  const rl = new RateLimiter({ burst: 3, perMinute: 60, now: () => t });
  assert.deepEqual(rl.take("a"), { ok: true, remaining: 2 });
  assert.deepEqual(rl.take("a"), { ok: true, remaining: 1 });
  assert.deepEqual(rl.take("a"), { ok: true, remaining: 0 });
  assert.deepEqual(rl.take("a"), { ok: false, retryAfterS: 1 }, "60/min is one a second");
  t += 999;
  assert.equal(rl.take("a").ok, false, "not quite a second yet");
  t += 2;
  assert.equal(rl.take("a").ok, true);
  t += 3_600_000;
  assert.deepEqual(rl.take("a"), { ok: true, remaining: 2 }, "never refills past the burst");
});

test("clients are independent", () => {
  const rl = new RateLimiter({ burst: 1, perMinute: 1, now: () => 0 });
  assert.equal(rl.take("a").ok, true);
  assert.equal(rl.take("a").ok, false);
  assert.equal(rl.take("b").ok, true);
});

test("a slow rate says how long to wait", () => {
  const rl = new RateLimiter({ burst: 1, perMinute: 2, now: () => 0 });
  rl.take("a");
  assert.deepEqual(rl.take("a"), { ok: false, retryAfterS: 30 });
});

test("memory is bounded: the least recently seen client is dropped first", () => {
  const rl = new RateLimiter({ burst: 1, perMinute: 1, maxClients: 2, now: () => 0 });
  rl.take("a");
  rl.take("b");
  rl.take("a");           // a is now the most recent
  rl.take("c");           // evicts b
  assert.equal(rl.size, 2);
  assert.equal(rl.take("a").ok, false, "a is still remembered");
  assert.equal(rl.take("b").ok, true, "b starts over with a full bucket");
  assert.equal(rl.size, 2);
});

const req = (xff: string | string[] | undefined, remote = "10.0.0.9") =>
  ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: remote } }) as never;

test("clientIp with no trusted proxy uses the socket and ignores X-Forwarded-For, which anyone can send", () => {
  assert.equal(clientIp(req("1.2.3.4"), 0), "10.0.0.9");
  assert.equal(clientIp(req(undefined), 0), "10.0.0.9");
});

test("clientIp behind one proxy takes the entry that proxy appended, never a client-supplied one", () => {
  assert.equal(clientIp(req("203.0.113.7"), 1), "203.0.113.7");
  assert.equal(clientIp(req("6.6.6.6, 203.0.113.7"), 1), "203.0.113.7", "a forged leftmost entry is ignored");
  assert.equal(clientIp(req(["6.6.6.6", "203.0.113.7"]), 1), "203.0.113.7");
  assert.equal(clientIp(req("a, b, 203.0.113.7"), 2), "b");
  assert.equal(clientIp(req(""), 1), "10.0.0.9", "an empty header falls back to the socket");
  assert.equal(clientIp(req("x".repeat(500)), 1).length, 64);
});
