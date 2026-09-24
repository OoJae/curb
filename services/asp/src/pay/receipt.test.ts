import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concat, getBytes, keccak256 } from "ethers";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { buildReceipt, receiptIdOf, receiptPath, writeReceipt, RECEIPT_SCHEMA } from "./receipt.ts";
import { sha256Hex } from "../hash.ts";
import { persistOnce } from "../persist.ts";

const requirements: PaymentRequirements = {
  scheme: "exact", network: "eip155:196", asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736", amount: "10000",
  payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 300, extra: { name: "USD₮0", version: "1" },
};
const payload: PaymentPayload = {
  x402Version: 2, accepted: requirements,
  payload: { signature: "0x" + "5e".repeat(65), authorization: { from: "0x2222222222222222222222222222222222222222", nonce: "0x01" } },
};
const TX = "0x" + "ab".repeat(32);
const body = Buffer.from('{"schema":"curb.asp.calendar/1"}');
const input = {
  route: "GET /v1/closure-calendar", query: { symbol: "wTCENTx", horizonDays: 7 }, requirements, payload,
  settlement: { transaction: TX, status: "success" }, responseBody: body, contentType: "application/json", tsMs: 1,
};

test("receiptId is keccak256 over the 32 transaction bytes followed by the 32 digest bytes", () => {
  const digest = sha256Hex(body);
  assert.equal(receiptIdOf(TX, digest), keccak256(concat([getBytes(TX), getBytes(digest)])));
  assert.notEqual(receiptIdOf(TX, sha256Hex(Buffer.from("other bytes"))), receiptIdOf(TX, digest), "different bytes, different receipt");
});

test("a receipt names the payer from the authorization when the Broker does not, and keeps no signature", () => {
  const r = buildReceipt(input);
  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(r.payer, "0x2222222222222222222222222222222222222222");
  assert.equal(r.responseDigest, sha256Hex(body));
  assert.equal(r.responseBytes, body.byteLength);
  assert.ok(!JSON.stringify(r).includes("5e".repeat(65)));
  assert.equal(buildReceipt({ ...input, settlement: { transaction: TX, payer: "0x3333333333333333333333333333333333333333" } }).payer,
    "0x3333333333333333333333333333333333333333", "the Broker's payer wins when present");
});

test("receipts are write-once: a second write for the same id never replaces the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-asp-receipt-"));
  const r = writeReceipt(dir, input);
  const path = receiptPath(dir, r.receiptId);
  const first = readFileSync(path, "utf8");
  writeReceipt(dir, { ...input, tsMs: 999 });
  assert.equal(readFileSync(path, "utf8"), first);
  assert.equal(persistOnce(path, "tampered"), false);
  assert.equal(readFileSync(path, "utf8"), first);
  // A pre-existing file at an unrelated name is untouched by the temp-file-and-rename dance.
  writeFileSync(join(dir, "other.json"), "x");
  assert.equal(readFileSync(join(dir, "other.json"), "utf8"), "x");
});
