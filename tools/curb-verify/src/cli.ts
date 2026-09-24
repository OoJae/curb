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
 * Needs Node >= 22.18, which strips TypeScript types natively. Installed from npm, the entry point is
 * bin/curb-verify.mjs, a plain-JavaScript launcher that checks the version before any TypeScript is
 * loaded. (Node refuses to strip types under node_modules/, and a .ts entry point cannot guard itself
 * on a Node that cannot parse it.) The check below covers running this file directly from a checkout.
 */
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 18)) {
  process.stderr.write(`curb-verify needs Node 22.18 or newer (found ${process.versions.node}); it runs TypeScript directly.\n`);
  process.exit(2);
}

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { classify, expectKind, SCHEMAS } from "./classify.ts";
import { EXIT, exitFor, fromOffline, iso, renderCheck, renderJson } from "./render.ts";
import type { CheckLike } from "./render.ts";
import {
  CLOCK, DEFAULT_ARCHIVES, SCORECARD, checkUrl, mapLimit, networkDeps, parseRange, verifyTx, worstExit, writesInRange,
} from "./tx.ts";
import type { Verdict } from "./tx.ts";
import { verifyBundleOffline } from "../../../services/attestor/src/verify/offline.ts";
import { verifyWitness } from "../../../services/attestor/src/witness.ts";
import { DEFAULT_RPCS } from "../../../services/attestor/src/sources/chain.ts";
import { verifyMarkBundleOffline } from "../../../services/keeper/src/markRound.ts";

const USAGE = `curb-verify -- check a Curb number against the evidence it was published with

  curb-verify tx <hash>                check one onchain write: a MarketClock round or a Scorecard mark
  curb-verify range <from>..<to>       check every Curb write in a block range (<to> may be "latest")
  curb-verify bundle  [<path|url|root|->]   verify a round or mark bundle offline
  curb-verify witness [<path|url|root|->]   recover the signer of a witness statement
  curb-verify selftest                 verify the bundled mainnet fixtures, no network

Options
  --json            one JSON object per item, on stdout
  --archive <base>  where evidence is fetched from (repeatable, tried in order);
                    default ${DEFAULT_ARCHIVES.join(", then ")}
  --rpc <url>       X Layer RPC (repeatable, tried in order); default ${DEFAULT_RPCS.join(", ")}

Contracts: MarketClock ${CLOCK}, Scorecard ${SCORECARD} (X Layer, chain 196)

Exit codes
  0 verified   1 NOT reproduced   2 usage error   3 unavailable (nothing concluded)   4 unsupported
  A range exits with its worst item: 1, then 4, then 3.

Schemas verified: ${Object.values(SCHEMAS).join(", ")}`;

