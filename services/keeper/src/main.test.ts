/**
 * Keeper configuration at boot.
 *
 * Attribution (ERC-8021, 24 Sep 2026): DATA_SUFFIX carries the X Layer Builder Code onto every commit and
 * settle. It is off unless set, and a bad value must stop the keeper at boot -- through the same logged
 * fatal path as any other config error -- never reach the Sender, and never throw at import time (which
 * would also break every test that imports closureId from main.ts).
 *
 * /healthz reports what the live Sender appends, not what DATA_SUFFIX says (review, 24 Sep 2026): a keeper
 * with no key has no Sender and signs nothing, so its health must not claim attribution is on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { Wallet } from "ethers";
import {
  loadConfig, attributionHealth, clockSkewStep, archiveStep, CLOCK_SKEW_MAX_S, ARCHIVE_BACKLOG_MS, backfillBusy,
} from "./main.ts";
import { Sender } from "./tx/sender.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const BUILDER_SUFFIX = "0x6464377535306e636b74356537323966100080218021802180218021802180218021";

/** Run `fn` with some environment variables set (undefined = unset), restoring them afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; }
  };
  apply(vars);
  try { return fn(); } finally { apply(saved); }
}

/** Run main.ts as the entry point until `until` matches its stdout (15s at most), then kill it. */
function bootUntil(env: NodeJS.ProcessEnv, until: RegExp): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", MAIN], { env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(out);
    };
    const timer = setTimeout(finish, 15_000);
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); if (until.test(out)) finish(); });
    child.on("exit", finish);
  });
}

test("DATA_SUFFIX: unset or empty is off; the Builder Code suffix is trimmed, lower-cased and accepted", () => {
  for (const off of [undefined, "", "  "]) {
    withEnv({ DATA_SUFFIX: off }, () => {
      const { cfg, errors } = loadConfig();
      assert.equal(cfg.dataSuffix, "", JSON.stringify(off));
      assert.deepEqual(errors, []);
    });
  }
  withEnv({ DATA_SUFFIX: ` 0x${BUILDER_SUFFIX.slice(2).toUpperCase()}\n` }, () => {
    const { cfg, errors } = loadConfig();
    assert.equal(cfg.dataSuffix, BUILDER_SUFFIX);
    assert.deepEqual(errors, []);
  });
});

test("an invalid DATA_SUFFIX is a collected configuration error, never a throw at import time", () => {
  for (const bad of ["0xdeadbeef", BUILDER_SUFFIX.slice(2), BUILDER_SUFFIX.slice(0, -2), "0x" + BUILDER_SUFFIX.slice(4)]) {
    withEnv({ DATA_SUFFIX: bad }, () => {
      const { cfg, errors } = loadConfig();
      assert.equal(cfg.dataSuffix, "", "an unusable suffix is never passed on");
      assert.ok(errors.some((e) => e.startsWith("DATA_SUFFIX: ")), `${bad}: ${errors.join("; ")}`);
    });
  }
});

test("mark/2's signal settings: on by default through curb-asp's relay, with a kill switch and checked values", () => {
  const unset = { SIGNAL: undefined, SIGNAL_RELAY_BASE: undefined, SIGNAL_BINANCE_DIRECT: undefined, SIGNAL_FETCH_MS: undefined };
  withEnv(unset, () => {
    const { cfg, errors } = loadConfig();
    assert.deepEqual(errors, []);
    assert.equal(cfg.signal, true);
    assert.equal(cfg.signalRelayBase, "https://api.curb.markets");
    assert.equal(cfg.signalBinanceDirect, true);
    assert.equal(cfg.signalFetchMs, 4_000);
  });
  withEnv({ ...unset, SIGNAL: "off", SIGNAL_RELAY_BASE: "", SIGNAL_BINANCE_DIRECT: "0", SIGNAL_FETCH_MS: "2500" }, () => {
    const { cfg, errors } = loadConfig();
    assert.deepEqual(errors, []);
    assert.equal(cfg.signal, false, "the kill switch: every row takes the no-signal path");
    assert.equal(cfg.signalRelayBase, "", "empty skips the relay");
    assert.equal(cfg.signalBinanceDirect, false);
    assert.equal(cfg.signalFetchMs, 2_500);
  });
  withEnv({ ...unset, SIGNAL_RELAY_BASE: "https://relay.example/base/" }, () => {
    assert.equal(loadConfig().cfg.signalRelayBase, "https://relay.example/base");
  });
  withEnv({ ...unset, SIGNAL: "maybe", SIGNAL_RELAY_BASE: "not a url", SIGNAL_FETCH_MS: "60000" }, () => {
    const { errors } = loadConfig();
    assert.ok(errors.some((e) => e.startsWith("SIGNAL must be on|off")), errors.join("; "));
    assert.ok(errors.some((e) => e.startsWith("SIGNAL_RELAY_BASE is not a base URL")), errors.join("; "));
    assert.ok(errors.some((e) => e.startsWith("SIGNAL_FETCH_MS must be in")), errors.join("; "));
  });
});

