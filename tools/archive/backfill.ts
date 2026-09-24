#!/usr/bin/env node
/**
 * Fill the R2 archive with everything Curb has already written on chain. Run from the Mac.
 *
 * The services publish every NEW bundle after its fsync (publish.ts). This covers what came before, and
 * any gap a publisher left. The chain is the index:
 *   - rounds: every MarketClock `StateAttested` write from block 70,617,365, scanned in 100-block log
 *     queries. The bundle comes from host A, or from --rounds-dir (a copy of host B's outbox, for
 *     takeover rounds host A never had).
 *   - marks: every Scorecard v2 `ClosureCommitted` from block 71,231,806. The keeper serves bundles on
 *     the VPS loopback only, so they come from --marks-dir, a local copy pulled with scp.
 *   - witness statements, optionally: host B's signed statements from --witness-dir.
 *
 * Each write is checked with `curb-verify tx`'s own pipeline (checkRound / checkMarkRound against the
 * chain) BEFORE it is uploaded, so the locked prefixes only ever receive evidence that reproduces. The
 * bytes uploaded are exactly the bytes that were checked. PUTs carry If-None-Match: *, so a 412 means
 * "already there". A write the public archive already serves is skipped outright. That makes the whole
 * run resumable: run it again and it picks up where it stopped.
 *
 * index/latest.json, index/rounds.ndjson and index/marks.ndjson are rewritten at the end of a full run.
 * They are a convenience, not evidence: the chain and the locked objects are the record.
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node tools/archive/backfill.ts \
 *     --marks-dir ~/curb-evidence/marks [--rounds-dir …] [--witness-dir …] [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadR2Config, putObject } from "../../services/attestor/src/publish.ts";
import type { PutResult } from "../../services/attestor/src/publish.ts";
import { attestedRounds, rpcAny, DEFAULT_RPCS } from "../../services/attestor/src/sources/chain.ts";
import type { AttestedRound } from "../../services/attestor/src/sources/chain.ts";
import { WITNESS_SCHEMA, verifyWitness } from "../../services/attestor/src/witness.ts";
import type { WitnessDoc } from "../../services/attestor/src/witness.ts";
import { closuresCommitted } from "../../services/keeper/src/sources/scorecard.ts";
import type { CommittedRow } from "../../services/keeper/src/sources/scorecard.ts";
import {
  ARCHIVE, CHAIN_ID, CLOCK, FIRST_ROUND_BLOCK, HOST_A, SCORECARD, SCORECARD_FROM_BLOCK, checkUrl, mapLimit, verifyTx, worstExit,
} from "../curb-verify/src/tx.ts";
import type { Deps, Evidence } from "../curb-verify/src/tx.ts";
import { EXIT } from "../curb-verify/src/render.ts";

/** Host A and host B, the only keys whose witness statements belong in the archive. */
export const CURB_ATTESTORS = ["0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4", "0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8"];

export type Status =
  | "present"         // the public archive already serves it; not re-checked
  | "uploaded"        // checked, then stored
  | "already"         // checked, then the PUT answered 412: someone stored it first
  | "would-upload"    // --dry-run: checked, and would be stored
  | "not-reproduced"  // checked and it FAILS: never uploaded
  | "unavailable"     // no bundle found, or the chain could not be read
  | "unsupported"     // a document this verifier has no check for
  | "put-failed";     // checked, but the bucket refused it or never answered

export interface Item { kind: "round" | "mark" | "witness" | "index"; key: string; tx?: string; block?: number; status: Status; detail?: string }

export interface BackfillOptions {
  roundsFrom: number;
  marksFrom: number;
  to: number;
  dryRun: boolean;
  writeIndex: boolean;
  concurrency: number;
  /** Blocks per attestedRounds / closuresCommitted call (each is 100-block log queries inside). */
  window?: number;
  witnessDir?: string;
  expectedSigners?: string[];
  /** Base delay between retries of a scan window or a PUT (default 1s, doubling). */
  retryMs?: number;
  now?: () => number;
}

export interface BackfillIO {
  rounds(from: number, to: number): Promise<AttestedRound[]>;
  closures(from: number, to: number): Promise<CommittedRow[]>;
  /** verifyTx's view of the world: the RPC, and where bundles come from. */
  deps: Deps;
  /** Does the PUBLIC archive already serve this key? */
  inArchive(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array): Promise<PutResult>;
  log(line: string): void;
}

