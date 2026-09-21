import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRound } from "./round.ts";
import type { CohortEntry, RoundInputs } from "./round.ts";
import { verifyBundleOffline } from "./verify/offline.ts";
import { hashBytes } from "./tree.ts";
import type { Exchange, FetchLogEntry } from "./sources/xstocks.ts";
import { Regime } from "./regime.ts";

const API = "https://api.xstocks.fi/api/v2/public";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const XHKG_BODY = enc({
  mic: "XHKG", timezone: "Asia/Hong_Kong", isOpen: true, currentSession: null, nextChangeAt: null,
  schedule: {
    timezone: "Asia/Hong_Kong",
    sessions: [
      { kind: "Extended", days: WEEK, open: "09:00", close: "09:30" },
      { kind: "Regular", days: WEEK, open: "09:30", close: "12:00" },
      { kind: "Regular", days: WEEK, open: "13:00", close: "16:00" },
      { kind: "Extended", days: WEEK, open: "16:00", close: "16:10" },
    ],
    holidays: [],
  },
});

function tencentBody(period: string) {
  return enc({
    symbol: "TCENTx",
    trading: {
      currency: "USD", tradingHoursMode: "Regular", isTradingHalted: false, currentPeriod: period,
      openNow: period === "market", nextChangeAt: "2026-10-06T04:00:00.000Z",
      exchange: { mic: "XHKG", abbreviation: "HKEX", name: "HKEX", timezone: "Asia/Hong_Kong" },
      limitsPerPeriod: {
        market: { minOrderFiatValue: 1000, maxOrderFiatValue: 10_000_000 },
        extended: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
        overnight: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
        closed: { minOrderFiatValue: 1000, maxOrderFiatValue: 0 },
      },
    },
  });
}

const COHORT: CohortEntry[] = [
  { wrapper: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E", raw: "0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42", symbol: "TCENTx", mic: "XHKG" },
];

function exchange(url: string, body: Uint8Array, respEndMs: number): Exchange {
  return {
    url, status: 200, ok: true, body, bodyHash: hashBytes(body), bytes: body.byteLength,
    reqStartMs: respEndMs - 120, respEndMs, headers: { "cf-cache-status": "DYNAMIC" }, error: null,
  };
}

function inputs(period: string, evaluatedAt: string): RoundInputs {
  const t = new Date(evaluatedAt).getTime();
  const assetUrl = `${API}/assets/TCENTx?network=XLayer`;
  const schedUrl = `${API}/exchanges/XHKG`;
  const assetEx = exchange(assetUrl, tencentBody(period), t - 500);
  const schedEx = exchange(schedUrl, XHKG_BODY, t - 700);
  const log: FetchLogEntry[] = [schedEx, assetEx].map((e, i) => ({
    seq: i + 1, url: e.url, status: e.status, ok: e.ok, bodyHash: e.bodyHash, reqStartMs: e.reqStartMs, respEndMs: e.respEndMs, error: null,
  }));
  return {
    chainId: 196,
    clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",
    kind: "venue-close",
    targetMs: t,
    evaluatedAtMs: t,
    codeDigest: "sha256:test",
    cohort: COHORT,
    assetExchanges: new Map([["TCENTx", assetEx]]),
    scheduleExchanges: new Map([["XHKG", schedEx]]),
    fetchLog: log,
    chain: {
      block: { number: 70603928, hash: "0x" + "11".repeat(32), timestamp: t / 1000, rpc: "https://rpc.xlayer.tech" },
      results: [{ label: "gcm:0xfa15", target: COHORT[0].raw, callData: "0x2b63c300", success: true, returnData: "0x" }],
    },
  };
}

test("a round built at the 12:00 HKT close commits Tencent as CLOSED with cap 0", () => {
  const round = buildRound(inputs("market", "2026-10-06T04:00:00Z"));
  assert.equal(round.claims.length, 1);
  assert.equal(round.claims[0].regime, Regime.CLOSED);
  assert.equal(round.claims[0].capUsd, 0n);
  assert.match(round.root, /^0x[0-9a-f]{64}$/);
});

test("a stranger with only the published bundle reproduces the root and every claim", () => {
  const round = buildRound(inputs("market", "2026-10-06T04:00:00Z"));
  const published = JSON.parse(JSON.stringify(round.bundle)); // what an HTTP fetch of the bundle yields
  const v = verifyBundleOffline(published);
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);
  assert.equal(v.root, round.root);
});

test("tampering with a committed HTTP body is caught and named", () => {
  const round = buildRound(inputs("market", "2026-10-06T03:00:00Z"));
  const bundle = JSON.parse(JSON.stringify(round.bundle));
  const [h] = Object.keys(bundle.blobs).filter((k) => Buffer.from(bundle.blobs[k], "base64").toString().includes("TCENTx"));
  bundle.blobs[h] = Buffer.from(tencentBody("closed")).toString("base64");
  const v = verifyBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("blob hash mismatch")));
});

