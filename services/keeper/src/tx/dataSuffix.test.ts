/**
 * ERC-8021 attribution in the Sender (24 Sep 2026).
 *
 * This file is byte-identical in services/attestor and services/keeper, like the sender.ts it tests: both
 * services sign through the same Sender, so both prove the same four things. The suffix reaches the
 * simulation, the gas estimate and the signature exactly once; every replacement path keeps it; off means
 * the calldata is untouched; and a malformed suffix never produces a Sender. "Malformed" includes the
 * silent cases the review found: any schema but 0, and codes that are not printable Builder Codes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, Transaction } from "ethers";
import { Sender, STUCK_MS, ERC8021_MARKER, normalizeDataSuffix, builderCodes } from "./sender.ts";
import type { RpcFn } from "./sender.ts";

/** Builder Code dd7u50nckt5e729f, ERC-8021 schema 0: utf8(code) ++ 0x10 (length) ++ 0x00 (schema) ++ marker. */
const SUFFIX = "0x6464377535306e636b74356537323966100080218021802180218021802180218021";
const TAIL = SUFFIX.slice(2);
const TO = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
/** Shaped like real calldata: a selector and one word, as settle(bytes32) is. */
const DATA = "0x" + "8ed83271" + "ab".repeat(32);
const NEXT = "0x" + "8ed83271" + "cd".repeat(32);
const KEY = "0x" + "4c".repeat(32);
const meta = (id: string) => ({ id, kind: "heartbeat", targetMs: 0 });
const markers = (hex: string) => hex.toLowerCase().split(ERC8021_MARKER).length - 1;
/** A schema-0 suffix built by the formula from raw code bytes, so a test can make one with any content. */
const suffixOf = (codes: string | Buffer) => {
  const b = typeof codes === "string" ? Buffer.from(codes, "latin1") : codes;
  return "0x" + b.toString("hex") + b.length.toString(16).padStart(2, "0") + "00" + ERC8021_MARKER;
};
/** SUFFIX with the bytes starting at `index` (0-based, of the 34) overwritten by `hex`; the length is kept. */
const overwrite = (index: number, hex: string) => SUFFIX.slice(0, 2 + 2 * index) + hex + SUFFIX.slice(2 + 2 * index + hex.length);

interface Chain { pending: number; latest: number }
type ReceiptFn = (hash: string, now: number) => { status: string; blockNumber: string; gasUsed: string } | null;

