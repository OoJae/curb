/**
 * Verify the bundled mainnet fixtures, with no network at all.
 *
 * This is the first thing a sceptic should run: it proves the verifier works, on real rounds that
 * MarketClock actually wrote, before they point it at anything of ours. It also proves a tampered
 * bundle is caught -- a verifier that only ever says "ok" has told you nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyBundleOffline } from "../../../services/attestor/src/verify/offline.ts";
import { EXIT, fromOffline } from "./render.ts";

/**
 * Both are real MarketClock rounds. The first is deliberately included because it is *imperfect*:
 * round 70,617,365 -- the first attestation Curb ever wrote -- carries a top-level `kind: "diff"`
 * that contradicts its own committed `PARAMS.kind: "heartbeat"`. Its claims still re-derive exactly,
 * so it is REPRODUCED with inconsistent labels, and demonstrating that distinction on first run is
 * the point: a tool that collapsed "a label is wrong" into "the number is wrong" would be useless
 * for deciding whether to trust a row.
 */
const FIXTURES: Array<{ name: string; labelsConsistent: boolean }> = [
  { name: "round-70617365", labelsConsistent: false },
  { name: "round-70619137", labelsConsistent: true },
];

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../../services/attestor/src/fixtures/${name}.bundle.json`, import.meta.url));

export async function runSelftest(json: boolean): Promise<number> {
  const results: Array<{ fixture: string; check: string; ok: boolean; detail: string }> = [];

  for (const { name, labelsConsistent } of FIXTURES) {
    let bundle: Record<string, unknown>;
    try { bundle = JSON.parse(readFileSync(fixturePath(name), "utf8")); }
    catch (e) {
      // The fixtures are stripped from runtime images on purpose but MUST ship in the npm package.
      results.push({ fixture: name, check: "load", ok: false, detail: `fixture missing: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const raw = verifyBundleOffline(bundle as never);
    const clean = fromOffline(raw);
    results.push({
      fixture: name, check: "claims re-derive", ok: clean.reproduced,
      detail: clean.reproduced ? `root ${raw.root}` : clean.failures.join("; "),
    });
    results.push({
      fixture: name,
      check: labelsConsistent ? "labels agree with the root" : "wrong label is surfaced, not hidden",
      ok: clean.labelsConsistent === labelsConsistent,
      detail: labelsConsistent
        ? (clean.labelsConsistent ? "every top-level field matches its committed counterpart" : clean.labelFailures.join("; "))
        : (clean.labelsConsistent ? "expected this round's known label defect to be reported, and it was not" : clean.labelFailures.join("; ")),
    });

    // Flip one committed preimage. The root no longer covers it, so this MUST fail.
    const tampered = JSON.parse(JSON.stringify(bundle)) as { json: Record<string, string> };
    const key = Object.keys(tampered.json)[0];
    if (key) {
      tampered.json[key] = JSON.stringify({ tampered: true });
      const bad = fromOffline(verifyBundleOffline(tampered as never));
      results.push({
        fixture: name, check: "catches tampering", ok: !bad.reproduced,
        detail: bad.reproduced ? "a tampered bundle verified -- the verifier is broken" : `rejected: ${bad.failures[0]}`,
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (json) {
    process.stdout.write(JSON.stringify({ schema: "curb.verify/1", kind: "selftest", ok: failed.length === 0, results }) + "\n");
  } else {
    for (const r of results) process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.fixture}  ${r.check}: ${r.detail}\n`);
    process.stdout.write(failed.length === 0
      ? `selftest passed: ${results.length} checks over ${FIXTURES.length} real mainnet rounds, no network\n`
      : `selftest FAILED: ${failed.length} of ${results.length} checks\n`);
  }
  return failed.length === 0 ? EXIT.VERIFIED : EXIT.NOT_REPRODUCED;
}