test("a claim that does not follow from the inputs is caught", () => {
  const round = buildRound(inputs("market", "2026-10-06T03:00:00Z"));
  const bundle = JSON.parse(JSON.stringify(round.bundle));
  // Swap in a lie about the claim while leaving its leaf hash pointing at the original preimage.
  const claimHash = Object.keys(bundle.json).find((k) => bundle.json[k].includes('"regime":4'))!;
  const lie = JSON.parse(bundle.json[claimHash]);
  lie.regime = 1;
  bundle.json[claimHash] = JSON.stringify(lie);
  const v = verifyBundleOffline(bundle);
  assert.equal(v.ok, false);
});

test("the root is reproducible: building the same round twice gives the same root", () => {
  assert.equal(buildRound(inputs("market", "2026-10-06T04:00:00Z")).root, buildRound(inputs("market", "2026-10-06T04:00:00Z")).root);
});

// Regression from the first live round (14 Sep 2026): the published top-level `kind` said "diff" while
// the committed PARAMS leaf said "heartbeat". The kind is now committed, and the verifier rejects a
// top-level label that contradicts it.
test("a relabelled round kind is caught, because only the committed PARAMS kind counts", () => {
  const round = buildRound(inputs("market", "2026-10-06T03:00:00Z"));
  const bundle = JSON.parse(JSON.stringify(round.bundle));
  assert.equal(verifyBundleOffline(bundle).ok, true);
  bundle.kind = "activation";
  const v = verifyBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("top-level kind")));
});

test("the round kind is part of the root: the same inputs with a different kind give a different root", () => {
  const a = buildRound({ ...inputs("market", "2026-10-06T03:00:00Z"), kind: "heartbeat" });
  const b = buildRound({ ...inputs("market", "2026-10-06T03:00:00Z"), kind: "diff" });
  assert.notEqual(a.root, b.root);
  assert.equal(a.bundle.kind, "heartbeat");
  assert.equal(b.bundle.kind, "diff");
});

test("tampering with the uncommitted top-level claims copy is caught", () => {
  const round = buildRound(inputs("market", "2026-10-06T03:00:00Z"));
  const bundle = JSON.parse(JSON.stringify(round.bundle));
  bundle.claims[0].regime = 1;
  const v = verifyBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("top-level claims")));
});

// ---------------------------------------------------------------------------------------------
// derive/3 commits the previous tick's observation, because it is an input to the claims.
// ---------------------------------------------------------------------------------------------

test("the prior observation is committed, and a round with a shut prior holds the reopen", () => {
  const t = new Date("2026-10-06T05:00:02Z").getTime();
  const open = { ...inputs("market", "2026-10-06T05:00:02Z"), kind: "diff" as const };
  const held = buildRound({ ...open, prior: { evaluatedAtMs: t - 5_000, claims: { [COHORT[0].wrapper.toLowerCase()]: { regime: 1, capUsd: "0" } } } });
  assert.equal(held.claims[0].regime, Regime.CLOSED, "one unconfirmed body cannot reopen the asset");
  assert.equal(verifyBundleOffline(held.bundle).ok, true, "and the hold re-derives from the bundle alone");

  const confirmed = buildRound({ ...open, prior: held.observed });
  assert.equal(confirmed.claims[0].regime, Regime.MARKET);
  assert.equal(verifyBundleOffline(confirmed.bundle).ok, true);
  assert.notEqual(held.root, confirmed.root, "a different prior is a different input, so a different root");
});

test("tampering with the committed prior is caught", () => {
  const t = new Date("2026-10-06T05:00:02Z").getTime();
  const held = buildRound({ ...inputs("market", "2026-10-06T05:00:02Z"), prior: { evaluatedAtMs: t - 5_000, claims: { [COHORT[0].wrapper.toLowerCase()]: { regime: 1, capUsd: "0" } } } });
  const bundle = JSON.parse(JSON.stringify(held.bundle));
  // Rewrite the prior so it claims the asset was already open, which would license the reopen.
  const priorHash = Object.keys(bundle.json).find((k) => bundle.json[k].includes('"regime":1') && bundle.json[k].includes("evaluatedAtMs"))!;
  bundle.json[priorHash] = JSON.stringify({ claims: { [COHORT[0].wrapper.toLowerCase()]: { capUsd: "100000", regime: 4 } }, evaluatedAtMs: t - 5_000 });
  const v = verifyBundleOffline(bundle);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("JSON preimage hash mismatch")), v.failures.join("; "));
});

test("a bundle whose method confirms reopens but carries no prior leaf is rejected", () => {
  const round = buildRound({ ...inputs("market", "2026-10-06T03:00:00Z"), prior: null });
  const bundle = JSON.parse(JSON.stringify(round.bundle));
  const tree = bundle.tree as { values: { value: [number, string, string] }[] };
  const before = tree.values.length;
  tree.values = tree.values.filter((v) => Number(v.value[0]) !== 8);
  assert.equal(tree.values.length, before - 1);
  const v = verifyBundleOffline(bundle);
  assert.equal(v.ok, false);
});
