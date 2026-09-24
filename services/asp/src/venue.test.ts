import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VenueStore } from "./venue.ts";
import { XStocksClient } from "./sources/xstocks.ts";
import type { Asset } from "./cohort.ts";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const asset = { wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", symbol: "wTCENTx", rawSymbol: "TCENTx" } as Asset;

test("a failed refresh keeps the last good bytes, records why, and the age decides stale vs outage", async () => {
  let t = Date.parse("2026-09-22T02:00:00Z");
  const now = () => t;
  let up = true;
  const bodies: Record<string, string> = {
    "https://issuer.test/assets/TCENTx?network=XLayer": fixture("tcentx.asset.json"),
    "https://issuer.test/exchanges/XHKG": fixture("xhkg.exchange.json"),
  };
  // 404 is not retried by the client, so the failing path stays fast.
  const fetchStub = (async (u: string | URL | Request) =>
    up ? new Response(bodies[String(u)], { status: 200 }) : new Response("gone", { status: 404 })) as typeof fetch;
  const client = new XStocksClient("https://issuer.test", fetchStub, now);
  const store = new VenueStore({ refreshMs: 600_000, staleAfterMs: 630_000, outageMs: 1_800_000 });
  const errors: string[] = [];

  assert.equal(store.status(asset.wrapper, t).outage, true, "never fetched is an outage, not a default");
  await store.refresh([asset], client, now, undefined, (_a, e) => errors.push(e));
  const good = store.status(asset.wrapper, t);
  assert.equal(good.venue?.mic, "XHKG");
  assert.equal(good.venue?.limits.market.maxOrderFiatValue, 10_000_000);
  assert.equal(good.venue?.reportedPeriod, "closed", "the fixture was captured overnight");
  assert.equal(good.stale, false);

  t += 300_000;
  up = false;
  await store.refresh([asset], client, now, undefined, (_a, e) => errors.push(e));
  assert.equal(errors.length, 0, "fresh bytes are not refetched");

  t += 400_000;   // 700s old: due, and the refetch fails
  await store.refresh([asset], client, now, undefined, (_a, e) => errors.push(e));
  const stale = store.status(asset.wrapper, t);
  assert.equal(stale.venue, good.venue, "the last good bytes are kept");
  assert.equal(stale.stale, true);
  assert.equal(stale.outage, false);
  assert.match(stale.lastError!, /http 404/);
  assert.equal(errors.length, 1);

  t += 1_200_000;   // 1900s old
  assert.equal(store.status(asset.wrapper, t).outage, true);

  up = true;
  await store.refresh([asset], client, now);
  const back = store.status(asset.wrapper, t);
  assert.equal(back.outage, false);
  assert.equal(back.lastError, null);
  assert.equal(back.ageMs, 0);
});
