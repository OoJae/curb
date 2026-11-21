import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS, CONTRACTS, resolveAsset, requireAsset, UnknownSymbol } from "./assets.ts";

test("the table is MarketClock's cohort: twelve wrappers, four in Hong Kong and eight in the US", () => {
  assert.deepEqual(ASSETS.map((a) => a.symbol), [
    "wTCENTx", "wXIAOx", "wMEITx", "wSHEINx", "wNVDAx", "wAAPLx",
    "wSPYx", "wQQQx", "wGOOGLx", "wCRCLx", "wSPCXx", "wTSLAx",
  ]);
  assert.deepEqual(ASSETS.map((a) => a.mic), [
    "XHKG", "XHKG", "XHKG", "XHKG", "XNAS", "XNAS",
    "ARCX", "XNAS", "XNAS", "XNYS", "XNAS", "XNAS",
  ]);
  // Registered on 21 Nov 2026; the addresses are the ones MarketClock's AssetRegistered events carry.
  assert.equal(ASSETS.find((a) => a.symbol === "wSPYx")!.wrapper, "0xE7E553Cd128F0011777323A0b44a7b96EA1CB540");
  assert.equal(ASSETS.find((a) => a.symbol === "wTSLAx")!.wrapper, "0xc3FdBe3A68EE5dE461D30415a8165cf9Aefe1171");
  for (const a of ASSETS) assert.equal(a.ticker, a.symbol.slice(1), "the issuer ticker is the wrapper symbol without its w");
  assert.equal(ASSETS.find((a) => a.symbol === "wTCENTx")!.wrapper, "0x41333Df9E7639188BBfca5522dC4844398Af9f9E");
  assert.equal(CONTRACTS.marketClock, "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b");
  assert.equal(CONTRACTS.scorecard, "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f");
});

test("a wrapper symbol, its issuer ticker and its address all resolve, in any case, trimmed", () => {
  for (const s of ["wTCENTx", "WTCENTX", "wtcentx", "TCENTx", "tcentx", "  TCENTx ", "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", "0x41333df9e7639188bbfca5522dc4844398af9f9e"]) {
    assert.equal(resolveAsset(s)?.symbol, "wTCENTx", s);
  }
  assert.equal(resolveAsset("AAPLx")?.wrapper, "0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f");
  assert.equal(resolveAsset("wSHEINx")?.mic, "XHKG");
});

test("anything else is refused: other tickers, the raw token, near-miss addresses, empty and oversized input", () => {
  for (const s of [
    "", "   ", "GME", "TCENT", "0700.HK", "wTCENTxx", "AAPL",
    "0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42",          // TCENTx's raw rebasing token, not the wrapper
    "0x41333Df9E7639188BBfca5522dC4844398Af9f9F",          // the wrapper with its last digit changed
    "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",          // MarketClock itself
    "w".repeat(65), "wTCENTx".repeat(20),
  ]) {
    assert.equal(resolveAsset(s), undefined, JSON.stringify(s));
  }
});

test("requireAsset names what it accepts, and echoes at most 64 characters of what it refused", () => {
  assert.equal(requireAsset("meitx").symbol, "wMEITx");
  const long = "X".repeat(500);
  assert.throws(() => requireAsset(long), (e: unknown) => {
    assert.ok(e instanceof UnknownSymbol);
    assert.equal(e.input.length, 64);
    assert.ok(!e.message.includes("X".repeat(65)));
    for (const a of ASSETS) assert.ok(e.message.includes(a.symbol) && e.message.includes(a.wrapper));
    return true;
  });
});
