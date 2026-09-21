import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify, expectKind } from "./classify.ts";
import { EXIT, exitFor, fromOffline, iso, renderCheck } from "./render.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const FIX = (n: string) => fileURLToPath(new URL(`../../../services/attestor/src/fixtures/${n}`, import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { encoding: "utf8" });
const roundBundle = () => JSON.parse(readFileSync(FIX("round-70619137.bundle.json"), "utf8"));

// --- classification -----------------------------------------------------------------------

test("each schema is recognised, and nothing else is", () => {
  assert.equal(classify(roundBundle()).kind, "round");
  for (const bad of [null, undefined, 42, "not a bundle", [], {}, { schema: 7 }]) {
    assert.equal(classify(bad).kind, null, JSON.stringify(bad));
  }
  const unknown = classify({ schema: "curb.something/1" });
  assert.equal(unknown.kind, null);
  assert.match((unknown as { reason: string }).reason, /unsupported schema/);
});

test("a round bundle wearing the mark schema is refused, not coerced", () => {
  // The two schemas use the same leaf kinds to mean different things, so crossing them must fail
  // on the schema string rather than on whatever the other verifier happens to do with the leaves.
  const b = roundBundle();
  b.schema = "curb.scorecard.markbundle/1";
  const c = classify(b);
  assert.equal(c.kind, null, "a round bundle has no `marks`, so it is not a valid mark bundle");
});

test("a verb pinned to one kind names the right verb when refusing", () => {
  const c = classify(roundBundle());
  const r = expectKind(c, "witness");
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /use: curb-verify round/);
});

// --- the exit-code contract ---------------------------------------------------------------

test("exit codes follow reproduction, not label agreement", () => {
  const base = { failures: [], labelFailures: [], warnings: [] };
  assert.equal(exitFor({ ...base, reproduced: true, labelsConsistent: true }), EXIT.VERIFIED);
  assert.equal(exitFor({ ...base, reproduced: true, labelsConsistent: false }), EXIT.VERIFIED,
    "a wrong label is reported but does not make the committed number wrong");
  assert.equal(exitFor({ ...base, reproduced: false, labelsConsistent: true }), EXIT.NOT_REPRODUCED);
});

test("the top-level prefix splits labels from real failures", () => {
  const c = fromOffline({ ok: false, root: "0x1", failures: ["top-level kind=a contradicts b", "claim mismatch for NVDAx"] });
  assert.deepEqual(c.labelFailures, ["top-level kind=a contradicts b"]);
  assert.deepEqual(c.failures, ["claim mismatch for NVDAx"]);
  assert.equal(c.reproduced, false);
  assert.equal(c.labelsConsistent, false);
});

// --- rendering ----------------------------------------------------------------------------

test("timestamps render as UTC regardless of the host timezone", () => {
  // The bug this guards: a verifier that prints a different instant in Lagos than in Singapore.
  assert.equal(iso(1789386400510), "2026-09-14T11:46:40Z", "the first attestation Curb ever wrote");
  assert.equal(iso(0), "1970-01-01T00:00:00Z");
});

test("every failure is printed, never elided", () => {
  const many = Array.from({ length: 12 }, (_, i) => `failure ${i}`);
  const out = renderCheck("x", [], { reproduced: false, labelsConsistent: true, failures: many, labelFailures: [], warnings: [] });
  for (const f of many) assert.ok(out.includes(f), `${f} was dropped`);
  assert.ok(out.includes("NOT REPRODUCED"));
});

// --- the real binary ------------------------------------------------------------------------

test("a real mainnet round verifies through the actual binary", () => {
  const r = run("bundle", FIX("round-70619137.bundle.json"));
  assert.equal(r.status, EXIT.VERIFIED, r.stderr);
  assert.match(r.stdout, /REPRODUCED/);
});

test("a tampered copy of that same round is caught, and exits 1 rather than crashing", () => {
  const b = roundBundle();
  b.json[Object.keys(b.json)[0]] = JSON.stringify({ tampered: true });
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "bundle", "-"], { encoding: "utf8", input: JSON.stringify(b) });
  assert.equal(r.status, EXIT.NOT_REPRODUCED, r.stdout + r.stderr);
  assert.match(r.stdout, /NOT REPRODUCED/);
});

test("an unsupported schema exits 4 and names what it does verify", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "bundle", "-"], { encoding: "utf8", input: '{"schema":"nope/1"}' });
  assert.equal(r.status, EXIT.UNSUPPORTED);
  assert.match(r.stderr, /curb\.marketclock\.bundle\/1/);
});

test("usage errors are exit 2, and plain http is refused outright", () => {
  assert.equal(run("no-such-verb").status, EXIT.USAGE);
  assert.equal(run("bundle", "/does/not/exist").status, EXIT.USAGE);
  const http = run("bundle", "http://example.com/b.json");
  assert.equal(http.status, EXIT.USAGE);
  assert.match(http.stderr, /refusing plain http/);
});

test("--json emits one parseable object carrying the verdict", () => {
  const r = run("bundle", "--json", FIX("round-70619137.bundle.json"));
  assert.equal(r.status, EXIT.VERIFIED);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.schema, "curb.verify/1");
  assert.equal(o.kind, "round");
  assert.equal(o.reproduced, true);
  assert.equal(o.inputRoot, o.root);
});

test("selftest passes offline and proves the verifier can still say no", () => {
  const r = run("selftest");
  assert.equal(r.status, EXIT.VERIFIED, r.stdout + r.stderr);
  assert.match(r.stdout, /catches tampering/);
  assert.match(r.stdout, /wrong label is surfaced/);
});
