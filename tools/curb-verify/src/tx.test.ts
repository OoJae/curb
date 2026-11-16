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
  CLOCK, FIRST_ROUND_BLOCK, SCORECARD, SCORECARD_FROM_BLOCK, checkUrl, mapLimit, parseRange, priceSourcesAbi, verifyTx, worstExit, writesInRange,
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
  /** What `eth_getBlockByNumber("latest")` answers; defaults to `timestamp`. A string makes the read fail. */
  latestTimestamp?: number | "fail";
  /** The answer to Scorecard.priceSources(wrapper); a string is returned as raw data, "fail" throws. */
  priceSource?: [string, boolean, number, number, number] | string;
}

const PRICE_SOURCES = priceSourcesAbi.getFunction("priceSources")!.selector;

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
      if (method === "eth_getBlockByNumber") {
        if (params[0] !== "latest") return { timestamp: hex(chain!.timestamp) } as T;
        if (chain!.latestTimestamp === "fail") throw new Error("latest block unavailable");
        return { timestamp: hex(chain!.latestTimestamp ?? chain!.timestamp) } as T;
      }
      if (method === "eth_call") {
        const data = String((params[0] as { data: string }).data);
        if (data.startsWith(PRICE_SOURCES)) {
          const p = chain!.priceSource;
          if (p === "fail") throw new Error("eth_call failed");
          if (typeof p === "string") return p as T;
          return priceSourcesAbi.encodeFunctionResult("priceSources", p ?? [POOL, true, 120, 18, 6]) as T;
        }
        return chain!.settlements as T;
      }
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
    // Block 71,300,000 is inside mark/1's range, so the row is built and committed as mark/1.
    method: METHOD,
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
  assert.ok(v.fields.some(([k, x]) => k === "settled" && x.startsWith("not yet")), JSON.stringify(v.fields));
  // A row read at block 71,299,970 is pre-fix: its swap lists are not checked, and the output says so.
  assert.ok(v.fields.some(([k, x]) => k === "swaps" && x === "not recorded (pre-fix keeper)"), JSON.stringify(v.fields));
  assert.equal(v.check!.evidence!.era, "pre-swap-fix");
  assert.ok(v.check!.evidence!.notes[0].startsWith("pre-fix row"));
  assert.deepEqual(v.check!.warnings, []);
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

// ---------------------------------------------------------------------------------------------
// deploy 2: the settle window, the price source, and strict swap evidence
// ---------------------------------------------------------------------------------------------

const field = (v: { fields: Array<[string, string]> }, k: string) => v.fields.find(([x]) => x === k)?.[1];
const DEADLINE = "2026-09-22T11:05:00Z";   // settleAfter 05:00:00Z + SETTLE_DELAY 300 s + SETTLE_WINDOW 6 h

test("tx: an open unsettled row says until when", async () => {
  const { round, chain, hash, key } = markRow();
  const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
  assert.equal(field(v, "settled"), `not yet (window open until ${DEADLINE})`);
  assert.equal(v.exit, EXIT.VERIFIED);
});

test("tx: an expired unsettled row says so (row 151: TooLate, never graded)", async () => {
  const { round, chain, hash, key } = markRow();
  chain.latestTimestamp = REOPEN_S + 300 + 21_600 + 1;
  const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
  assert.equal(field(v, "settled"), `not settled; settle window closed ${DEADLINE} (TooLate: this row can no longer be graded)`);
  assert.equal(v.exit, EXIT.VERIFIED, "the row still reproduces; it was never graded");
  // At the deadline second itself the contract still accepts a settle.
  chain.latestTimestamp = REOPEN_S + 300 + 21_600;
  assert.match(field(await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) })), "settled")!, /^not yet/);
});

test("tx: a failed latest-block read keeps the cautious 'not yet'", async () => {
  const { round, chain, hash, key } = markRow();
  chain.latestTimestamp = "fail";
  const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
  assert.equal(field(v, "settled"), "not yet");
  assert.equal(v.exit, EXIT.VERIFIED);
});

test("tx: a REGISTRY that disagrees with priceSources fails", async () => {
  const { round, chain, hash, key } = markRow();
  chain.priceSource = ["0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", true, 120, 18, 6];
  const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
  assert.equal(v.exit, EXIT.NOT_REPRODUCED);
  assert.match(v.check!.failures.join(), /REGISTRY entry for wTCENTx \(pool, equityIsToken0, decimals\) is not Scorecard\.priceSources/);
  chain.priceSource = [POOL, false, 120, 18, 6];
  assert.equal((await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }))).exit, EXIT.NOT_REPRODUCED, "the side matters as much as the pool");
});

test("tx: an unreadable or empty priceSources is a warning, never a failure", async () => {
  for (const p of ["fail", "0x", ["0x0000000000000000000000000000000000000000", false, 0, 0, 0]] as const) {
    const { round, chain, hash, key } = markRow();
    chain.priceSource = p as Chain["priceSource"];
    const v = await verifyTx(hash, deps(chain, { [key]: JSON.stringify(round.bundle) }));
    assert.equal(v.exit, EXIT.VERIFIED, JSON.stringify(p));
    assert.ok(v.check!.warnings.some((w) => w.includes("priceSources")), JSON.stringify(v.check!.warnings));
  }
});

