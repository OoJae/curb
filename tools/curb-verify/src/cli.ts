#!/usr/bin/env node
/**
 * curb-verify -- re-derive a Curb number instead of trusting it.
 *
 * Every regime Curb writes to MarketClock, and every closure mark it writes to Scorecard, commits a
 * Merkle root of the exact inputs it used. This takes the published bundle, rebuilds the root, checks
 * every leaf preimage, re-runs the committed method on the committed inputs, and -- for the chain
 * verbs -- checks the result against what was actually written on chain. It answers one question:
 * does the number Curb put on chain follow from the evidence Curb published?
 *
 * No shebang flag: Node >= 22.18 strips types natively, and `#!/usr/bin/env -S node --flag` is not
 * portable. The version guard below runs before any syntax Node 20 would choke on is reached.
 */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  process.stderr.write(`curb-verify needs Node 22.18 or newer (found ${process.versions.node}); it runs TypeScript directly.\n`);
  process.exit(2);
}

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { classify, expectKind, SCHEMAS } from "./classify.ts";
import { EXIT, exitFor, fromOffline, iso, renderCheck, renderJson } from "./render.ts";
import type { CheckLike } from "./render.ts";
import { verifyBundleOffline } from "../../../services/attestor/src/verify/offline.ts";
import { verifyWitness } from "../../../services/attestor/src/witness.ts";
import { verifyMarkBundleOffline } from "../../../services/keeper/src/markRound.ts";

const USAGE = `curb-verify -- check a Curb number against the evidence it was published with

  curb-verify bundle  [<path|url|->]   verify a round or mark bundle offline
  curb-verify witness [<path|url|->]   recover the signer of a witness statement
  curb-verify selftest                 verify the bundled mainnet fixtures, no network

Options
  --json          one JSON object per item, on stdout
  --archive <base>  archive base URL (repeatable, tried in order)

Exit codes
  0 verified   1 NOT reproduced   2 usage error   3 unavailable (nothing concluded)   4 unsupported schema

Schemas verified: ${Object.values(SCHEMAS).join(", ")}`;

