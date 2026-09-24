// One function per shot id in docs/specs/brand-site-video.md §5.
//
//   S01–S09  curb.markets (site) — every function takes the site base, so a shot can point at a Vercel
//            preview today and at https://curb.markets on the day. `?capture=1` is always appended.
//   O1–O6    the X Layer explorer. OKLink's own host (oklink.com) fails its "device risk check" from
//            this machine even in an unautomated Chrome, so the default is OKX's explorer
//            (web3.okx.com/explorer/x-layer), the same OKLink data, OKX-branded, and it prints the
//            Builder Code chip beside the tx hash. Pass --explorer https://www.oklink.com/xlayer to switch.
//   M1       the OKX AI marketplace listing (agent #13869), in a persistent headed profile the user
//            has logged into once. URL from CURB_M1_URL.
//   T1–T5    terminal outputs, recorded verbatim with UTC stamps by term.mjs (never screen-recorded).
//
// Every shot function has the signature  async (ctx) => { path?, record?, note? }  and throws on a
// hard failure. Assertions are recorded through capture-lib's `ok()` and printed in the run summary.

import path from "node:path";
import fs from "node:fs";
import { newSession, ok, W, H, VIDEO_DIR, MEDIA } from "./capture-lib.mjs";
import { record } from "./term.mjs";

export const ADDR = {
  clock: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",
  scorecard: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f",
  wTCENTx: "0x41333Df9E7639188BBfca5522dC4844398Af9f9E",
};
export const TX = {
  settlement: "0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7", // $0.01 paid call, 24 Sep 11:56:21Z
  receipt: "0xcee1ee75f7323746b96afa5f4056640507a96d02316ba40f9010ac2d58a9817c",
  registration: "0xe2420407a65b51a468f060a52496e15587ce13d1c23fccff30330d8ab293ccc7", // marketplace agent #13869
  builderMint: "0xc3315eb4785c394567ee74e86ee6210443bb0ea80fac8564d15a4598482f051b", // Builder Code dd7u50nckt5e729f
};
export const BUILDER_CODE = "dd7u50nckt5e729f";
export const HOST_A = "https://attestor-a-production.up.railway.app";
export const API = "https://api.curb.markets";
export const RPC = "https://rpc.xlayer.tech";
export const REPO = path.resolve(VIDEO_DIR, "..");

/** Host A's /healthz, parsed. lastRound.tx is the attestation O2/T5 use; lastRound.root the T4 bundle. */
export async function hostA() {
  const res = await fetch(`${HOST_A}/healthz`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`host A /healthz HTTP ${res.status}`);
  return res.json();
}