import { assembleSwapEvidence } from "../../../services/keeper/src/evidence.ts";
import { RECESS, RECESS_ROOT_OF, inputsFromBundle, loadBundle, recessRows } from "../../../services/keeper/src/fixtures/markFixtures.test.ts";

/** The 13 Nov wXIAOx recess round rebuilt with assembled swap evidence (spec W4a.2), committed 20 blocks after its read. */
function strictRow() {
  const XIAO = "0x076CF393E701839FC7a5832D2c68AaFA235682AE";
  const MARK2 = "curb.scorecard.mark/2";
  const i = inputsFromBundle(loadBundle(RECESS_ROOT_OF.wXIAOx));
  const c = i.closures[0];
  const ev = assembleSwapEvidence({
    symbol: "wXIAOx", pool: "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", cutBlock: RECESS.cutBlock, cutBlockHash: null, cutRead: null,
    pinnedBlock: RECESS.pinnedBlock, closingWindowMs: 900_000, rows: recessRows("wXIAOx"), ranges: [[RECESS.closingFrom, RECESS.pinnedBlock]],
    midAtCutE18: c.input.midAtCutE18, midNowE18: c.input.midNowE18, preCutMidE18: c.input.lastPrintE18, mustCommit: false,
  });
  if (ev.kind !== "commit") throw new Error(`fixture did not assemble: ${ev.kind}`);
  c.input = { ...c.input, ...ev.input };
  c.closingSwaps = ev.closingSwaps;
  c.closureSwaps = ev.closureSwaps;
  c.swapEvidence = ev.swapEvidence;
  const round = buildMarkRound(i);
  const m = round.marks[0].mark;
  const block = RECESS.pinnedBlock + 20;
  const id = closureId(XIAO, c.settleAfterS, round.root);
  const hash = "0x" + "dd".repeat(32);
  const input = scorecardAbi.encodeFunctionData("commit", [{
    wrapper: XIAO, committedAt: 0, committedBlock: 0, settleAfter: c.settleAfterS, mark: m.markE18, bandBps: m.bandBps,
    inputRoot: round.root, methodDigest: methodDigestOf(MARK2), lastPrint: m.lastPrintE18, closingVwap: m.closingVwapE18, staleOracle: 0n,
  }]);
  const log = scorecardAbi.encodeEventLog("ClosureCommitted", [id, XIAO, m.markE18, m.bandBps, c.settleAfterS, block, round.root, methodDigestOf(MARK2)]);
  const chain: Chain = {
    tx: { hash, from: "0xd3d9bf9ff2a80aa13d9c0299fadc9775343a1af6", to: SCORECARD.toLowerCase(), blockNumber: block, input },
    logs: [{ address: SCORECARD.toLowerCase(), topics: log.topics, data: log.data }],
    timestamp: Math.floor(i.evaluatedAtMs / 1000) + 12,
    settlements: scorecardAbi.encodeFunctionResult("settlements", [0, 0, 0, 0, 0, 0, 0, 0, false]),
    priceSource: ["0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417", true, 120, 18, 6],
  };
  return { round, chain, hash, key: `marks/${round.root.toLowerCase()}.json` };
}

test("tx: a strict row reproduces and shows what its swap evidence covers", async () => {
  const { round, chain, hash, key } = strictRow();
  const d = { ...deps(chain, { [key]: JSON.stringify(round.bundle) }), swapEvidenceFromBlock: RECESS.pinnedBlock - 100 };
  const v = await verifyTx(hash, d);
  assert.equal(v.exit, EXIT.VERIFIED, JSON.stringify(v.check?.failures));
  assert.equal(field(v, "swaps"), "closing 9 in 75772220..75773120, closure 14 in 75773121..75776392");
  assert.equal(field(v, "flags"), "recess-no-edge");
  assert.equal(field(v, "drift"), "-24 bp");
  assert.equal(v.check!.evidence!.era, "swap-evidence");
  assert.equal(v.check!.evidence!.complete, true);
  assert.deepEqual(v.check!.evidence!.notes, ["the cut mid is not bound to a committed pool read (closure opened before this keeper build)"]);
  // The same row with the cutover above its read block is pre-fix to this verifier, and still exit 0.
  const p = await verifyTx(hash, { ...deps(chain, { [key]: JSON.stringify(round.bundle) }), swapEvidenceFromBlock: RECESS.pinnedBlock + 1 });
  assert.equal(p.exit, EXIT.VERIFIED);
  assert.equal(field(p, "swaps"), "not recorded (pre-fix keeper)");
});

test("tx: a strict row whose evidence does not back its input is NOT reproduced", async () => {
  const { round, chain, hash, key } = strictRow();
  const b = JSON.parse(JSON.stringify(round.bundle));
  const h = Object.keys(b.json).find((k) => b.json[k].includes('"evidence":"curb.scorecard.swaps/2"'))!;
  b.json[h] = b.json[h].replace('"closingComplete":true', '"closingComplete":false');   // the leaf no longer hashes
  const v = await verifyTx(hash, { ...deps(chain, { [key]: JSON.stringify(b) }), swapEvidenceFromBlock: RECESS.pinnedBlock - 100 });
  assert.equal(v.exit, EXIT.NOT_REPRODUCED);
});
