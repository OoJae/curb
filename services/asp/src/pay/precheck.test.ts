/**
 * The local payment pre-check, offline. The honest payload is made by the SDK's own client scheme
 * (@okxweb3/x402-evm/exact/client) signing with a viem account, which is how an x402 buyer signs; the
 * pre-check verifies with ethers. So a pass here is two implementations agreeing on the digest, not one
 * agreeing with itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedDataEncoder, Wallet, getAddress } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/client";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { createPaymentPrecheck, PRECHECK_REASONS, VALID_AFTER_SKEW_S } from "./precheck.ts";
import type { PrecheckOptions } from "./precheck.ts";
import { USDT0 } from "./routes.ts";

const T0 = Date.parse("2026-09-25T09:00:00Z");
const NETWORK = "eip155:196";
// The live revenue wallet and challenge terms, as api.curb.markets served them on 25 Sep 2026.
const PAY_TO = getAddress("0x277cA91276A3801667B76C97Da3872Ccb6E96068");
const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact", network: NETWORK, amount: "10000", asset: USDT0.address.toLowerCase(), payTo: PAY_TO,
  maxTimeoutSeconds: 300, extra: { name: "USD₮0", version: "1" },
};
const BUYER_KEY = "0x" + "4b".repeat(32);
const buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`);
const STRANGER = new Wallet("0x" + "5c".repeat(32));

/** A payload exactly as the SDK's client builds it, signed at `atMs` (the client reads Date.now()). */
async function sdkPayload(atMs = T0, requirements = REQUIREMENTS): Promise<PaymentPayload> {
  const realNow = Date.now;
  Date.now = () => atMs;
  try {
    const signed = await new ExactEvmScheme(buyer).createPaymentPayload(2, requirements);
    return { x402Version: 2, resource: { url: "https://api.curb.markets/v1/closure-calendar", description: "", mimeType: "application/json" }, accepted: requirements, payload: signed.payload };
  } finally { Date.now = realNow; }
}

/** The same payload with its authorization (or signature) changed, and NOT re-signed. */
function tampered(p: PaymentPayload, auth: Record<string, unknown> = {}, signature?: unknown): PaymentPayload {
  const inner = p.payload as { authorization: Record<string, unknown>; signature: string };
  return { ...p, payload: { authorization: { ...inner.authorization, ...auth }, signature: signature === undefined ? inner.signature : signature } };
}

