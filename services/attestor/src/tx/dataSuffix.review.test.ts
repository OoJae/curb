/**
 * Adversarial review of ERC-8021 attribution in the Sender (24 Sep 2026).
 *
 * Tests that PASS here are attacks that failed (the change held). The two tests named "FIXED" were
 * "FINDING" tests: they pinned a validator that accepted a slipped schema byte and a code of NUL bytes.
 * The validator now refuses both, so they assert the refusal instead. The one case no validator can refuse,
 * a well-formed but wrong code, is still accepted, and is pinned here to the defence that replaced the check:
 * builderCodes() shows it in plain text, and every committed deploy literal decodes to Curb's own code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, Transaction, getAddress } from "ethers";
import { Sender, STUCK_MS, ERC8021_MARKER, normalizeDataSuffix, builderCodes } from "./sender.ts";
import type { RpcFn } from "./sender.ts";
import { checkRound } from "../witness.ts";
import type { TxInfo } from "../sources/chain.ts";

const SUFFIX = "0x6464377535306e636b74356537323966100080218021802180218021802180218021";
const TAIL = SUFFIX.slice(2);
const TO = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
const DATA = "0x" + "8ed83271" + "ab".repeat(32);
const NEXT = "0x" + "8ed83271" + "cd".repeat(32);
const KEY = "0x" + "4c".repeat(32);
const markers = (hex: string) => hex.toLowerCase().split(ERC8021_MARKER).length - 1;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "curb-review-"));
  const clock = { t: 1_000_000 };
  const chain = { pending: 7, latest: 7 };
  const sent: string[] = [];
  const seen: { method: string; data?: string }[] = [];
  const rpc: RpcFn = async (_u, method, params) => {
    seen.push({ method, data: (params[0] as { data?: string })?.data });
    switch (method) {
      case "eth_call": return "0x";
      case "eth_estimateGas": return "0x" + (257_076).toString(16);
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": return "0x" + (params[1] === "latest" ? chain.latest : chain.pending).toString(16);
      case "eth_sendRawTransaction": sent.push(params[0] as string); return Transaction.from(params[0] as string).hash;
      case "eth_getTransactionReceipt": return null;
      case "eth_getTransactionByHash": return { hash: params[0] };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const make = (dataSuffix: string | undefined) => new Sender({
    wallet: new Wallet(KEY), rpcs: ["https://a"], chainId: 196, dbPath: join(dir, "outbox.sqlite"),
    rpc, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, dataSuffix,
  });
  return { dir, clock, chain, sent, seen, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cross-deploy: a stuck row signed by the OLD (plain) sender is replaced by the NEW sender with the suffix exactly once", async () => {
  const w = world();
  const old = w.make(undefined);
  const p = await old.prepare(TO, DATA, { id: "old", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(old.broadcastAndWait(p), /not mined/);
  for (const raw of w.sent) assert.equal(Transaction.from(raw).data, DATA, "the old code sent plain calldata");
  // Redeploy with attribution on, same outbox file (the Railway / host B volume).
  const fresh = w.make(SUFFIX);
  w.chain.pending = 8;
  w.clock.t += STUCK_MS;
  const r = await fresh.prepare(TO, NEXT, { id: "new", kind: "heartbeat", targetMs: 0 });
  assert.equal(r.nonce, p.nonce);
  assert.equal(r.replaces?.id, "old");
  assert.equal(Transaction.from(r.raw).data, NEXT + TAIL);
  assert.equal(markers(r.data), 1);
  const est = w.seen.filter((s) => s.method === "eth_estimateGas").map((s) => s.data);
  assert.deepEqual(est, [DATA, NEXT + TAIL], "old estimate plain, new estimate carries the suffix");
  w.cleanup();
});

test("rollback: attribution turned OFF replaces a stuck suffixed row with plain calldata (no residual suffix)", async () => {
  const w = world();
  const on = w.make(SUFFIX);
  const p = await on.prepare(TO, DATA, { id: "on", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(on.broadcastAndWait(p), /not mined/);
  for (const raw of w.sent) assert.equal(Transaction.from(raw).data, DATA + TAIL);
  const off = w.make(undefined);
  w.chain.pending = 8;
  w.clock.t += STUCK_MS;
  const r = await off.prepare(TO, NEXT, { id: "off", kind: "heartbeat", targetMs: 0 });
  assert.equal(Transaction.from(r.raw).data, NEXT);
  w.cleanup();
});

test("interleaved concurrent prepares on one key: each gets exactly one suffix and distinct nonces", async () => {
  const w = world();
  const s = w.make(SUFFIX);
  const ps = await Promise.all([0, 1, 2, 3].map((i) => s.prepare(TO, "0x8ed83271" + String(i).repeat(64), { id: `c${i}`, kind: "heartbeat", targetMs: 0 })));
  for (const p of ps) assert.equal(markers(Transaction.from(p.raw).data), 1);
  assert.equal(new Set(ps.map((p) => p.nonce)).size, 4);
  w.cleanup();
});

test("host B running witness code WITHOUT any sender change still reproduces host A's suffixed round (checkRound is untouched by this change)", () => {
  const load = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8"));
  const t = load("round-70619137.tx.json");
  const tx: TxInfo = { hash: t.hash, from: getAddress(t.from), to: getAddress(t.to), blockNumber: t.blockNumber, input: t.input + TAIL };
  const c = checkRound(load("round-70619137.bundle.json"), tx, 196, TO, t.timestamp);
  assert.deepEqual(c.failures, []);
  assert.equal(c.reproduced, true);
  // Doubled suffix (a hypothetical double-append) also still reproduces: the witness could not catch it.
  const c2 = checkRound(load("round-70619137.bundle.json"), { ...tx, input: tx.input + TAIL }, 196, TO, t.timestamp);
  assert.equal(c2.reproduced, true, "witness is blind to trailing bytes, so double-append must be prevented in the Sender");
});

test("FIXED: a one-character typo in the schema-id byte (00 -> 01) is refused, alone or with the length byte", () => {
  // byte 17 (the schema id) sits at hex offset 2 + 34..36
  const typo = SUFFIX.slice(0, 2 + 34) + "01" + SUFFIX.slice(2 + 36);
  assert.equal(typo.length, SUFFIX.length);
  assert.notEqual(typo, SUFFIX);
  assert.throws(() => normalizeDataSuffix(typo), /declares ERC-8021 schema 1; Curb sends only schema 0/);
  // Both the codes-length and the schema byte wrong: refused on the schema before the length is read.
  const typo2 = SUFFIX.slice(0, 2 + 32) + "0f01" + SUFFIX.slice(2 + 36);
  assert.throws(() => normalizeDataSuffix(typo2), /schema 1/);
});

test("FIXED: a schema-0 suffix whose 'code' is 16 NUL bytes is refused; a mistyped code is shown in plain text", () => {
  const nul = "0x" + "00".repeat(16) + "10" + "00" + ERC8021_MARKER;
  assert.throws(() => normalizeDataSuffix(nul), /byte 0x00 at position 0 of its codes; a Builder Code is printable ASCII/);
  // Well-formed and wrong: no validator can know Curb's code, so it is accepted, and its defence is that it
  // decodes to itself for the boot log and /healthz ...
  const wrongCode = "0x" + Buffer.from("dd7u50nckt5e729g", "utf8").toString("hex") + "10" + "00" + ERC8021_MARKER;
  assert.equal(normalizeDataSuffix(wrongCode), wrongCode, "still accepted: nothing in the Sender pins Curb's code");
  assert.deepEqual(builderCodes(wrongCode), ["dd7u50nckt5e729g"]);
  // ... and that no committed deploy literal is it. The literals are pinned to dd7u50nckt5e729f in main.test.ts;
  // this re-reads them to show the mistyped one would not get through.
  const root = new URL("../../../../", import.meta.url);
  const railway = readFileSync(new URL(".railway/railway.ts", root), "utf8");
  const deploy = readFileSync(new URL("script/hostb/deploy.sh", root), "utf8");
  assert.ok(railway.includes(`DATA_SUFFIX: "${SUFFIX}"`) && deploy.includes(`\nDATA_SUFFIX=${SUFFIX}\n`));
  assert.ok(!railway.includes(wrongCode.slice(2)) && !deploy.includes(wrongCode.slice(2)));
});
