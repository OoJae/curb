import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { inDenseWindow, validScheduleBody, validAssetBody, loadConfig, attributionHealth } from "./main.ts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { verifyBundleOffline } from "./verify/offline.ts";
import { Sender, normalizeDataSuffix, builderCodes, ERC8021_MARKER } from "./tx/sender.ts";
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

// Attribution (ERC-8021, 24 Sep 2026): DATA_SUFFIX carries the X Layer Builder Code. Off unless set; a bad
// value must stop the host at boot like a bad MODE does, never reach the Sender or throw at import.

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

test("boot logs whether attribution is on before anything else, and a bad DATA_SUFFIX is fatal before that", async () => {
  // DATA_DIR is a FILE, so main() dies at its first mkdir (as root too) right after the attribution line:
  // no data directory, no key, no network.
  const dir = mkdtempSync(join(tmpdir(), "curb-attr-boot-"));
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "");
  const env = { ...process.env, MODE: "shadow", DATA_DIR: file, RPCS: "http://127.0.0.1:9", ATTESTOR_KEY_PASSWORD: "" };
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

// /healthz (review, 24 Sep 2026). It used to report `on` from DATA_SUFFIX alone, so a keyless shadow host --
// no key, no Sender, nothing ever signed -- said every transaction was attributed. It now reports what the
// live Sender appends, and decodes the code so the page shows "dd7u50nckt5e729f", not 34 bytes of hex.

test("/healthz attribution is what the live Sender appends: off without a key, whatever DATA_SUFFIX says", () => {
  const off = { on: false, dataSuffix: null, codes: [] };
  // Keyless shadow: main() builds `key && new Sender(...)`, which is null, so there is nothing to attribute.
  assert.deepEqual(attributionHealth(null), off);
  const dir = mkdtempSync(join(tmpdir(), "curb-attr-health-"));
  try {
    const senderWith = (dataSuffix: string | undefined, n: number) => new Sender({
      wallet: new Wallet("0x" + "4c".repeat(32)), rpcs: ["https://a"], chainId: 196,
      dbPath: join(dir, `outbox-${n}.sqlite`), rpc: async () => null, dataSuffix,
    });
    assert.deepEqual(attributionHealth(senderWith(BUILDER_SUFFIX, 1)), { on: true, dataSuffix: BUILDER_SUFFIX, codes: ["dd7u50nckt5e729f"] });
    assert.deepEqual(attributionHealth(senderWith(BUILDER_SUFFIX.toUpperCase().replace(/^0X/, "0x"), 2)).dataSuffix, BUILDER_SUFFIX);
    assert.deepEqual(attributionHealth(senderWith("", 3)), off);
    assert.deepEqual(attributionHealth(senderWith(undefined, 4)), off);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The wiring, which a unit test of the helper cannot see: health is built from the Sender, not the config.
  const src = readFileSync(MAIN, "utf8");
  assert.match(src, /attribution: attributionHealth\(sender\)/);
  assert.doesNotMatch(src, /on: CFG\.dataSuffix !== ""/);
});

// Deploy configs (review, 24 Sep 2026). A DATA_SUFFIX goes live through `railway config apply` (host A) and
// script/hostb/deploy.sh (host B and the keeper), and railway checks nothing on the way. A malformed value
// takes a host down at boot -- host A with no old deployment to fall back on, because its volume forbids two
// deployments at once -- and a well-formed WRONG code boots cleanly and credits every transaction to
// someone else. So every literal committed to either file is decoded here, and must be Curb's own code.
// Off ("") is allowed: it is loud (the boot log and /healthz both say so), not silent.

const CURB_BUILDER_CODE = "dd7u50nckt5e729f";
const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("every DATA_SUFFIX committed to a deploy config is well-formed and carries Curb's own Builder Code", () => {
  const pinned = (value: string, where: string) => {
    assert.equal(normalizeDataSuffix(value), value, `${where}: committed exactly as sent (valid, lower-case)`);
    if (value !== "") assert.deepEqual(builderCodes(value), [CURB_BUILDER_CODE], where);
  };
  // Host A. Every DATA_SUFFIX key is a plain literal: a computed or preserve()d value would dodge this test.
  const railway = repoFile(".railway/railway.ts");
  const keys = railway.match(/^\s*DATA_SUFFIX\s*:.*$/gm) ?? [];
  assert.equal(keys.length, 1, "host A sets DATA_SUFFIX once");
  for (const line of keys) {
    const m = line.match(/^\s*DATA_SUFFIX\s*:\s*"(0x[0-9a-f]*|)",?\s*$/);
    assert.ok(m, `.railway/railway.ts: not a plain lower-case hex literal: ${line.trim()}`);
    pinned(m[1], ".railway/railway.ts");
  }
  // Host B and the keeper: one literal, checked against BUILDER_CODE, and both env files take that one value.
  const deploy = repoFile("script/hostb/deploy.sh");
  assert.match(deploy, new RegExp(`^BUILDER_CODE=${CURB_BUILDER_CODE}$`, "m"));
  const assignments = deploy.match(/^DATA_SUFFIX=.*$/gm) ?? [];
  const literals = assignments.filter((a) => !a.startsWith('DATA_SUFFIX="$(node ') && a !== "DATA_SUFFIX=${DATA_SUFFIX}");
  assert.equal(literals.length, 1, `exactly one literal: ${literals.join(" | ")}`);
  const m = literals[0].match(/^DATA_SUFFIX=(0x[0-9a-f]*|)$/);
  assert.ok(m, `script/hostb/deploy.sh: not a plain lower-case hex literal: ${literals[0]}`);
  pinned(m[1], "script/hostb/deploy.sh");
  assert.equal(assignments.filter((a) => a === "DATA_SUFFIX=${DATA_SUFFIX}").length, 2, "attestor-b.env and keeper.env");
  // And the two deploy paths agree, so host A and host B credit the same code.
  assert.equal(keys[0].match(/"(.*)"/)![1], m[1]);
});

test("deploy.sh's pre-flight check stops a malformed or foreign DATA_SUFFIX before anything reaches the box", () => {
  // Run the script's own check, extracted verbatim, exactly as the script calls it (never the script itself).
  const deploy = repoFile("script/hostb/deploy.sh");
  const found = deploy.match(/node --experimental-strip-types --input-type=module -e '([^']*)' "\$REPO\/services\/attestor\/src\/tx\/sender\.ts" "\$DATA_SUFFIX" "\$BUILDER_CODE"/);
  assert.ok(found, "the check is where the script runs it, with the arguments it expects");
  const senderPath = fileURLToPath(new URL("./tx/sender.ts", import.meta.url));
  const check = (suffix: string) => spawnSync(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", found[1], senderPath, suffix, CURB_BUILDER_CODE],
    { encoding: "utf8", timeout: 20_000 });
  const ok = check(BUILDER_SUFFIX.toUpperCase().replace(/^0X/, "0x"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, BUILDER_SUFFIX + "\n", "prints the normalised value the env files then take");
  assert.match(ok.stderr, /attribution on: Builder Code dd7u50nckt5e729f/);
  const off = check("");
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout, "\n");
  const wrong = "0x" + Buffer.from("dd7u50nckt5e729g", "utf8").toString("hex") + "10" + "00" + ERC8021_MARKER;
  const slipped = BUILDER_SUFFIX.slice(0, 2 + 34) + "01" + BUILDER_SUFFIX.slice(2 + 36);
  for (const [bad, why] of [[wrong, /carries Builder Code dd7u50nckt5e729g, not dd7u50nckt5e729f/], [slipped, /schema 1/], ["0xdeadbeef", /ERC-8021 marker/]] as const) {
    const r = check(bad);
    assert.notEqual(r.status, 0, bad);
    assert.equal(r.stdout, "", "nothing for the env files to take");
    assert.match(r.stderr, why);
  }
});
