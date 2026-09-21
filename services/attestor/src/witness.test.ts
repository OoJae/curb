import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Wallet, getAddress } from "ethers";
import { checkRound, compareObservation, signWitness, verifyWitness, Observation } from "./witness.ts";
import type { TxInfo } from "./sources/chain.ts";
import { clockAbi } from "./sources/chain.ts";

// Real mainnet data: X Layer block 70,619,137 (the first derive/2 round) and block 70,617,365 (the
// first attestation ever, whose uncommitted top-level label was wrong; see DECISIONS D-7).
const CLOCK = "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b";
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const txOf = (name: string): TxInfo => {
  const t = load(name);
  return { hash: t.hash, from: getAddress(t.from), to: getAddress(t.to), blockNumber: t.blockNumber, input: t.input };
};
const tsOf = (name: string): number => load(name).timestamp;
const NEW = "round-70619137";
const OLD = "round-70617365";

test("a real derive/2 round is reproduced: root, derive(), and the calldata that was actually written", () => {
  const c = checkRound(load("round-70619137.bundle.json"), txOf("round-70619137.tx.json"), 196, CLOCK, tsOf("round-70619137.tx.json"));
  assert.deepEqual(c.failures, []);
  assert.equal(c.reproduced, true);
  assert.equal(c.labelsConsistent, true);
  assert.equal(c.method, "curb.marketclock.derive/2");
  assert.equal(c.claims.length, 6);
  assert.equal(c.claims.find((k) => k.symbol === "NVDAx")!.capUsd, "1000000");
});

test("the first-ever round reproduces its claims but is flagged for its wrong top-level label", () => {
  const c = checkRound(load("round-70617365.bundle.json"), txOf("round-70617365.tx.json"), 196, CLOCK, tsOf("round-70617365.tx.json"));
  assert.equal(c.reproduced, true, "what was written equals what was committed");
  assert.equal(c.labelsConsistent, false);
  assert.ok(c.labelFailures.some((f) => f.includes("top-level kind")));
  assert.equal(c.method, "curb.marketclock.derive/1");
});

test("a host that commits one thing and writes another is caught, even though its bundle verifies", () => {
  const bundle = load("round-70619137.bundle.json");
  const tx = txOf("round-70619137.tx.json");
  const args = clockAbi.decodeFunctionData("attestBatch", tx.input);
  const caps = [...args[2]].map((x: bigint) => x);
  caps[caps.length - 1] = 999_999_999n; // lie about one cap in the calldata only
  const forged = { ...tx, input: clockAbi.encodeFunctionData("attestBatch", [args[0], args[1], caps, args[3], args[4], args[5]]) };
  const c = checkRound(bundle, forged, 196, CLOCK, tsOf("round-70619137.tx.json"));
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.startsWith("calldata[")), c.failures.join("\n"));
});

test("a bundle for a different root, or a write to a different contract, is not reproduced", () => {
  const bundle = load("round-70619137.bundle.json");
  const wrongBundle = checkRound(load("round-70617365.bundle.json"), txOf("round-70619137.tx.json"), 196, CLOCK, tsOf("round-70619137.tx.json"));
  assert.equal(wrongBundle.reproduced, false);
  assert.ok(wrongBundle.failures.some((f) => f.includes("inputRoot")));
  const wrongTo = checkRound(bundle, { ...txOf("round-70619137.tx.json"), to: getAddress("0x" + "22".repeat(20)) }, 196, CLOCK, tsOf("round-70619137.tx.json"));
  assert.equal(wrongTo.reproduced, false);
  assert.equal(checkRound(bundle, txOf("round-70619137.tx.json"), 1, CLOCK, tsOf("round-70619137.tx.json")).reproduced, false, "wrong chain id");
});

test("a chain read that does not precede the write is refused", () => {
  const tx = { ...txOf("round-70619137.tx.json"), blockNumber: 1 };
  const c = checkRound(load("round-70619137.bundle.json"), tx, 196, CLOCK, tsOf("round-70619137.tx.json"));
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("does not precede")));
});

