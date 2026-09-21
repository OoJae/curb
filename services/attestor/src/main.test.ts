import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inDenseWindow, validScheduleBody, validAssetBody } from "./main.ts";
import { readFileSync } from "node:fs";
import { verifyBundleOffline } from "./verify/offline.ts";
import type { ExchangeSchedule } from "./regime.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

test("importing main.ts does not start the service (tests and tools can import decide/inDenseWindow)", () => {
  // If main() had started, it would have opened a listener and kept this process alive; reaching here
  // with the export callable is the check.
  assert.equal(typeof inDenseWindow, "function");
});

test("a malformed schedule is skipped by the polling heuristic instead of aborting the tick", () => {
  const bad = new Map<string, ExchangeSchedule>([["XHKG", { schedule: null } as unknown as ExchangeSchedule]]);
  assert.equal(inDenseWindow(bad, Date.parse("2026-10-06T04:00:00Z")), false);
});

test("an invalid MODE is a fatal configuration error, never the live writer", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `process.env.MODE="Live"; const m = await import(${JSON.stringify(MAIN)}); console.log("imported");`], { encoding: "utf8", timeout: 20_000 });
  assert.match(r.stdout, /imported/);
  // Run it as the entry point with a bogus mode: it must log a fatal config error (and back off), not boot.
  const run = spawnSync(process.execPath, ["--experimental-strip-types", MAIN], {
    encoding: "utf8", timeout: 3_000, env: { ...process.env, MODE: "Live", DATA_DIR: "/nonexistent-curb-test" },
  });
  assert.match(run.stdout, /"event":"fatal".*MODE must be one of shadow\|live\|standby/);
  assert.doesNotMatch(run.stdout, /"event":"boot"/);
});

test("schedule body validator accepts the real issuer shape and rejects shapes that used to abort ticks", () => {
  const real = { schedule: { timezone: "Asia/Hong_Kong", sessions: [{ kind: "Regular", days: ["Monday"], open: "09:30", close: "12:00" }], holidays: [{ startsAt: "2026-09-25T04:00:00.000Z", endsAt: "2026-09-25T16:00:00.000Z", kind: "Closed" }] } };
  assert.equal(validScheduleBody(real), true);
  for (const bad of [null, {}, { schedule: {} }, { schedule: { timezone: "Mars/Olympus", sessions: [] } }, { schedule: { timezone: "UTC", sessions: [{ open: "9", close: "12:00", days: [] }] } },
    { schedule: { timezone: "UTC", sessions: [{ open: "09:00", close: "12:00" }] } }, { schedule: { timezone: "UTC", holidays: [{ startsAt: "soon", endsAt: "later" }] } }, { schedule: { timezone: "UTC", sessions: "all day" } }]) {
    assert.equal(validScheduleBody(bad), false, JSON.stringify(bad));
  }
});

test("asset body validator rejects an unknown period instead of letting it become an undefined regime", () => {
  assert.equal(validAssetBody({ trading: { currentPeriod: "market", isTradingHalted: false, limitsPerPeriod: {}, nextChangeAt: null } }), true);
  assert.equal(validAssetBody({ trading: { currentPeriod: null, isTradingHalted: false } }), true);
  assert.equal(validAssetBody({ trading: { currentPeriod: "market", isTradingHalted: "no" } }), false, "halt flag reaches calldata");
  assert.equal(validAssetBody({ trading: { currentPeriod: "market", isTradingHalted: false, limitsPerPeriod: { market: { maxOrderFiatValue: 1e40 } } } }), false, "cap beyond uint128");
  assert.equal(validAssetBody({ trading: { currentPeriod: "lunch", isTradingHalted: false } }), false);
  assert.equal(validAssetBody({ trading: { currentPeriod: "market", isTradingHalted: false, nextChangeAt: "whenever" } }), false);
  assert.equal(validAssetBody("<html>"), false);
});

test("every committed body in a real mainnet bundle passes the validators (no honest input is withheld)", () => {
  const bundle = JSON.parse(readFileSync(new URL("./fixtures/round-70619137.bundle.json", import.meta.url), "utf8"));
  let schedules = 0, assets = 0;
  for (const b64 of Object.values(bundle.blobs) as string[]) {
    const v = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (v.schedule) { schedules++; assert.equal(validScheduleBody(v), true); }
    else { assets++; assert.equal(validAssetBody(v), true, JSON.stringify(v).slice(0, 200)); }
  }
  assert.ok(schedules >= 2 && assets >= 6, `${schedules} schedules, ${assets} assets`);
  assert.equal(verifyBundleOffline(bundle).ok, true);
});