test("boot logs whether attribution is on before anything else, and a bad DATA_SUFFIX is fatal before that", async () => {
  // DATA_DIR is a FILE, so main() dies at its first mkdir (as root too) right after the attribution line:
  // no state, no key, no network.
  const dir = mkdtempSync(join(tmpdir(), "curb-keeper-attr-boot-"));
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "");
  const env = {
    ...process.env, MODE: "shadow", SCORECARD: "", DATA_DIR: file, RPCS: "http://127.0.0.1:9",
    KEEPER_KEY_PASSWORD: "", ATTESTOR_KEY_PASSWORD: "",
  };
  try {
    const on = await bootUntil({ ...env, DATA_SUFFIX: BUILDER_SUFFIX }, /"event":"fatal"/);
    // The code in plain text, not just the hex: a mistyped code is visible in the log at a glance.
    assert.match(on, new RegExp(`"event":"attribution","on":true,"dataSuffix":"${BUILDER_SUFFIX}","codes":\\["dd7u50nckt5e729f"\\]`));
    const off = await bootUntil({ ...env, DATA_SUFFIX: "" }, /"event":"fatal"/);
    assert.match(off, /"event":"attribution","on":false/);
    const bad = await bootUntil({ ...env, DATA_SUFFIX: "0xdeadbeef" }, /"event":"fatal"/);
    assert.match(bad, /"event":"fatal".*invalid configuration: DATA_SUFFIX: dataSuffix 0xdeadbeef does not end with the ERC-8021 marker/);
    assert.doesNotMatch(bad, /"event":"attribution"/);
    assert.doesNotMatch(bad, /"event":"boot"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/healthz attribution is what the live Sender appends: off without a key, whatever DATA_SUFFIX says", () => {
  const off = { on: false, dataSuffix: null, codes: [] };
  // No key (shadow with no password): main() builds `key ? new Sender(...) : null`, so nothing is signed.
  assert.deepEqual(attributionHealth(null), off);
  const dir = mkdtempSync(join(tmpdir(), "curb-keeper-attr-health-"));
  try {
    const senderWith = (dataSuffix: string | undefined, n: number) => new Sender({
      wallet: new Wallet("0x" + "4c".repeat(32)), rpcs: ["https://a"], chainId: 196,
      dbPath: join(dir, `outbox-${n}.sqlite`), rpc: async () => null, dataSuffix,
    });
    assert.deepEqual(attributionHealth(senderWith(BUILDER_SUFFIX, 1)), { on: true, dataSuffix: BUILDER_SUFFIX, codes: ["dd7u50nckt5e729f"] });
    assert.deepEqual(attributionHealth(senderWith("", 2)), off);
    assert.deepEqual(attributionHealth(senderWith(undefined, 3)), off);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The wiring, which a unit test of the helper cannot see: health is built from the Sender, not the config.
  const src = readFileSync(MAIN, "utf8");
  assert.match(src, /attribution: attributionHealth\(sender\)/);
  assert.doesNotMatch(src, /on: CFG\.dataSuffix !== ""/);
});

// ---------------------------------------------------------------------------------------------
// Deploy 2: W6 (plan persistence) and W10 (alarms, health, operations). Source-text tests read main.ts as
// written; `fnBody` cuts one top-level function out of it.
// ---------------------------------------------------------------------------------------------

const SRC = () => readFileSync(MAIN, "utf8");
/** The text of a top-level function, from its declaration to the first `}` at column 0 after it. */
function fnBody(src: string, decl: string): string {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `${decl} not found in main.ts`);
  const end = src.indexOf("\n}\n", i);
  assert.ok(end > i, `${decl} has no end`);
  return src.slice(i, end + 2);
}
const after = (text: string, needle: string, from: number) => text.indexOf(needle, from);

test("W6: main.ts writes the state file only through saveState(", () => {
  const src = SRC();
  assert.equal(src.split("persistReplace(statePath()").length - 1, 1, "exactly one write of keeper-state.json");
  const save = fnBody(src, "function saveState(state: State): void");
  assert.match(save, /state\.v = 2;\n\s*persistReplace\(statePath\(\), JSON\.stringify\(state\)\);/);
  assert.doesNotMatch(src, /writeFileSync\(statePath\(\)/);
  // The old build loads `{ ...empty, ...JSON.parse(text) }`, so `v` and every later optional field survive a rollback.
  assert.match(fnBody(src, "function loadState(): State"), /\{ \.\.\.empty, \.\.\.JSON\.parse\(/);
});

test("W6: the end-of-tick write calls saveState(state) after the settle pass, and a failed write is paged before the tick fails", () => {
  const tick = fnBody(SRC(), "async function tick(");
  const settle = tick.indexOf("await settlePass(");
  const save = after(tick, "saveState(state)", settle);
  assert.ok(settle > 0 && save > settle, "saveState(state) after settlePass(");
  const flush = after(tick, "alarms.flush(", save);
  const rethrow = after(tick, "if (persistError) throw persistError;", flush);
  assert.ok(tick.indexOf("await delivered;", flush) < rethrow);
  assert.ok(flush > save && rethrow > flush, "the persist alarm is flushed, then the tick fails as HEAD's did");
  // (W2 adds the backfill write after the flush, also through saveState(state).)
});

test("W6: commitPass persists the plan and the attempt number before anything is signed", () => {
  const cp = fnBody(SRC(), "async function commitPass(");
  const built = cp.indexOf("c.plan = built;");
  const planSave = after(cp, "saveState(state)", built);
  const firstSend = Math.min(...["sender.prepare(", "sendCommit(", "commitAttempt("].map((n) => cp.indexOf(n)).filter((i) => i >= 0));
  assert.ok(built > 0 && planSave > built && firstSend > planSave, "plan -> saveState -> first signature");
  // A plan that cannot be saved is kept in memory and nothing is sent this tick.
  assert.match(cp.slice(planSave), /^saveState\(state\); \}\n\s*catch \(e\) \{\n[^]*?raise\(1, "keeper:state-persist-failed"[^\n]*\n\s*continue;/);
  // Until W5 moves the send into commitAttempt (whose order outcome.test.ts pins), the attempt is saved inline.
  if (cp.includes("sender.prepare(")) {
    const inc = cp.indexOf("plan.attempts++;");
    const attemptSave = after(cp, "saveState(state)", inc);
    assert.ok(inc > planSave && attemptSave > inc && cp.indexOf("sender.prepare(") > attemptSave, "attempts++ -> saveState -> prepare");
    assert.match(cp.slice(attemptSave), /^saveState\(state\); \}\n\s*catch \(e\) \{\n\s*plan\.attempts--;[^]*?continue;/);
  }
  // buildPlan runs only for a closure without a plan: a restart can only reuse the saved one.
  assert.match(cp, /if \(!c\.plan\) \{\n\s*const built = await buildPlan\(/);
});

test("W10: the boot line names paging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-keeper-alarms-boot-"));
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "");
  const env = {
    ...process.env, MODE: "shadow", SCORECARD: "", DATA_DIR: file, RPCS: "http://127.0.0.1:9", DATA_SUFFIX: "",
    KEEPER_KEY_PASSWORD: "", ATTESTOR_KEY_PASSWORD: "", HC_URL: "", HC_ALARM_URL: "",
  };
  try {
    const off = await bootUntil(env, /"event":"fatal"/);
    const i = off.indexOf('"event":"alarms","paging":false,"heartbeat":false');
    assert.ok(i >= 0, off);
    assert.ok(i < off.indexOf('"event":"fatal"'));
    assert.ok(off.indexOf('"event":"attribution"') < i, "right after the attribution line");
    const url = "https://hc-ping.example/secret-uuid";
    const on = await bootUntil({ ...env, HC_URL: url, HC_ALARM_URL: url }, /"event":"fatal"/);
    assert.match(on, /"event":"alarms","paging":true,"heartbeat":true/);
    assert.doesNotMatch(on, /secret-uuid/, "never the URLs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W10: LOW_BALANCE_WEI is a collected error, never a throw at import", () => {
  withEnv({ LOW_BALANCE_WEI: undefined }, () => {
    const { cfg, errors } = loadConfig();
    assert.equal(cfg.lowBalanceWei, 3_000_000_000_000_000n);
    assert.deepEqual(errors, []);
  });
  withEnv({ LOW_BALANCE_WEI: " 123 " }, () => assert.equal(loadConfig().cfg.lowBalanceWei, 123n));
  for (const bad of ["abc", "", "-1", "1e18", "0x10", "1.5"]) {
    withEnv({ LOW_BALANCE_WEI: bad }, () => {
      let r: ReturnType<typeof loadConfig> | undefined;
      assert.doesNotThrow(() => { r = loadConfig(); });
      assert.ok(r!.errors.some((e) => e.startsWith("LOW_BALANCE_WEI must be a decimal integer")), `${bad}: ${r!.errors.join("; ")}`);
    });
  }
});

test("W10: no await on raise anywhere in main.ts; alarms are flushed after the settle pass and in the loop's catch", () => {
  const src = SRC();
  assert.doesNotMatch(src, /await raise\(/);
  assert.doesNotMatch(src, /await alarms\.raise\(/);
  // The review gate is literally `grep -n "await raise\|await alarms" main.ts` empty.
  assert.doesNotMatch(src, /await raise|await alarms/);
  assert.doesNotMatch(src, /async function raise\(/);
  assert.match(src, /function raise\(sev: 1 \| 2, key: string, message: string\): void \{ alarms\.raise\(sev, key, message\); \}/);
  assert.match(src, /const alarms = createAlarms\(\{ url: CFG\.alarmUrl, hostId: CFG\.hostId, log \}\);/);
  const tick = fnBody(src, "async function tick(");
  assert.ok(tick.indexOf("alarms.flush(") > tick.indexOf("await settlePass("), "alarms.flush( after settlePass(");
  assert.ok(tick.indexOf("alarms.flush(") > tick.indexOf("await commitPass("));
  const main = fnBody(src, "async function main()");
  const katch = main.indexOf('log("tick-error"');
  assert.ok(katch > 0 && main.indexOf("alarms.flush(", katch) > main.indexOf('"keeper:ticks-failing"', katch));
  assert.match(main.slice(katch), /const delivered = alarms\.flush\(ALARM_FLUSH_BUDGET_MS\);\n\s*await delivered;/);
  assert.match(tick, /const delivered = alarms\.flush\(ALARM_FLUSH_BUDGET_MS\);\n\s*await delivered;/);
  // The HEAD implementation (inline POSTs, its own cooldown map) is gone.
  assert.doesNotMatch(src, /alarmSentAt|alarmCheckDown/);
});

test("W10: clock skew pages on the third consecutive tick beyond 30 s", () => {
  const ts = 1_794_542_157;
  const at = (skewS: number) => (ts + skewS) * 1000;
  let streak = 0;
  for (const [skewS, alarm] of [[31, false], [-45, false], [40, true], [41, true], [30, false], [31, false]] as const) {
    const r = clockSkewStep(streak, at(skewS), ts);
    assert.equal(r.skewS, skewS);
    assert.equal(r.alarm, alarm, `skew ${skewS}`);
    streak = r.streak;
  }
  assert.equal(CLOCK_SKEW_MAX_S, 30);
  assert.equal(clockSkewStep(0, at(0.4), ts).skewS, 0);
  // The reading is taken when the block was pinned, not at step 13 after a long commit.
  const tick = fnBody(SRC(), "async function tick(");
  assert.match(tick, /const block = await pinLatest\(CFG\.rpcs\);\n\s*const pinnedAtMs = Date\.now\(\);/);
  assert.match(tick, /observeTick\(health, block, pinnedAtMs, Date\.now\(\)\);/);
});

test("W10: a parked archive item pages; items waiting 60 minutes are a sev-2 backlog", () => {
  const t0 = 1_000_000;
  let since: number | null = null;
  let r = archiveStep(since, { queued: 0, parked: 0 }, t0);
  assert.deepEqual(r, { backlogSinceMs: null, parked: false, backlog: false });
  r = archiveStep(r.backlogSinceMs, { queued: 2, parked: 0 }, t0);
  assert.deepEqual(r, { backlogSinceMs: t0, parked: false, backlog: false });
  r = archiveStep(r.backlogSinceMs, { queued: 1, parked: 0 }, t0 + ARCHIVE_BACKLOG_MS - 1);
  assert.equal(r.backlog, false);
  r = archiveStep(r.backlogSinceMs, { queued: 1, parked: 0 }, t0 + ARCHIVE_BACKLOG_MS);
  assert.deepEqual(r, { backlogSinceMs: t0, parked: false, backlog: true });
  since = archiveStep(r.backlogSinceMs, { queued: 0, parked: 0 }, t0 + ARCHIVE_BACKLOG_MS + 1).backlogSinceMs;
  assert.equal(since, null, "an empty queue resets the age");
  // Parked items page on their own (sev-1) and do not count as a backlog.
  assert.deepEqual(archiveStep(null, { queued: 1, parked: 1 }, t0), { backlogSinceMs: null, parked: true, backlog: false });
  // /healthz keeps publish.ts's literal wiring and adds the backlog age and the alarm queue.
  const body = fnBody(SRC(), "function healthBody(");
  assert.match(body, /archive: publisher\.health\(\)/);
  assert.match(body, /backlogSinceMs = watch\.archiveBacklogSinceMs/);
  assert.match(body, /alarms: alarmsHealth/);
  assert.match(SRC(), /res\.end\(JSON\.stringify\(healthBody\(health, ok\)\)\);/);
});

test("W10: the minClosureS comment says what such a row would be, not that the pool does not trade", () => {
  const cfg = fnBody(SRC(), "export function loadConfig()");
  assert.doesNotMatch(cfg, /the mark equals the last print by construction/);
  assert.doesNotMatch(cfg, /the pool\s*\*?\s*barely trades/);
  assert.match(cfg, /committed seconds after the cut, with almost no closure behind it/);
});

test("W10: deploy.sh saves the keeper's log before docker rm -f, backs up its state after, and sets BACKFILL_CHUNKS_PER_TICK", () => {
  const path = fileURLToPath(new URL("../../../script/hostb/deploy.sh", import.meta.url));
  const sh = readFileSync(path, "utf8");
  const keeperEnv = sh.match(/cat > \/etc\/curb\/keeper\.env <<CONF\n([^]*?)\nCONF\n/);
  assert.ok(keeperEnv, "the keeper.env heredoc");
  const line = keeperEnv[1].match(/^BACKFILL_CHUNKS_PER_TICK=(\d+)$/m);
  assert.ok(line, "at column 0");
  assert.equal(line[1], "20");
  assert.ok(Number(line[1]) >= 0 && Number(line[1]) <= 60);
  // Only inside the REMOTE heredoc: the header comment names the same files.
  const remote = sh.match(/<<'REMOTE'\n([^]*?)\nREMOTE\n/);
  assert.ok(remote, "the REMOTE heredoc");
  const r = remote[1];
  const order = ["docker logs curb-keeper", "docker rm -f curb-keeper", "keeper-state.predeploy-", "docker run -d --name curb-keeper"].map((n) => [n, r.indexOf(n)] as const);
  for (const [n, i] of order) assert.ok(i >= 0, `${n} in the REMOTE heredoc`);
  for (let k = 1; k < order.length; k++) assert.ok(order[k - 1][1] < order[k][1], `${order[k - 1][0]} before ${order[k][0]}`);
  // The log save cannot stop the deploy, and the keeper is restarted even if the state copy fails.
  assert.match(r, /docker logs curb-keeper 2>&1 \| gzip -c > "\/var\/lib\/curb\/logs\/curb-keeper-[^\n]*\|\| /);
  const n = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  assert.equal(n.status, 0, n.stderr);
});

// ---------------------------------------------------------------------------------------------
// Deploy 2: W2 (the per-tick swap scan, the closure store, the backfill).
// ---------------------------------------------------------------------------------------------

test("W2: the per-tick scan cannot abort a commit or a settle", () => {
  const src = SRC();
  const tick = fnBody(src, "async function tick(");
  const scan = tick.indexOf("scanRange(");
  assert.ok(scan > 0, "tick calls scanRange(");
  const tryAt = tick.lastIndexOf("try {", scan);
  assert.ok(tryAt > 0 && tick.slice(tryAt, scan).split("}").length === 1, "scanRange( sits inside a try {");
  assert.ok(tick.indexOf("commitPass(", scan) > scan && tick.indexOf("settlePass(", scan) > scan, "commitPass( and settlePass( after it");
  assert.doesNotMatch(src, /await scanSwaps\(/);
  assert.doesNotMatch(src, /appendSwaps\(/);
  assert.doesNotMatch(src, /readSwapFile\(/);
  // Heads in parallel with the pinned endpoint's head as a floor; a 60-block overlap; a 5-block trail; the budget.
  assert.match(tick, /const rawHeads = await readHeads\(CFG\.rpcs\);/);
  assert.match(tick, /heads\[bi\] = Math\.max\(heads\[bi\], block\.number\)/);
  assert.match(tick, /const scanTo = block\.number - 5;/);
  assert.match(tick, /state\.lastScannedBlock \+ 1 - 60/);
  assert.match(tick, /\{ maxChunks: 10, deadlineMs: 10_000, heads, endpointOrder: "first" \}/);
  assert.match(tick, /if \(scan\.servedTo > state\.lastScannedBlock\) state\.lastScannedBlock = scan\.servedTo;/, "the cursor never moves backwards");
});

test("W2: rows reach the closure files after the per-asset loop and before the commit pass", () => {
  const tick = fnBody(SRC(), "async function tick(");
  const loop = tick.indexOf("for (const a of assets) {\n    const w = a.wrapper;");
  const ing = tick.indexOf("ingest(store, tracked, scan, recentHashes)");
  assert.ok(loop > 0 && ing > loop && tick.indexOf("await commitPass(") > ing);
  // The per-asset loop handles no swaps any more, and freezes the predicted reopen once a plan exists.
  const body = tick.slice(loop, ing);
  assert.doesNotMatch(body, /swapsByPool|swapCount \+=/);
  assert.match(body, /if \(reopenMs !== null && !open\.committed && !open\.plan\) open\.reopenMs = reopenMs;/);
  assert.match(body, /health\.assetsLastEvaluatedMs\[a\.symbol\] = nowMs;/);
  // Only witnessed, unplanned, uncommitted closures are filled.
  assert.match(fnBody(SRC(), "function trackedClosures("), /if \(!c\.witnessedCut \|\| c\.plan \|\| c\.committed\) continue;/);
});

test("W2: closure open and abandon handle the file through the store", () => {
  const src = SRC();
  const tick = fnBody(src, "async function tick(");
  const open = tick.slice(tick.indexOf("const fresh: Closure = {"), tick.indexOf('log("closure-open"'));
  assert.match(open, /cutBlockHash: block\.hash,/);
  assert.match(open, /cutRead: cutReadOf\(poolSnap, a\.pool\),/);
  assert.match(open, /coverage: \{ ranges: \[\], rows: 0 \},/);
  assert.match(open, /store\.remove\(fresh\)/);
  const abandon = tick.slice(tick.indexOf('log("closure-abandoned"'), tick.indexOf("delete state.open[w];", tick.indexOf('log("closure-abandoned"')));
  assert.match(abandon, /store\.remove\(open\)/);
  assert.doesNotMatch(src, /rmSync\(/, "no bare file removal left in main.ts");
  assert.doesNotMatch(src, /swapsPath/);
});

test("W2: BACKFILL_CHUNKS_PER_TICK", () => {
  withEnv({ BACKFILL_CHUNKS_PER_TICK: undefined }, () => {
    const { cfg, errors } = loadConfig();
    assert.equal(cfg.backfillChunksPerTick, 20);
    assert.deepEqual(errors, []);
  });
  withEnv({ BACKFILL_CHUNKS_PER_TICK: "0" }, () => assert.equal(loadConfig().cfg.backfillChunksPerTick, 0));
  withEnv({ BACKFILL_CHUNKS_PER_TICK: "60" }, () => assert.equal(loadConfig().cfg.backfillChunksPerTick, 60));
  for (const bad of ["61", "-1", "1.5", "abc", ""]) {
    withEnv({ BACKFILL_CHUNKS_PER_TICK: bad }, () => {
      let r: ReturnType<typeof loadConfig> | undefined;
      assert.doesNotThrow(() => { r = loadConfig(); });
      assert.ok(r!.errors.some((e) => e.startsWith("BACKFILL_CHUNKS_PER_TICK must be in [0,60]")), `${bad}: ${r!.errors.join("; ")}`);
    });
  }
});

test("W2: no backfill on the first tick; it runs after the flush and saves through saveState", () => {
  const src = SRC();
  const tick = fnBody(src, "async function tick(");
  const call = tick.indexOf("await backfillStep(");
  assert.ok(call > 0);
  const guard = tick.lastIndexOf("if (health.ticks >= 1 && CFG.backfillChunksPerTick > 0) {", call);
  assert.ok(guard > 0 && call < tick.indexOf("\n  }", guard), "the backfill call is inside the block guarded by health.ticks >= 1");
  // The W6 half: after the end-of-tick write, the flush and the rethrow.
  const rethrow = tick.indexOf("if (persistError) throw persistError;");
  assert.ok(rethrow > tick.indexOf("alarms.flush(") && call > rethrow);
  const step = fnBody(src, "async function backfillStep(");
  assert.match(step, /if \(rep\.claimed > 0\) \{\n\s*try \{ saveState\(state\); \}/);
  assert.doesNotMatch(step, /persistReplace\(/);
  assert.match(step, /if \(busy\) return;/);
  assert.match(step, /Math\.min\(12_000, CFG\.tickMs - \(Date\.now\(\) - tickStartMs\) - 3_000\)/);
  assert.match(step, /if \(deadlineMs < 2_000\) return;/);
  assert.match(step, /bf\.level = Math\.min\(8, Math\.max\(1, 2 \* bf\.level\)\);/);
  assert.doesNotMatch(step, /await raise|await alarms/);
});

test("W2: a tick is busy inside a commit window, a settle window, or after a send", () => {
  const cfg = { minClosureS: 1_800, commitLeadS: 600, settleDelayS: 300 };
  const now = 1_794_542_157_000, nowS = now / 1000;
  const shut = (reopenInS: number, over: Record<string, unknown> = {}) =>
    ({ witnessedCut: true, reopenMs: now + reopenInS * 1000, cutAtMs: now - 3_600_000, ...over });
  const busy = (open: unknown[], pending: unknown[] = [], sent = false) =>
    backfillBusy({ open: open as never, pending: pending as never }, now, nowS, sent, cfg);
  assert.equal(busy([]), false);
  assert.equal(busy([shut(720)]), true, "inside COMMIT_LEAD_S + 120");
  assert.equal(busy([shut(721)]), false);
  assert.equal(busy([shut(-60)]), true, "up to a minute past the reopen");
  assert.equal(busy([shut(-61)]), false);
  assert.equal(busy([shut(300, { committed: {} })]), false, "already committed");
  assert.equal(busy([shut(300, { witnessedCut: false })]), false, "never committable");
  assert.equal(busy([shut(300, { cutAtMs: now - 600_000 })]), false, "shorter than MIN_CLOSURE_S");
  assert.equal(busy([shut(300, { reopenMs: null })]), false);
  const row = (settleAfterS: number, over: Record<string, unknown> = {}) => ({ committed: { settleAfterS }, ...over });
  assert.equal(busy([], [row(nowS - 300 + 60)]), true, "from a minute before the settle opens");
  assert.equal(busy([], [row(nowS - 300 - 600)]), true, "to ten minutes after");
  assert.equal(busy([], [row(nowS - 300 + 61)]), false);
  assert.equal(busy([], [row(nowS - 300 - 601)]), false);
  assert.equal(busy([], [row(nowS - 300, { settled: { txHash: "0x" } })]), false);
  assert.equal(busy([], [], true), true, "a transaction was sent this tick");
});
