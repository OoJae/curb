/**
 * W10.1: alarms never sit on the commit or settle path. `raise` is synchronous and offline; `flush` delivers
 * the queue once per tick within a budget, coalescing every sev-1 into one page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlarms, ALARM_COOLDOWN_MS, ALARM_BODY_MAX } from "./alarms.ts";

const URL_ = "https://hc-ping.example/abc";

interface Call { url: string; body: string }

/** A fetch stub that records every request and answers with `respond` (default: 200 "OK"). */
function stub(respond: (c: Call, n: number) => Response | Promise<Response> = () => new Response("OK")) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), body: String(init?.body ?? "") };
    calls.push(c);
    return respond(c, calls.length);
  }) as typeof fetch;
  return { calls, fetch: f };
}

function harness(over: { url?: string; respond?: (c: Call, n: number) => Response | Promise<Response>; fetch?: typeof fetch } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const s = stub(over.respond);
  const alarms = createAlarms({
    url: over.url ?? URL_, hostId: "keeper", log: (event, fields) => { logs.push({ event, fields }); },
    fetch: over.fetch ?? s.fetch, now: () => clock.t,
  });
  return { alarms, calls: s.calls, logs, clock };
}

test("raise never touches the network", async () => {
  const h = harness();
  const r = h.alarms.raise(1, "keeper:commit-failed:wTCENTx:1", "commit for wTCENTx failed");
  assert.equal(r, undefined, "synchronous, returns nothing to await");
  h.alarms.raise(2, "keeper:late-log", "late");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.logs.map((l) => l.event), ["alarm", "alarm"], "every raise is logged at once, as HEAD did");
  assert.equal(h.alarms.health().queued, 2);
  await h.alarms.flush();
  assert.ok(h.calls.length > 0);
});

test("the first sev-1 after a boot re-arms first", async () => {
  const h = harness();
  h.alarms.raise(1, "keeper:ticks-failing", "no successful tick for 11 minutes");
  assert.equal(h.alarms.health().checkDown, true, "unknown after a restart, so assumed down");
  await h.alarms.flush();
  assert.deepEqual(h.calls, [
    { url: URL_, body: "re-arm" },
    { url: `${URL_}/fail`, body: "[keeper] sev-1 no successful tick for 11 minutes" },
  ]);
  assert.equal(h.alarms.health().queued, 0);
  assert.equal(h.alarms.health().checkDown, true, "after a page the check is down until re-armed");
  // The next page re-arms again (healthchecks notifies only on a state change).
  h.alarms.raise(1, "keeper:other", "second");
  await h.alarms.flush();
  assert.deepEqual(h.calls.slice(2).map((c) => [c.url, c.body]), [[URL_, "re-arm"], [`${URL_}/fail`, "[keeper] sev-1 second"]]);
});

test("sev-1 alarms of one tick are coalesced", async () => {
  const h = harness();
  h.alarms.raise(1, "keeper:a", "one");
  h.alarms.raise(1, "keeper:b", "two");
  h.alarms.raise(1, "keeper:c", "three");
  await h.alarms.flush();
  const fails = h.calls.filter((c) => c.url === `${URL_}/fail`);
  assert.equal(fails.length, 1, "one page however many keys fired");
  assert.deepEqual(fails[0].body.split("\n"), ["[keeper] sev-1 one", "[keeper] sev-1 two", "[keeper] sev-1 three"]);
  assert.equal(h.calls.length, 2, "plus the boot re-arm, nothing else");
  assert.equal(h.alarms.health().queued, 0);
});

test("a key already queued is updated in place, never duplicated; a sev-1 upgrades a queued sev-2", async () => {
  let up = false;
  const h = harness({ respond: () => (up ? new Response("OK") : new Response("down", { status: 503 })) });
  h.alarms.raise(2, "keeper:k", "first");
  h.alarms.raise(2, "keeper:k", "second");
  h.alarms.raise(2, "keeper:k", "third");
  assert.equal(h.alarms.health().queued, 1);
  assert.equal(h.logs.filter((l) => l.event === "alarm").length, 1, "a condition firing every tick is logged once while queued");
  h.alarms.raise(1, "keeper:k", "now urgent");
  assert.equal(h.alarms.health().queued, 1);
  assert.equal(h.logs.filter((l) => l.event === "alarm").length, 2, "the upgrade is logged");
  h.alarms.raise(2, "keeper:k", "milder again");
  assert.equal(h.alarms.health().queued, 1);
  up = true;
  await h.alarms.flush();
  assert.deepEqual(h.calls.map((c) => [c.url, c.body]), [[URL_, "re-arm"], [`${URL_}/fail`, "[keeper] sev-1 now urgent"]],
    "one page, at the highest severity raised, with that raise's message");
  assert.equal(h.alarms.health().queued, 0);
});

