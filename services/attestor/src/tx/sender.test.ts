import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, Transaction, Interface } from "ethers";
import { Sender, RevertedInSimulation, GAS_FLOOR, PendingUnresolved, STUCK_MS } from "./sender.ts";
import type { RpcFn } from "./sender.ts";
import { loadOrCreateKey } from "./keys.ts";

const CLOCK = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
const ERRORS = new Interface(["error NotAttestor()"]);

interface MockState {
  pending: number;
  /** Confirmed nonce; defaults to `pending`. */
  latest?: number;
  /** When set, every eth_sendRawTransaction is rejected with this message. */
  rejectSend?: string;
  estimate: bigint;
  revert: boolean;
  sent: string[];
  receiptFor: (hash: string, now: number) => { status: string; blockNumber: string; gasUsed: string } | null;
}

function mockRpc(s: MockState, clock: { t: number }): RpcFn {
  return async (_url, method, params) => {
    switch (method) {
      case "eth_call":
        if (s.revert) throw Object.assign(new Error("execution reverted"), { data: ERRORS.encodeErrorResult("NotAttestor") });
        return "0x";
      case "eth_estimateGas": return "0x" + s.estimate.toString(16);
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" }; // 20,000,000 wei
      case "eth_getTransactionCount": return "0x" + (params[1] === "latest" ? (s.latest ?? s.pending) : s.pending).toString(16);
      case "eth_sendRawTransaction":
        if (s.rejectSend) throw new Error(s.rejectSend);
        s.sent.push(params[0] as string); return Transaction.from(params[0] as string).hash;
      case "eth_getTransactionReceipt": return s.receiptFor(params[0] as string, clock.t);
      default: throw new Error(`unexpected ${method}`);
    }
  };
}

function setup(over: Partial<MockState> & { wallet?: Wallet; dbPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "curb-sender-"));
  const clock = { t: 1_000_000 };
  const state: MockState = {
    pending: 7, estimate: 492_319n, revert: false, sent: [],
    receiptFor: (hash) => ({ status: "0x1", blockNumber: "0x100", gasUsed: "0x5000" }),
    ...over,
  } as MockState;
  const wallet = over.wallet ?? Wallet.createRandom();
  const dbPath = over.dbPath ?? join(dir, "outbox.sqlite");
  const sender = new Sender({
    wallet, rpcs: ["https://a", "https://b"], chainId: 196, dbPath,
    rpc: mockRpc(state, clock), now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; }, errorInterface: ERRORS,
  });
  return { dir, dbPath, clock, state, sender, wallet, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a round that would revert is refused before signing, with the decoded reason", async () => {
  const { sender, state, cleanup } = setup({ revert: true });
  await assert.rejects(
    sender.prepare(CLOCK, "0x1234", { id: "r1", kind: "heartbeat", targetMs: 0 }),
    (e: unknown) => e instanceof RevertedInSimulation && e.reason === "NotAttestor()",
  );
  assert.equal(state.sent.length, 0, "nothing may be broadcast");
  cleanup();
});

test("gas limit is twice the estimate, and never below the floor", async () => {
  const a = setup({ estimate: 492_319n });
  const pa = await a.sender.prepare(CLOCK, "0x1234", { id: "g1", kind: "heartbeat", targetMs: 0 });
  assert.equal(pa.gasLimit, 984_638n, "the real first-round estimate doubled");
  a.cleanup();

  const b = setup({ estimate: 100_000n });
  const pb = await b.sender.prepare(CLOCK, "0x1234", { id: "g2", kind: "heartbeat", targetMs: 0 });
  assert.equal(pb.gasLimit, GAS_FLOOR);
  b.cleanup();
});

test("signed transaction is EIP-1559 on chain 196, to MarketClock, from the host key", async () => {
  const { sender, wallet, cleanup } = setup();
  const p = await sender.prepare(CLOCK, "0xabcdef", { id: "s1", kind: "heartbeat", targetMs: 0 });
  const tx = Transaction.from(p.raw);
  assert.equal(tx.type, 2);
  assert.equal(tx.chainId, 196n);
  assert.equal(tx.to, CLOCK);
  assert.equal(tx.from, wallet.address);
  assert.equal(tx.data, "0xabcdef");
  assert.ok(tx.maxFeePerGas! >= 40_000_000n, "at least 2x the flat 0.02 gwei base fee");
  cleanup();
});

