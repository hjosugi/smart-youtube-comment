// Playwright e2e: the settings sheet builds from the schema, a change live-updates
// the danmaku engine config AND persists to localStorage. Mock mode (no network).

import { chromium } from "playwright";
import { serveWeb } from "./_serve.mjs";

const { port, close } = await serveWeb();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" });
await page.waitForSelector(".settings-btn", { timeout: 8000 });
await page.click(".settings-btn");
await page.waitForSelector('[data-key="speedPct"]', { timeout: 4000 });

// schema-driven: several known controls exist
const controlKeys = await page.$$eval("[data-key]", (els) => els.map((e) => e.dataset.key));

// change scroll speed to 200% and dispatch input (live preview + save)
await page.$eval('[data-key="speedPct"]', (el) => {
  el.value = "200";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(200);

const after = await page.evaluate(() => ({
  durationScale: globalThis.SYCApp?.overlay?.cfg?.durationScale,
  saved: JSON.parse(localStorage.getItem("syc:settings") || "{}").speedPct,
}));

// NG filter: save a word, confirm it persists
await page.$eval(".ng", (el) => {
  el.value = "blockme";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.click(".ng-save");
await page.waitForTimeout(150);
const ngSaved = await page.evaluate(() => JSON.parse(localStorage.getItem("syc:filter") || "{}").users?.[0]);

await browser.close();
close();

const checks = [
  ["schema built many controls", controlKeys.length >= 15],
  ["has speed + opacity + maxActive controls", ["speedPct", "opacity", "maxActive"].every((k) => controlKeys.includes(k))],
  ["speed 200% -> durationScale 0.5 (live)", Math.abs((after.durationScale ?? 0) - 0.5) < 1e-9],
  ["speedPct persisted to localStorage", after.saved === 200],
  ["NG list persisted", ngSaved === "blockme"],
  ["no page errors", errors.length === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
if (!ok) console.log("detail:", JSON.stringify({ after, ngSaved, controlKeys: controlKeys.length }), errors);
console.log(ok ? "RESULT: ✅ settings UI verified (live preview + persistence)" : "RESULT: ❌ FAIL");
process.exit(ok ? 0 : 1);