test("an undelivered sev-1 is retried and then dropped", async () => {
  let answer = "OK (rate limited)";
  const h = harness({ respond: (c) => new Response(c.url.endsWith("/fail") ? answer : "OK") });
  h.alarms.raise(1, "keeper:settle-late:0xabc", "row unsettled 1h after its window opened");
  await h.alarms.flush();
  assert.equal(h.alarms.health().queued, 1, "a 200 that is not exactly OK was not recorded: keep it");
  answer = "OK";
  h.clock.t += 30_000;
  await h.alarms.flush();
  assert.equal(h.alarms.health().queued, 0);
  const fails = h.calls.filter((c) => c.url.endsWith("/fail"));
  assert.equal(fails.length, 2);
  assert.equal(fails[1].body, fails[0].body);
  // A delivery that keeps failing for over an hour is dropped, loudly.
  answer = "nope";
  h.alarms.raise(1, "keeper:other", "will never be accepted");
  await h.alarms.flush();
  h.clock.t += 61 * 60_000;
  await h.alarms.flush();
  assert.equal(h.alarms.health().queued, 0);
  assert.equal(h.alarms.health().dropped, 1);
  assert.deepEqual(h.logs.filter((l) => l.event === "alarm-dropped").map((l) => l.fields?.key), ["keeper:other"]);
});

test("a refused re-arm stops the flush; the sev-1 stays queued and is retried next tick", async () => {
  let armed = false;
  const h = harness({ respond: (c) => new Response(c.url === URL_ ? (armed ? "OK" : "nope") : "OK") });
  h.alarms.raise(1, "keeper:x", "x");
  h.alarms.raise(2, "keeper:y", "y");
  await h.alarms.flush();
  assert.deepEqual(h.calls.map((c) => c.url), [URL_], "no /fail on a check that may be down, and the flush stops");
  assert.equal(h.alarms.health().queued, 2);
  armed = true;
  await h.alarms.flush();
  assert.deepEqual(h.calls.map((c) => c.url), [URL_, URL_, `${URL_}/fail`, `${URL_}/log`]);
  assert.equal(h.alarms.health().queued, 0);
});

test("flush keeps to its budget", async () => {
  // Never answers, but honours its abort signal.
  const hanging = (async (_i: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  })) as typeof fetch;
  const h = harness({ fetch: hanging });
  h.alarms.raise(1, "keeper:a", "a");
  const t0 = performance.now();
  await h.alarms.flush(600);
  assert.ok(performance.now() - t0 < 1_100, `returned in ${Math.round(performance.now() - t0)} ms`);
  assert.equal(h.alarms.health().queued, 1, "the sev-1 stays queued");
});

test("flush keeps to its budget even when fetch ignores its signal", async () => {
  const deaf = (async () => new Promise<Response>(() => { /* never settles */ })) as typeof fetch;
  const h = harness({ fetch: deaf });
  h.alarms.raise(1, "keeper:a", "a");
  h.alarms.raise(2, "keeper:b", "b");
  const t0 = performance.now();
  await h.alarms.flush(700);
  assert.ok(performance.now() - t0 < 1_200, `returned in ${Math.round(performance.now() - t0)} ms`);
  assert.equal(h.alarms.health().queued, 2);
});

test("nothing starts with less than 500 ms of budget", async () => {
  const h = harness();
  h.alarms.raise(1, "keeper:a", "a");
  await h.alarms.flush(400);
  assert.equal(h.calls.length, 0);
  assert.equal(h.alarms.health().queued, 1);
});