async function readSource(src: string | undefined, archives: string[], dirs: string[]): Promise<{ text: string; from: string }> {
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
  // A bare 0x-root is looked up in the archives, in order. It is never mistaken for a path.
  if (/^0x[0-9a-fA-F]{64}$/.test(src)) {
    for (const base of archives) {
      for (const dir of dirs) {
        try { return { text: await get(`${base}/${dir}/${src.toLowerCase()}.json`), from: `${base}/${dir}/${src.toLowerCase()}.json` }; } catch { /* next */ }
      }
    }
    fail(EXIT.UNAVAILABLE, `no archive served ${src} (tried ${archives.join(", ")})`);
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

// ---------------------------------------------------------------------------------------------
// tx and range
// ---------------------------------------------------------------------------------------------

function verdictJson(v: Verdict): string {
  const extra = { tx: v.tx, block: v.block ?? null, inputRoot: v.inputRoot ?? null, source: v.source ?? null, exit: v.exit };
  if (v.check) return renderJson(v.kind ?? "tx", { ...extra, method: v.check.method, evaluatedAtMs: v.check.evaluatedAtMs }, v.check);
  return JSON.stringify({ schema: "curb.verify/1", kind: v.kind ?? "tx", ...extra, ok: false, error: v.message ?? "" });
}

function verdictHuman(v: Verdict): string {
  if (v.check) return renderCheck(`${v.kind} ${v.inputRoot}`, v.fields, v.check);
  const label = v.exit === EXIT.UNAVAILABLE ? "UNAVAILABLE" : v.exit === EXIT.UNSUPPORTED ? "UNSUPPORTED" : "USAGE";
  const head = `${v.kind ?? "tx"} ${v.inputRoot ?? v.tx}`;
  const width = Math.max(0, ...v.fields.map(([k]) => k.length));
  return [head, ...v.fields.map(([k, x]) => `  ${k.padEnd(width)}  ${x}`), `  ${label}: ${v.message ?? ""}`].join("\n");
}

async function runTx(hash: string | undefined, json: boolean, rpcs: string[], archives: string[]): Promise<never> {
  if (!hash) fail(EXIT.USAGE, "usage: curb-verify tx <hash>");
  const v = await verifyTx(hash, networkDeps(rpcs, archives));
  if (v.exit === EXIT.USAGE) fail(EXIT.USAGE, v.message ?? "bad arguments");
  emit(json, verdictHuman(v), verdictJson(v));
  process.exit(v.exit);
}

async function runRange(spec: string | undefined, json: boolean, rpcs: string[], archives: string[]): Promise<never> {
  const r = spec ? parseRange(spec) : null;
  if (!r) fail(EXIT.USAGE, `usage: curb-verify range <from>..<to>   e.g. range 70617365..70620000 or range 71231806..latest (got ${JSON.stringify(spec ?? "")})`);
  const net = networkDeps(rpcs, archives);
  let to: number;
  if (r.to === "latest") {
    try { to = Number(BigInt(await net.rpc<string>("eth_blockNumber", []))) - 5; }
    catch (e) { fail(EXIT.UNAVAILABLE, `could not read the chain head: ${e instanceof Error ? e.message : String(e)}`); }
  } else to = r.to;
  if (to < r.from) fail(EXIT.USAGE, `range ${r.from}..${to} is empty`);
  if (to - r.from > 20_000) process.stderr.write(`curb-verify: scanning ${(to - r.from + 1).toLocaleString("en-US")} blocks in 100-block log queries; this takes a while\n`);

  let writes;
  try { writes = await writesInRange(r.from, to, net); }
  catch (e) { fail(EXIT.UNAVAILABLE, `could not list the writes in ${r.from}..${to}: ${e instanceof Error ? e.message : String(e)}`); }

  const verdicts = await mapLimit(writes, 4, (w) => verifyTx(w.tx, net));
  for (const v of verdicts) {
    if (json) { process.stdout.write(verdictJson(v) + "\n"); continue; }
    if (v.exit === EXIT.VERIFIED && v.check) {
      const labels = v.check.labelsConsistent ? "" : "  (labels disagree; run `curb-verify tx` on it for detail)";
      process.stdout.write(`REPRODUCED  ${v.kind!.padEnd(5)}  block ${String(v.block).padStart(10)}  ${v.tx}${labels}\n`);
    } else {
      process.stdout.write(verdictHuman(v) + "\n");
    }
  }
  const count = (code: number) => verdicts.filter((v) => v.exit === code).length;
  const exit = worstExit(verdicts.map((v) => v.exit));
  const summary = {
    writes: verdicts.length,
    rounds: writes.filter((w) => w.kind === "round").length,
    marks: writes.filter((w) => w.kind === "mark").length,
    reproduced: count(EXIT.VERIFIED), notReproduced: count(EXIT.NOT_REPRODUCED),
    unavailable: count(EXIT.UNAVAILABLE), unsupported: count(EXIT.UNSUPPORTED),
  };
  if (json) process.stdout.write(JSON.stringify({ schema: "curb.verify/1", kind: "range", from: r.from, to, ...summary, exit }) + "\n");
  else {
    process.stdout.write(`range ${r.from}..${to}: ${summary.writes} Curb writes (${summary.rounds} rounds, ${summary.marks} marks): `
      + `${summary.reproduced} reproduced, ${summary.notReproduced} NOT reproduced, ${summary.unavailable} unavailable, ${summary.unsupported} unsupported\n`);
  }
  process.exit(exit);
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
        rpc: { type: "string", multiple: true, default: [] },
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
  const given = (values.archive as string[]).map((a) => a.replace(/\/+$/, ""));
  const archives = given.length ? given : DEFAULT_ARCHIVES;
  const rpcs = (values.rpc as string[]).length ? (values.rpc as string[]) : DEFAULT_RPCS;
  for (const u of [...given, ...(values.rpc as string[])]) {
    const bad = checkUrl(u);
    if (bad) fail(EXIT.USAGE, bad);
  }

  switch (verb) {
    case "bundle":
    case "witness": {
      const { text, from } = await readSource(arg, archives, verb === "witness" ? ["witness"] : ["rounds", "marks"]);
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
    case "tx":
      return runTx(arg, json, rpcs, archives);
    case "range":
      return runRange(arg, json, rpcs, archives);
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