/** A well-formed authorization with the given fields, validly signed by STRANGER over the USD₮0 domain. */
async function strangerSigned(p: PaymentPayload, auth: Record<string, unknown> = {}): Promise<PaymentPayload> {
  const a = { ...(p.payload as { authorization: Record<string, unknown> }).authorization, ...auth };
  const signature = await STRANGER.signTypedData(
    { name: "USD₮0", version: "1", chainId: 196, verifyingContract: USDT0.address },
    { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    a,
  );
  return tampered(p, a, signature);
}

function precheck(o: Partial<PrecheckOptions> = {}) {
  const lookups: string[] = [];
  const hasCode = o.payerHasCode === undefined ? async (address: string) => { lookups.push(address); return false; } : o.payerHasCode;
  const run = createPaymentPrecheck({ network: NETWORK, asset: USDT0.address, payTo: PAY_TO, now: () => T0, ...o, payerHasCode: hasCode });
  return { run, lookups };
}

test("the digest's domain is USD₮0's own: the challenge's extra hashes to the token's DOMAIN_SEPARATOR on X Layer", () => {
  // DOMAIN_SEPARATOR() on 0x779D…3736, read with cast at https://xlayer.drpc.org on 25 Sep 2026.
  assert.equal(
    TypedDataEncoder.hashDomain({ name: REQUIREMENTS.extra.name as string, version: REQUIREMENTS.extra.version as string, chainId: 196, verifyingContract: USDT0.address }),
    "0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d",
  );
});

test("a payment exactly as the SDK's client signs it passes, with no chain read", async () => {
  const { run, lookups } = precheck();
  const p = await sdkPayload();
  const a = (p.payload as { authorization: Record<string, string> }).authorization;
  assert.equal(a.from, buyer.address);
  assert.equal(await run(p, REQUIREMENTS), null);
  assert.deepEqual(lookups, [], "the signature recovers to `from`: nothing to ask the chain");

  // Its whole validity window passes, both ends, and so does more than the price.
  const late = precheck({ now: () => Number(a.validBefore) * 1000 - 1_000 });
  assert.equal(await late.run(p, REQUIREMENTS), null);
  const early = precheck({ now: () => (Number(a.validAfter) - VALID_AFTER_SKEW_S) * 1000 });
  assert.equal(await early.run(p, REQUIREMENTS), null);
  assert.equal(await run(await strangerSigned(p, { from: STRANGER.address, value: "20000" }), REQUIREMENTS), null);
  // The x402 wire allows numbers where the SDK writes decimal strings.
  assert.equal(await run(await strangerSigned(p, { from: STRANGER.address, validAfter: 0, validBefore: Math.floor(T0 / 1000) + 300 }), REQUIREMENTS), null);
});

test("each field that cannot succeed is refused with its own reason, before any chain read", async () => {
  const { run, lookups } = precheck();
  const p = await sdkPayload();
  const nowS = Math.floor(T0 / 1000);
  const cases: Array<[string, PaymentPayload, PaymentRequirements, string]> = [
    ["another recipient", tampered(p, { to: "0x1111111111111111111111111111111111111111" }), REQUIREMENTS, PRECHECK_REASONS.recipient],
    ["no recipient", tampered(p, { to: undefined }), REQUIREMENTS, PRECHECK_REASONS.recipient],
    ["less than the price", tampered(p, { value: "9999" }), REQUIREMENTS, PRECHECK_REASONS.value],
    ["expired", tampered(p, { validBefore: String(nowS - 1) }), REQUIREMENTS, PRECHECK_REASONS.validBefore],
    ["expiring this second", tampered(p, { validBefore: String(nowS) }), REQUIREMENTS, PRECHECK_REASONS.validBefore],
    ["not valid for another minute", tampered(p, { validAfter: String(nowS + VALID_AFTER_SKEW_S + 1) }), REQUIREMENTS, PRECHECK_REASONS.validAfter],
    ["validAfter missing", tampered(p, { validAfter: undefined }), REQUIREMENTS, PRECHECK_REASONS.malformed],
    ["validAfter not a number", tampered(p, { validAfter: "soon" }), REQUIREMENTS, PRECHECK_REASONS.malformed],
    ["no signature", tampered(p, {}, null), REQUIREMENTS, PRECHECK_REASONS.malformed],
    ["another network", { ...p, accepted: { ...p.accepted, network: "eip155:1" } }, REQUIREMENTS, PRECHECK_REASONS.network],
    ["terms on another network", p, { ...REQUIREMENTS, network: "eip155:1" }, PRECHECK_REASONS.network],
    ["another asset", { ...p, accepted: { ...p.accepted, asset: "0x74b7f16337b8972027f6196a17a631ac6de26d22" } }, REQUIREMENTS, PRECHECK_REASONS.asset],
  ];
  for (const [why, payload, req, reason] of cases) {
    const r = await run(payload, req);
    assert.equal(r?.reason, reason, why);
    assert.ok(r!.detail.length > 0, why);
  }
  assert.deepEqual(lookups, []);
  assert.match((await run(tampered(p, { to: STRANGER.address }), REQUIREMENTS))!.detail, new RegExp(PAY_TO));
  assert.match((await run(tampered(p, { validBefore: String(nowS - 1) }), REQUIREMENTS))!.detail, new RegExp(`clock reads ${nowS}`));
});

test("a signature by someone else is refused only when the chain says the payer has no code", async () => {
  const p = await sdkPayload();
  // Every field right, but signed by STRANGER while `from` says buyer: exactly a made-up authorization.
  const forged = await strangerSigned(p);
  const eoa = precheck();
  assert.equal((await eoa.run(forged, REQUIREMENTS))?.reason, PRECHECK_REASONS.signature);
  assert.deepEqual(eoa.lookups, [buyer.address], "one eth_getCode, for `from`");
  // An edited field breaks the buyer's own signature the same way.
  assert.equal((await eoa.run(tampered(p, { value: "20000" }), REQUIREMENTS))?.reason, PRECHECK_REASONS.signature);

  // A payer with code (a smart account; an EIP-7702 account like the OKX Agentic Wallet) may validate by
  // ERC-1271, which only the Broker can check: it goes on.
  const smart = precheck({ payerHasCode: async () => true });
  assert.equal(await smart.run(forged, REQUIREMENTS), null);
  // So does anything this side cannot be sure of.
  assert.equal(await precheck({ payerHasCode: async () => { throw new Error("rpc down"); } }).run(forged, REQUIREMENTS), null, "RPC error");
  const started = Date.now();
  assert.equal(await precheck({ payerHasCode: () => new Promise<boolean>(() => {}), codeLookupMs: 30 }).run(forged, REQUIREMENTS), null, "RPC silent");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(await precheck({ payerHasCode: null }).run(forged, REQUIREMENTS), null, "no chain wired");

  // Not a plain 65-byte ECDSA signature: ERC-6492-wrapped, 64-byte compact, or an odd v. Never judged here.
  const sig = (forged.payload as { signature: string }).signature;
  const wrapped = "0x" + "00".repeat(64) + sig.slice(2) + "6492".repeat(16);
  for (const s of [wrapped, sig.slice(0, 130), sig.slice(0, 130) + "25", "not-hex"]) {
    const x = precheck();
    assert.equal(await x.run(tampered(p, {}, s), REQUIREMENTS), null, s.slice(0, 20));
    assert.deepEqual(x.lookups, [], "and never costs a chain read");
  }
  // Domain parameters missing from the terms: nothing to recover against, so it goes on.
  assert.equal(await eoa.run(forged, { ...REQUIREMENTS, extra: {} }), null);
});

test("chain reads are capped per minute; past the cap a forged signature goes on to the Broker", async () => {
  let t = T0;
  const x = precheck({ now: () => t, maxCodeLookupsPerMinute: 2 });
  const forged = await strangerSigned(await sdkPayload());
  assert.equal((await x.run(forged, REQUIREMENTS))?.reason, PRECHECK_REASONS.signature);
  assert.equal((await x.run(forged, REQUIREMENTS))?.reason, PRECHECK_REASONS.signature);
  assert.equal(await x.run(forged, REQUIREMENTS), null, "cap spent");
  assert.equal(x.lookups.length, 2);
  t += 60_000;
  assert.equal((await x.run(forged, REQUIREMENTS))?.reason, PRECHECK_REASONS.signature, "the window rolls");
});

test("the pre-check never throws: a payload of the wrong shape is a refusal or a pass, not an error", async () => {
  const { run } = precheck();
  for (const junk of [{}, { accepted: REQUIREMENTS }, { accepted: REQUIREMENTS, payload: null }, { accepted: REQUIREMENTS, payload: { authorization: "x" } }]) {
    const r = await run(junk as unknown as PaymentPayload, REQUIREMENTS);
    assert.ok(r === null || typeof r.reason === "string");
  }
});