export function defaults(over = {}) {
  return {
    site: "https://curb.markets",
    explorer: "https://web3.okx.com/explorer/x-layer",
    termOut: path.join(VIDEO_DIR, "terminal"),
    clipSuffix: "",
    headed: false,
    ...over,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Wait until the page's visible text satisfies `test`, polling once a second. */
async function waitText(s, test, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await s.text().catch(() => "");
    if (test(t)) return t;
    await s.hold(1000);
  }
  return null;
}

/** Explorer pages: load, wait for real data (not the spinner, not "not found"), dismiss cookie bar. */
async function explorerPage(s, url, mustInclude, { retries = 3 } = {}) {
  for (let i = 1; i <= retries; i++) {
    await s.go(url, { wait: "commit", timeout: 90000 });
    const t = await waitText(s, (x) => mustInclude.every((m) => x.includes(m)) || /wasn’t found|No data matching/.test(x));
    if (t && mustInclude.every((m) => t.includes(m))) {
      // Dismiss the cookie bar only if it is there, with an exact match: a loose "Accept" once matched
      // something else on a settle page and navigated to OKX's 404.
      if (/By clicking "Accept"/.test(t)) {
        await s.page.getByRole("button", { name: "Accept", exact: true }).first().click({ timeout: 1500 }).catch(() => {});
      }
      await s.hold(1200);
      const now = await s.text().catch(() => "");
      if (!mustInclude.every((m) => now.includes(m))) { console.log("  … page changed after load; reloading"); continue; }
      s.mark("ready");
      return now;
    }
    console.log(`  … explorer not ready (attempt ${i}/${retries}); retrying in 20 s`);
    await s.hold(20000);
  }
  throw new Error(`explorer never showed ${mustInclude.join(" + ")} at ${url}`);
}

const site = (ctx, p) => ctx.site.replace(/\/$/, "") + p;
const clipId = (ctx, id) => id + (ctx.clipSuffix || "");

/** Site pages: load with ?capture=1, wait for fonts and the first live number. */
async function sitePage(s, url, ready = /./) {
  await s.go(url, { capture: true, wait: "domcontentloaded" });
  await s.page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  const t = await waitText(s, (x) => ready.test(x), 30000);
  ok(s.id, "site page rendered", !!t, url);
  if (!t) throw new Error(`site not ready: ${url}`);
  s.mark("ready");
  return t;
}

// ── S: curb.markets ─────────────────────────────────────────────────────────────────────────────

/** S01 · live hero flips paper → ink at the 11:55 HKT cut (Fri 03:55Z). Records until the flip + 6 s. */
export async function S01(ctx) {
  const s = await newSession(clipId(ctx, "S01"), { headless: !ctx.headed });
  await sitePage(s, site(ctx, "/"), /trades|shut|open/i);
  await s.expectText("hero headline", /The market that trades/i);
  const regime = () => s.page.evaluate(() => document.documentElement.dataset.regime || document.body.dataset.regime || "").catch(() => "");
  const r0 = await regime();
  ok(s.id, "starts in paper mode (HK open)", /open|paper|market/i.test(r0), `data-regime=${r0}`);
  await s.move(W * 0.62, H * 0.52, 40);
  const deadline = ctx.flipDeadline ? Date.parse(ctx.flipDeadline) : Date.now() + 5 * 60000;
  let flipped = false;
  while (Date.now() < deadline) {
    const r = await regime();
    if (r && r !== r0) { flipped = true; s.mark("flip " + r0 + "→" + r); break; }
    await s.hold(500);
  }
  ok(s.id, "hero flipped paper → ink on the chain's word", flipped);
  await s.hold(6000);
  await s.still("S01-after-flip");
  await s.expectText("regime chip says shut", /shut/i);
  return { path: await s.finish() };
}

/** S02 · the unroll: scroll the 250vh pinned hero through all four captions. */
export async function S02(ctx) {
  const s = await newSession(clipId(ctx, "S02"), { headless: !ctx.headed });
  await sitePage(s, site(ctx, "/?regime=shut"), /trades/i);
  await s.hold(1500);
  const span = await s.page.evaluate(() => { const el = document.querySelector("[data-unroll], #unroll, .hm-unroll"); return el ? el.offsetTop + el.offsetHeight - innerHeight : innerHeight * 1.5; });
  for (const [f, ms, hold] of [[0.25, 2600, 600], [0.6, 4200, 900], [0.8, 3000, 1200], [1.0, 2600, 1800]]) {
    await s.scrollTo(span * f, ms); await s.hold(hold);
  }
  await s.expectText("caption: Mon 09:30 — opens", /09:30/);
  await s.expectText("caption: This week — 141 h 20 m", /141 h 20 m/);
  await s.still("S02-unrolled");
  return { path: await s.finish() };
}

/** S03 · /clock: the six-row board, a row hovered, the latest round's tx and inputRoot. */
export async function S03(ctx) {
  const s = await newSession(clipId(ctx, "S03"), { headless: !ctx.headed });
  await sitePage(s, site(ctx, "/clock"), /wTCENTx/);
  await s.expectText("six wrappers on the board", /wTCENTx[\s\S]*wSHEINx[\s\S]*wXIAOx[\s\S]*wMEITx[\s\S]*wNVDAx[\s\S]*wAAPLx/);
  await s.expectText("attested N min ago", /attested/i);
  await s.hold(1500);
  await s.moveToSel("text=wTCENTx"); await s.hold(1800);
  await s.scrollToEl(s.page.locator("text=/latest round/i").first(), 0.25, 1800).catch(() => {});
  await s.hold(2400);
  await s.still("S03-clock");
  return { path: await s.finish() };
}

/** S04 · /scorecard: a row committed (~04:50Z) or graded (~05:05Z) slides in. `ctx.phase` = commit|settle. */
export async function S04(ctx) {
  const phase = ctx.phase || "commit";
  const s = await newSession(clipId(ctx, `S04-${phase}`), { headless: !ctx.headed });
  const t0 = await sitePage(s, site(ctx, "/scorecard"), /graded|tie/i);
  const rows0 = (t0.match(/0x[0-9a-f]{4,}/gi) || []).length;
  await s.move(W * 0.4, H * 0.55, 30);
  const deadline = ctx.until ? Date.parse(ctx.until) : Date.now() + 3 * 60000;
  let changed = false;
  while (Date.now() < deadline) {
    const t = await s.text();
    if ((t.match(/0x[0-9a-f]{4,}/gi) || []).length !== rows0 || (phase === "settle" && /graded .*just now|tie/i.test(t) && t !== t0)) { changed = true; s.mark("row " + phase); break; }
    await s.hold(1000);
  }
  ok(s.id, `a ${phase} row appeared while recording`, changed);
  await s.hold(5000);
  await s.still(`S04-${phase}`);
  await s.expectText("A tie is not a win", /tie is not a win/i);
  return { path: await s.finish() };
}

/** S05 · /api: "ask without paying" animates 402 → free preview + price. */
export async function S05(ctx) {
  const s = await newSession(clipId(ctx, "S05"), { headless: !ctx.headed });
  await sitePage(s, site(ctx, "/api"), /closure-calendar|402/i);
  await s.hold(1200);
  await s.click("text=/ask without paying/i");
  const t = await waitText(s, (x) => /402/.test(x) && /\$0\.01|10000/.test(x), 20000);
  ok(s.id, "402 challenge shown with the $0.01 price", !!t);
  await s.hold(3500);
  await s.still("S05-402");
  await s.expectText("paid-call proof tx on the page", /0xe874/i);
  return { path: await s.finish() };
}

/** Wait (up to 60 s) until an instrument page's status tag says it is reading the live contracts. The site
 *  reads the public RPC at 3 requests a second, so the first paint is the specimen for a few seconds. */
async function waitLive(s, sel) {
  return s.page.waitForFunction((q) => /Live on X Layer/.test(document.querySelector(q)?.textContent ?? ""), sel, { timeout: 60000 })
    .then(() => s.page.waitForTimeout(1500)).then(() => true, () => false);
}

/** S06 · /notes: the certificate (guilloche, tilt) and the descending clock. Variant B = specimen. */
export async function S06(ctx) {
  const s = await newSession(clipId(ctx, "S06"), { headless: !ctx.headed });
  const t = await sitePage(s, site(ctx, "/notes"), /reopen/i);
  ok(s.id, "honest label when not live", !/specimen/i.test(t) || /in build/i.test(t));
  ok(s.id, "live contracts read (not the specimen)", await waitLive(s, "[data-nt-status]"));
  await s.moveToSel("[data-nt-cert] .crt, .crt"); await s.hold(1400);
  await s.move(W * 0.62, H * 0.42, 40); await s.hold(1400);
  await s.still("S06-certificate");
  // The descending clock for the live lot: cleared price, realised discount once the reopen is printed.
  const clockY = await s.page.locator("#clock").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 40).catch(() => null);
  if (clockY != null) { await s.scrollTo(clockY, 1600); await s.hold(1800); await s.still("S06-clock"); }
  return { path: await s.finish() };
}