const ARCHIVED: Status[] = ["present", "uploaded", "already"];
const exitOf = (s: Status): number =>
  s === "not-reproduced" || s === "put-failed" ? EXIT.NOT_REPRODUCED
  : s === "unsupported" ? EXIT.UNSUPPORTED
  : s === "unavailable" ? EXIT.UNAVAILABLE
  : EXIT.VERIFIED;

export async function backfill(o: BackfillOptions, io: BackfillIO) {
  const items: Item[] = [];
  const window = o.window ?? 2_000;

  // 1. The chain, scanned whole before anything is uploaded: a partial scan must never write an index.
  const retryMs = o.retryMs ?? 1_000;
  const rounds = await scan("rounds", o.roundsFrom, o.to, window, o.concurrency, retryMs, io.rounds, io.log);
  const marks = o.to >= o.marksFrom ? await scan("marks", o.marksFrom, o.to, window, o.concurrency, retryMs, io.closures, io.log) : [];
  io.log(`found ${rounds.length} MarketClock rounds in ${o.roundsFrom}..${o.to} and ${marks.length} Scorecard marks in ${o.marksFrom}..${o.to}`);

  // 2. Every write: skip it if archived, otherwise check it exactly as a judge would, then upload.
  const one = async (kind: "round" | "mark", tx: string, block: number, root: string): Promise<Item> => {
    const key = `${kind === "round" ? "rounds" : "marks"}/${root.toLowerCase()}.json`;
    const item: Item = { kind, key, tx: tx.toLowerCase(), block, status: "unavailable" };
    if (await io.inArchive(key).catch(() => false)) return { ...item, status: "present" };
    const v = await verifyTx(tx, io.deps);
    if (v.exit !== EXIT.VERIFIED || !v.check || v.text === undefined) {
      const status: Status = v.exit === EXIT.NOT_REPRODUCED ? "not-reproduced" : v.exit === EXIT.UNSUPPORTED || v.exit === EXIT.USAGE ? "unsupported" : "unavailable";
      return { ...item, status, detail: v.check ? v.check.failures.join("; ") : v.message };
    }
    if (v.key !== key) return { ...item, status: "not-reproduced", detail: `the calldata commits ${v.key}, the log says ${key}` };
    if (o.dryRun) return { ...item, status: "would-upload", detail: v.source };
    const s = await store(key, v.bytes ?? Buffer.from(v.text, "utf8"));
    return { ...item, status: s.status, detail: s.detail ?? v.source };
  };
  const store = async (key: string, body: Uint8Array): Promise<Pick<Item, "status" | "detail">> => {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await io.put(key, body);
      if (r.ok) return { status: r.existed ? "already" : "uploaded" };
      last = r.error ?? `HTTP ${r.status}`;
      const transient = r.status === 0 || r.status === 429 || r.status >= 500;
      if (!transient) break;
      await new Promise((res) => setTimeout(res, (o.retryMs ?? 1_000) * attempt));
    }
    return { status: "put-failed", detail: last };
  };

  let done = 0;
  const progress = (total: number, what: string) => { if (++done % 100 === 0 || done === total) io.log(`${what}: ${done}/${total}`); };
  done = 0;
  items.push(...await mapLimit(rounds, o.concurrency, async (r) => { const it = await one("round", r.txHash, r.blockNumber, r.inputRoot); progress(rounds.length, "rounds"); return it; }));
  done = 0;
  items.push(...await mapLimit(marks, o.concurrency, async (m) => { const it = await one("mark", m.txHash, m.committedBlock, m.inputRoot); progress(marks.length, "marks"); return it; }));

  // 3. Host B's witness statements, if a copy was given.
  if (o.witnessDir) items.push(...await mapLimit(witnessFiles(o.witnessDir), o.concurrency, async (w): Promise<Item> => {
    const item: Item = { kind: "witness", key: w.key, status: "unavailable" };
    const body = readFileSync(w.path);
    const bad = checkWitnessFile(body, w.name, w.byTx, o.expectedSigners ?? CURB_ATTESTORS);
    if (bad) return { ...item, status: bad.status, detail: bad.detail };
    if (await io.inArchive(w.key).catch(() => false)) return { ...item, status: "present" };
    if (o.dryRun) return { ...item, status: "would-upload" };
    const s = await store(w.key, body);
    return { ...item, status: s.status, detail: s.detail };
  }));

  // 4. The index, only from a complete scan.
  let index: Record<string, string> | null = null;
  const full = o.roundsFrom <= FIRST_ROUND_BLOCK && o.marksFrom <= SCORECARD_FROM_BLOCK;
  if (!o.writeIndex) io.log("index: skipped (--no-index)");
  else if (!full) io.log(`index: skipped, the scan did not start at ${FIRST_ROUND_BLOCK} / ${SCORECARD_FROM_BLOCK}, so it would be partial`);
  else {
    index = buildIndex(rounds, marks, items, o.to, (o.now ?? Date.now)());
    if (o.dryRun) io.log(`index: would write ${Object.keys(index).join(", ")}`);
    else for (const [key, body] of Object.entries(index)) {
      const r = await store(key, Buffer.from(body, "utf8"));
      items.push({ kind: "index", key, status: r.status, detail: r.detail });
    }
  }

  return { items, index, exit: worstExit(items.map((i) => exitOf(i.status))) };
}