test("nonces never repeat, even while the chain still reports the old pending count", async () => {
  const { sender, cleanup } = setup({ pending: 7 });
  const a = await sender.prepare(CLOCK, "0x01", { id: "n1", kind: "heartbeat", targetMs: 0 });
  const b = await sender.prepare(CLOCK, "0x02", { id: "n2", kind: "heartbeat", targetMs: 0 });
  assert.equal(a.nonce, 7);
  assert.equal(b.nonce, 8);
  cleanup();
});

test("the same round cannot be prepared twice", async () => {
  const { sender, cleanup } = setup();
  await sender.prepare(CLOCK, "0x01", { id: "dup", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(sender.prepare(CLOCK, "0x01", { id: "dup", kind: "heartbeat", targetMs: 0 }), /already prepared/);
  cleanup();
});

test("a stuck transaction is replaced at the SAME nonce with a higher fee", async () => {
  let firstHash = "";
  const env = setup({
    receiptFor: (hash, now) => {
      // The original never mines; only a replacement broadcast after 12s does.
      if (hash === firstHash || now < 1_000_000 + 12_500) return null;
      return { status: "0x1", blockNumber: "0x200", gasUsed: "0x6000" };
    },
  });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "stuck", kind: "heartbeat", targetMs: 0 });
  firstHash = p.hash;
  const receipt = await env.sender.broadcastAndWait(p);
  assert.equal(receipt.replacements, 1);
  assert.notEqual(receipt.hash, p.hash);
  const txs = env.state.sent.map((r) => Transaction.from(r));
  const replacement = txs.find((t) => t.hash === receipt.hash)!;
  assert.equal(replacement.nonce, p.nonce, "replacement must reuse the nonce");
  assert.ok(replacement.maxFeePerGas! > p.maxFeePerGas, "replacement must pay more");
  env.cleanup();
});

test("a normal round is broadcast to every RPC and returns its receipt", async () => {
  const { sender, state, cleanup } = setup();
  const p = await sender.prepare(CLOCK, "0x01", { id: "ok", kind: "heartbeat", targetMs: 0 });
  const r = await sender.broadcastAndWait(p);
  assert.equal(r.status, 1);
  assert.equal(r.replacements, 0);
  assert.equal(state.sent.filter((raw) => raw === p.raw).length, 2, "sent to both RPCs");
  cleanup();
});

// Regressions from the host B review (14 Sep 2026): each of these used to leave a permanent nonce gap or a
// double write.

test("a broadcast every node explicitly refuses releases its nonce: the next round reuses it", async () => {
  const env = setup({ pending: 7, rejectSend: "transaction underpriced" });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "fail", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(env.sender.broadcastAndWait(p), /no RPC accepted/);
  env.state.rejectSend = undefined;
  const q = await env.sender.prepare(CLOCK, "0x02", { id: "next", kind: "heartbeat", targetMs: 0 });
  assert.equal(q.nonce, 7);
  env.cleanup();
});

test("a broadcast with an UNKNOWN outcome (timeout) keeps its nonce tracked: no gap, no stacking", async () => {
  const env = setup({ pending: 7, latest: 7, rejectSend: "TimeoutError: The operation was aborted due to timeout", receiptFor: () => null });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "maybe", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(env.sender.broadcastAndWait(p), /not mined/);
  env.state.rejectSend = undefined;
  env.state.pending = 8; // the node did pool it after all
  await assert.rejects(env.sender.prepare(CLOCK, "0x02", { id: "blocked", kind: "heartbeat", targetMs: 0 }), (e: unknown) => e instanceof PendingUnresolved);
  env.clock.t += STUCK_MS;
  const r = await env.sender.prepare(CLOCK, "0x03", { id: "replace", kind: "heartbeat", targetMs: 0 });
  assert.equal(r.nonce, 7, "replaces at the tracked nonce instead of leaving 7 orphaned");
  env.cleanup();
});

test("a signature orphaned by a crash between prepare and broadcast does not reserve a nonce after restart", async () => {
  const env = setup({ pending: 7 });
  await env.sender.prepare(CLOCK, "0x01", { id: "orphan", kind: "heartbeat", targetMs: 0 });
  const restarted = setup({ pending: 7, wallet: env.wallet as Wallet, dbPath: env.dbPath });
  const q = await restarted.sender.prepare(CLOCK, "0x02", { id: "after-restart", kind: "heartbeat", targetMs: 0 });
  assert.equal(q.nonce, 7);
  env.cleanup();
});