/** S07 · /depth: the LTV curve; drag the depth handle; "you are here". Variant B = specimen. */
export async function S07(ctx) {
  const s = await newSession(clipId(ctx, "S07"), { headless: !ctx.headed });
  const t = await sitePage(s, site(ctx, "/depth"), /LTV|depth/i);
  ok(s.id, "honest label when not live", !/specimen/i.test(t) || /in build/i.test(t));
  ok(s.id, "live contracts read (not the specimen)", await waitLive(s, "[data-dp-status]"));
  const handle = s.page.locator("[data-handle], .dp-handle, [role=slider]").first();
  if (await handle.count()) {
    const b = await s.moveTo(handle);
    await s.page.mouse.down(); await s.move(b.x + 260, b.y + b.height / 2, 60); await s.page.mouse.up();
  }
  await s.hold(1800);
  await s.still("S07-ltv");
  return { path: await s.finish() };
}

/** S08 · mobile 390×844: the home page as a phone sees it. */
export async function S08(ctx) {
  const s = await newSession(clipId(ctx, "S08"), { headless: !ctx.headed, viewport: { width: 390, height: 844 }, dpr: 3 });
  await sitePage(s, site(ctx, "/"), /trades/i);
  await s.hold(1500);
  await s.scrollTo(700, 2400); await s.hold(1500);
  await s.scrollTo(1500, 2400); await s.hold(1500);
  await s.still("S08-mobile");
  return { path: await s.finish() };
}