/** A mock RPC that records every request, so a test can see exactly which bytes each step was shown. */
function harness(dataSuffix: string | undefined, over: { chain?: Chain; receipt?: ReceiptFn } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "curb-suffix-"));
  const clock = { t: 1_000_000 };
  const chain: Chain = over.chain ?? { pending: 7, latest: 7 };
  const receipt: ReceiptFn = over.receipt ?? (() => ({ status: "0x1", blockNumber: "0x100", gasUsed: "0x5000" }));
  const seen: { method: string; params: unknown[] }[] = [];
  const sent: string[] = [];
  const rpc: RpcFn = async (_url, method, params) => {
    seen.push({ method, params });
    switch (method) {
      case "eth_call": return "0x";
      case "eth_estimateGas": return "0x" + (257_076).toString(16); // host A's real attestBatch, suffixed
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": return "0x" + (params[1] === "latest" ? chain.latest : chain.pending).toString(16);
      case "eth_sendRawTransaction": sent.push(params[0] as string); return Transaction.from(params[0] as string).hash;
      case "eth_getTransactionReceipt": return receipt(params[0] as string, clock.t);
      case "eth_getTransactionByHash": return { hash: params[0] };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const sender = new Sender({
    wallet: new Wallet(KEY), rpcs: ["https://a"], chainId: 196, dbPath: join(dir, "outbox.sqlite"),
    rpc, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, dataSuffix,
  });
  const dataOf = (method: string) => seen.filter((s) => s.method === method).map((s) => (s.params[0] as { data: string }).data);
  return { sender, clock, chain, seen, sent, dataOf, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the suffix constant is the Builder Code under the ERC-8021 schema-0 formula", () => {
  assert.equal(SUFFIX, "0x" + Buffer.from("dd7u50nckt5e729f", "utf8").toString("hex") + "10" + "00" + ERC8021_MARKER);
  assert.equal(TAIL.length / 2, 34);
  assert.equal(normalizeDataSuffix(SUFFIX), SUFFIX);
  assert.equal(normalizeDataSuffix(SUFFIX.toUpperCase().replace(/^0X/, "0x")), SUFFIX, "upper-case hex is accepted and lower-cased");
});

test("builderCodes decodes a suffix to the plain-text codes a person can check; off is []", () => {
  assert.deepEqual(builderCodes(SUFFIX), ["dd7u50nckt5e729f"]);
  assert.deepEqual(builderCodes(SUFFIX.toUpperCase().replace(/^0X/, "0x")), ["dd7u50nckt5e729f"]);
  assert.deepEqual(builderCodes(undefined), []);
  assert.deepEqual(builderCodes(""), []);
  // ERC-8021 schema 0 carries a comma-delimited list; each code comes back on its own.
  assert.deepEqual(builderCodes(suffixOf("dd7u50nckt5e729f,other1")), ["dd7u50nckt5e729f", "other1"]);
  // The one mistake no validator can see is a well-formed WRONG code. It is accepted, and shown as itself.
  assert.deepEqual(builderCodes(suffixOf("dd7u50nckt5e729g")), ["dd7u50nckt5e729g"]);
  // It throws exactly when normalizeDataSuffix does, so it can never show a code the Sender would refuse.
  assert.throws(() => builderCodes("0xdeadbeef"), /ERC-8021 marker/);
});

// (a) appended exactly once, and every step before the broadcast sees it

test("attribution on: eth_call, eth_estimateGas and the signed transaction all carry the suffix exactly once", async () => {
  const h = harness(SUFFIX);
  const p = await h.sender.prepare(TO, DATA, meta("a"));
  const want = DATA + TAIL;
  assert.deepEqual(h.dataOf("eth_call"), [want], "the simulation ran on the bytes that are sent");
  assert.deepEqual(h.dataOf("eth_estimateGas"), [want], "the gas estimate includes the suffix's calldata cost");
  const signed = Transaction.from(p.raw);
  assert.equal(signed.data, want);
  assert.equal(markers(signed.data), 1);
  assert.equal(p.data, want, "Prepared.data is what was signed");
  assert.equal(h.sender.dataSuffix, SUFFIX);
  h.cleanup();
});

test("calldata that already ends with the configured suffix is not suffixed a second time", async () => {
  const h = harness(SUFFIX);
  const once = DATA + TAIL;
  const p = await h.sender.prepare(TO, once, meta("already"));
  assert.equal(Transaction.from(p.raw).data, once);
  assert.deepEqual(h.dataOf("eth_call"), [once]);
  // Case is not a loophole: hex that differs only in case is the same bytes.
  const q = await h.sender.prepare(TO, "0x" + once.slice(2).toUpperCase(), meta("already-upper"));
  assert.equal(Transaction.from(q.raw).data, once);
  // Feeding a Prepared.data back in (as a careless retry might) is also a no-op.
  const r = await h.sender.prepare(TO, p.data, meta("fed-back"));
  assert.equal(markers(Transaction.from(r.raw).data), 1);
  h.cleanup();
});

test("calldata ending in some OTHER ERC-8021 suffix is ordinary calldata: ours is appended after it", async () => {
  // Only the last suffix is read by a parser, so ours must be last for the transaction to be Curb's.
  const other = "0x" + Buffer.from("othercode", "utf8").toString("hex") + "09" + "00" + ERC8021_MARKER;
  const h = harness(SUFFIX);
  const p = await h.sender.prepare(TO, DATA + other.slice(2), meta("other"));
  assert.equal(Transaction.from(p.raw).data, DATA + other.slice(2) + TAIL);
  h.cleanup();
});

// (b) replacements preserve it

test("the 12s fee bump re-signs the attributed calldata: every broadcast carries the suffix once", async () => {
  let first = "";
  const h = harness(SUFFIX, {
    // The original never mines; only a transaction broadcast after the 12s bump does.
    receipt: (hash, now) => (hash === first || now < 1_000_000 + 12_500 ? null : { status: "0x1", blockNumber: "0x200", gasUsed: "0x6000" }),
  });
  const p = await h.sender.prepare(TO, DATA, meta("bump"));
  first = p.hash;
  const r = await h.sender.broadcastAndWait(p);
  assert.equal(r.replacements, 1);
  const txs = h.sent.map((raw) => Transaction.from(raw));
  const bump = txs.find((t) => t.hash === r.hash)!;
  assert.ok(bump, "the mined transaction is the bump");
  assert.notEqual(bump.hash, p.hash);
  assert.equal(bump.nonce, p.nonce);
  for (const t of txs) assert.equal(t.data, DATA + TAIL, `tx ${t.hash} (nonce ${t.nonce}, fee ${t.maxFeePerGas})`);
  h.cleanup();
});

test("a stuck-row replacement at the same nonce carries the new round's calldata with the suffix once", async () => {
  const h = harness(SUFFIX, { chain: { pending: 8, latest: 7 }, receipt: () => null });
  const p = await h.sender.prepare(TO, DATA, meta("slow"));
  await assert.rejects(h.sender.broadcastAndWait(p), /not mined/);
  h.chain.latest = 8;
  h.chain.pending = 9;
  h.clock.t += STUCK_MS;
  const r = await h.sender.prepare(TO, NEXT, meta("replacement"));
  assert.equal(r.nonce, p.nonce, "replaces at the stuck nonce");
  assert.equal(r.replaces?.id, "slow");
  assert.equal(Transaction.from(r.raw).data, NEXT + TAIL);
  // Everything broadcast for the stuck row -- first send, 4s rebroadcast, 12s bump -- carried it once too.
  assert.ok(h.sent.length >= 2);
  for (const raw of h.sent) assert.equal(Transaction.from(raw).data, DATA + TAIL);
  h.cleanup();
});

// (c) off means untouched

test("attribution off (unset or empty): calldata is simulated, estimated and signed byte for byte as given", async () => {
  for (const off of [undefined, ""]) {
    const h = harness(off);
    const p = await h.sender.prepare(TO, DATA, meta("plain"));
    assert.deepEqual(h.dataOf("eth_call"), [DATA]);
    assert.deepEqual(h.dataOf("eth_estimateGas"), [DATA]);
    assert.equal(Transaction.from(p.raw).data, DATA);
    assert.equal(p.data, DATA);
    assert.equal(markers(p.data), 0);
    assert.equal(h.sender.dataSuffix, "");
    h.cleanup();
  }
});

// (d) a bad suffix never becomes a Sender

test("an invalid suffix is refused when the Sender is built, before its outbox is created", () => {
  const cases: [string, RegExp][] = [
    ["0x", /does not end with the ERC-8021 marker/],
    [TAIL, /0x-prefixed hex/],                                     // the 0x forgotten
    [" " + SUFFIX, /0x-prefixed hex/],                             // whitespace is the caller's to trim
    [SUFFIX.slice(0, -1), /whole bytes/],                          // a character lost in a paste
    [SUFFIX.replace("6464", "zz64"), /0x-prefixed hex/],           // not hex
    ["0x" + "ab".repeat(34), /does not end with the ERC-8021 marker/],
    [SUFFIX.slice(0, -2), /does not end with the ERC-8021 marker/], // last byte of the marker lost
    ["0x" + ERC8021_MARKER, /too short/],                           // the marker and nothing else
    ["0x0000" + ERC8021_MARKER, /no Builder Code/],                 // schema 0, zero-length codes
    ["0x" + TAIL.slice(2), /declares 16 bytes of schema-0 codes but carries 15/], // first byte of the code lost
    ["0x64" + TAIL, /declares 16 bytes of schema-0 codes but carries 17/],        // a byte pasted twice
    // Silent before the review (24 Sep 2026): each of these booted cleanly and credited nobody.
    [overwrite(17, "01"), /declares ERC-8021 schema 1; Curb sends only schema 0/], // one slip in the schema byte
    [overwrite(16, "0f01"), /schema 1/],                                            // length AND schema bytes wrong
    [overwrite(17, "ff"), /schema 255/],
    [suffixOf(Buffer.alloc(16)), /byte 0x00 at position 0 of its codes/],          // a code of 16 NUL bytes
    [suffixOf("dd7u50nckt5e729\u0000"), /byte 0x00 at position 15/],               // one NUL at the end
    [suffixOf("dd7u50nckt5e729\u00e9"), /byte 0xe9 at position 15/],               // not ASCII
    [suffixOf("dd7u50nc t5e729f"), /byte 0x20 at position 8/],                    // whitespace inside a code
    [suffixOf("dd7u50nckt5e729f\n"), /byte 0x0a at position 16/],                 // a pasted newline
    [suffixOf(",dd7u50nckt5e729f"), /empty Builder Code/],                         // leading comma
    [suffixOf("dd7u50nckt5e729f,"), /empty Builder Code/],                         // trailing comma
    [suffixOf("dd7u50nc,,kt5e729f"), /empty Builder Code/],                        // doubled comma
    [suffixOf(","), /empty Builder Code/],
  ];
  for (const [v, re] of cases) {
    assert.throws(() => normalizeDataSuffix(v), re, JSON.stringify(v));
    const dir = mkdtempSync(join(tmpdir(), "curb-suffix-bad-"));
    const dbPath = join(dir, "outbox.sqlite");
    assert.throws(
      () => new Sender({ wallet: new Wallet(KEY), rpcs: ["https://a"], chainId: 196, dbPath, rpc: async () => null, dataSuffix: v }),
      re, JSON.stringify(v),
    );
    assert.equal(existsSync(dbPath), false, "no outbox is opened for a Sender that cannot exist");
    rmSync(dir, { recursive: true, force: true });
  }
});
