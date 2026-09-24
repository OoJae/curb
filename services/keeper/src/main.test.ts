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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { loadConfig, attributionHealth } from "./main.ts";
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