async function readSource(src: string | undefined, archives: string[]): Promise<{ text: string; from: string }> {
  if (src === undefined || src === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return { text: Buffer.concat(chunks).toString("utf8"), from: "stdin" };
  }
  if (/^https?:\/\//i.test(src)) {
    if (/^http:\/\//i.test(src)) fail(EXIT.USAGE, `refusing plain http: ${src} -- a verifier a network can rewrite is not a verifier`);
    return { text: await get(src), from: src };
  }
  if (/^file:\/\//i.test(src)) fail(EXIT.USAGE, "refusing file:// -- pass a path directly");
  // A bare 0x-root with archives configured is a convenience, not a guess about what it is.
  if (/^0x[0-9a-fA-F]{64}$/.test(src) && archives.length) {
    for (const base of archives) {
      for (const dir of ["rounds", "marks", "witness"]) {
        try { return { text: await get(`${base}/${dir}/${src.toLowerCase()}.json`), from: `${base}/${dir}/${src.toLowerCase()}.json` }; } catch { /* next */ }
      }
    }
    fail(EXIT.UNAVAILABLE, `no archive served ${src}`);
  }
  try { return { text: readFileSync(src, "utf8"), from: src }; }
  catch (e) { fail(EXIT.USAGE, `cannot read ${src}: ${e instanceof Error ? e.message : String(e)}`); }
}

async function get(url: string): Promise<string> {
  let res: Response;
  try { res = await fetch(url, { signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`); }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function fail(code: number, message: string): never {
  process.stderr.write(`curb-verify: ${message}\n`);
  process.exit(code);
}

function emit(json: boolean, human: string, jsonLine: string) {
  process.stdout.write((json ? jsonLine : human) + "\n");
}

/** Verify one already-parsed document. Returns the check plus how to describe it. */
function verifyDoc(doc: unknown, from: string, json: boolean): { check: CheckLike; kind: string } {
  const c = classify(doc);
  if (c.kind === null) fail(EXIT.UNSUPPORTED, c.reason);

  if (c.kind === "witness") {
    const { ok, recovered } = verifyWitness(c.doc);
    const m = c.doc.message;
    const check: CheckLike = {
      reproduced: ok,
      labelsConsistent: true,
      failures: ok ? [] : [`signature recovers ${recovered}, which is not the claimed signer ${c.doc.signer}`],
      labelFailures: [],
      warnings: [],
    };
    emit(json,
      renderCheck(`witness ${m.inputRoot}`, [
        ["source", from],
        ["signer", c.doc.signer],
        ["tx", `${m.txHash}  block ${m.blockNumber.toLocaleString("en-US")}`],
        ["written", iso(m.writtenAt * 1000)],
        ["attestor", m.attestor],
        ["method", m.method],
        ["says", `reproduced=${m.reproduced} labelsConsistent=${m.labelsConsistent} observation=${m.observation}`],
      ], check),
      renderJson("witness", { source: from, inputRoot: m.inputRoot, signer: c.doc.signer, recovered, message: m }, check));
    return { check, kind: "witness" };
  }

  // Total, like `checkRound` is. Neither offline verifier guards every field it reads, so a
  // sufficiently mangled bundle makes one throw -- and a throw here means "this does not check out",
  // never "I could not reach the network". Letting it reach the top-level catch would report a
  // broken bundle as exit 3 and tell the reader nothing was concluded, when plenty was.
  let r: { ok: boolean; root: string; failures: string[] };
  try {
    r = c.kind === "round" ? verifyBundleOffline(c.doc) : verifyMarkBundleOffline(c.doc);
  } catch (e) {
    r = { ok: false, root: "", failures: [`verification threw on this bundle: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const check = fromOffline(r);
  const fields: Array<[string, string]> = [["source", from], ["root", r.root || "(unreadable)"]];
  if (c.kind === "round") {
    fields.push(["kind", String(c.doc.kind)], ["evaluated", iso(c.doc.evaluatedAtMs)], ["claims", String(c.doc.claims?.length ?? 0)]);
  } else {
    fields.push(["scorecard", String(c.doc.scorecard)], ["evaluated", iso(c.doc.evaluatedAtMs)], ["marks", String(c.doc.marks?.length ?? 0)]);
  }
  emit(json, renderCheck(`${c.kind} bundle ${c.doc.inputRoot}`, fields, check),
    renderJson(c.kind, { source: from, inputRoot: c.doc.inputRoot, root: r.root }, check));
  return { check, kind: c.kind };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        archive: { type: "string", multiple: true, default: [] },
        help: { type: "boolean", default: false },
      },
    });
  } catch (e) { fail(EXIT.USAGE, `${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE + "\n");
    process.exit(positionals.length === 0 && !values.help ? EXIT.USAGE : EXIT.VERIFIED);
  }

  const [verb, arg] = positionals;
  const json = Boolean(values.json);
  const archives = (values.archive as string[]).map((a) => a.replace(/\/+$/, ""));

  switch (verb) {
    case "bundle":
    case "witness": {
      const { text, from } = await readSource(arg, archives);
      let doc: unknown;
      try { doc = JSON.parse(text); } catch { fail(EXIT.USAGE, `${from} is not JSON`); }
      if (verb === "witness") {
        const c = classify(doc);
        const want = expectKind(c, "witness");
        if (!want.ok) fail(c.kind === null ? EXIT.UNSUPPORTED : EXIT.USAGE, want.message);
      } else {
        // `bundle` accepts either bundle kind but never a witness doc.
        const c = classify(doc);
        if (c.kind === "witness") fail(EXIT.USAGE, "that is a witness statement; use: curb-verify witness ...");
      }
      const { check } = verifyDoc(doc, from, json);
      process.exit(exitFor(check));
      break;
    }
    case "selftest": {
      const { runSelftest } = await import("./selftest.ts");
      process.exit(await runSelftest(json));
      break;
    }
    default:
      fail(EXIT.USAGE, `unknown verb ${JSON.stringify(verb)}\n\n${USAGE}`);
  }
}

main().catch((e) => fail(EXIT.UNAVAILABLE, e instanceof Error ? e.message : String(e)));