/** S09 · the live hero + regime chip after the reopen (~05:15Z). */
export async function S09(ctx) {
  const s = await newSession(clipId(ctx, "S09"), { headless: !ctx.headed });
  await sitePage(s, site(ctx, "/"), /trades/i);
  await s.expectText("hero headline", /The market that trades/i);
  await s.move(W * 0.82, 40, 40);
  await s.hold(1200);
  await s.click("[popovertarget], .regime-chip, [data-regime-chip]").catch(() => {});
  await s.hold(2600);
  await s.still("S09-hero");
  return { path: await s.finish() };
}

// ── O: the X Layer explorer ─────────────────────────────────────────────────────────────────────

const exTx = (ctx, h) => `${ctx.explorer}/tx/${h}`;
const exAddr = (ctx, a) => `${ctx.explorer}/address/${a}`;

/** O1 · MarketClock contract page: the five-minute cadence of attestations from host A. */
export async function O1(ctx) {
  const s = await newSession(clipId(ctx, "O1"), { headless: !ctx.headed });
  await explorerPage(s, exAddr(ctx, ADDR.clock), [ADDR.clock, "Txn hash", "0xe42c6251"]);
  await s.expectText("contract address shown", ADDR.clock);
  await s.expectText("attestBatch calls (0xe42c6251) listed", "0xe42c6251");
  await s.expectText("from host A 0x842e…", /0x842e/i);
  await s.still("O1-marketclock");
  await s.move(760, 700, 40); await s.hold(900);
  await s.scrollTo(260, 2200); await s.hold(1200);
  await s.move(740, 460, 30); await s.hold(1400);
  await s.still("O1-marketclock-rows");
  return { path: await s.finish() };
}

/** O2 · an attestation tx carrying the Builder Code (host A /healthz lastRound.tx, or ctx.tx). */
export async function O2(ctx) {
  const tx = ctx.tx || (await hostA()).lastRound.tx;
  const s = await newSession(clipId(ctx, "O2"), { headless: !ctx.headed });
  await explorerPage(s, exTx(ctx, tx), [tx, "Txn hash", "0xe42c6251"]);
  await s.expectText("Builder Code chip beside the hash", BUILDER_CODE);
  await s.expectText("to MarketClock", ADDR.clock.toLowerCase());
  await s.expectText("attestBatch selector", "0xe42c6251");
  await s.hold(1500);
  // Rest the cursor just under the chip, pointing at it without covering the code.
  const chip = await s.page.locator(`text=${BUILDER_CODE}`).first().boundingBox().catch(() => null);
  if (chip) await s.move(chip.x + chip.width * 0.5, chip.y + chip.height + 16);
  await s.hold(3500);
  await s.still("O2-attestation");
  await s.move(900, 515, 36); await s.hold(1800);
  await s.scrollTo(560, 2600); await s.hold(2400);
  await s.still("O2-attestation-input");
  const p = await s.finish();
  fs.writeFileSync(path.join(MEDIA, "clips", clipId(ctx, "O2") + ".tx"), tx + "\n");
  return { path: p, note: tx };
}

