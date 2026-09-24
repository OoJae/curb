/**
 * `tx` and `range`, offline. The chain and the archive are fakes serving REAL mainnet data (the two
 * fixture rounds) or a mark bundle built by the keeper's own code, so every verdict comes from the
 * production check and only the transport is simulated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./render.ts";
import {
  CLOCK, FIRST_ROUND_BLOCK, SCORECARD, SCORECARD_FROM_BLOCK, checkUrl, mapLimit, parseRange, verifyTx, worstExit, writesInRange,
} from "./tx.ts";
import type { Deps, Evidence } from "./tx.ts";
import { buildMarkRound } from "../../../services/keeper/src/markRound.ts";
import type { MarkInputs } from "../../../services/keeper/src/markRound.ts";
import { closureId, methodDigestOf, scorecardAbi } from "../../../services/keeper/src/sources/scorecard.ts";

const FIX = (n: string) => fileURLToPath(new URL(`../../../services/attestor/src/fixtures/${n}`, import.meta.url));
const fixtureTx = (name: string) => JSON.parse(readFileSync(FIX(`${name}.tx.json`), "utf8")) as { hash: string; from: string; to: string; blockNumber: number; input: string; timestamp: number };
const fixtureBundle = (name: string) => readFileSync(FIX(`${name}.bundle.json`), "utf8");
const hex = (n: number) => "0x" + n.toString(16);
const BUILDER_SUFFIX = "6464377535306e636b74356537323966100080218021802180218021802180218021";

interface Chain {
  tx: { hash: string; from: string; to: string | null; blockNumber: number; input: string };
  status?: string;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
  timestamp: number;
  settlements?: string;
}

function deps(chain: Chain | null, served: Record<string, string>, calls: string[] = []): Deps {
  return {
    async rpc<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(method);
      const want = String(params[0]).toLowerCase();
      if (method === "eth_getTransactionByHash") {
        if (!chain || chain.tx.hash.toLowerCase() !== want) return null as T;
        return { ...chain.tx, blockNumber: hex(chain.tx.blockNumber) } as T;
      }
      if (method === "eth_getTransactionReceipt") {
        if (!chain || chain.tx.hash.toLowerCase() !== want) return null as T;
        return {
          status: chain.status ?? "0x1", blockNumber: hex(chain.tx.blockNumber),
          logs: (chain.logs ?? []).map((l) => ({ ...l, blockNumber: hex(chain.tx.blockNumber), transactionHash: chain.tx.hash })),
        } as T;
      }
      if (method === "eth_getBlockByNumber") return { timestamp: hex(chain!.timestamp) } as T;
      if (method === "eth_call") return chain!.settlements as T;
      throw new Error(`unexpected ${method}`);
    },
    async evidence(key: string): Promise<Evidence> {
      if (served[key] !== undefined) return { ok: true, text: served[key], source: `https://archive.test/${key}` };
      return { ok: false, tried: [`https://archive.test/${key}: HTTP 404`] };
    },
  };
}

const roundChain = (name: string, input?: string): Chain => {
  const t = fixtureTx(name);
  return { tx: { hash: t.hash, from: t.from, to: t.to, blockNumber: t.blockNumber, input: input ?? t.input }, timestamp: t.timestamp };
};
const rootOf = (name: string) => JSON.parse(fixtureBundle(name)).inputRoot.toLowerCase() as string;

// ---------------------------------------------------------------------------------------------
// rounds: real mainnet writes
// ---------------------------------------------------------------------------------------------

test("tx: a real MarketClock round reproduces from its hash alone", async () => {
  const v = await verifyTx(fixtureTx("round-70619137").hash, deps(roundChain("round-70619137"), { [`rounds/${rootOf("round-70619137")}.json`]: fixtureBundle("round-70619137") }));
  assert.equal(v.exit, EXIT.VERIFIED, JSON.stringify(v.check?.failures));
  assert.equal(v.kind, "round");
  assert.equal(v.inputRoot, rootOf("round-70619137"));
  assert.equal(v.check!.labelsConsistent, true);
  assert.equal(v.text, fixtureBundle("round-70619137"), "the exact bytes served are kept, for the backfill");
  assert.ok(v.fields.some(([k, x]) => k === "claims" && /TCENTx:/.test(x)));
});

test("tx: the first round Curb ever wrote reproduces, and its wrong label is surfaced, not fatal", async () => {
  const v = await verifyTx(fixtureTx("round-70617365").hash, deps(roundChain("round-70617365"), { [`rounds/${rootOf("round-70617365")}.json`]: fixtureBundle("round-70617365") }));
  assert.equal(v.exit, EXIT.VERIFIED);
  assert.equal(v.check!.labelsConsistent, false);
  assert.match(v.check!.labelFailures.join(), /top-level kind/);
});

test("tx: a round whose calldata carries the Builder Code suffix still reproduces", async () => {
  const t = fixtureTx("round-70619137");
  const v = await verifyTx(t.hash, deps(roundChain("round-70619137", t.input + BUILDER_SUFFIX), { [`rounds/${rootOf("round-70619137")}.json`]: fixtureBundle("round-70619137") }));
  assert.equal(v.exit, EXIT.VERIFIED, JSON.stringify(v.check?.failures));
});

test("tx: a tampered bundle is NOT reproduced (1), with every failure listed", async () => {
  const b = JSON.parse(fixtureBundle("round-70619137"));
  b.json[Object.keys(b.json)[0]] = JSON.stringify({ tampered: true });
  const v = await verifyTx(fixtureTx("round-70619137").hash, deps(roundChain("round-70619137"), { [`rounds/${rootOf("round-70619137")}.json`]: JSON.stringify(b) }));
  assert.equal(v.exit, EXIT.NOT_REPRODUCED);
  assert.ok(v.check!.failures.length >= 1);
});

test("tx: the root comes from the chain, so another round's genuine bundle does not pass for this one", async () => {
  const v = await verifyTx(fixtureTx("round-70619137").hash, deps(roundChain("round-70619137"), { [`rounds/${rootOf("round-70619137")}.json`]: fixtureBundle("round-70617365") }));
  assert.equal(v.exit, EXIT.NOT_REPRODUCED);
  assert.match(v.check!.failures.join(), /calldata inputRoot/);
});

test("tx: no archive serving the bundle is unavailable (3), never an accusation", async () => {
  const v = await verifyTx(fixtureTx("round-70619137").hash, deps(roundChain("round-70619137"), {}));
  assert.equal(v.exit, EXIT.UNAVAILABLE);
  assert.match(v.message!, /no archive served rounds\/0x[0-9a-f]{64}\.json .*HTTP 404/);
});

test("tx: an unknown schema at the committed root is unsupported (4); a mark bundle there is not reproduced (1)", async () => {
  const key = `rounds/${rootOf("round-70619137")}.json`;
  const unknown = await verifyTx(fixtureTx("round-70619137").hash, deps(roundChain("round-70619137"), { [key]: '{"schema":"curb.marketclock.bundle/9"}' }));
  assert.equal(unknown.exit, EXIT.UNSUPPORTED);
  const { round } = markRow();
  const wrongKind = await verifyTx(fixtureTx("round-70619137").hash, deps(roundChain("round-70619137"), { [key]: JSON.stringify(round.bundle) }));
  assert.equal(wrongKind.exit, EXIT.NOT_REPRODUCED);
  assert.match(wrongKind.check!.failures.join(), /is a mark document/);
});

test("tx: not a Curb write, a reverted write, an unknown hash, a dead RPC, a malformed hash", async () => {
  const other = roundChain("round-70619137");
  other.tx.to = "0x" + "22".repeat(20);
  assert.equal((await verifyTx(other.tx.hash, deps(other, {}))).exit, EXIT.UNSUPPORTED);

  const reverted = { ...roundChain("round-70619137"), status: "0x0" };
  const r = await verifyTx(reverted.tx.hash, deps(reverted, {}));
  assert.equal(r.exit, EXIT.UNSUPPORTED);
  assert.match(r.message!, /reverted/);

  assert.equal((await verifyTx("0x" + "99".repeat(32), deps(roundChain("round-70619137"), {}))).exit, EXIT.UNAVAILABLE);

  const dead: Deps = { rpc: async () => { throw new Error("ECONNREFUSED"); }, evidence: async () => ({ ok: false, tried: [] }) };
  assert.equal((await verifyTx("0x" + "99".repeat(32), dead)).exit, EXIT.UNAVAILABLE);

  for (const bad of ["", "0x1234", "8e87d0f08af4025a742c377dce985449b3b131b3a61e64b0bb793b822fcd47e1", "0x" + "zz".repeat(32)]) {
    assert.equal((await verifyTx(bad, deps(null, {}))).exit, EXIT.USAGE, bad);
  }
});

// ---------------------------------------------------------------------------------------------
// marks: a bundle built by the keeper's own code, committed by a real-shaped transaction
// ---------------------------------------------------------------------------------------------

const E18 = 10n ** 18n;
const W = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const POOL = "0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f";
const CUT_MS = new Date("2026-09-22T11:56:00+08:00").getTime();
const REOPEN_S = Math.floor(new Date("2026-09-22T13:00:00+08:00").getTime() / 1000);
const EVAL_MS = new Date("2026-09-22T12:50:00+08:00").getTime();
const COMMIT_BLOCK = 71_300_000;
const COMMIT_AT_S = Math.floor(EVAL_MS / 1000) + 20;
const METHOD = "curb.scorecard.mark/1";

function markInputs(): MarkInputs {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  return {
    chainId: 196, clock: CLOCK, scorecard: SCORECARD, evaluatedAtMs: EVAL_MS, codeDigest: "sha256:test",
    specs: [{ wrapper: W, symbol: "wTCENTx", pool: POOL, equityIsToken0: true, equityDecimals: 18, stableDecimals: 6 }],
    chain: {
      block: { number: COMMIT_BLOCK - 30, hash: "0x" + "11".repeat(32), timestamp: COMMIT_AT_S - 30, rpc: "https://rpc.xlayer.tech" },
      results: [{ label: `slot0:${POOL}`, target: POOL, callData: "0x3850c7bd", success: true, returnData: "0x" }],
    },
    closures: [{
      wrapper: W, symbol: "wTCENTx", cutAtMs: CUT_MS, cutBlock: COMMIT_BLOCK - 3800, settleAfterS: REOPEN_S,
      input: {
        wrapper: W, symbol: "wTCENTx", lastPrintE18: 54n * E18, midAtCutE18: 54n * E18, midNowE18: 5508n * E18 / 100n,
        closingVwapE18: 545n * E18 / 10n, swapsDuringClosure: 4,
      },
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
  } as MarkInputs;
}

function markRow(markOverride?: bigint) {
  const round = buildMarkRound(markInputs());
  const m = round.marks[0].mark;
  const mark = markOverride ?? m.markE18;
  const id = closureId(W, REOPEN_S, round.root);
  const hash = "0x" + "ee".repeat(32);
  const input = scorecardAbi.encodeFunctionData("commit", [{
    wrapper: W, committedAt: 0, committedBlock: 0, settleAfter: REOPEN_S, mark, bandBps: m.bandBps,
    inputRoot: round.root, methodDigest: methodDigestOf(METHOD), lastPrint: m.lastPrintE18, closingVwap: m.closingVwapE18, staleOracle: 0n,
  }]) + BUILDER_SUFFIX;
  const ev = scorecardAbi.encodeEventLog("ClosureCommitted", [id, W, mark, m.bandBps, REOPEN_S, COMMIT_BLOCK, round.root, methodDigestOf(METHOD)]);
  const chain: Chain = {
    tx: { hash, from: "0xd3d9bf9ff2a80aa13d9c0299fadc9775343a1af6", to: SCORECARD.toLowerCase(), blockNumber: COMMIT_BLOCK, input },
    logs: [{ address: SCORECARD.toLowerCase(), topics: ev.topics, data: ev.data }],
    timestamp: COMMIT_AT_S,
    settlements: scorecardAbi.encodeFunctionResult("settlements", [0, 0, 0, 0, 0, 0, 0, 0, false]),
  };
  return { round, chain, hash, key: `marks/${round.root.toLowerCase()}.json` };
}

test("tx: a Scorecard commit is checked against its mark bundle with checkMarkRound", async () => {
  const { round, chain, hash, key } = markRow();
  const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
  assert.equal(v.exit, EXIT.VERIFIED, JSON.stringify(v.check?.failures));
  assert.equal(v.kind, "mark");
  assert.equal(v.inputRoot, round.root.toLowerCase());
  assert.ok(v.fields.some(([k, x]) => k === "row" && x.startsWith("wTCENTx  mark 54.5400  band 125 bps")), JSON.stringify(v.fields));
  assert.ok(v.fields.some(([k, x]) => k === "settled" && x === "not yet"));
});

test("tx: a commit that writes a different mark than its bundle derives is NOT reproduced", async () => {
  const { round, chain, hash, key } = markRow(1n * E18);
  const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
  assert.equal(v.exit, EXIT.NOT_REPRODUCED);
  assert.match(v.check!.failures.join(), /mark/);
});

test("tx: a mark not yet in any archive is unavailable (3)", async () => {
  const { chain, hash } = markRow();
  const v = await verifyTx(hash, deps(chain, {}));
  assert.equal(v.exit, EXIT.UNAVAILABLE);
  assert.match(v.message!, /no archive served marks\//);
});

// ---------------------------------------------------------------------------------------------
// range, and the small pure pieces
// ---------------------------------------------------------------------------------------------

test("range: rounds and marks merged oldest first, each contract scanned only from its own first block", async () => {
  const asked: string[] = [];
  const writes = await writesInRange(70_000_000, 71_300_000, {
    rounds: async (f, t) => { asked.push(`rounds ${f}..${t}`); return [{ txHash: "0xB", blockNumber: 71_250_000 }, { txHash: "0xA", blockNumber: 70_700_000 }]; },
    closures: async (f, t) => { asked.push(`closures ${f}..${t}`); return [{ txHash: "0xC", committedBlock: 71_240_000 }, { txHash: "0xb", committedBlock: 71_250_000 }]; },
  });
  assert.deepEqual(asked.sort(), [`closures ${SCORECARD_FROM_BLOCK}..71300000`, `rounds ${FIRST_ROUND_BLOCK}..71300000`]);
  assert.deepEqual(writes, [
    { tx: "0xa", block: 70_700_000, kind: "round" },
    { tx: "0xc", block: 71_240_000, kind: "mark" },
    { tx: "0xb", block: 71_250_000, kind: "round" },
  ], "a hash reported twice is one write");
  const none = await writesInRange(1, 2, { rounds: async () => { throw new Error("not called"); }, closures: async () => { throw new Error("not called"); } });
  assert.deepEqual(none, []);
});

test("range: the exit code is the worst item's, with not-reproduced first", () => {
  assert.equal(worstExit([]), EXIT.VERIFIED);
  assert.equal(worstExit([0, 0]), EXIT.VERIFIED);
  assert.equal(worstExit([0, 3]), EXIT.UNAVAILABLE);
  assert.equal(worstExit([3, 4, 0]), EXIT.UNSUPPORTED);
  assert.equal(worstExit([3, 4, 1, 0]), EXIT.NOT_REPRODUCED);
});

test("range syntax", () => {
  assert.deepEqual(parseRange("70617365..70620000"), { from: 70617365, to: 70620000 });
  assert.deepEqual(parseRange("70,617,365..latest"), { from: 70617365, to: "latest" });
  assert.deepEqual(parseRange("70_617_365..70_617_365"), { from: 70617365, to: 70617365 });
  for (const bad of ["", "5", "5..", "..5", "5..3", "a..b", "5...6", "-1..3"]) assert.equal(parseRange(bad), null, bad);
});

test("mapLimit keeps order and never exceeds its limit", async () => {
  let inFlight = 0, peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (x) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, x * 3));
    inFlight--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
});

test("archives and RPCs must be https, or plain http on loopback only", () => {
  assert.equal(checkUrl("https://archive.curb.markets"), null);
  assert.equal(checkUrl("http://127.0.0.1:8092"), null);
  assert.equal(checkUrl("http://localhost:8091"), null);
  assert.match(checkUrl("http://archive.curb.markets")!, /refusing http:/);
  assert.match(checkUrl("file:///etc/passwd")!, /refusing file:/);
  assert.match(checkUrl("not a url")!, /not a URL/);
});

// ---------------------------------------------------------------------------------------------
// the real binary, and the published layout
// ---------------------------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { encoding: "utf8", timeout: 60_000 });

test("cli: tx and range usage errors are exit 2; an unreachable RPC is exit 3", () => {
  assert.equal(run("tx").status, EXIT.USAGE);
  assert.equal(run("tx", "0x1234").status, EXIT.USAGE);
  assert.equal(run("range", "5..3").status, EXIT.USAGE);
  assert.equal(run("range").status, EXIT.USAGE);
  const insecure = run("tx", "0x" + "11".repeat(32), "--archive", "http://archive.curb.markets");
  assert.equal(insecure.status, EXIT.USAGE);
  assert.match(insecure.stderr, /refusing http:/);
  const dead = run("tx", "0x" + "11".repeat(32), "--rpc", "http://127.0.0.1:9", "--json");
  assert.equal(dead.status, EXIT.UNAVAILABLE, dead.stdout + dead.stderr);
  const o = JSON.parse(dead.stdout.trim());
  assert.equal(o.exit, EXIT.UNAVAILABLE);
  assert.equal(o.ok, false);
});

test("cli: a range below Curb's first write has no writes and exits 0 without touching the network", () => {
  const r = run("range", "1..2", "--rpc", "http://127.0.0.1:9", "--json");
  assert.equal(r.status, EXIT.VERIFIED, r.stderr);
  const summary = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  assert.equal(summary.kind, "range");
  assert.equal(summary.writes, 0);
});

test("published layout: installed under node_modules/, the bin launcher runs where a bare .ts entry cannot", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "curb-verify-pkg-"));
  try {
    const pkg = join(tmp, "node_modules", "curb-verify");
    const notTests = (p: string) => !p.endsWith(".test.ts") && !p.includes("node_modules");
    for (const d of ["tools/curb-verify/bin", "tools/curb-verify/src", "services/attestor/src", "services/keeper/src"]) {
      cpSync(join(repo, d), join(pkg, d), { recursive: true, filter: notTests });
    }
    cpSync(join(repo, "package.json"), join(pkg, "package.json"));
    symlinkSync(join(repo, "services", "attestor", "node_modules"), join(pkg, "node_modules"), "dir");

    const direct = spawnSync(process.execPath, [join(pkg, "tools/curb-verify/src/cli.ts"), "selftest"], { encoding: "utf8", timeout: 60_000 });
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/, "why the launcher exists");

    const viaBin = spawnSync(process.execPath, [join(pkg, "tools/curb-verify/bin/curb-verify.mjs"), "selftest"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(viaBin.status, EXIT.VERIFIED, viaBin.stdout + viaBin.stderr);
    assert.match(viaBin.stdout, /selftest passed/);
    assert.doesNotMatch(viaBin.stderr, /ExperimentalWarning/, "no noise on a judge's terminal");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
