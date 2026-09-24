// Capture library for the Curb demo. Adapted from BlastRadius (capture-lib.mjs / capture-run.mjs).
//
// Every clip is a real browser session recorded with Playwright's recordVideo at 1920×1080, rendered
// at DPR 2 and downscaled, with a visible cursor driven by the same eased coordinates we hand to the
// mouse. A demo without a cursor reads as a slideshow; a cursor that teleports reads as a robot.
//
// Site URLs get `?capture=1`, which tells curb.markets to hide its own cursor effects so only this
// cursor is on screen. Every clip carries text assertions: a shot that recorded the wrong page, an
// error state or a stale number fails loudly in the summary instead of silently reaching the edit.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MEDIA = path.join(VIDEO_DIR, "media");
export const W = 1920, H = 1080;

/** One result per assertion, across every clip in the run. */
export const results = [];
export function ok(clip, name, pass, detail = "") {
  results.push({ clip, name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail && !pass ? `  (${detail})` : ""}`);
  return !!pass;
}

/** Pass/fail summary; returns the process exit code. */
export function summary(clipPaths = []) {
  console.log("\n═══ CLIPS ═══");
  for (const c of clipPaths) console.log(` ${c.id.padEnd(5)} ${c.path ?? "FAILED" + (c.error ? ": " + c.error : "")}`);
  const fails = results.filter((r) => !r.pass);
  console.log(`\n═══ CHECKS: ${results.length - fails.length}/${results.length} passed ═══`);
  for (const f of fails) console.log(`  FAILED [${f.clip}] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  return fails.length || clipPaths.some((c) => !c.path) ? 1 : 0;
}

/** The cursor: an ivory ring with an ink keyline, legible on ink, on paper and on OKLink's white. */
const CURSOR = `
(() => {
  if (window.__curInstalled) return; window.__curInstalled = true;
  const mount = () => {
    if (document.getElementById('__cur')) return;
    const d = document.createElement('div');
    d.id = '__cur';
    d.style.cssText = [
      'position:fixed','left:0','top:0','width:20px','height:20px','z-index:2147483647',
      'pointer-events:none','border-radius:50%','border:2px solid #F4EFE6',
      'box-shadow:0 0 0 1.5px rgba(15,23,32,.9), inset 0 0 0 1.5px rgba(15,23,32,.55)',
      'background:rgba(244,239,230,.10)','transform:translate(-50%,-50%)',
      'transition:width .12s ease,height .12s ease,background .12s ease',
      'will-change:transform','opacity:0'
    ].join(';');
    (document.body || document.documentElement).appendChild(d);
    window.__cur = (x,y) => { d.style.opacity='1'; d.style.transform='translate('+x+'px,'+y+'px) translate(-50%,-50%)'; };
    window.__curDown = () => { d.style.width='13px'; d.style.height='13px'; d.style.background='rgba(244,239,230,.55)'; };
    window.__curUp = () => { d.style.width='20px'; d.style.height='20px'; d.style.background='rgba(244,239,230,.10)'; };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
`;

/** Append ?capture=1 (or &capture=1) to a site URL. Leaves third-party URLs alone. */
export function withCapture(url) {
  const u = new URL(url);
  if (!u.searchParams.has("capture")) u.searchParams.set("capture", "1");
  return u.toString();
}

/**
 * Open a recorded browser session.
 * @param {string} id       shot id, e.g. "O1"; raw webm goes to media/raw/<id>/
 * @param {object} o
 *   headless   default true. OKLink sometimes blocks headless; pass false + channel:"chrome".
 *   channel    "chrome" to drive the real installed Google Chrome instead of Chrome for Testing.
 *   dpr        device scale factor, default 2 (rendered at 2× and downscaled by the recorder).
 *   viewport   {width,height}, default 1920×1080. S08 uses 390×844.
 *   cursor     default true.
 *   record     default true; false for stills-only sessions.
 */
export async function newSession(id, o = {}) {
  const { headless = true, channel, dpr = 2, viewport = { width: W, height: H }, cursor = true, record = true } = o;
  const rawDir = path.join(MEDIA, "raw", id);
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(path.join(MEDIA, "stills"), { recursive: true });
  const browser = await chromium.launch({
    headless, channel,
    args: ["--hide-scrollbars", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
  });
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: dpr, locale: "en-US", timezoneId: "UTC", colorScheme: "light",
    userAgent: o.userAgent,
    ...(record ? { recordVideo: { dir: rawDir, size: { width: viewport.width, height: viewport.height } } } : {}),
  });
  const t0 = Date.now();
  const page = await ctx.newPage();
  if (cursor) await page.addInitScript(CURSOR);
  const state = { x: viewport.width / 2, y: viewport.height / 2 };
  const marks = [];

  const s = {
    id, page, ctx, browser, t0, marks,
    /** Record a named moment (ms from the start of the recording) for the edit. */
    mark(name) { const t = Date.now() - t0; marks.push({ name, t }); return t; },
    async go(url, { capture = false, wait = "domcontentloaded", timeout = 60000 } = {}) {
      const u = capture ? withCapture(url) : url;
      await page.goto(u, { waitUntil: wait, timeout });
      if (cursor) await page.evaluate(CURSOR).catch(() => {});
      s.mark("loaded " + u);
    },
    /** Human-paced pointer movement: eased (out-cubic), never teleporting. */
    async move(x, y, steps = 28) {
      const sx = state.x, sy = state.y;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = 1 - Math.pow(1 - t, 3);
        const cx = sx + (x - sx) * e, cy = sy + (y - sy) * e;
        await page.mouse.move(cx, cy);
        if (cursor) await page.evaluate(([a, b]) => window.__cur && window.__cur(a, b), [cx, cy]).catch(() => {});
        await page.waitForTimeout(12);
      }
      state.x = x; state.y = y;
    },
    async moveTo(locator) {
      const box = await locator.boundingBox();
      if (!box) throw new Error("no box for locator");
      await s.move(box.x + box.width / 2, box.y + box.height / 2);
      return box;
    },
    async moveToSel(sel, nth = 0) { return s.moveTo(page.locator(sel).nth(nth)); },
    async click(sel, nth = 0) {
      const loc = typeof sel === "string" ? page.locator(sel).nth(nth) : sel;
      await s.moveTo(loc);
      if (cursor) await page.evaluate(() => window.__curDown && window.__curDown()).catch(() => {});
      await page.waitForTimeout(90);
      await loc.click();
      if (cursor) await page.evaluate(() => window.__curUp && window.__curUp()).catch(() => {});
      await page.waitForTimeout(160);
    },
    /** Type like a person: per-key delay, no pasting. */
    async type(sel, text, delay = 80) { await page.locator(sel).first().pressSequentially(text, { delay }); },
    /**
     * Eased scroll that reads as a camera move. Uses the site's Lenis when it exposes one
     * (curb.markets does: window.lenis), else an in-page rAF ease-in-out cubic.
     */
    async scrollTo(y, ms = 1400) {
      await page.evaluate(async ([target, dur]) => {
        if (window.lenis && typeof window.lenis.scrollTo === "function") {
          await new Promise((res) => window.lenis.scrollTo(target, { duration: dur / 1000, onComplete: res }));
          return;
        }
        const start = window.scrollY, delta = target - start, t0 = performance.now();
        await new Promise((res) => {
          const step = (now) => {
            const t = Math.min((now - t0) / dur, 1);
            const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            window.scrollTo(0, start + delta * e);
            t < 1 ? requestAnimationFrame(step) : res();
          };
          requestAnimationFrame(step);
        });
      }, [y, ms]);
    },
    /** Scroll so an element sits at `frac` of the viewport height. */
    async scrollToEl(locator, frac = 0.3, ms = 1400) {
      const y = await locator.evaluate((el, f) => el.getBoundingClientRect().top + window.scrollY - window.innerHeight * f, frac);
      await s.scrollTo(Math.max(0, y), ms);
    },
    async still(name) {
      const p = path.join(MEDIA, "stills", `${name}${id.endsWith("-dry") ? "-dry" : ""}.png`);
      await page.screenshot({ path: p });
      s.mark("still " + name);
      return p;
    },
    async hold(ms) { await page.waitForTimeout(ms); },
    async text() { return page.evaluate(() => document.body.innerText); },
    /** Per-clip text assertion against the page's visible text. */
    async expectText(name, pattern) {
      const t = await s.text().catch(() => "");
      const pass = typeof pattern === "string" ? t.includes(pattern) : pattern.test(t);
      return ok(id, name, pass, pass ? "" : `not found: ${pattern}`);
    },
    async expectVisible(name, sel) {
      const v = await page.locator(sel).first().isVisible().catch(() => false);
      return ok(id, name, v, v ? "" : `not visible: ${sel}`);
    },
    /** Close, transcode to media/clips/<id>.mp4, write the marks sidecar. */
    async finish({ transcodeTo = id } = {}) {
      await page.waitForTimeout(400);
      const v = record ? page.video() : null;
      await ctx.close();
      await browser.close();
      if (!v) return null;
      const webm = await v.path();
      const mp4 = transcode(webm, path.join(MEDIA, "clips", `${transcodeTo}.mp4`));
      fs.writeFileSync(path.join(MEDIA, "clips", `${transcodeTo}.json`), JSON.stringify({
        id, recordedAt: new Date(t0).toISOString(), webm: path.relative(VIDEO_DIR, webm), marks,
      }, null, 2) + "\n");
      return mp4;
    },
  };
  return s;
}

/** webm → H.264 MP4 through transcode.sh (CRF 18, yuv420p, faststart, 30 fps, no audio). */
export function transcode(input, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const out = execFileSync("bash", [path.join(VIDEO_DIR, "capture", "transcode.sh"), input, output], { encoding: "utf8" });
  process.stdout.write("  " + out.trim().split("\n").join("\n  ") + "\n");
  return path.relative(VIDEO_DIR, output);
}

/** Wait until a wall-clock UTC instant ("2026-09-25T03:54:15Z"). Prints a countdown once a minute. */
export async function untilUtc(iso, label = "") {
  const at = Date.parse(iso);
  let last = -1;
  for (;;) {
    const left = at - Date.now();
    if (left <= 0) return;
    const m = Math.floor(left / 60000);
    if (m !== last) { console.log(`  … ${label || iso}: ${m} min ${Math.floor((left % 60000) / 1000)} s to go (now ${new Date().toISOString()})`); last = m; }
    await new Promise((r) => setTimeout(r, Math.min(left, 1000)));
  }
}
