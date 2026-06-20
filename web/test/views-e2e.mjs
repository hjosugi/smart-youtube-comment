// Playwright e2e for the two views: the danmaku overlay and the comment list,
// each independently toggleable (💬 / 📋), in mock mode (no network/YouTube).

import { chromium } from "playwright";
import { serveWeb } from "./_serve.mjs";

const { port, close } = await serveWeb();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" });
await page.waitForSelector(".clist", { timeout: 8000 });
await page.waitForTimeout(2000); // let the mock feed both views

const initial = await page.evaluate(() => {
  const c = document.querySelector("canvas.syc-danmaku-canvas");
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
  return {
    listRows: document.querySelectorAll(".clist-row").length,
    listVisible: !document.querySelector(".clist").hidden,
    canvasLit: lit,
    emojiImgs: document.querySelectorAll(".clist-emoji").length, // custom-emoji <img> in the list
  };
});

// turn the comment list OFF
await page.click("#listToggle");
await page.waitForTimeout(300);
const listOff = await page.evaluate(() => ({
  hidden: document.querySelector(".clist").hidden,
  saved: JSON.parse(localStorage.getItem("syc:settings")).listEnabled,
}));

// turn danmaku OFF (persisted)
await page.click("#toggle");
await page.waitForTimeout(300);
const danmakuOff = await page.evaluate(() => JSON.parse(localStorage.getItem("syc:settings")).enabled);

await browser.close();
close();

const checks = [
  ["comment list populated", initial.listRows > 3],
  ["comment list visible by default", initial.listVisible === true],
  ["danmaku renders alongside list", initial.canvasLit > 1000],
  ["custom emoji rendered as <img> in list", initial.emojiImgs > 0],
  ["list toggle hides the list", listOff.hidden === true],
  ["list toggle persists (listEnabled=false)", listOff.saved === false],
  ["danmaku toggle persists (enabled=false)", danmakuOff === false],
  ["no page errors", errors.length === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
if (!ok) console.log("detail:", JSON.stringify({ initial, listOff, danmakuOff }), errors);
console.log(ok ? "RESULT: ✅ danmaku + comment list views verified" : "RESULT: ❌ FAIL");
process.exit(ok ? 0 : 1);
