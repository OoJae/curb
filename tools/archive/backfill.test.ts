/**
 * The backfill, offline. The chain, host A, the public archive and the bucket are fakes. Every bundle
 * is real mainnet data (the two fixture rounds) or built by the keeper's own code, and every check is
 * the production one (`verifyTx` -> checkRound / checkMarkRound). So these tests show what would land in
 * the locked prefixes, and what would be kept out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfill, checkWitnessFile, witnessFiles } from "./backfill.ts";
import type { BackfillIO, BackfillOptions, Item } from "./backfill.ts";
import type { PutResult } from "../../services/attestor/src/publish.ts";
import type { AttestedRound } from "../../services/attestor/src/sources/chain.ts";
import { buildMarkRound } from "../../services/keeper/src/markRound.ts";
import type { MarkInputs } from "../../services/keeper/src/markRound.ts";
import { closureId, methodDigestOf, scorecardAbi } from "../../services/keeper/src/sources/scorecard.ts";
import type { CommittedRow } from "../../services/keeper/src/sources/scorecard.ts";
import { CLOCK, FIRST_ROUND_BLOCK, SCORECARD, SCORECARD_FROM_BLOCK } from "../curb-verify/src/tx.ts";
import type { Evidence } from "../curb-verify/src/tx.ts";
import { EXIT } from "../curb-verify/src/render.ts";

const FIX = (n: string) => fileURLToPath(new URL(`../../services/attestor/src/fixtures/${n}`, import.meta.url));
const hex = (n: number) => "0x" + n.toString(16);

interface ChainTx { hash: string; from: string; to: string; blockNumber: number; input: string; timestamp: number; logs?: Array<{ address: string; topics: string[]; data: string }> }

const fixture = (name: string) => {
  const tx = JSON.parse(readFileSync(FIX(`${name}.tx.json`), "utf8")) as ChainTx;
  const bytes = readFileSync(FIX(`${name}.bundle.json`));
  const root = JSON.parse(bytes.toString("utf8")).inputRoot.toLowerCase() as string;
  const round: AttestedRound = { txHash: tx.hash, blockNumber: tx.blockNumber, inputRoot: root, wrappers: ["0x41333Df9E7639188BBfca5522dC4844398Af9f9E"] };
  return { tx, bytes, root, round, key: `rounds/${root}.json` };
};
const A = fixture("round-70617365");
const B = fixture("round-70619137");

// ---- a mark, built by the keeper's code, committed by a real-shaped transaction --------------

const E18 = 10n ** 18n;
const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const POOL = "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f";
const CUT_MS = new Date("2026-09-22T11:56:00+08:00").getTime();
const REOPEN_S = Math.floor(new Date("2026-09-22T13:00:00+08:00").getTime() / 1000);
const EVAL_MS = new Date("2026-09-22T12:50:00+08:00").getTime();
const COMMIT_BLOCK = 71_300_000;
const COMMIT_AT_S = Math.floor(EVAL_MS / 1000) + 20;

function mark() {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const round = buildMarkRound({
    chainId: 196, clock: CLOCK, scorecard: SCORECARD, evaluatedAtMs: EVAL_MS, codeDigest: "sha256:test",
    specs: [{ wrapper: W, symbol: "wTCENTx", pool: POOL, equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 }],
    chain: {
      block: { number: COMMIT_BLOCK - 30, hash: "0x" + "11".repeat(32), timestamp: COMMIT_AT_S - 30, rpc: "https://rpc.xlayer.tech" },
      results: [{ label: `slot0:${POOL}`, target: POOL, callData: "0x3850c7bd", success: true, returnData: "0x" }],
    },
    closures: [{
      wrapper: W, symbol: "wTCENTx", cutAtMs: CUT_MS, cutBlock: COMMIT_BLOCK - 3800, settleAfterS: REOPEN_S,
      input: { wrapper: W, symbol: "wTCENTx", lastPrintE18: 54n * E18, midAtCutE18: 54n * E18, midNowE18: 5508n * E18 / 100n, closingVwapE18: 545n * E18 / 10n, swapsDuringClosure: 4 },
      closingSwaps: [{ blockNumber: COMMIT_BLOCK - 3900, logIndex: 3, equityAbs: E18, priceE18: 545n * E18 / 10n }],
      closureSwaps: [{ blockNumber: COMMIT_BLOCK - 2000, logIndex: 1, equityAbs: 2n * E18, priceE18: 5508n * E18 / 100n }],
      venue: {
        mic: "XHKG",
        assetUrl: "https://api.xstocks.fi/api/v2/public/assets/TCENTx?network=XLayer", assetBodyHash: "0x" + "ab".repeat(32),
        exchangeUrl: "https://api.xstocks.fi/api/v2/public/exchanges/XHKG", exchangeBodyHash: "0x" + "cd".repeat(32),
        cutAtMs: CUT_MS,
        limitsPerPeriod: { market: { maxOrderFiatValue: 2_000_000 }, extended: { maxOrderFiatValue: 0 }, overnight: { maxOrderFiatValue: 0 }, closed: { maxOrderFiatValue: 0 } },
        schedule: {
          timezone: "Asia/Hong_Kong", holidays: [],
          sessions: [
            { kind: "Extended", days, open: "09:00", close: "09:30" }, { kind: "Regular", days, open: "09:30", close: "12:00" },
            { kind: "Regular", days, open: "13:00", close: "16:00" }, { kind: "Extended", days, open: "16:00", close: "16:10" },
          ],
        },
        predictedReopenMs: REOPEN_S * 1000,
      },
    }],
  } as MarkInputs);
  const m = round.marks[0].mark;
  const id = closureId(W, REOPEN_S, round.root);
  const digest = methodDigestOf("curb.scorecard.mark/1");
  const hash = "0x" + "ee".repeat(32);
  const input = scorecardAbi.encodeFunctionData("commit", [{
    wrapper: W, committedAt: 0, committedBlock: 0, settleAfter: REOPEN_S, mark: m.markE18, bandBps: m.bandBps,
    inputRoot: round.root, methodDigest: digest, lastPrint: m.lastPrintE18, closingVwap: m.closingVwapE18, staleOracle: 0n,
  }]);
  const ev = scorecardAbi.encodeEventLog("ClosureCommitted", [id, W, m.markE18, m.bandBps, REOPEN_S, COMMIT_BLOCK, round.root, digest]);
  const tx: ChainTx = { hash, from: "0xd3d9bf9ff2a80aa13d9c0299fadc9775343a1af6", to: SCORECARD.toLowerCase(), blockNumber: COMMIT_BLOCK, input, timestamp: COMMIT_AT_S, logs: [{ address: SCORECARD.toLowerCase(), topics: ev.topics, data: ev.data }] };
  const row: CommittedRow = {
    id, wrapper: W, settleAfter: REOPEN_S, committedBlock: COMMIT_BLOCK, mark: m.markE18.toString(), bandBps: m.bandBps,
    inputRoot: round.root.toLowerCase(), methodDigest: digest, lastPrint: null, closingVwap: null, staleOracle: null, txHash: hash,
  };
  const bytes = Buffer.from(JSON.stringify(round.bundle));
  return { tx, row, bytes, key: `marks/${round.root.toLowerCase()}.json` };
}
const M = mark();

// ---- the fake world ----------------------------------------------------------------------

function world(o: {
  rounds?: AttestedRound[]; closures?: CommittedRow[]; txs?: ChainTx[];
  served?: Record<string, Uint8Array>; inArchive?: string[];
  put?: (key: string, n: number) => PutResult;
}) {
  const puts: Array<{ key: string; body: Buffer }> = [];
  const logs: string[] = [];
  const txs = new Map((o.txs ?? []).map((t) => [t.hash.toLowerCase(), t]));
  const io: BackfillIO = {
    rounds: async (f, t) => (o.rounds ?? []).filter((r) => r.blockNumber >= f && r.blockNumber <= t),
    closures: async (f, t) => (o.closures ?? []).filter((r) => r.committedBlock >= f && r.committedBlock <= t),
    deps: {
      async rpc<T>(method: string, params: unknown[]): Promise<T> {
        const t = txs.get(String(params[0]).toLowerCase());
        if (method === "eth_getTransactionByHash") return (t ? { ...t, blockNumber: hex(t.blockNumber) } : null) as T;
        if (method === "eth_getTransactionReceipt") {
          return (t ? { status: "0x1", blockNumber: hex(t.blockNumber), logs: (t.logs ?? []).map((l) => ({ ...l, blockNumber: hex(t.blockNumber), transactionHash: t.hash })) } : null) as T;
        }
        if (method === "eth_getBlockByNumber") {
          const b = [...txs.values()].find((x) => hex(x.blockNumber) === params[0]);
          return { timestamp: hex(b!.timestamp) } as T;
        }
        if (method === "eth_call") return scorecardAbi.encodeFunctionResult("settlements", [0, 0, 0, 0, 0, 0, 0, 0, false]) as T;
        throw new Error(method);
      },
      async evidence(key: string): Promise<Evidence> {
        const b = o.served?.[key];
        return b ? { ok: true, text: Buffer.from(b).toString("utf8"), source: `https://host-a.test/${key}`, bytes: new Uint8Array(b) } : { ok: false, tried: [`https://host-a.test/${key}: HTTP 404`] };
      },
    },
    inArchive: async (key) => (o.inArchive ?? []).includes(key),
    async put(key, body) {
      puts.push({ key, body: Buffer.from(body) });
      return o.put ? o.put(key, puts.filter((p) => p.key === key).length) : { ok: true, status: 200, existed: false };
    },
    log: (s) => { logs.push(s); },
  };
  return { io, puts, logs };
}

const OPTS: BackfillOptions = {
  roundsFrom: FIRST_ROUND_BLOCK, marksFrom: SCORECARD_FROM_BLOCK, to: 71_400_000,
  dryRun: false, writeIndex: true, concurrency: 3, window: 50_000, retryMs: 0, now: () => Date.UTC(2026, 8, 25),
};
const byKey = (items: Item[]) => Object.fromEntries(items.map((i) => [i.key, i.status]));

// ---------------------------------------------------------------------------------------------

test("a full run checks each write, uploads the exact bytes it checked, skips what the archive serves, and rewrites the index", async () => {
  const present: AttestedRound = { txHash: "0x" + "cc".repeat(32), blockNumber: 70_700_000, inputRoot: "0x" + "dd".repeat(32), wrappers: [] };
  const w = world({
    rounds: [B.round, A.round, present], closures: [M.row], txs: [A.tx, B.tx, M.tx],
    served: { [A.key]: A.bytes, [B.key]: B.bytes, [M.key]: M.bytes }, inArchive: [`rounds/${present.inputRoot}.json`],
    put: (key) => (key === B.key ? { ok: true, status: 412, existed: true } : { ok: true, status: 200, existed: false }),
  });
  const r = await backfill(OPTS, w.io);
  assert.equal(r.exit, EXIT.VERIFIED, JSON.stringify(r.items));
  assert.deepEqual(byKey(r.items), {
    [A.key]: "uploaded", [B.key]: "already", [`rounds/${present.inputRoot}.json`]: "present", [M.key]: "uploaded",
    "index/rounds.ndjson": "uploaded", "index/marks.ndjson": "uploaded", "index/latest.json": "uploaded",
  });
  const body = (key: string) => w.puts.find((p) => p.key === key)!.body;
  assert.ok(body(A.key).equals(A.bytes), "byte for byte what host A served and the check passed");
  assert.ok(body(M.key).equals(M.bytes));
  assert.equal(w.puts.filter((p) => p.key === `rounds/${present.inputRoot}.json`).length, 0, "an archived round is not re-uploaded");

  const lines = body("index/rounds.ndjson").toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.block, l.archived]), [[70_617_365, true], [70_619_137, true], [70_700_000, true]], "oldest first, all archived");
  const latest = JSON.parse(body("index/latest.json").toString("utf8"));
  assert.equal(latest.schema, "curb.archive.index/1");
  assert.equal(latest.rounds.count, 3);
  assert.equal(latest.marks.count, 1);
  assert.equal(latest.marks.latest.tx, M.tx.hash);
  assert.equal(latest.scannedToBlock, 71_400_000);
  assert.equal(latest.generatedAt, "2026-09-25T00:00:00.000Z");
});

test("a bundle that does not reproduce is reported and never reaches the locked prefix", async () => {
  const tampered = JSON.parse(B.bytes.toString("utf8"));
  tampered.json[Object.keys(tampered.json)[0]] = JSON.stringify({ tampered: true });
  const w = world({ rounds: [A.round, B.round], txs: [A.tx, B.tx], served: { [A.key]: A.bytes, [B.key]: Buffer.from(JSON.stringify(tampered)) } });
  const r = await backfill({ ...OPTS, writeIndex: false }, w.io);
  assert.equal(r.exit, EXIT.NOT_REPRODUCED);
  assert.equal(byKey(r.items)[B.key], "not-reproduced");
  assert.equal(byKey(r.items)[A.key], "uploaded");
  assert.deepEqual(w.puts.map((p) => p.key), [A.key]);
});

test("--dry-run checks everything and uploads nothing", async () => {
  const w = world({ rounds: [A.round], closures: [M.row], txs: [A.tx, M.tx], served: { [A.key]: A.bytes, [M.key]: M.bytes } });
  const r = await backfill({ ...OPTS, dryRun: true }, w.io);
  assert.equal(r.exit, EXIT.VERIFIED);
  assert.deepEqual(byKey(r.items), { [A.key]: "would-upload", [M.key]: "would-upload" });
  assert.equal(w.puts.length, 0);
  assert.ok(r.index, "the index it would write is still built, for inspection");
});

test("marks without a local copy are unavailable (3), and the index says they are not archived", async () => {
  const w = world({ rounds: [A.round], closures: [M.row], txs: [A.tx, M.tx], served: { [A.key]: A.bytes } });
  const r = await backfill(OPTS, w.io);
  assert.equal(r.exit, EXIT.UNAVAILABLE);
  assert.equal(byKey(r.items)[M.key], "unavailable");
  const marks = w.puts.find((p) => p.key === "index/marks.ndjson")!.body.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(marks.map((m) => [m.tx, m.archived]), [[M.tx.hash, false]]);
});

test("a scan that did not start at the first block never writes the index", async () => {
  const w = world({ rounds: [A.round, B.round], txs: [A.tx, B.tx], served: { [A.key]: A.bytes, [B.key]: B.bytes } });
  const r = await backfill({ ...OPTS, roundsFrom: 70_619_000 }, w.io);
  assert.equal(r.index, null);
  assert.deepEqual(w.puts.map((p) => p.key), [B.key]);
  assert.ok(w.logs.some((l) => /index: skipped/.test(l)));
});

test("a transient PUT failure is retried; a refusal is put-failed and fails the run", async () => {
  const flaky = world({ rounds: [A.round], txs: [A.tx], served: { [A.key]: A.bytes }, put: (_k, n) => (n < 3 ? { ok: false, status: 503, existed: false, error: "HTTP 503" } : { ok: true, status: 200, existed: false }) });
  const r1 = await backfill({ ...OPTS, writeIndex: false }, flaky.io);
  assert.equal(byKey(r1.items)[A.key], "uploaded");
  assert.equal(flaky.puts.length, 3);

  const refused = world({ rounds: [A.round], txs: [A.tx], served: { [A.key]: A.bytes }, put: () => ({ ok: false, status: 403, existed: false, error: "HTTP 403 AccessDenied" }) });
  const r2 = await backfill({ ...OPTS, writeIndex: false }, refused.io);
  assert.equal(r2.exit, EXIT.NOT_REPRODUCED);
  assert.equal(refused.puts.length, 1, "a 403 is not retried");
  assert.deepEqual(r2.items.map((i) => [i.status, i.detail]), [["put-failed", "HTTP 403 AccessDenied"]]);
});

test("a scan window that keeps failing stops the run before anything is uploaded", async () => {
  const w = world({ rounds: [A.round], txs: [A.tx], served: { [A.key]: A.bytes } });
  let calls = 0;
  w.io.rounds = async () => { calls++; throw new Error("no RPC could serve logs"); };
  await assert.rejects(backfill(OPTS, w.io), /rounds scan of .* failed 4 times/);
  assert.ok(calls >= 4, "each window is tried four times before the run gives up");
  assert.equal(w.puts.length, 0);
});

// ---- witness statements --------------------------------------------------------------------

const WITNESS = readFileSync(new URL("./fixtures/witness-70619137.test-key.json", import.meta.url));
const wdoc = JSON.parse(WITNESS.toString("utf8"));

test("witness: a statement signed by an expected key, filed under its own root and tx, is archived", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-witness-"));
  try {
    mkdirSync(join(dir, "tx"));
    writeFileSync(join(dir, `${wdoc.message.inputRoot}.json`), WITNESS);
    writeFileSync(join(dir, "tx", `${wdoc.message.txHash}.json`), WITNESS);
    writeFileSync(join(dir, "state.json"), "{}"); // host B's cursor file: not evidence, never uploaded
    assert.deepEqual(witnessFiles(dir).map((f) => f.key).sort(), [`witness/${wdoc.message.inputRoot}.json`, `witness/tx/${wdoc.message.txHash}.json`]);
    const w = world({});
    const r = await backfill({ ...OPTS, writeIndex: false, witnessDir: dir, expectedSigners: [wdoc.signer] }, w.io);
    assert.equal(r.exit, EXIT.VERIFIED, JSON.stringify(r.items));
    assert.deepEqual(w.puts.map((p) => p.key).sort(), [`witness/${wdoc.message.inputRoot}.json`, `witness/tx/${wdoc.message.txHash}.json`]);
    assert.ok(w.puts.every((p) => p.body.equals(WITNESS)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("witness: a forged, misfiled or foreign statement is refused", () => {
  const root = wdoc.message.inputRoot as string;
  assert.equal(checkWitnessFile(WITNESS, root, false, [wdoc.signer]), null);
  assert.match(checkWitnessFile(WITNESS, root, false, ["0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4"])!.detail, /not a Curb attestor/);
  assert.match(checkWitnessFile(WITNESS, "0x" + "00".repeat(32), false, [wdoc.signer])!.detail, /filed as/);
  assert.match(checkWitnessFile(WITNESS, root, true, [wdoc.signer])!.detail, /filed as/, "the root file is not the tx file");
  const forged = { ...wdoc, message: { ...wdoc.message, reproduced: !wdoc.message.reproduced } };
  assert.equal(checkWitnessFile(Buffer.from(JSON.stringify(forged)), root, false, [wdoc.signer])!.status, "not-reproduced");
  assert.equal(checkWitnessFile(Buffer.from('{"schema":"other/1"}'), root, false, [wdoc.signer])!.status, "unsupported");
});
