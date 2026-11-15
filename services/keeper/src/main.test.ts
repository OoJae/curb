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
import { Wallet, Transaction, Interface } from "ethers";
import {
  loadConfig, attributionHealth, clockSkewStep, archiveStep, CLOCK_SKEW_MAX_S, ARCHIVE_BACKLOG_MS, backfillBusy,
  sendCommit, settleRows,
} from "./main.ts";
import { Sender } from "./tx/sender.ts";
import type { RpcFn } from "./tx/sender.ts";
import { scorecardErrors } from "./outcome.ts";

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

// ---------------------------------------------------------------------------------------------
// Deploy 2: W5 (transaction outcomes, settles, reconciliation) wired into main.ts.
// ---------------------------------------------------------------------------------------------

const SCORECARD_ADDR = "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f";
const ROW151_ID = "0xfc88b5dbe6d0ab024e18027980626b2c97165f387c85159bbd111bf5c6122ecf";
const ROW151_SETTLE_AFTER = 1_793_151_000;                  // 28 Oct 2026 01:30:00Z; readyAt 01:35:00Z
const settleIface = new Interface(["function settle(bytes32 id)"]);

/** The keeper's real Sender over a mock chain; `receipt()` and `revert()` decide what the chain says. */
function chainHarness(o: { receipt: () => { status: string; blockNumber: string; gasUsed: string } | null; revert?: () => string | null }) {
  const dir = mkdtempSync(join(tmpdir(), "curb-keeper-w5-"));
  const clock = { t: 1_000_000 };
  const sent: string[] = [];
  const rpc: RpcFn = async (_url, method, params) => {
    switch (method) {
      case "eth_call": { const d = o.revert?.() ?? null; if (d) throw Object.assign(new Error("execution reverted"), { data: d }); return "0x"; }
      case "eth_estimateGas": return "0x" + (118_167).toString(16);
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": return "0x7";
      case "eth_sendRawTransaction": sent.push(Transaction.from(params[0] as string).hash!); return sent.at(-1);
      case "eth_getTransactionReceipt": return o.receipt();
      case "eth_getTransactionByHash": return { hash: params[0] };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const sender = new Sender({
    wallet: new Wallet("0x" + "4c".repeat(32)), rpcs: ["https://a"], chainId: 196, dbPath: join(dir, "outbox.sqlite"),
    rpc, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, errorInterface: scorecardErrors,
  });
  return { sender, sent, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function pendingRow151() {
  return {
    wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", symbol: "wTCENTx", cutAtMs: 0, cutBlock: 74_370_000,
    midAtCutE18: "1", preCutMidE18: "1", witnessedCut: true, reopenMs: ROW151_SETTLE_AFTER * 1000, swapCount: 0,
    committed: { id: ROW151_ID, root: "0x" + "51".repeat(32), settleAfterS: ROW151_SETTLE_AFTER, markE18: "1", bandBps: 1, onChain: true, txHash: "0xc0", atMs: 0 },
  };
}

function settleDeps(sender: unknown, chainNowS: number, over: Record<string, unknown> = {}) {
  const alarms: Array<[number, string, string]> = [];
  const events: string[] = [];
  const health = { settledTotal: 0 } as { settledTotal: number; lastSettle?: Record<string, unknown> };
  let saves = 0;
  const removed: Array<{ wrapper: string; cutBlock: number }> = [];
  const d = {
    mode: "live", scorecard: SCORECARD_ADDR, settleDelayS: 300, sender, health, balanceWei: 10n ** 16n, chainNowS,
    nowMs: chainNowS * 1000, save: () => { saves++; }, raise: (s: 1 | 2, k: string, m: string) => { alarms.push([s, k, m]); },
    log: (e: string) => { events.push(e); }, removeFile: (c: { wrapper: string; cutBlock: number }) => { removed.push(c); }, ...over,
  };
  return { d: d as never, alarms, events, health, removed, saves: () => saves };
}

test("W5: a settle mined with status 0 (row 151, PriceDeviates on chain) is NOT settled; the next tick settles it", async () => {
  let status = "0x0";
  const h = chainHarness({ receipt: () => ({ status, blockNumber: "0x46efbbe", gasUsed: "0x1cd97" }) });
  const row = pendingRow151();
  const state = { lastScannedBlock: 0, lastPrint: {}, open: {}, pending: [row], recent: [], expired: [] } as never as {
    pending: unknown[]; recent: Array<{ id: string; tx: string; block?: number }>; expired: unknown[];
  };
  const t1 = settleDeps(h.sender, 1_793_151_306);            // 01:35:06Z, the minute row 151's settle reverted
  await settleRows(state as never, t1.d);
  assert.equal(h.sent.length, 1, "the settle was sent");
  assert.equal(state.pending.length, 1, "status 0 keeps the row owed");
  assert.equal(state.recent.length, 0);
  assert.equal(t1.health.settledTotal, 0, "never counted as settled");
  assert.deepEqual(t1.events, ["settle-reverted"]);
  assert.deepEqual(t1.alarms.map((a) => a.slice(0, 2)), [[2, `keeper:settle-reverted:${ROW151_ID}`]]);
  assert.equal(t1.saves(), 1, "the attempt counter is saved before the send");
  status = "0x1";
  const t2 = settleDeps(h.sender, 1_793_151_336);            // the next tick
  await settleRows(state as never, t2.d);
  assert.equal(h.sent.length, 2);
  assert.equal(state.pending.length, 0);
  assert.deepEqual(state.recent.map((r) => [r.id, r.tx, r.block]), [[ROW151_ID, h.sent[1], 74_382_270]]);
  assert.equal(t2.health.settledTotal, 1);
  assert.deepEqual(t2.events, ["settled"]);
  h.cleanup();
});

test("W5: a refused settle simulation sends nothing and keeps the row; AlreadySettled settles it without a send", async () => {
  let revert: string | null = scorecardErrors.encodeErrorResult("PriceDeviates", [-237294, -237347]);
  const h = chainHarness({ receipt: () => ({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1" }), revert: () => revert });
  const row = pendingRow151();
  const state = { lastScannedBlock: 0, lastPrint: {}, open: {}, pending: [row], recent: [], expired: [] } as never as { pending: unknown[]; recent: unknown[] };
  const t1 = settleDeps(h.sender, 1_793_151_306);
  await settleRows(state as never, t1.d);
  assert.equal(h.sent.length, 0);
  assert.equal(state.pending.length, 1);
  assert.deepEqual(t1.events, ["settle-retry"]);
  revert = scorecardErrors.encodeErrorResult("AlreadySettled", [ROW151_ID]);
  const t2 = settleDeps(h.sender, 1_793_151_336);
  await settleRows(state as never, t2.d);
  assert.equal(h.sent.length, 0);
  assert.deepEqual([state.pending.length, state.recent.length, t2.health.settledTotal], [0, 1, 0]);
  assert.deepEqual(t2.events, ["settled-by-other"]);
  h.cleanup();
});

test("W5: settles keep to Scorecard's window and need gas, not isKeeper", async () => {
  const h = chainHarness({ receipt: () => ({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1" }) });
  const mk = () => ({ lastScannedBlock: 0, lastPrint: {}, open: {}, pending: [pendingRow151()], recent: [], expired: [] } as never as { pending: unknown[]; expired: Array<{ id: string; reason: string }> });
  const readyAt = ROW151_SETTLE_AFTER + 300, deadline = readyAt + 21_600;
  // One second early: kept, nothing sent.
  let s = mk();
  await settleRows(s as never, settleDeps(h.sender, readyAt - 1).d);
  assert.deepEqual([h.sent.length, s.pending.length], [0, 1]);
  // Underfunded or unknown balance, or shadow mode: kept, nothing sent; an hour after readyAt it pages.
  for (const over of [{ balanceWei: 10n ** 14n - 1n }, { balanceWei: null }, { mode: "shadow" }, { sender: null }]) {
    s = mk();
    const t = settleDeps(over.sender === null ? null : h.sender, readyAt + 3_601, over);
    await settleRows(s as never, t.d);
    assert.deepEqual([h.sent.length, s.pending.length], [0, 1], JSON.stringify(over, (_, v) => (typeof v === "bigint" ? String(v) : v)));
    assert.deepEqual(t.alarms.map((a) => a.slice(0, 2)), [[1, `keeper:settle-late:${ROW151_ID}`]]);
  }
  // Past deadline - 60: expired, sev-1, never sent.
  s = mk();
  const t = settleDeps(h.sender, deadline - 59);
  await settleRows(s as never, t.d);
  assert.deepEqual([h.sent.length, s.pending.length], [0, 0]);
  assert.deepEqual(s.expired.map((e) => [e.id, e.reason]), [[ROW151_ID, "window-closed"]]);
  assert.deepEqual(t.alarms.map((a) => a.slice(0, 2)), [[1, `keeper:settle-expired:${ROW151_ID}`]]);
  // Inside the window with gas: sent (the health object carries no isKeeper at all).
  s = mk();
  await settleRows(s as never, settleDeps(h.sender, deadline - 60).d);
  assert.deepEqual([h.sent.length, s.pending.length], [1, 0]);
  h.cleanup();
});

test("W5: a commit mined with status 0 is not recorded; status 1 is, with its block", async () => {
  let status = "0x0";
  const h = chainHarness({ receipt: () => ({ status, blockNumber: "0x48434c0", gasUsed: "0x5000" }) });
  const closure = (): Record<string, unknown> => ({
    wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", symbol: "wTCENTx", cutAtMs: 0, cutBlock: 75_773_120,
    midAtCutE18: "1", preCutMidE18: "1", witnessedCut: true, reopenMs: 1, swapCount: 0,
    plan: { root: "0x" + "11".repeat(32), id: "0x" + "22".repeat(32), settleAfterS: 1, markE18: "1", bandBps: 1, data: "0x8ed83271" + "ab".repeat(32), attempts: 0 },
  });
  const health = { armed: true, isKeeper: true, committedTotal: 0 } as Record<string, unknown>;
  let saves = 0;
  const d = { sender: h.sender, health: health as never, nowMs: 1, lastChance: false, save: () => { saves++; } };
  const c = closure();
  await sendCommit(c as never, d, { mode: "live", scorecard: SCORECARD_ADDR });
  assert.equal(c.committed, undefined, "a reverted commit records nothing");
  assert.equal((c.plan as { attempts: number }).attempts, 1);
  assert.equal(saves, 1, "the attempt was saved before the send; nothing after (no books changed)");
  assert.equal(health.committedTotal, 0);
  status = "0x1";
  await sendCommit(c as never, d, { mode: "live", scorecard: SCORECARD_ADDR });
  const rec = c.committed as unknown as { onChain: boolean; block: number };
  assert.deepEqual([rec.onChain, rec.block], [true, 75_773_120]);
  assert.equal(health.committedTotal, 1);
  assert.equal(h.sent.length, 2);
  // Committed closures are never sent again.
  await sendCommit(c as never, d, { mode: "live", scorecard: SCORECARD_ADDR });
  assert.equal(h.sent.length, 2);
  h.cleanup();
});

test("W5: the shadow branch requires CFG.mode !== \"live\"; live but unarmed holds the commit and records nothing", async () => {
  const mk = (): Record<string, unknown> => ({
    wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", symbol: "wTCENTx", cutAtMs: 0, cutBlock: 1, midAtCutE18: "1",
    preCutMidE18: "1", witnessedCut: true, reopenMs: 1, swapCount: 0,
    plan: { root: "0x" + "11".repeat(32), id: "0x" + "22".repeat(32), settleAfterS: 1, markE18: "1", bandBps: 1, data: "0x", attempts: 0 },
  });
  const d = (armed: boolean, sender: unknown) => ({ sender: sender as never, health: { armed, isKeeper: armed, committedTotal: 0 } as never, nowMs: 5, lastChance: false, save: () => {} });
  const live = { mode: "live", scorecard: SCORECARD_ADDR };
  for (const [armed, sender] of [[false, {}], [true, null]] as const) {
    const c = mk();
    await sendCommit(c as never, d(armed, sender), live);
    assert.equal(c.committed, undefined, "SFS B1: never a permanent shadow mark in live mode");
    assert.equal((c.plan as { attempts: number }).attempts, 0, "nothing attempted");
  }
  const c = mk();
  await sendCommit(c as never, d(false, null), { mode: "shadow", scorecard: SCORECARD_ADDR });
  assert.deepEqual([(c.committed as { onChain: boolean }).onChain, (c.committed as { atMs: number }).atMs], [false, 5]);
  const body = fnBody(SRC(), "export async function sendCommit(");
  assert.ok(body.indexOf('if (cfg.mode !== "live") {') < body.indexOf('log("shadow-mark"'));
  assert.match(body, /raise\(1, `keeper:commit-held-unarmed:\$\{c\.symbol\}`/);
  assert.equal(SRC().split('log("shadow-mark"').length - 1, 1, "the shadow branch exists only in sendCommit");
});

test("W5: no .broadcastAndWait( in main.ts; every send goes through sendOnce", () => {
  const src = SRC();
  assert.doesNotMatch(src, /\.broadcastAndWait\(/);
  assert.doesNotMatch(src, /\.prepare\(CFG\.scorecard/);
  assert.equal(src.split("sendOnce(").length - 1, 1, "one call, in sendTx");
  assert.match(fnBody(src, "function sendTx("), /sendWatch\.sends\+\+;\n\s*return sendOnce\(sender, to, data, meta\);/);
  // The backfill's busy rule reads the passes' own send count.
  const tick = fnBody(src, "async function tick(");
  assert.match(tick, /const sendsBefore = sendWatch\.sends;\n\s*await commitPass\([^\n]*\n\s*await settlePass\([^\n]*\n\s*const sentThisTick = sendWatch\.sends !== sendsBefore;/);
});

test("W5: the balance is found by balanceCall(health.address).label and chain.results[chain.results.length - 1] is gone", () => {
  const tick = fnBody(SRC(), "async function tick(");
  assert.doesNotMatch(SRC(), /chain\.results\[chain\.results\.length - 1\]/);
  assert.match(tick, /chain\.results\.find\(\(r\) => r\.label === balanceCall\(health\.address\)\.label\)/);
  // An unreadable balance keeps the last one that decoded instead of reading as 0.
  assert.match(tick, /if \(bal !== null\) \{ onchainWatch\.lastBalanceWei = bal;/);
  assert.match(tick, /health\.armed = CFG\.mode === "live" && health\.isKeeper && knownBal !== null && knownBal >= CFG\.lowBalanceWei;/);
  assert.match(tick, /closureCountCall\(CFG\.scorecard\),/);
});

test("W5: the Sender is built with rpc: maxNonceRpc(", () => {
  assert.match(fnBody(SRC(), "async function main()"), /rpc: maxNonceRpc\(async \(url, method, params\) => \{[^]*?\}, CFG\.rpcs\),/);
});

test("W5: sendCommit is the only caller of commitAttempt(", () => {
  const src = SRC();
  assert.equal(src.split("commitAttempt(").length - 1, 1);
  assert.ok(fnBody(src, "export async function sendCommit(").includes("commitAttempt("));
  const cp = fnBody(src, "async function commitPass(");
  assert.match(cp, /await sendCommit\(c, \{ sender, health, nowMs, lastChance, save: \(\) => saveState\(state\) \}\);/);
});

test("W5: settlePass decides with canSettle( and does not read health.isKeeper", () => {
  const src = SRC();
  const pass = fnBody(src, "async function settlePass(") + fnBody(src, "export async function settleRows(");
  assert.match(pass, /canSettle\(d\.mode, d\.sender !== null, d\.balanceWei\)/);
  assert.match(pass, /balanceWei: onchainWatch\.lastBalanceWei, chainNowS/);
  assert.doesNotMatch(pass, /isKeeper|\.armed/);
  // Chain time, not the VPS clock.
  assert.match(fnBody(src, "async function tick("), /await settlePass\(state, sender, health, block\.timestamp, nowMs\);/);
});

test("W5: reconcile runs before commitPass( and settlePass( inside its own try", () => {
  const src = SRC();
  const tick = fnBody(src, "async function tick(");
  const rec = tick.indexOf("await reconcileStep(state, block, nowMs);");
  assert.ok(rec > 0 && rec < tick.indexOf("await commitPass(") && rec < tick.indexOf("await settlePass("));
  const step = fnBody(src, "async function reconcileStep(");
  const tryAt = step.indexOf("try {");
  assert.ok(tryAt > 0 && tryAt < step.indexOf("readChainBook("));
  assert.match(step, /readChainBook\(block, calls, CFG\.rpcs, RECONCILE_DEADLINE_MS\)/);
  assert.match(step, /\} catch \(e\) \{\n\s*onchainWatch\.skipped\+\+;\n\s*log\("reconcile-skipped"/);
  assert.match(step, /revive: closureFromRecent,/);
});

// ---------------------------------------------------------------------------------------------
// Deploy 2: W7 (holiday evidence and the cut check). Source text for the wiring; the per-closure steps main.ts
// exports run on the real venue schedules committed in the archived bundles (fixtures/marks).
// ---------------------------------------------------------------------------------------------

import { closureVenueSchedule, openLedger, foldVenueRead, onCutCheck, abandonAlarms } from "./main.ts";
import type { CutAnchor } from "./main.ts";
import { checkCut, expectedCapAt, holidayKey, venueEvidenceFor } from "./venueTime.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { ExchangeSchedule } from "./regime.ts";
import { buildMarkRound, verifyMarkBundleOffline } from "./markRound.ts";
import type { VenueEvidence } from "./markRound.ts";
import { LeafKind, subjectOf } from "./tree.ts";
import { ROOTS, inputsFromBundle, leafValue, loadBundle } from "./fixtures/markFixtures.test.ts";

/** The venue a keeper holds (main.ts `Venue`), rebuilt from an archived bundle's committed venue leaf. */
function venueFrom(root: string, atMs: number, holidays?: ExchangeSchedule["schedule"]["holidays"]) {
  const b = loadBundle(root);
  const v = leafValue(b, LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${leafValue(b, LeafKind.CLAIM).wrapper.toLowerCase()}`)) as VenueEvidence;
  return {
    mic: v.mic, assetUrl: v.assetUrl, assetBodyHash: v.assetBodyHash, exchangeUrl: v.exchangeUrl, exchangeBodyHash: v.exchangeBodyHash,
    limits: v.limitsPerPeriod,
    sched: { mic: v.mic, timezone: v.schedule.timezone, isOpen: false, currentSession: null, nextChangeAt: null, schedule: { ...v.schedule, holidays: holidays ?? v.schedule.holidays } } as ExchangeSchedule,
    atMs,
  };
}
const HK = (atMs = 0) => venueFrom(ROOTS.recessXIAO, atMs);
const US = (atMs = 0, holidays?: ExchangeSchedule["schedule"]["holidays"]) => venueFrom(ROOTS.us9Nov, atMs, holidays);
const T = (s: string) => Date.parse(s);
const TICK = 30_000;

/** A closure as the per-asset loop opens one (W2 fields, W7 ledger), cut at `cutAtMs`. */
function opened(symbol: string, cutAtMs: number, venue: ReturnType<typeof US>, block = 75_000_000) {
  return {
    wrapper: "0x" + "12".repeat(20), symbol, cutAtMs, cutBlock: block, midAtCutE18: "1000", preCutMidE18: "999" as string | null,
    witnessedCut: true, reopenMs: null as number | null, swapCount: 0,
    cutBlockHash: "0x" + "aa".repeat(32), cutRead: null, coverage: { ranges: [[block - 900, block + 10]] as Array<[number, number]>, rows: 3 },
    holidayLedger: openLedger(venue),
  } as Parameters<typeof onCutCheck>[0];
}
const anchorAt = (nowMs: number, block: number): CutAnchor =>
  ({ nowMs, block: { number: block, hash: "0x" + "bb".repeat(32) }, midE18: 2000n, poolSnap: { block: { number: block, hash: "0x" + "bb".repeat(32), timestamp: Math.floor(nowMs / 1000), rpc: "" }, results: [] }, pool: "0x" + "34".repeat(20) });

/**
 * Drive the loop's W7 step tick by tick (every 30 s, one block per second), exactly as tick() does for a closure
 * without a plan: checkCut on the closure's schedule, then onCutCheck. Stops at the first recut or unanchorable.
 */
function runTicks(c: Parameters<typeof onCutCheck>[0], venue: ReturnType<typeof US>, untilMs: number) {
  const kinds: Array<[string, string]> = [];
  for (let now = c.cutAtMs, blk = c.cutBlock; now <= untilMs; now += TICK, blk += 30) {
    const r = checkCut(c, venue.limits, closureVenueSchedule(venue, c.holidayLedger), now, TICK);
    onCutCheck(c, r, anchorAt(now, blk));
    kinds.push([new Date(now).toISOString(), r.kind]);
    if (r.kind === "recut" || r.kind === "unanchorable") break;
  }
  return kinds;
}

test("W7: the reopen prediction uses the closure's schedule", () => {
  const tick = fnBody(SRC(), "async function tick(");
  const loop = tick.slice(tick.indexOf("for (const a of assets) {\n    const w = a.wrapper;"), tick.indexOf("ingest(store, tracked, scan, recentHashes)"));
  assert.match(loop, /const sched = venue \? closureVenueSchedule\(venue, open\?\.holidayLedger\) : null;/);
  assert.match(loop, /const reopenMs = venue && sched \? nextCapReturnMs\(venue\.limits, sched, nowMs\) : null;/);
  assert.match(fnBody(SRC(), "export function closureVenueSchedule("), /closureSchedule\(venue\.sched\.schedule, ledger\)/);
  // With nothing kept it is the latest read; with a kept entry, the entry is in it.
  const us = US();
  assert.deepEqual(closureVenueSchedule(us, openLedger(us)).schedule, us.sched.schedule);
  const pruned = US(0, us.sched.schedule.holidays.slice(1));
  const s = closureVenueSchedule(pruned, openLedger(us));
  assert.ok(s.schedule.holidays.some((h) => holidayKey(h) === holidayKey(us.sched.schedule.holidays[0])));
});

test("W7: the ledger is folded on every fresh venue read, and frozen by a plan", () => {
  const tick = fnBody(SRC(), "async function tick(");
  assert.match(tick, /venues\.set\(a\.wrapper, v\);\n\s*\/\/[^\n]*\n\s*foldVenueRead\(state\.open, a\.wrapper, v\);/);
  assert.match(tick, /if \(open && venue && !open\.plan && !open\.committed && !open\.holidayLedger\) open\.holidayLedger = openLedger\(venue\);/, "W7.3: an old-build closure gets a ledger");
  assert.match(tick, /holidayLedger: openLedger\(venue\),/, "a new closure starts one");
  const us = US(1);
  const open: Record<string, { plan?: unknown; committed?: unknown; holidayLedger?: ReturnType<typeof openLedger> }> = {
    a: {}, b: { plan: {} }, c: { committed: {} },
  };
  for (const k of ["a", "b", "c", "missing"]) foldVenueRead(open, k, us);
  assert.equal(open.a.holidayLedger!.entries.length, us.sched.schedule.holidays.length);
  assert.equal(open.b.holidayLedger, undefined, "a planned closure's schedule is frozen");
  assert.equal(open.c.holidayLedger, undefined);
  // An issuer body with junk in its holiday list never throws here.
  const junk = { ...us, sched: { ...us.sched, schedule: { ...us.sched.schedule, holidays: [null, { startsAt: 1 }, "x"] as never } } };
  assert.doesNotThrow(() => foldVenueRead(open, "a", junk));
  assert.equal(openLedger(undefined), undefined);
});

test("W7: the cut is checked on open and every tick, and a recut removes the old file first", () => {
  const tick = fnBody(SRC(), "async function tick(");
  const loop = tick.slice(tick.indexOf("for (const a of assets) {\n    const w = a.wrapper;"), tick.indexOf("ingest(store, tracked, scan, recentHashes)"));
  assert.equal(loop.split("checkCut(").length - 1, 2, "checkCut( on the opening tick and on every later tick");
  const openAt = loop.indexOf("checkCut(fresh,");
  assert.ok(openAt > loop.indexOf("const fresh: Closure = {") && openAt < loop.indexOf("state.open[w] = fresh;"), "checked before the closure is stored");
  const later = loop.indexOf("checkCut(open,");
  assert.ok(later > 0 && loop.lastIndexOf("if (venue && sched && !open.plan && !open.committed) {", later) > openAt, "every tick until a plan exists");
  assert.ok(later < loop.indexOf("open.reopenMs = reopenMs;"), "before the prediction is stored");
  const step = fnBody(SRC(), "export function onCutCheck(");
  const recut = step.slice(step.indexOf('case "recut"'), step.indexOf('case "unanchorable"'));
  assert.ok(recut.indexOf("store.remove(c)") >= 0 && recut.indexOf("store.remove(c)") < recut.indexOf("applyRecut("), "the old file (old cutBlock) goes first");
  assert.match(recut, /cutRead: cutReadOf\(at\.poolSnap, at\.pool\)/);
  assert.doesNotMatch(step, /await /);
});

test("W7: a suspect closure is never planned", () => {
  const cp = fnBody(SRC(), "async function commitPass(");
  const gate = cp.indexOf("if (!c.plan && c.cutSuspect !== false) continue;");
  assert.ok(gate > 0 && gate < cp.indexOf("buildPlan("), "the gate precedes buildPlan(");
  assert.ok(gate > cp.indexOf("if (c.reopenMs === null || !venue) {") && gate < cp.indexOf("CFG.minClosureS * 1000"), "after the venue gate, before minClosureS");
  assert.match(fnBody(SRC(), "function backfillEligible("), /\.filter\(\(t\) => t\.c\.cutSuspect === false\)/, "nor backfilled");
  assert.match(fnBody(SRC(), "function closuresHealth("), /cutSuspect: c\.cutSuspect \?\? null,/, "and /healthz says why");
});

test("W7: closure-missed only for confirmed, witnessed, long closures; a blip the schedule never confirmed is a phantom", () => {
  const tick = fnBody(SRC(), "async function tick(");
  const abandon = tick.slice(tick.indexOf('log("closure-abandoned"'), tick.indexOf("delete state.open[w];", tick.indexOf('log("closure-abandoned"')));
  assert.match(abandon, /cutSuspect: open\.cutSuspect \?\? null, lastedS:/);
  assert.match(abandon, /abandonAlarms\(open, nowMs, CFG\.minClosureS\);/);
  const body = fnBody(SRC(), "export function abandonAlarms(");
  for (const s of ["keeper:closure-missed", "keeper:phantom-closure", "witnessedCut", "minClosureS"]) assert.ok(body.includes(s), s);
  const now = T("2026-11-16T01:30:30Z");
  const c = (over: Record<string, unknown>) => ({ symbol: "wX", cutBlock: 1, cutAtMs: now - 3_600_000, cutSuspect: false, witnessedCut: true, ...over }) as Parameters<typeof abandonAlarms>[0];
  assert.equal(abandonAlarms(c({}), now, 1_800), "missed");
  assert.equal(abandonAlarms(c({ cutAtMs: now - 600_000 }), now, 1_800), null, "short: a closure-too-short row was never due");
  assert.equal(abandonAlarms(c({ witnessedCut: false }), now, 1_800), null, "unwitnessed: no row was possible");
  for (const s of [true, "unanchorable", undefined]) assert.equal(abandonAlarms(c({ cutSuspect: s }), now, 1_800), "phantom", String(s));
});

test("W7: a scheduled cut is confirmed on its opening tick", () => {
  const hk = HK();
  const c = opened("wXIAOx", T("2026-11-13T07:56:04Z"), hk);
  assert.deepEqual(runTicks(c, hk, c.cutAtMs), [["2026-11-13T07:56:04.000Z", "ok"]]);
  assert.equal(c.cutSuspect, false);
  assert.equal(c.cutBlock, 75_000_000, "nothing re-anchored");
});

test("W7: an HK blip merging into the 11:55 lunch cut is re-anchored at the schedule's cut, and its row re-derives", () => {
  const hk = HK();
  const c = opened("wXIAOx", T("2026-11-13T03:52:00Z"), hk);
  const run = runTicks(c, hk, T("2026-11-13T04:10:00Z"));
  assert.deepEqual(run.at(-1), ["2026-11-13T03:55:00.000Z", "recut"]);
  assert.ok(run.slice(0, -1).every(([, k]) => k === "suspect"));
  assert.equal(c.cutAtMs, T("2026-11-13T03:55:00Z"));
  assert.equal(c.cutBlock, 75_000_000 + 180);
  assert.equal(c.cutBlockHash, "0x" + "bb".repeat(32));
  assert.equal(c.midAtCutE18, "2000");
  assert.equal(c.preCutMidE18, null);
  assert.deepEqual(c.coverage, { ranges: [], rows: 0 });
  assert.equal(c.cutSuspect, false);
  assert.deepEqual(c.recut, { fromCutAtMs: T("2026-11-13T03:52:00Z"), fromCutBlock: 75_000_000 });
  assert.equal(c.witnessedCut, true);
  // At the commit instant the closure's schedule gives 05:00Z from now and from the new cut, and says shut at the cut.
  const now = T("2026-11-13T04:50:00Z");
  const settleAfterS = Math.floor(nextCapReturnMs(hk.limits, closureVenueSchedule(hk, c.holidayLedger), now)! / 1000);
  assert.equal(settleAfterS * 1000, T("2026-11-13T05:00:00Z"));
  const ev = venueEvidenceFor(c, hk, now, settleAfterS);
  assert.equal(ev.kind, "ok");
  if (ev.kind === "ok") assert.equal(expectedCapAt(ev.evidence.limitsPerPeriod, { mic: ev.evidence.mic, schedule: ev.evidence.schedule } as ExchangeSchedule, ev.evidence.cutAtMs), 0, "S18 holds on the re-anchored cut");
});

test("W7: an HK phantom persisting into the recess is re-anchored at 03:55Z", () => {
  const hk = HK();
  const c = opened("wXIAOx", T("2026-11-13T02:00:00Z"), hk);
  const run = runTicks(c, hk, T("2026-11-13T04:10:00Z"));
  assert.deepEqual(run.at(-1), ["2026-11-13T03:55:00.000Z", "recut"]);
  assert.ok(run.slice(0, -1).every(([, k]) => k === "suspect"));
  assert.equal(c.cutAtMs, T("2026-11-13T03:55:00Z"));
  assert.equal(c.recut!.fromCutAtMs, T("2026-11-13T02:00:00Z"));
});

test("W7: a US phantom persisting to the close is re-anchored at the first tick from 20:55Z, then too short to mark", () => {
  const us = US();
  const c = opened("wNVDAx", T("2026-11-13T15:30:44Z"), us);
  const run = runTicks(c, us, T("2026-11-13T21:30:00Z"));
  assert.deepEqual(run.at(-1), ["2026-11-13T20:55:14.000Z", "recut"]);
  assert.ok(run.slice(0, -1).every(([, k]) => k === "suspect"));
  const reopen = nextCapReturnMs(us.limits, closureVenueSchedule(us, c.holidayLedger), c.cutAtMs)!;
  assert.equal(reopen, T("2026-11-13T21:00:00Z"));
  assert.ok(reopen - c.cutAtMs < 1_800_000, "commitPass drops it as closure-too-short, the right answer");
});

test("W7: a suspect closure inherited after its schedule shut is unanchorable, once", () => {
  const us = US();
  const c = opened("wNVDAx", T("2026-11-13T15:30:44Z"), us);
  const at = T("2026-11-13T20:56:00Z");
  onCutCheck(c, checkCut(c, us.limits, closureVenueSchedule(us, c.holidayLedger), at, TICK), anchorAt(at, 75_100_000));
  assert.equal(c.cutSuspect, "unanchorable");
  assert.equal(c.cutBlock, 75_000_000, "never re-anchored");
  onCutCheck(c, checkCut(c, us.limits, closureVenueSchedule(us, c.holidayLedger), at + TICK, TICK), anchorAt(at + TICK, 75_100_030));
  assert.equal(c.cutSuspect, "unanchorable");
});

test("W7: Thanksgiving-shaped: a holiday listed at the cut and pruned before the commit still gives the settleAfter a verifier re-derives", () => {
  const listed = US(T("2026-11-26T00:50:00Z"));
  const entry = listed.sched.schedule.holidays.find((h) => h.startsAt === "2026-11-26T01:00:00.000Z")!;
  assert.ok(entry, "the fixture lists Thanksgiving");
  const prunedList = listed.sched.schedule.holidays.filter((h) => holidayKey(h) !== holidayKey(entry));
  // Cut at 00:55:30Z: the opening tick starts the ledger from the list as read, and the cut is a scheduled one.
  const cut = T("2026-11-26T00:55:30Z");
  const c = opened("wNVDAx", cut, listed);
  onCutCheck(c, checkCut(c, listed.limits, closureVenueSchedule(listed, c.holidayLedger), cut, TICK), anchorAt(cut, 75_000_000));
  assert.equal(c.cutSuspect, false);
  // 12:00Z: the issuer has pruned the entry (it started 11 h ago); a fresh read is folded in step 6, and kept.
  const state = { open: { [c.wrapper]: c } };
  foldVenueRead(state.open, c.wrapper, US(T("2026-11-26T12:00:00Z"), prunedList));
  assert.ok(c.holidayLedger!.entries.some((e) => holidayKey(e) === holidayKey(entry)));
  // The commit tick, 27 Nov 00:50Z, with the latest (pruned) read: the loop's prediction, and the evidence buildPlan commits.
  const latest = US(T("2026-11-27T00:40:00Z"), prunedList);
  const now = T("2026-11-27T00:50:00Z");
  const reopenMs = nextCapReturnMs(latest.limits, closureVenueSchedule(latest, c.holidayLedger), now)!;
  assert.equal(reopenMs, T("2026-11-27T01:00:00Z"));
  const settleAfterS = Math.floor(reopenMs / 1000);
  const ev = venueEvidenceFor(c, latest, now, settleAfterS);
  assert.equal(ev.kind, "ok", JSON.stringify(ev));
  if (ev.kind !== "ok") return;
  assert.deepEqual(ev.evidence.holidaysKept!.map(holidayKey), [holidayKey(entry)]);
  // What every verifier re-derives from the committed bytes: walked from the cut, the committed schedule gives settleAfter.
  assert.equal(nextCapReturnMs(ev.evidence.limitsPerPeriod, { mic: ev.evidence.mic, schedule: ev.evidence.schedule } as ExchangeSchedule, ev.evidence.cutAtMs), settleAfterS * 1000);
  // ...where the latest list alone (HEAD) would have walked to 26 Nov 01:00Z and the row would not reproduce.
  assert.equal(nextCapReturnMs(latest.limits, latest.sched, cut), T("2026-11-26T01:00:00Z"));
  // And through the repo verifier: a round built with this evidence reproduces from the cut, with no fallback.
  const i = inputsFromBundle(loadBundle(ROOTS.us9Nov));
  Object.assign(i.closures[0], { cutAtMs: cut, settleAfterS, venue: ev.evidence });
  i.evaluatedAtMs = now;
  const v = verifyMarkBundleOffline(JSON.parse(JSON.stringify(buildMarkRound(i).bundle)));
  assert.deepEqual(v.failures, []);
  assert.ok(!v.notes.some((n) => n.includes("reopen re-derived from the commit instant")), v.notes.join(" | "));
  const strict = verifyMarkBundleOffline(JSON.parse(JSON.stringify(buildMarkRound(i).bundle)), { era: "swap-evidence" });
  assert.ok(!strict.failures.some((f) => /reopen|venue|cut time|predicted reopen|holidaysKept|open at the cut/.test(f)), strict.failures.join(" | "));
});

// ---------------------------------------------------------------------------------------------
// Deploy 2: W4b (the commitPass loop and buildPlan).
// ---------------------------------------------------------------------------------------------
import { mock } from "node:test";
import { mkdirSync, readdirSync } from "node:fs";
import { commitTiming, closureId } from "./main.ts";
import { RECESS, RECESS_ROOT_OF, recessRows, slot0Of } from "./fixtures/markFixtures.test.ts";
import type { RecessSymbol } from "./fixtures/markFixtures.test.ts";

test("W4b: venue checks run before any network call in buildPlan", () => {
  const bp = fnBody(SRC(), "export async function buildPlan(");
  const ve = bp.indexOf("venueEvidenceFor(");
  assert.ok(ve > 0 && ve < bp.indexOf("fillForCommit("));
  assert.doesNotMatch(bp.slice(0, ve), /await /, "nothing is awaited before the venue checks");
  assert.match(bp, /const ve = venueEvidenceFor\(c, venue, nowMs, settleAfterS\);/);
  assert.match(bp, /if \(ve\.kind === "defer"\) \{\n\s*if \(ve\.reopenMs !== null\) c\.reopenMs = ve\.reopenMs;/);
  assert.match(bp, /venue: ve\.evidence,/, "the committed venue evidence is venueEvidenceFor's");
});

test("W4b: strict self-check before evidence is persisted", () => {
  const src = SRC();
  const bp = fnBody(src, "export async function buildPlan(");
  const order = ["fillForCommit(", "assembleSwapEvidence(", "verifyMarkBundleOffline(", "persistOnce(", "publisher.enqueue("].map((n) => [n, bp.indexOf(n)] as const);
  for (const [n, i] of order) assert.ok(i > 0, `${n} in buildPlan`);
  for (let k = 1; k < order.length; k++) assert.ok(order[k - 1][1] < order[k][1], `${order[k - 1][0]} before ${order[k][0]}`);
  assert.match(bp, /verifyMarkBundleOffline\(JSON\.parse\(JSON\.stringify\(round\.bundle\)\), \{ era: "swap-evidence" \}\)/);
  assert.match(bp, /if \(!check\.ok\) \{[^]*?return undefined;/);
  for (const gone of ["swapsInRange(", "fetchClosingWindow(", "blockHashOf(", "readSwapFile("]) assert.equal(src.includes(gone), false, gone);
  // The fill is bounded, and a closure file that cannot be read is treated as uncovered, never as an empty pool.
  assert.match(bp, /maxChunks: 20,\n\s*deadlineMs: Math\.min\(10_000, Math\.max\(2_000, CFG\.tickMs - \(Date\.now\(\) - t\.tickStartMs\) - 5_000\)\)/);
  assert.match(bp, /let ranges: Array<\[number, number\]> = \[\];\n\s*try \{\n\s*const file = store\.read\(c, pinnedBlock\);/);
});

test("W4b: the plan is on disk before the first attempt", () => {
  const src = SRC();
  const cp = fnBody(src, "async function commitPass(");
  const set = cp.indexOf("c.plan = built;");
  const save = cp.indexOf("saveState(state)", set);
  const send = cp.indexOf("sendCommit(", save);
  assert.ok(set > 0 && save > set && send > save);
  assert.equal(cp.split("buildPlan(").length - 1, 1);
  assert.match(cp, /if \(!c\.plan\) \{\n\s*const built = await buildPlan\(/, "buildPlan( only inside if (!c.plan)");
  const sc = fnBody(src, "export async function sendCommit(");
  assert.ok(sc.includes("commitAttempt("));
  assert.ok(!sc.includes("broadcastAndWait("));
});

test("W4b: closures are planned earliest reopen first, each with its own clock and try", () => {
  const cp = fnBody(SRC(), "async function commitPass(");
  const sort = cp.indexOf(".sort(");
  const loop = cp.indexOf("for (const w of order) {");
  assert.ok(sort > 0 && loop > sort, ".sort( precedes the loop");
  const body = cp.slice(loop);
  assert.match(body, /^for \(const w of order\) \{\n\s*const c = state\.open\[w\];\n\s*try \{/, "the loop body is one try");
  assert.ok(body.indexOf("Date.now()") > 0, "a clock per closure");
  assert.match(body, /\} catch \(e\) \{\n\s*log\("plan-error"[^\n]*\n\s*raise\(2, `keeper:plan-error:\$\{c\.symbol\}`/);
  assert.match(cp, /const due = \(c: Closure\) => \(c\.plan \? c\.plan\.settleAfterS \* 1000 : c\.reopenMs \?\? Number\.POSITIVE_INFINITY\);/);
  assert.match(cp, /const toReopenS = Math\.floor\(\(due\(c\) - nowMs\) \/ 1000\);/);
});

test("W4b: alarms are never awaited in commitPass or buildPlan", () => {
  for (const fn of ["async function commitPass(", "export async function buildPlan("]) {
    const body = fnBody(SRC(), fn);
    assert.doesNotMatch(body, /await raise\(|await alarms\./, fn);
  }
});

test("W4b: the must-commit point and the last chance, per closure", () => {
  const cfg = { tickMs: 30_000, commitFloorS: 120 };
  // Default 30 s ticks: stop waiting for data at T-390 s; the last tick that can still send is above T-150 s.
  assert.deepEqual(commitTiming(390, 0, cfg), { nextTickS: 30, mustCommit: false, lastChance: false });
  assert.deepEqual(commitTiming(389, 0, cfg), { nextTickS: 30, mustCommit: true, lastChance: false });
  assert.equal(commitTiming(150, 0, cfg).lastChance, false);
  assert.equal(commitTiming(149, 0, cfg).lastChance, true);
  // A slow previous tick moves both earlier.
  assert.equal(commitTiming(414, 45, cfg).nextTickS, 55);
  assert.equal(commitTiming(414, 45, cfg).mustCommit, true);
  assert.equal(commitTiming(415, 45, cfg).mustCommit, false);
  const cp = fnBody(SRC(), "async function commitPass(");
  assert.match(cp, /const \{ mustCommit, lastChance \} = commitTiming\(toReopenS, t\.lastTickS, CFG\);/);
  assert.match(cp, /await buildPlan\(c, a, venue, assets, poolSnap, read\.priceE18, digest, \{ \.\.\.t, nowMs, mustCommit \}\)/);
  // The main loop hands the tick its own start and the previous tick's duration.
  const main = fnBody(SRC(), "async function main()");
  assert.match(main, /await tick\(state, assets, venues, client, sender, health, digest, \{ tickStartMs: tickStart, lastTickS \}\);/);
  assert.match(main, /lastTickS = \(Date\.now\(\) - tickStart\) \/ 1000;/);
});

test("W4b: the only refusals in buildPlan are the schedule's and D2's; a degraded row pages and is committed", () => {
  const bp = fnBody(SRC(), "export async function buildPlan(");
  assert.equal(bp.split('.kind === "refuse"').length - 1, 2, "venueEvidenceFor's (I10/I11) and assembleSwapEvidence's (D2)");
  assert.match(bp, /raise\(1, `keeper:closing-window-incomplete:\$\{c\.symbol\}`/);
  assert.match(bp, /raise\(ev\.degraded\.includes\("closure-inconsistent"\) \? 1 : 2, `keeper:swap-coverage-incomplete:\$\{c\.symbol\}`/);
  // Block-time drift pages and never stops the plan.
  const drift = bp.slice(bp.indexOf("const driftS"), bp.indexOf("// 5."));
  assert.match(drift, /raise\(1, `keeper:block-time-drift:\$\{c\.symbol\}`/);
  assert.doesNotMatch(drift, /return/);
});

/**
 * End to end, no network: a second instance of main.ts (its own CFG: a temp DATA_DIR, shadow, SIGNAL=off, RPCS at a
 * closed local port) runs the real buildPlan on the 13 Nov 2026 HK recess: the archived round's pinned read, venue,
 * registry and mids, and the real Swap logs of the closing window and the closure written to the closure file.
 */
async function recessHarness() {
  const dir = mkdtempSync(join(tmpdir(), "curb-keeper-w4b-"));
  mkdirSync(join(dir, "marks"), { recursive: true });
  mkdirSync(join(dir, "closures"), { recursive: true });
  const params = leafValue(loadBundle(RECESS_ROOT_OF.wXIAOx), LeafKind.PARAMS, subjectOf("params"));
  const vars: Record<string, string> = {
    DATA_DIR: dir, MODE: "shadow", SIGNAL: "off", RPCS: "http://127.0.0.1:9", SCORECARD: params.scorecard, CLOCK: params.clock,
    CHAIN_ID: String(params.chainId), HC_URL: "", HC_ALARM_URL: "",
  };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  let m: typeof import("./main.ts");
  try { m = await import(new URL("./main.ts?w4b-e2e", import.meta.url).href); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

  const setup = (sym: RecessSymbol, o: { rows?: (r: ReturnType<typeof recessRows>) => ReturnType<typeof recessRows>; ranges?: Array<[number, number]>; cutRead?: boolean } = {}) => {
    const b = loadBundle(RECESS_ROOT_OF[sym]);
    const p = leafValue(b, LeafKind.PARAMS, subjectOf("params"));
    const chain = leafValue(b, LeafKind.CHAIN_CALL);
    const registry = leafValue(b, LeafKind.REGISTRY, subjectOf("registry"));
    const claim = leafValue(b, LeafKind.CLAIM);
    const w = String(claim.wrapper).toLowerCase();
    const mi = leafValue(b, LeafKind.CA_SNAPSHOT, subjectOf(`markinput:${w}`));
    const swaps = leafValue(b, LeafKind.FETCH_LOG, subjectOf(`swaps:${w}`));
    const v = leafValue(b, LeafKind.HTTP_EXCHANGE, subjectOf(`venue:${w}`)) as VenueEvidence;
    const assets = registry.pools.map((x: Record<string, unknown>) => ({ ...x, raw: "0x0000000000000000000000000000000000000000", rawSymbol: String(x.symbol).replace(/^w/, "") }));
    const a = assets.find((x: { symbol: string }) => x.symbol === sym);
    const venue = {
      mic: v.mic, assetUrl: v.assetUrl, assetBodyHash: v.assetBodyHash, exchangeUrl: v.exchangeUrl, exchangeBodyHash: v.exchangeBodyHash,
      limits: v.limitsPerPeriod, atMs: p.evaluatedAtMs - 60_000,
      sched: { mic: v.mic, timezone: v.schedule.timezone, isOpen: false, currentSession: null, nextChangeAt: null, schedule: v.schedule } as unknown as ExchangeSchedule,
    };
    const rows = (o.rows ?? ((r) => r))(recessRows(sym));
    writeFileSync(join(dir, "closures", `${w}-${swaps.cutBlock}.jsonl`),
      rows.map((r) => JSON.stringify({ b: r.blockNumber, i: r.logIndex, q: r.equityAbs.toString(), p: r.priceE18.toString() }) + "\n").join(""));
    const hash = "0x" + "ab".repeat(32);
    const cutRead = o.cutRead ? { blockNumber: swaps.cutBlock, blockHash: hash, blockTimestamp: Math.floor(swaps.cutAtMs / 1000), slot0: slot0Of(b, sym) } : null;
    const c = {
      wrapper: claim.wrapper, symbol: sym, cutAtMs: swaps.cutAtMs, cutBlock: swaps.cutBlock,
      midAtCutE18: mi.midAtCutE18, preCutMidE18: mi.lastPrintE18, witnessedCut: true, reopenMs: swaps.settleAfterS * 1000, swapCount: 0,
      cutBlockHash: cutRead ? hash : null, cutRead, cutSuspect: false,
      coverage: { ranges: o.ranges ?? [[RECESS.closingFrom, RECESS.pinnedBlock]], rows: rows.length },
      refusals: undefined as number | undefined,
    };
    const poolSnap = { block: { ...chain.block, rpc: "http://127.0.0.1:9" }, results: chain.calls };
    const t = (mustCommit: boolean) => ({ heads: [chain.block.number], chainNowS: chain.block.timestamp, lastTickS: 0, tickStartMs: Date.now(), nowMs: p.evaluatedAtMs, mustCommit });
    const plan = (mustCommit = false) => m.buildPlan(c as never, a, venue as never, assets, poolSnap as never, BigInt(mi.midNowE18), String(p.codeDigest), t(mustCommit));
    return { c, plan, settleAfterS: swaps.settleAfterS as number };
  };
  const bundleOf = (root: string) => JSON.parse(readFileSync(join(dir, "marks", `${root}.json`), "utf8"));
  const marks = () => readdirSync(join(dir, "marks")).length;
  return { setup, bundleOf, marks, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W4b: end to end, buildPlan on the real 13 Nov recess builds a plan whose bundle reproduces strictly (N below its read block)", async () => {
  const events: Array<Record<string, unknown>> = [];
  const quiet = mock.method(console, "log", (line: string) => { try { events.push(JSON.parse(line)); } catch { /* not ours */ } });
  const h = await recessHarness();
  const N = RECESS.pinnedBlock - 1;
  try {
    // wXIAOx: 9 closing swaps, 14 closure swaps, full coverage, no cut read (a closure opened by the old build).
    const x = h.setup("wXIAOx");
    const plan = await x.plan();
    assert.ok(plan, JSON.stringify(events.filter((e) => /refused|deferred|self-check/.test(String(e.event)))));
    assert.equal(plan.settleAfterS, x.settleAfterS);
    assert.equal(plan.markE18, "3701436175140696810");
    assert.equal(plan.bandBps, 37);
    assert.equal(plan.id, closureId(x.c.wrapper, x.settleAfterS, plan.root));
    const v = verifyMarkBundleOffline(h.bundleOf(plan.root), { swapEvidenceFromBlock: N });
    assert.equal(v.era, "swap-evidence", "N is below the read block: the strict era");
    assert.deepEqual(v.failures, []);
    assert.equal(v.ok, true);
    assert.equal(v.evidenceComplete, true);
    assert.deepEqual(v.notes, ["the cut mid is not bound to a committed pool read (closure opened before this keeper build)"]);
    const built = events.find((e) => e.event === "mark-built")!;
    assert.deepEqual([built.closingSwaps, built.swaps, built.complete, built.closingComplete, built.degraded], [9, 14, true, true, []]);
    // The same bytes under N above the read block are a pre-fix row, still ok.
    assert.equal(verifyMarkBundleOffline(h.bundleOf(plan.root), { swapEvidenceFromBlock: RECESS.pinnedBlock + 1 }).era, "pre-swap-fix");

    // wMEITx: nothing traded; its cut read is committed and binds midAtCut (S8): no note at all.
    const y = h.setup("wMEITx", { cutRead: true });
    const py = await y.plan();
    assert.ok(py);
    const vy = verifyMarkBundleOffline(h.bundleOf(py.root), { swapEvidenceFromBlock: N });
    assert.deepEqual([vy.ok, vy.failures, vy.notes, vy.evidenceComplete], [true, [], [], true]);

    // A tail gap before the must-commit point: the fill asks the (closed) RPC, cannot serve it, and the plan defers.
    const before = h.marks();
    const g = h.setup("wXIAOx", { ranges: [[RECESS.closingFrom, RECESS.pinnedBlock - 5]] });
    assert.equal(await g.plan(false), undefined);
    assert.equal(h.marks(), before, "nothing persisted");
    assert.ok(events.some((e) => e.event === "plan-deferred" && String(e.reason).includes("gaps remain")));
    // At the must-commit point the same gap is committed honestly: complete false, the gap named, sev-2 page.
    const pg = await g.plan(true);
    assert.ok(pg);
    const vg = verifyMarkBundleOffline(h.bundleOf(pg.root), { swapEvidenceFromBlock: N });
    assert.deepEqual([vg.ok, vg.failures, vg.evidenceComplete], [true, [], false]);
    assert.equal(pg.markE18, plan.markE18, "the mark does not depend on the gap");
    assert.ok(events.some((e) => e.event === "alarm" && e.key === "keeper:swap-coverage-incomplete:wXIAOx" && e.sev === 2));

    // D2: no closure swap recorded while the price moved, at the must-commit point: refused, nothing persisted.
    const d2 = h.setup("wXIAOx", { rows: (r) => r.filter((s) => s.blockNumber <= RECESS.cutBlock) });
    const n = h.marks();
    assert.equal(await d2.plan(true), undefined);
    assert.equal(h.marks(), n);
    assert.equal(d2.c.refusals, 1);
    assert.ok(events.some((e) => e.event === "mark-refused" && e.key === "keeper:swap-evidence-inconsistent:wXIAOx"));
  } finally {
    quiet.mock.restore();
    h.done();
  }
});

// ---------------------------------------------------------------------------------------------
// Deploy 2: W3 (retention, disk, memory) wired into main.ts.
// ---------------------------------------------------------------------------------------------

test("W3: boot reports orphans and deletes nothing", () => {
  const main = fnBody(SRC(), "async function main()");
  const load = main.indexOf("const state = loadState();");
  const firstTick = main.indexOf("tick(", load);
  assert.ok(load > 0 && firstTick > load);
  const boot = main.slice(load, firstTick);
  assert.match(boot, /const orphans = orphanReport\(CFG\.dataDir, state\);/);
  assert.match(boot, /log\("closure-file-orphans", \{ files: orphans\.files, bytes: orphans\.bytes \}\)/);
  assert.doesNotMatch(boot, /rmSync\(|unlinkSync\(|store\.remove\(|removeSwapFile\(/);
  // orphanReport is orphanClosureFiles plus sizes (retention.ts).
  const retention = readFileSync(fileURLToPath(new URL("./retention.ts", import.meta.url)), "utf8");
  assert.match(fnBody(retention, "export function orphanReport("), /const files = orphanClosureFiles\(dataDir, state\);/);
});

test("W3: settled and expired rows delete their swap file", async () => {
  const src = SRC();
  assert.match(fnBody(src, "function settleRow("), /recordSettled\(state, c, how\);\n\s*removeSwapFile\(c, remove\);/);
  assert.match(fnBody(src, "function expireRow("), /recordExpired\(state, c, reason, atMs\);\n\s*removeSwapFile\(c, remove\);/);
  const rm = fnBody(src, "function removeSwapFile(");
  assert.match(rm, /remove: RemoveFile = \(x\) => store\.remove\(x\)/);
  assert.match(rm, /if \(!c\.wrapper \|\| !c\.cutBlock\) return;\n\s*try \{ remove\(/);

  const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
  let status = "0x1";
  let revert: string | null = null;
  const run = async (row: Record<string, unknown>, chainNowS: number, over: Record<string, unknown> = {}) => {
    // A fresh outbox per case: each case's first attempt reuses the id settle:<root>:1.
    const h = chainHarness({ receipt: () => ({ status, blockNumber: "0x46efbbe", gasUsed: "0x1cd97" }), revert: () => revert });
    const state = { lastScannedBlock: 0, lastPrint: {}, open: {}, pending: [row], recent: [], expired: [] } as never as { pending: unknown[] };
    const t = settleDeps(h.sender, chainNowS, over);
    try { await settleRows(state as never, t.d); } finally { h.cleanup(); }
    return { state, t };
  };
  const readyAt = ROW151_SETTLE_AFTER + 300;
  // Settled by our transaction: the file goes.
  let r = await run(pendingRow151(), readyAt);
  assert.deepEqual([r.state.pending.length, r.t.removed], [0, [{ wrapper: W, cutBlock: 74_370_000 }]]);
  // A status-0 settle keeps the row, and its file.
  status = "0x0";
  r = await run(pendingRow151(), readyAt);
  assert.deepEqual([r.state.pending.length, r.t.removed.length], [1, 0]);
  // Settled by someone else (AlreadySettled): the file goes.
  revert = scorecardErrors.encodeErrorResult("AlreadySettled", [ROW151_ID]);
  r = await run(pendingRow151(), readyAt);
  assert.deepEqual([r.state.pending.length, r.t.removed.length], [0, 1]);
  revert = null;
  // Expired at the window's end: the file goes.
  r = await run(pendingRow151(), readyAt + 21_600 - 59);
  assert.deepEqual([r.state.pending.length, r.t.removed.length], [0, 1]);
  // A row revived from `recent` without a file name: nothing to delete, never a throw.
  status = "0x1";
  r = await run({ ...pendingRow151(), wrapper: "", cutBlock: 0 }, readyAt);
  assert.deepEqual([r.state.pending.length, r.t.removed.length], [0, 0]);
  // A delete that throws (EIO) never undoes the settle.
  r = await run(pendingRow151(), readyAt, { removeFile: () => { throw new Error("EIO: i/o error, unlink"); } });
  assert.equal(r.state.pending.length, 0);
  assert.equal(r.t.health.settledTotal, 1);
});

test("W3: disk and memory reach /healthz every tick, and a filling disk pages", () => {
  const src = SRC();
  const tick = fnBody(src, "async function tick(");
  const save = tick.indexOf("try { saveState(state); }");
  const disk = tick.indexOf("observeDisk(state, health);");
  assert.ok(save > 0 && disk > save && disk < tick.indexOf("alarms.flush("), "after the end-of-tick write, before the flush");
  const od = fnBody(src, "function observeDisk(");
  assert.match(od, /const du = diskMonitor\.read\(\);/);
  assert.match(od, /health\.disk = \{ \.\.\.du, orphans: diskWatch\.orphans \};/);
  assert.match(od, /health\.mem = memUsage\(\);/);
  assert.match(od, /const alarm = diskAlarm\(du\.freeMb\);\n\s*if \(alarm\) raise\(\.\.\.alarm\);/);
  assert.match(od, /^function observeDisk[^]*try \{[^]*\} catch \(e\) \{ log\("disk-check-error"/);
  assert.match(src, /const diskMonitor = createDiskMonitor\(CFG\.dataDir\);/);
});