test("cooldown and severity", async () => {
  const h = harness();
  h.alarms.raise(1, "keeper:k", "first");
  await h.alarms.flush();
  h.clock.t += 5 * 60_000;
  h.alarms.raise(1, "keeper:k", "again within 15 min");
  assert.equal(h.alarms.health().queued, 0, "skipped: delivered less than 15 minutes ago at the same severity");
  await h.alarms.flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/fail")).length, 1, "one delivery");
  h.clock.t += ALARM_COOLDOWN_MS;
  h.alarms.raise(1, "keeper:k", "after the cooldown");
  await h.alarms.flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/fail")).length, 2);

  // A sev-1 after a delivered sev-2 of the same key is delivered; a sev-2 after a delivered sev-1 is not.
  h.alarms.raise(2, "keeper:j", "informational");
  await h.alarms.flush();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/log")).length, 1);
  h.alarms.raise(1, "keeper:j", "now it matters");
  await h.alarms.flush();
  assert.equal(h.calls.at(-1)!.url, `${URL_}/fail`);
  assert.equal(h.calls.at(-1)!.body, "[keeper] sev-1 now it matters");
  const n = h.calls.length;
  h.alarms.raise(2, "keeper:j", "milder");
  await h.alarms.flush();
  assert.equal(h.calls.length, n);
});

test("sev-2 alarms are coalesced into one /log and not retried", async () => {
  const h = harness({ respond: (c) => new Response(c.url.endsWith("/log") ? "nope" : "OK") });
  h.alarms.raise(2, "keeper:a", "one");
  h.alarms.raise(2, "keeper:b", "two");
  await h.alarms.flush();
  assert.deepEqual(h.calls, [{ url: `${URL_}/log`, body: "[keeper] sev-2 one\n[keeper] sev-2 two" }], "no re-arm for sev-2");
  assert.equal(h.alarms.health().queued, 0, "removed whatever the answer");
  h.alarms.raise(2, "keeper:a", "one again");
  assert.equal(h.alarms.health().queued, 0, "its cooldown started: no per-tick storm against a failing endpoint");
});

test("a sev-1 page is capped at 9,000 characters; the rest stays queued", async () => {
  const h = harness();
  const big = "x".repeat(4_000);
  for (const k of ["a", "b", "c"]) h.alarms.raise(1, `keeper:${k}`, big);
  await h.alarms.flush();
  const fails = h.calls.filter((c) => c.url.endsWith("/fail"));
  assert.equal(fails.length, 1);
  assert.ok(fails[0].body.length <= ALARM_BODY_MAX);
  assert.equal(fails[0].body.split("\n").length, 2);
  assert.equal(h.alarms.health().queued, 1);
  await h.alarms.flush();
  assert.equal(h.alarms.health().queued, 0);
  // A single over-long message is truncated, never stuck.
  h.alarms.raise(1, "keeper:huge", "y".repeat(20_000));
  await h.alarms.flush();
  assert.equal(h.calls.at(-1)!.body.length, ALARM_BODY_MAX);
  assert.equal(h.alarms.health().queued, 0);
});

test("no URL logs and sends nothing", async () => {
  const h = harness({ url: "" });
  h.alarms.raise(1, "keeper:a", "a");
  h.alarms.raise(1, "keeper:a", "a again");
  h.alarms.raise(2, "keeper:b", "b");
  await h.alarms.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.alarms.health().paging, false);
  assert.equal(h.alarms.health().queued, 0);
  assert.equal(h.logs.filter((l) => l.event === "alarm").length, 2, "the cooldown applies to the log line, as HEAD");
  assert.deepEqual(h.alarms.health().lastSev1, { key: "keeper:a", atMs: h.clock.t });
});

test("raise never throws, even when logging does", () => {
  const alarms = createAlarms({ url: URL_, hostId: "keeper", log: () => { throw new Error("stdout closed"); }, fetch: stub().fetch });
  assert.doesNotThrow(() => alarms.raise(1, "keeper:a", "a"));
  assert.equal(alarms.health().queued, 1);
});

test("a flush that throws inside fetch resolves and keeps the alarm", async () => {
  const h = harness({ fetch: (() => { throw new Error("boom"); }) as unknown as typeof fetch });
  h.alarms.raise(1, "keeper:a", "a");
  await h.alarms.flush();
  assert.equal(h.alarms.health().queued, 1);
});