test("a stale prepared signature stops reserving its nonce after a minute", async () => {
  const env = setup({ pending: 7 });
  await env.sender.prepare(CLOCK, "0x01", { id: "old", kind: "heartbeat", targetMs: 0 });
  env.clock.t += 61_000;
  const q = await env.sender.prepare(CLOCK, "0x02", { id: "new", kind: "heartbeat", targetMs: 0 });
  assert.equal(q.nonce, 7);
  env.cleanup();
});

test("while a timed-out transaction may still mine, nothing is sent on top of it; after STUCK_MS it is replaced at its nonce", async () => {
  const env = setup({ pending: 8, latest: 7, receiptFor: () => null });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "slow", kind: "heartbeat", targetMs: 0 });
  assert.equal(p.nonce, 8);
  await assert.rejects(env.sender.broadcastAndWait(p), /not mined/);
  // The chain still has not confirmed nonce 8 (latest=8 means nonce 8 is next to confirm).
  env.state.latest = 8;
  env.state.pending = 9;
  await assert.rejects(env.sender.prepare(CLOCK, "0x02", { id: "blocked", kind: "heartbeat", targetMs: 0 }), (e: unknown) => e instanceof PendingUnresolved);
  env.clock.t += STUCK_MS;
  const r = await env.sender.prepare(CLOCK, "0x03", { id: "replacement", kind: "heartbeat", targetMs: 0 });
  assert.equal(r.nonce, 8, "replaces the stuck transaction instead of stacking a second write");
  const stuckFee = Transaction.from(env.state.sent.at(-1)!).maxFeePerGas!;
  assert.ok(r.maxFeePerGas >= stuckFee * 2n || r.maxFeePerGas === 1_000_000_000n, "pays at least double");
  env.cleanup();
});

test("a timed-out transaction that mined later is reconciled, and the next nonce follows the chain", async () => {
  const env = setup({ pending: 7, latest: 7, receiptFor: () => null });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "late", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(env.sender.broadcastAndWait(p), /not mined/);
  env.state.latest = 8;
  env.state.pending = 8;
  env.state.receiptFor = () => ({ status: "0x1", blockNumber: "0x300", gasUsed: "0x5000" });
  const q = await env.sender.prepare(CLOCK, "0x02", { id: "after", kind: "heartbeat", targetMs: 0 });
  assert.equal(q.nonce, 8);
  env.cleanup();
});

test("host key: generated once, encrypted at 0600, and reloaded to the same address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-key-"));
  const path = join(dir, "keys", "attestor.keystore.json");
  const pw = "a-long-sealed-variable-password-for-tests";
  const first = await loadOrCreateKey(path, pw);
  assert.equal(first.created, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const again = await loadOrCreateKey(path, pw);
  assert.equal(again.created, false);
  assert.equal(again.address, first.address);
  await assert.rejects(loadOrCreateKey(path, "wrong-password-that-is-long-enough!!"));
  await assert.rejects(loadOrCreateKey(join(dir, "other.json"), "short"), /ATTESTOR_KEY_PASSWORD/);
  assert.equal(existsSync(join(dir, "other.json")), false, "no keystore is created without a valid password");
  rmSync(dir, { recursive: true, force: true });
});

// Second review (14 Sep 2026): a geth-like pool that enforces the 10% outbid rule and never mines.