/** O3 · Scorecard v2 contract page now; in the live window, the commit (~04:50Z) and settle (~05:05Z) txs. */
export async function O3(ctx) {
  const tag = ctx.tx ? (ctx.phase || "tx") : "contract";
  const s = await newSession(clipId(ctx, `O3-${tag}`), { headless: !ctx.headed });
  if (ctx.tx) {
    await explorerPage(s, exTx(ctx, ctx.tx), [ctx.tx, "Txn hash"]);
    await s.expectText("to Scorecard", ADDR.scorecard.toLowerCase());
    await s.expectText("Builder Code chip", BUILDER_CODE);
  } else {
    await explorerPage(s, exAddr(ctx, ADDR.scorecard), [ADDR.scorecard, "Txn hash"]);
    await s.expectText("contract address shown", ADDR.scorecard);
  }
  await s.hold(1200);
  await s.move(760, 620, 40); await s.hold(1600);
  await s.still(`O3-${tag}`);
  return { path: await s.finish() };
}

/** O4 · the $0.01 settlement: 10000 USD₮0 units from the Agentic Wallet to curb-revenue. */
export async function O4(ctx) {
  const s = await newSession(clipId(ctx, "O4"), { headless: !ctx.headed });
  await explorerPage(s, exTx(ctx, TX.settlement), [TX.settlement, "Txn hash", "ERC20 token transfers", "0x055b"]);
  await s.expectText("0.01 USD₮0 transfer", /0\.01\s*USD₮0/);
  await s.expectText("to curb-revenue 0x277c…", /0x277c/i);
  await s.expectText("from the Agentic Wallet 0x055b…", /0x055b/i);
  await s.expectText("block 71481945", "71481945");
  await s.hold(1500);
  const row = await s.page.getByText("ERC20 token transfers").first().boundingBox({ timeout: 3000 }).catch(() => null);
  await s.move(660, row ? row.y - 176 : 536, 30);           // the "Transaction action" line: Transfer 0.01 USD₮0
  await s.hold(2400);
  await s.move(1010, row ? row.y + row.height / 2 : 713, 30); // the ERC-20 row: from the Agentic Wallet, for 0.01
  await s.hold(3600);
  await s.still("O4-settlement");
  return { path: await s.finish() };
}

/** O5 · the marketplace registration tx (agent #13869). */
export async function O5(ctx) {
  const s = await newSession(clipId(ctx, "O5"), { headless: !ctx.headed });
  await explorerPage(s, exTx(ctx, TX.registration), [TX.registration, "Txn hash"]);
  await s.expectText("from the Agentic Wallet 0x055b…", /0x055b/i);
  await s.hold(1200); await s.move(900, 420, 40); await s.hold(1800);
  await s.still("O5-registration");
  return { path: await s.finish() };
}

/** O6 · the Builder Code mint (dd7u50nckt5e729f), block 71,444,945. */
export async function O6(ctx) {
  const s = await newSession(clipId(ctx, "O6"), { headless: !ctx.headed });
  await explorerPage(s, exTx(ctx, TX.builderMint), [TX.builderMint, "Txn hash"]);
  await s.expectText("block 71444945", "71444945");
  await s.hold(1200); await s.move(900, 420, 40); await s.hold(1800);
  await s.still("O6-builder-mint");
  return { path: await s.finish() };
}