/** Scan a block range in windows, several at once, retrying each window. Throws if one keeps failing. */
async function scan<T extends { txHash: string }>(
  what: string, from: number, to: number, window: number, concurrency: number, retryMs: number,
  fn: (f: number, t: number) => Promise<T[]>, log: (s: string) => void,
): Promise<T[]> {
  const windows: Array<[number, number]> = [];
  for (let f = from; f <= to; f += window) windows.push([f, Math.min(to, f + window - 1)]);
  let done = 0;
  const parts = await mapLimit(windows, concurrency, async ([f, t]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await fn(f, t);
        if (++done % 50 === 0 || done === windows.length) log(`${what}: scanned ${done}/${windows.length} windows (last done: ${f}..${t})`);
        return out;
      } catch (e) {
        if (attempt >= 4) throw new Error(`${what} scan of ${f}..${t} failed ${attempt} times: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, retryMs * 2 ** attempt));
      }
    }
  });
  const seen = new Set<string>();
  return parts.flat().filter((x) => (seen.has(x.txHash.toLowerCase()) ? false : (seen.add(x.txHash.toLowerCase()), true)));
}

// ---------------------------------------------------------------------------------------------
// witness statements from a local copy of host B's DATA_DIR/witness
// ---------------------------------------------------------------------------------------------

const HASH_FILE = /^(0x[0-9a-f]{64})\.json$/;

export function witnessFiles(dir: string): Array<{ key: string; path: string; name: string; byTx: boolean }> {
  const out: Array<{ key: string; path: string; name: string; byTx: boolean }> = [];
  const list = (d: string) => (existsSync(d) ? readdirSync(d) : []);
  for (const f of list(dir)) { const m = f.match(HASH_FILE); if (m) out.push({ key: `witness/${m[1]}.json`, path: join(dir, f), name: m[1], byTx: false }); }
  for (const f of list(join(dir, "tx"))) { const m = f.match(HASH_FILE); if (m) out.push({ key: `witness/tx/${m[1]}.json`, path: join(dir, "tx", f), name: m[1], byTx: true }); }
  return out;
}

/** A statement is archived only if its signature recovers a Curb attestor and it is filed under its own hash. */
export function checkWitnessFile(body: Uint8Array, name: string, byTx: boolean, signers: string[]): { status: Status; detail: string } | null {
  let doc: WitnessDoc;
  try { doc = JSON.parse(Buffer.from(body).toString("utf8")); } catch { return { status: "not-reproduced", detail: "not JSON" }; }
  if (doc?.schema !== WITNESS_SCHEMA) return { status: "unsupported", detail: `schema ${JSON.stringify(doc?.schema)}` };
  let v: ReturnType<typeof verifyWitness>;
  try { v = verifyWitness(doc); } catch (e) { return { status: "not-reproduced", detail: `signature does not verify: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!v.ok) return { status: "not-reproduced", detail: `signature recovers ${v.recovered}, not the claimed ${doc.signer}` };
  if (!signers.some((s) => s.toLowerCase() === v.recovered.toLowerCase())) return { status: "not-reproduced", detail: `signed by ${v.recovered}, which is not a Curb attestor` };
  const filed = byTx ? doc.message.txHash : doc.message.inputRoot;
  if (String(filed).toLowerCase() !== name) return { status: "not-reproduced", detail: `filed as ${name} but the statement is about ${filed}` };
  return null;
}

// ---------------------------------------------------------------------------------------------
// the index
// ---------------------------------------------------------------------------------------------

export function buildIndex(rounds: AttestedRound[], marks: CommittedRow[], items: Item[], scannedTo: number, nowMs: number): Record<string, string> {
  const status = new Map(items.map((i) => [i.key, i.status]));
  const archived = (key: string) => ARCHIVED.includes(status.get(key) as Status);
  const roundRows = [...rounds].sort((a, b) => a.blockNumber - b.blockNumber).map((r) => {
    const key = `rounds/${r.inputRoot.toLowerCase()}.json`;
    return { block: r.blockNumber, tx: r.txHash.toLowerCase(), inputRoot: r.inputRoot.toLowerCase(), wrappers: r.wrappers, key, archived: archived(key) };
  });
  const markRows = [...marks].sort((a, b) => a.committedBlock - b.committedBlock).map((m) => {
    const key = `marks/${m.inputRoot.toLowerCase()}.json`;
    return {
      block: m.committedBlock, tx: m.txHash.toLowerCase(), inputRoot: m.inputRoot.toLowerCase(), id: m.id, wrapper: m.wrapper,
      settleAfter: m.settleAfter, mark: m.mark, bandBps: m.bandBps, key, archived: archived(key),
    };
  });
  const ends = <T>(xs: T[]) => ({ first: xs[0] ?? null, latest: xs.at(-1) ?? null });
  const latest = {
    schema: "curb.archive.index/1",
    note: "Convenience only, rebuilt by tools/archive/backfill.ts. The record is the chain and the locked rounds/, marks/ and witness/ objects; verify any row with `npx curb-verify tx <hash>`.",
    generatedAt: new Date(nowMs).toISOString(),
    scannedToBlock: scannedTo,
    chainId: CHAIN_ID, clock: CLOCK, scorecard: SCORECARD,
    rounds: { count: roundRows.length, archived: roundRows.filter((r) => r.archived).length, ...ends(roundRows.map(({ wrappers: _w, ...r }) => r)) },
    marks: { count: markRows.length, archived: markRows.filter((r) => r.archived).length, ...ends(markRows) },
  };
  const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  return {
    "index/rounds.ndjson": ndjson(roundRows),
    "index/marks.ndjson": ndjson(markRows),
    "index/latest.json": JSON.stringify(latest, null, 2) + "\n",
  };
}

// ---------------------------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------------------------

const USAGE = `node tools/archive/backfill.ts [options]

  --marks-dir <path>     local copy of the keeper's DATA_DIR/marks (scp from the VPS); marks need it
  --rounds-dir <path>    local copy of host B's DATA_DIR/outbox, for takeover rounds host A never had
  --witness-dir <path>   local copy of host B's DATA_DIR/witness, to archive its signed statements
  --dry-run              check everything, upload nothing; R2_* not needed
  --from <block>         first MarketClock block (default ${FIRST_ROUND_BLOCK}); a later start skips the index
  --marks-from <block>   first Scorecard block (default ${SCORECARD_FROM_BLOCK})
  --to <block>           last block (default: head - 10)
  --host-a <url>         default ${HOST_A}
  --archive <url>        public archive, to skip what it already serves (default ${ARCHIVE})
  --rpc <url>            repeatable (default ${DEFAULT_RPCS.join(", ")})
  --concurrency <n>      default 4
  --no-index             do not rewrite index/

Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default curb-archive).
Exit: 0 everything archived (or would be), 1 something did NOT reproduce or would not store,
      2 usage, 3 something unavailable, 4 something unsupported.`;

function localEvidence(dir: string | undefined, root: string): Evidence | null {
  if (!dir) return null;
  const p = join(dir, `${root}.json`);
  if (!existsSync(p)) return null;
  const bytes = readFileSync(p);
  const text = bytes.toString("utf8");
  try { JSON.parse(text); } catch { return null; }
  return { ok: true, text, source: p, bytes: new Uint8Array(bytes) };
}

async function main() {
  let a;
  try {
    a = parseArgs({
      strict: true,
      options: {
        "marks-dir": { type: "string" }, "rounds-dir": { type: "string" }, "witness-dir": { type: "string" },
        "dry-run": { type: "boolean", default: false }, "no-index": { type: "boolean", default: false },
        from: { type: "string" }, "marks-from": { type: "string" }, to: { type: "string" },
        "host-a": { type: "string", default: HOST_A }, archive: { type: "string", default: ARCHIVE },
        rpc: { type: "string", multiple: true, default: [] }, concurrency: { type: "string", default: "4" },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`); process.exit(EXIT.USAGE); }
  if (a.help) { process.stdout.write(USAGE + "\n"); process.exit(0); }

  const usage = (m: string): never => { process.stderr.write(`backfill: ${m}\n`); process.exit(EXIT.USAGE); };
  const int = (name: string, v: string | undefined, d: number) => {
    if (v === undefined) return d;
    const n = Number(v.replace(/[_,]/g, ""));
    return Number.isSafeInteger(n) && n >= 0 ? n : usage(`--${name} must be a block number`);
  };
  const rpcs = (a.rpc as string[]).length ? (a.rpc as string[]) : DEFAULT_RPCS;
  const hostA = String(a["host-a"]).replace(/\/+$/, "");
  const archive = String(a.archive).replace(/\/+$/, "");
  for (const u of [...(a.rpc as string[]), hostA, archive]) { const bad = checkUrl(u); if (bad) usage(bad); }
  for (const d of [a["marks-dir"], a["rounds-dir"], a["witness-dir"]]) if (d && !existsSync(d)) usage(`no such directory: ${d}`);
  const concurrency = int("concurrency", a.concurrency, 4) || 1;

  const r2 = loadR2Config();
  if (!a["dry-run"] && !r2.config) usage(`${r2.reason}. Set them, or pass --dry-run.`);
  const log = (s: string) => process.stderr.write(`${s}\n`);

  let to = int("to", a.to, -1);
  if (to < 0) to = Number(BigInt(await rpcAny<string>(rpcs, "eth_blockNumber", []))) - 10;
  const opts: BackfillOptions = {
    roundsFrom: int("from", a.from, FIRST_ROUND_BLOCK), marksFrom: int("marks-from", a["marks-from"], SCORECARD_FROM_BLOCK), to,
    dryRun: Boolean(a["dry-run"]), writeIndex: !a["no-index"], concurrency, witnessDir: a["witness-dir"],
  };
  log(opts.dryRun ? "dry run: checking everything, uploading nothing"
    : `uploading to bucket ${r2.config!.bucket} at ${r2.config!.endpoint}`);
  if (!a["marks-dir"]) log("no --marks-dir: every mark not already in the archive will be reported unavailable");

  const io: BackfillIO = {
    rounds: (f, t) => attestedRounds(rpcs, CLOCK, f, t),
    closures: (f, t) => closuresCommitted(rpcs, SCORECARD, f, t),
    deps: {
      rpc: <T>(method: string, params: unknown[]) => rpcAny<T>(rpcs, method, params),
      async evidence(key: string): Promise<Evidence> {
        const root = key.slice(key.indexOf("/") + 1, -".json".length);
        const tried: string[] = [];
        if (key.startsWith("rounds/")) {
          try {
            const res = await fetch(`${hostA}/${key}`, { signal: AbortSignal.timeout(20_000) });
            if (res.ok) {
              const bytes = new Uint8Array(await res.arrayBuffer());
              const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
              JSON.parse(text);
              return { ok: true, text, source: `${hostA}/${key}`, bytes };
            }
            tried.push(`${hostA}/${key}: HTTP ${res.status}`);
          } catch (e) { tried.push(`${hostA}/${key}: ${e instanceof Error ? e.message : String(e)}`); }
          const local = localEvidence(a["rounds-dir"], root);
          if (local) return local;
          if (a["rounds-dir"]) tried.push(`${a["rounds-dir"]}/${root}.json: absent`);
        } else {
          const local = localEvidence(a["marks-dir"], root);
          if (local) return local;
          tried.push(a["marks-dir"] ? `${a["marks-dir"]}/${root}.json: absent` : "no --marks-dir given");
        }
        return { ok: false, tried };
      },
    },
    async inArchive(key) {
      const res = await fetch(`${archive}/${key}`, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      return res.status === 200;
    },
    put: (key, body) => putObject(r2.config!, key, body, { timeoutMs: 30_000 }),
    log,
  };

  const { items, exit } = await backfill(opts, io);
  for (const i of items) {
    if (i.status === "present" || i.status === "uploaded" || i.status === "already" || i.status === "would-upload") continue;
    process.stdout.write(`${i.status.toUpperCase().padEnd(15)} ${i.kind.padEnd(7)} ${i.key}${i.tx ? `  tx ${i.tx}` : ""}${i.detail ? `\n                ${i.detail}` : ""}\n`);
  }
  for (const kind of ["round", "mark", "witness", "index"] as const) {
    const mine = items.filter((i) => i.kind === kind);
    if (!mine.length) continue;
    const by = new Map<string, number>();
    for (const i of mine) by.set(i.status, (by.get(i.status) ?? 0) + 1);
    process.stdout.write(`${kind}s: ${mine.length}  ${[...by].map(([s, n]) => `${s} ${n}`).join(", ")}\n`);
  }
  process.exit(exit);
}

const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return ""; } })() : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`backfill: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(EXIT.UNAVAILABLE); });
}
