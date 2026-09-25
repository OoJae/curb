import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256 } from "ethers";
import { nextReopen, venueLocalTime, humanDuration } from "./nextReopen.ts";
import { IssuerCache, OUTAGE_MS, REFRESH_MS, RETRY_AFTER_FAIL_MS } from "./issuer.ts";
import type { Fetch } from "./issuer.ts";
import { TimelineCache } from "./closureCalendar.ts";
import { CONTRACTS, requireAsset } from "./assets.ts";
import { clockAnswer, fakeChain } from "./fixtures/fakeChain.ts";
import type { ClockState } from "./fixtures/fakeChain.ts";

/** Real issuer bodies (see closureCalendar.test.ts): XHKG publishes 1 Oct and 19 Oct as holidays, nothing in September. */
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const BODIES: Record<string, Uint8Array> = {
  "/assets/TCENTx": bytes("tcentx.asset.json"),
  "/exchanges/XHKG": bytes("xhkg.exchange.json"),
  "/assets/NVDAx": bytes("nvdax.asset.json"),
  "/exchanges/XNAS": bytes("xnas.exchange.json"),
};

function issuerFetch(log: string[] = [], fail = false): Fetch {
  return async (url) => {
    log.push(url);
    const path = new URL(url).pathname.replace("/api/v2/public", "");
    const body = BODIES[path];
    if (fail || !body) return { ok: false, status: fail ? 503 : 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.slice().buffer };
  };
}

const TCENT = requireAsset("TCENTx");
const NVDA = requireAsset("NVDAx");
const at = (iso: string) => Date.parse(iso);

function deps(nowIso: string, clock: Record<string, ClockState>, fetchImpl: Fetch = issuerFetch()) {
  let now = at(nowIso);
  return {
    chain: fakeChain(clockAnswer(clock, CONTRACTS.marketClock)),
    issuer: new IssuerCache(fetchImpl, () => now),
    timelines: new TimelineCache(),
    now: () => now,
    set: (iso: string) => { now = at(iso); },
    advance: (ms: number) => { now += ms; },
  };
}

test("venue-local time is read from the instant, whatever the host's zone", () => {
  assert.equal(venueLocalTime("Asia/Hong_Kong", at("2026-09-25T01:30:00Z")), "Fri 2026-09-25 09:30 Asia/Hong_Kong");
  assert.equal(venueLocalTime("America/New_York", at("2026-09-25T04:00:00Z")), "Fri 2026-09-25 00:00 America/New_York");
  assert.equal(venueLocalTime("Asia/Hong_Kong", at("2026-09-27T16:00:00Z")), "Mon 2026-09-28 00:00 Asia/Hong_Kong");
});

test("durations read the way a person says them", () => {
  assert.equal(humanDuration(0), "under 1 min");
  assert.equal(humanDuration(59), "under 1 min");
  assert.equal(humanDuration(300), "5 min");
  assert.equal(humanDuration(3900), "1 h 5 min");
  assert.equal(humanDuration(63300), "17 h 35 min");
  assert.equal(humanDuration(236_100), "2 d 17 h 35 min");
  assert.equal(humanDuration(7200), "2 h");
});