function gethPool() {
  const pooled = new Map<number, { fee: bigint; tip: bigint }>();
  const accepted: Transaction[] = [];
  const refused: string[] = [];
  const rpc: RpcFn = async (_url, method, params) => {
    switch (method) {
      case "eth_call": return "0x";
      case "eth_estimateGas": return "0x" + (300_000).toString(16);
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x1312d00" };
      case "eth_getTransactionCount": {
        if (params[1] === "latest") return "0x0";
        let n = 0; while (pooled.has(n)) n++; return "0x" + n.toString(16);
      }
      case "eth_sendRawTransaction": {
        const tx = Transaction.from(params[0] as string);
        const prev = pooled.get(tx.nonce);
        if (prev && !(tx.maxFeePerGas! * 10n >= prev.fee * 11n && tx.maxPriorityFeePerGas! * 10n >= prev.tip * 11n)) {
          refused.push(`${tx.nonce}:${tx.maxFeePerGas}/${tx.maxPriorityFeePerGas}`);
          throw new Error("replacement transaction underpriced");
        }
        pooled.set(tx.nonce, { fee: tx.maxFeePerGas!, tip: tx.maxPriorityFeePerGas! });
        accepted.push(tx);
        return tx.hash;
      }
      case "eth_getTransactionReceipt": return null;
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, pooled, accepted, refused };
}

test("while nonce 0 never confirms, every retry replaces AT nonce 0 and outbids the pool; nothing stacks at nonce 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-geth-"));
  const clock = { t: 1_000_000 };
  const pool = gethPool();
  const sender = new Sender({
    wallet: Wallet.createRandom(), rpcs: ["https://a"], chainId: 196, dbPath: join(dir, "o.sqlite"),
    rpc: pool.rpc, now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
  });
  let rounds = 0;
  for (let i = 0; i < 20; i++) {
    clock.t += 30_000;
    try {
      const p = await sender.prepare(CLOCK, "0x" + i.toString(16).padStart(2, "0"), { id: `r${i}`, kind: "heartbeat", targetMs: 0 });
      rounds++;
      await sender.broadcastAndWait(p).catch(() => undefined);
    } catch (e) {
      if (!(e instanceof PendingUnresolved)) throw e;
    }
  }
  assert.ok(rounds >= 3, `expected several replacement rounds, got ${rounds}`);
  assert.deepEqual([...pool.pooled.keys()], [0], "only nonce 0 is ever pooled");
  const replacementsAtZero = pool.accepted.filter((t) => t.nonce === 0);
  assert.ok(replacementsAtZero.length >= 3);
  for (let i = 1; i < replacementsAtZero.length; i++) {
    assert.ok(replacementsAtZero[i].maxFeePerGas! * 10n >= replacementsAtZero[i - 1].maxFeePerGas! * 11n || replacementsAtZero[i].maxFeePerGas === 1_000_000_000n);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a discarded prepared round releases its nonce immediately", async () => {
  const env = setup({ pending: 7 });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "stale", kind: "heartbeat", targetMs: 0 });
  await env.sender.discard(p.id);
  const q = await env.sender.prepare(CLOCK, "0x02", { id: "fresh", kind: "heartbeat", targetMs: 0 });
  assert.equal(q.nonce, 7);
  env.cleanup();
});

test("at the fee ceiling, a transaction every node has dropped is replaced instead of waited on forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-ceiling-"));
  const clock = { t: 1_000_000 };
  const pool = gethPool();
  let dropped = false;
  const rpc: RpcFn = async (url, method, params) => {
    if (method === "eth_getTransactionByHash") return dropped ? null : { hash: params[0] };
    return pool.rpc(url, method, params);
  };
  const sender = new Sender({ wallet: Wallet.createRandom(), rpcs: ["https://a"], chainId: 196, dbPath: join(dir, "o.sqlite"), rpc, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  let ceilingHits = 0;
  for (let i = 0; i < 40 && ceilingHits === 0; i++) {
    clock.t += 30_000;
    try {
      const p = await sender.prepare(CLOCK, "0x" + i.toString(16).padStart(2, "0"), { id: `c${i}`, kind: "heartbeat", targetMs: 0 });
      await sender.broadcastAndWait(p).catch(() => undefined);
    } catch (e) {
      if (e instanceof PendingUnresolved && /ceiling/.test(e.message)) ceilingHits++;
      else if (!(e instanceof PendingUnresolved)) throw e;
    }
  }
  assert.equal(ceilingHits, 1, "fees escalated to the ceiling");
  dropped = true;
  pool.pooled.clear();
  clock.t += 30_000;
  const p = await sender.prepare(CLOCK, "0xff", { id: "after-drop", kind: "heartbeat", targetMs: 0 });
  assert.equal(p.nonce, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a fresh signature whose nonce is already used is a failed broadcast, not an accepted one", async () => {
  const env = setup({ pending: 7, rejectSend: "nonce too low" });
  const p = await env.sender.prepare(CLOCK, "0x01", { id: "low", kind: "heartbeat", targetMs: 0 });
  await assert.rejects(env.sender.broadcastAndWait(p), /no RPC accepted/);
  env.cleanup();
});