test("observation: agree, disagree, and no sample when the witness has no reading near that time", () => {
  const c = checkRound(load("round-70619137.bundle.json"), txOf("round-70619137.tx.json"), 196, CLOCK, tsOf("round-70619137.tx.json"));
  const t = c.evaluatedAtMs!;
  const same = c.claims.map((k) => ({ wrapper: k.wrapper, regime: k.regime, capUsd: BigInt(k.capUsd), halted: k.halted }));
  assert.equal(compareObservation(c.claims, t, [{ evaluatedAtMs: t + 10_000, claims: same }]).observation, Observation.AGREE);
  const other = same.map((k, i) => (i === 0 ? { ...k, regime: 4, capUsd: 100_000n } : k));
  const d = compareObservation(c.claims, t, [{ evaluatedAtMs: t - 5_000, claims: other }]);
  assert.equal(d.observation, Observation.DISAGREE);
  assert.equal(d.detail.length, 1);
  assert.equal(compareObservation(c.claims, t, [{ evaluatedAtMs: t + 120_000, claims: same }]).observation, Observation.NO_SAMPLE);
  assert.equal(compareObservation(c.claims, t, []).observation, Observation.NO_SAMPLE);
});

test("a witness signature recovers to the signer, and any change to the signed statement breaks it", async () => {
  const wallet = Wallet.createRandom();
  const tx = txOf("round-70619137.tx.json");
  const c = checkRound(load("round-70619137.bundle.json"), tx, 196, CLOCK, tsOf("round-70619137.tx.json"));
  const doc = await signWitness(wallet, {
    chainId: 196, clock: CLOCK, tx, writtenAtS: tsOf("round-70619137.tx.json"), inputRoot: load("round-70619137.bundle.json").inputRoot, check: c,
    observation: { observation: Observation.AGREE, sampleAtMs: c.evaluatedAtMs, detail: [] }, checkedAtS: 1789388200, hostId: "host-b",
  });
  assert.equal(verifyWitness(doc).ok, true);
  assert.equal(doc.message.attestor, getAddress(tx.from));
  const roundTripped = JSON.parse(JSON.stringify(doc));
  assert.equal(verifyWitness(roundTripped).ok, true, "survives JSON publication");
  assert.equal(verifyWitness({ ...roundTripped, message: { ...roundTripped.message, reproduced: false } }).ok, false);
  assert.equal(verifyWitness({ ...roundTripped, signer: Wallet.createRandom().address }).ok, false);
});

// Regressions from the pre-deploy review.

test("a perfect re-derivation of OLD inputs replayed into a later block is not reproduced", () => {
  const tx = { ...txOf(`${NEW}.tx.json`), blockNumber: txOf(`${NEW}.tx.json`).blockNumber + 2_000 };
  const c = checkRound(load(`${NEW}.bundle.json`), tx, 196, CLOCK, tsOf(`${NEW}.tx.json`) + 2_000);
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("stale or replayed")), c.failures.join("\n"));
});

test("an honest but late write (a timed-out tx that mined minutes later) is reproduced with a warning, not failed", () => {
  const tx = { ...txOf(`${NEW}.tx.json`), blockNumber: txOf(`${NEW}.tx.json`).blockNumber + 300 };
  const c = checkRound(load(`${NEW}.bundle.json`), tx, 196, CLOCK, tsOf(`${NEW}.tx.json`) + 300);
  assert.deepEqual(c.failures, []);
  assert.equal(c.reproduced, true);
  assert.ok(c.warnings.some((w) => w.startsWith("late write")));
});

test("a retired derivation method is refused outside its block range", () => {
  // The derive/1 bundle is internally perfect, but derive/1 was retired at block 70,619,137.
  const tx = { ...txOf(`${OLD}.tx.json`), blockNumber: 70_700_000 };
  const c = checkRound(load(`${OLD}.bundle.json`), tx, 196, CLOCK, tsOf(`${OLD}.tx.json`));
  assert.equal(c.reproduced, false);
  assert.ok(c.failures.some((f) => f.includes("not valid at block")));
});

test("a malformed bundle never throws: it is a signed failure, not a stuck queue", () => {
  const tx = txOf(`${NEW}.tx.json`);
  for (const junk of [null, "html error page", { inputRoot: "0x" + "00".repeat(32) }, { ...load(`${NEW}.bundle.json`), json: { x: 1 } }, { ...load(`${NEW}.bundle.json`), tree: { format: "nope" } }]) {
    const c = checkRound(junk, tx, 196, CLOCK, tsOf(`${NEW}.tx.json`));
    assert.equal(c.reproduced, false);
    assert.ok(c.failures.length > 0);
  }
});