test("Hong Kong before the open: shut, and capacity returns at 09:30, not at MarketClock's 09:00 boundary", async () => {
  const d = deps("2026-09-22T09:10:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n, toNext: 600 } });
  const r = await nextReopen(d, TCENT);
  assert.equal(r.shutNow, true);
  assert.equal(r.disagreement, null);
  assert.deepEqual(r.expectedReopen, {
    startsAt: "2026-09-21T07:55:00.000Z", startsAtVenue: "Mon 2026-09-21 15:55 Asia/Hong_Kong",
    endsAt: "2026-09-22T01:30:00.000Z", endsAtVenue: "Tue 2026-09-22 09:30 Asia/Hong_Kong",
    durationS: 63300, kind: "overnight", inSeconds: 1200,
  });
  assert.equal(r.nextClosure?.startsAtVenue, "Tue 2026-09-22 11:55 Asia/Hong_Kong", "the issuer cuts 5 minutes before the 12:00 recess");
  assert.equal(r.nextClosure?.endsAtVenue, "Tue 2026-09-22 13:00 Asia/Hong_Kong");
  assert.equal(r.nextClosure?.kind, "recess");
  assert.equal(r.summary, "wTCENTx: primary market shut now (MarketClock CLOSED, cap $0). By the issuer's schedule capacity returns at 2026-09-22T01:30:00.000Z (Tue 2026-09-22 09:30 Asia/Hong_Kong), in 20 min.");
  assert.equal(r.schedule.method, "curb.reopen/1");
  assert.equal(r.schedule.period, "extended", "09:00-09:30 is the pre-open: extended by label, zero cap");
  assert.equal(r.schedule.capUsd, 0);
  assert.equal(r.schedule.issuer?.assetBodyHash, keccak256(BODIES["/assets/TCENTx"]), "the answer names the exact issuer bytes");
  assert.equal(r.schedule.issuer?.exchangeBodyHash, keccak256(BODIES["/exchanges/XHKG"]));
  assert.match(r.fullCalendar.route, /closure-calendar\?symbol=wTCENTx/);
});

test("Friday's close reopens on Monday 09:30", async () => {
  const d = deps("2026-09-25T16:30:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n } });
  const r = await nextReopen(d, TCENT);
  assert.equal(r.expectedReopen?.endsAtVenue, "Mon 2026-09-28 09:30 Asia/Hong_Kong");
  assert.equal(r.expectedReopen?.kind, "weekend");
  assert.match(r.summary, /, in 2 d 17 h\.$/);
});

test("the lunch cut before MarketClock has recorded it: the answer says the two disagree", async () => {
  const d = deps("2026-09-22T11:57:00+08:00", { [TCENT.wrapper]: { regime: 4, cap: 100_000n } });
  const r = await nextReopen(d, TCENT);
  assert.equal(r.shutNow, false);
  assert.equal(r.schedule.open, false);
  assert.equal(r.expectedReopen?.endsAtVenue, "Tue 2026-09-22 13:00 Asia/Hong_Kong");
  assert.match(r.disagreement ?? "", /MarketClock still reads MARKET with cap \$100,000, but by the issuer's schedule a closure has begun \(cut at 2026-09-22T03:55:00\.000Z\)/);
  assert.match(r.summary, /disagree/);
});

test("MarketClock shut while the schedule says open: shut wins, and no reopen is invented", async () => {
  const d = deps("2026-09-22T10:00:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n } });
  const r = await nextReopen(d, TCENT);
  assert.equal(r.shutNow, true);
  assert.equal(r.expectedReopen, null);
  assert.match(r.disagreement ?? "", /treat the market as shut until the attestor records the reopen/);
  assert.equal(r.nextClosure?.startsAtVenue, "Tue 2026-09-22 11:55 Asia/Hong_Kong");
});

test("a US name overnight: open, and the next closure is the 5-minute handover at 03:55 ET", async () => {
  const d = deps("2026-09-24T21:30:00-04:00", { [NVDA.wrapper]: { regime: 2, cap: 200_000n } });
  const r = await nextReopen(d, NVDA);
  assert.equal(r.shutNow, false);
  assert.equal(r.expectedReopen, null);
  assert.equal(r.disagreement, null);
  assert.equal(r.nextClosure?.startsAtVenue, "Fri 2026-09-25 03:55 America/New_York");
  assert.equal(r.nextClosure?.endsAtVenue, "Fri 2026-09-25 04:00 America/New_York");
  assert.equal(r.nextClosure?.kind, "handover");
  assert.match(r.summary, /^wNVDAx: primary market open now \(MarketClock OVERNIGHT, cap \$200,000\)\. Next closure/);
});

test("the issuer is read once per asset per refresh window, not once per call", async () => {
  const log: string[] = [];
  const d = deps("2026-09-22T09:10:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n } }, issuerFetch(log));
  await Promise.all([nextReopen(d, TCENT), nextReopen(d, TCENT), nextReopen(d, TCENT)]);
  assert.equal(log.length, 2, "one asset read and one exchange read, shared by three concurrent calls");
  d.advance(REFRESH_MS);
  await nextReopen(d, TCENT);
  assert.equal(log.length, 4);
});

test("an unreachable issuer: MarketClock still answers, no reopen is guessed, and the warning says why", async () => {
  const d = deps("2026-09-22T09:10:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n, toNext: 600 } }, issuerFetch([], true));
  const r = await nextReopen(d, TCENT);
  assert.equal(r.shutNow, true);
  assert.equal(r.expectedReopen, null);
  assert.equal(r.marketClock.nextTransitionAt !== null, true);
  assert.match(r.marketClock.note, /not necessarily when capacity returns/);
  assert.match(r.warnings.join(" "), /could not be read \(asset TCENTx: http 503\)/);
});

test("after a failed read the issuer is left alone for 30 s, whatever the call rate", async () => {
  const log: string[] = [];
  let fail = true;
  const f: Fetch = async (url, init) => { if (fail) { log.push(url); return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; } return issuerFetch(log)(url, init); };
  const d = deps("2026-09-22T09:10:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n } }, f);
  await nextReopen(d, TCENT);
  await nextReopen(d, TCENT);
  d.advance(RETRY_AFTER_FAIL_MS - 1);
  await nextReopen(d, TCENT);
  assert.equal(log.length, 1, "one attempt, then nothing until the backoff passes");
  fail = false;
  d.advance(1);
  const r = await nextReopen(d, TCENT);
  assert.equal(log.length, 3);
  assert.ok(r.expectedReopen);
});

test("stale issuer bytes are served with their age until the outage threshold, then dropped", async () => {
  let fail = false;
  const f: Fetch = async (url, init) => (fail ? { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) } : issuerFetch()(url, init));
  const d = deps("2026-09-22T09:10:00+08:00", { [TCENT.wrapper]: { regime: 1, cap: 0n } }, f);
  await nextReopen(d, TCENT);
  fail = true;
  d.advance(REFRESH_MS + 1_000);
  const stale = await nextReopen(d, TCENT);
  assert.ok(stale.expectedReopen, "still answers from the last good bytes");
  assert.match(stale.warnings.join(" "), /issuer bytes are \d+ s old because the latest refresh failed/);
  d.advance(OUTAGE_MS);
  const gone = await nextReopen(d, TCENT);
  assert.equal(gone.expectedReopen, null);
});
