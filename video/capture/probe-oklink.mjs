// Probe a page (OKLink by default headed, since OKLink stalls headless) and dump what a viewer sees:
// a full-page screenshot and the visible text, under media/probe/. Used to find selectors for shots.
//   node capture/probe-oklink.mjs <url> [--headless] [--wait "text that means loaded"]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { MEDIA } from "./capture-lib.mjs";

const url = process.argv[2];
const headless = process.argv.includes("--headless");
const wi = process.argv.indexOf("--wait");
const waitFor = wi >= 0 ? process.argv[wi + 1] : null;
const browser = await chromium.launch({
  headless, channel: headless ? undefined : "chrome",
  args: ["--disable-blink-features=AutomationControlled", "--lang=en-US"],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC" });
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(url, { waitUntil: "commit", timeout: 90000 });
let text = "";
for (let i = 0; i < 120; i++) {
  text = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
  if (waitFor ? text.includes(waitFor) : /Block|not found|wasn’t found|Overview/.test(text)) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);
text = await page.evaluate(() => document.body.innerText).catch(() => "");
fs.mkdirSync(path.join(MEDIA, "probe"), { recursive: true });
const name = url.split("/").pop().slice(0, 12) + (headless ? "-headless" : "");
await page.screenshot({ path: path.join(MEDIA, "probe", name + ".png"), fullPage: true });
fs.writeFileSync(path.join(MEDIA, "probe", name + ".txt"), text);
fs.writeFileSync(path.join(MEDIA, "probe", name + ".html"), await page.content());
console.log("url", page.url(), "ms", Date.now() - t0, "title", await page.title());
console.log(text.slice(0, 5000));
await browser.close();