// ── M: the OKX AI marketplace ───────────────────────────────────────────────────────────────────

/** M1 · marketplace listing #13869. Needs CURB_M1_URL and a profile the user has logged into once. */
export async function M1(ctx) {
  const url = ctx.m1Url || process.env.CURB_M1_URL;
  if (!url) throw new Error("M1 needs CURB_M1_URL (the listing page for agent #13869, opened in a logged-in browser)");
  const s = await newSession(clipId(ctx, "M1"), { headless: false, channel: "chrome" });
  await s.go(url, { wait: "domcontentloaded" });
  const t = await waitText(s, (x) => /13869|Curb/i.test(x), 60000);
  ok(s.id, "listing shows Curb / #13869", !!t);
  await s.expectText("three services listed", /Closure Calendar[\s\S]*Accuracy[\s\S]*Discount/i);
  await s.hold(1500); await s.move(W * 0.5, H * 0.55, 40); await s.hold(2000);
  await s.still("M1-marketplace");
  return { path: await s.finish() };
}

// ── T: terminal outputs (recorded, never screen-captured) ───────────────────────────────────────

const STATE_SIG = "stateOf(address)((uint8,uint128,uint64,uint64,uint32,bool))";
const CAL = `${API}/v1/closure-calendar?symbol=wTCENTx`;

