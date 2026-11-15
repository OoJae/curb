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
import { verifyMarkBundleOffline } from "../../../services/keeper/src/markRound.ts";
import { SWAP_EVIDENCE_FROM_BLOCK } from "../../../services/keeper/src/swapEvidence.ts";
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

/**
 * Two real Scorecard marks, as archived. The 2 Oct holiday row is one of the six whose reopen re-derives only
 * from the commit instant (D-16): REPRODUCED, with that said in an EVIDENCE note. The 13 Nov recess row was
 * written by a keeper that decoded no pool Swap logs (D-15) while its own pool reads moved: REPRODUCED, with
 * EVIDENCE notes saying so. A tampered copy of the latter must fail.
 */
const MARKS: Array<{ name: string; root: string; notes: Array<[string, string]>; tamper?: boolean }> = [
  {
    name: "mark 0x3dafc1b6 (2 Oct holiday row)", root: "0x3dafc1b6355ef8bfacc33bbc0563489b65530afc2474a8b78fd9d560c7ff18ed",
    notes: [["reopen re-derived from the commit instant", "the reopen re-derives from the commit instant, and says so"]],
  },
  {
    name: "mark 0x06a92e82 (13 Nov recess row)", root: "0x06a92e8238992e4d2ed25fac5b4a6ac243e6bbadc8dd99cced80fbe16ca71b75",
    notes: [
      ["decoded no pool Swap logs", "the pre-fix keeper's missing swap evidence is surfaced"],
      ["the bundle's own pool reads moved", "a pool move with no swap listed is surfaced"],
    ],
    tamper: true,
  },
];

const markPath = (root: string) =>
  fileURLToPath(new URL(`../../../services/keeper/src/fixtures/marks/${root}.json`, import.meta.url));

/** `era cutover: block N`, or that this build has none yet (every row is then checked as pre-fix). */
export const eraCutoverLine = (n = SWAP_EVIDENCE_FROM_BLOCK) =>
  n === Number.MAX_SAFE_INTEGER ? "era cutover: NOT SET (pre-release build)" : `era cutover: block ${n}`;

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

  for (const { name, root, notes, tamper } of MARKS) {
    let bundle: Record<string, unknown>;
    try { bundle = JSON.parse(readFileSync(markPath(root), "utf8")); }
    catch (e) {
      results.push({ fixture: name, check: "load", ok: false, detail: `fixture missing: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const v = verifyMarkBundleOffline(bundle as never);
    const clean = fromOffline(v);
    results.push({
      fixture: name, check: "mark re-derives", ok: clean.reproduced,
      detail: clean.reproduced ? `root ${v.root}, era ${v.era}` : clean.failures.join("; "),
    });
    for (const [needle, check] of notes) {
      const hit = v.notes.find((n) => n.includes(needle));
      results.push({ fixture: name, check, ok: hit !== undefined, detail: hit ? `EVIDENCE ${hit.length > 96 ? hit.slice(0, 96) + "..." : hit}` : `no EVIDENCE note contains "${needle}"` });
    }
    if (tamper) {
      // Re-hash nothing: flip the committed mark itself. The claim no longer re-derives, so this MUST fail.
      const t = JSON.parse(JSON.stringify(bundle)) as { json: Record<string, string> };
      const key = Object.keys(t.json).find((k) => t.json[k].includes('"markE18"'));
      if (key) t.json[key] = t.json[key].replace(/"markE18":"(\d)/, (_m, d) => `"markE18":"${(Number(d) + 1) % 10}`);
      const bad = fromOffline(verifyMarkBundleOffline(t as never));
      results.push({
        fixture: name, check: "catches tampering", ok: !bad.reproduced,
        detail: bad.reproduced ? "a tampered mark verified -- the verifier is broken" : `rejected: ${bad.failures[0]}`,
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  const cutover = eraCutoverLine();
  if (json) {
    process.stdout.write(JSON.stringify({
      schema: "curb.verify/1", kind: "selftest", ok: failed.length === 0,
      eraCutoverBlock: SWAP_EVIDENCE_FROM_BLOCK === Number.MAX_SAFE_INTEGER ? null : SWAP_EVIDENCE_FROM_BLOCK, results,
    }) + "\n");
  } else {
    for (const r of results) process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.fixture}  ${r.check}: ${r.detail}\n`);
    process.stdout.write(`${cutover}\n`);
    process.stdout.write(failed.length === 0
      ? `selftest passed: ${results.length} checks over ${FIXTURES.length} real mainnet rounds and ${MARKS.length} real mainnet marks, no network\n`
      : `selftest FAILED: ${failed.length} of ${results.length} checks\n`);
  }
  return failed.length === 0 ? EXIT.VERIFIED : EXIT.NOT_REPRODUCED;
}