/** T1 · cast call stateOf(wTCENTx) on MarketClock. */
export async function T1(ctx) {
  const r = await record({
    id: "T1", out: ctx.termOut, title: "cast",
    argv: ["cast", "call", ADDR.clock, STATE_SIG, ADDR.wTCENTx, "--rpc-url", RPC],
    show: `cast call ${ADDR.clock} "${STATE_SIG}" ${ADDR.wTCENTx} --rpc-url ${RPC}`,
  });
  ok("T1", "cast exited 0", r.exitCode === 0);
  ok("T1", "a 6-field State tuple came back", /^\(\d+, \d+, \d+/.test(r.output.trim()), r.output.trim());
  return { record: r };
}

/** T2 · the unpaid call: HTTP 402 with the x402 challenge. */
export async function T2(ctx) {
  const r = await record({ id: "T2", out: ctx.termOut, title: "curl", argv: ["curl", "-si", CAL], show: `curl -si "${CAL}"` });
  ok("T2", "HTTP 402 Payment Required", /^HTTP\/[\d.]+ 402/m.test(r.output));
  ok("T2", "PAYMENT-REQUIRED header present", /payment-required:/i.test(r.output));
  return { record: r };
}

/** T3q · onchainos payment quote: probes the 402, parses the challenge, ranks candidates. Never signs. */
export async function T3q(ctx) {
  const r = await record({ id: "T3q", out: ctx.termOut, title: "onchainos", argv: ["onchainos", "payment", "quote", CAL], show: `onchainos payment quote "${CAL}"` });
  ok("T3q", "quote exited 0", r.exitCode === 0, `exit ${r.exitCode}`);
  ok("T3q", "quote names curb-revenue as payTo", /0x277c/i.test(r.output));
  return { record: r };
}

/** T3r · the receipt of the first paid call (read-only GET; immutable object). */
export async function T3r(ctx) {
  const url = `${API}/receipts/${TX.receipt}.json`;
  const r = await record({ id: "T3r", out: ctx.termOut, title: "curl", argv: ["curl", "-s", url], show: `curl -s ${url}` });
  ok("T3r", "receipt names the settlement tx", r.output.toLowerCase().includes(TX.settlement.slice(2, 18)));
  ok("T3r", "receipt carries responseDigest", /responseDigest/.test(r.output));
  return { record: r };
}

/**
 * T3 · the paid call. NOT automated: it spends $0.01 from the Agentic Wallet. The lead runs it by hand
 * at ~05:15Z through term.mjs with CURB_ALLOW_SPEND=1 (see capture/README.md). This only checks
 * whether that record exists yet.
 */
export async function T3(ctx) {
  const p = path.join(ctx.termOut, "T3.json");
  const have = fs.existsSync(p);
  ok("T3", "paid call recorded by the lead (terminal/…/T3.json)", have, have ? "" : "run by hand; see capture/README.md");
  return { note: have ? p : "pending: lead runs the paid call by hand" };
}

/** T4 · curb-verify on host A's latest round bundle (or ctx.root). */
export async function T4(ctx) {
  const root = ctx.root || (await hostA()).lastRound.root;
  const url = `${HOST_A}/rounds/${root}.json`;
  const r = await record({
    id: "T4", out: ctx.termOut, title: "curb-verify", cwd: REPO,
    argv: ["node", "tools/curb-verify/src/cli.ts", "bundle", url],
    show: `node tools/curb-verify/src/cli.ts bundle ${url}`,
  });
  ok("T4", "curb-verify exit 0 (verified)", r.exitCode === 0, `exit ${r.exitCode}`);
  return { record: r };
}

/** T4s · curb-verify selftest: the bundled mainnet fixtures, no network. */
export async function T4s(ctx) {
  const r = await record({
    id: "T4s", out: ctx.termOut, title: "curb-verify", cwd: REPO,
    argv: ["node", "tools/curb-verify/src/cli.ts", "selftest"],
    show: "node tools/curb-verify/src/cli.ts selftest",
  });
  ok("T4s", "selftest passed", r.exitCode === 0 && /selftest passed/.test(r.output), `exit ${r.exitCode}`);
  return { record: r };
}

/** T5 · the ERC-8021 suffix decoded from a real attestation's calldata tail (host A lastRound.tx). */
export async function T5(ctx) {
  const tx = ctx.tx || (await hostA()).lastRound.tx;
  const r = await record({
    id: "T5", out: ctx.termOut, title: "node", cwd: VIDEO_DIR,
    argv: ["node", "capture/decode-8021.mjs", tx],
    show: `node decode-8021.mjs ${tx}`,
  });
  ok("T5", "Builder Code decoded from calldata", r.exitCode === 0 && r.output.includes(BUILDER_CODE));
  return { record: r };
}

/** T6 · one closed 1-minute Binance kline for Tencent's perpetual, relayed byte for byte (mark/2's input). */
export async function T6(ctx) {
  const start = ctx.klineStart || 1790251200000; // 2026-09-24T12:00:00Z = 20:00 HKT, Hong Kong shut
  const url = `${API}/v1/relay/binance/klines?symbol=HK0700USDT&startTime=${start}&limit=1`;
  const r = await record({ id: "T6", out: ctx.termOut, title: "curl", argv: ["curl", "-s", url], show: `curl -s "${url}"` });
  ok("T6", "a kline came back", r.exitCode === 0 && /\d{13}/.test(r.output), r.output.slice(0, 120));
  return { record: r };
}

/** HZ · host A /healthz (lastRound), saved verbatim: the provenance of O2/T4/T5's tx and root. */
export async function HZ(ctx) {
  const r = await record({ id: "HZ", out: ctx.termOut, title: "curl", argv: ["curl", "-s", `${HOST_A}/healthz`], show: `curl -s ${HOST_A}/healthz` });
  let j = null; try { j = JSON.parse(r.output); } catch {}
  ok("HZ", "host A healthy with a lastRound", !!(j && j.ok && j.lastRound && j.lastRound.tx));
  ok("HZ", "attribution on, code dd7u50nckt5e729f", !!(j && j.attribution && j.attribution.codes && j.attribution.codes.includes(BUILDER_CODE)));
  return { record: r, healthz: j };
}

export const SHOTS = { S01, S02, S03, S04, S05, S06, S07, S08, S09, O1, O2, O3, O4, O5, O6, M1, T1, T2, T3q, T3r, T3, T4, T4s, T5, T6, HZ };
