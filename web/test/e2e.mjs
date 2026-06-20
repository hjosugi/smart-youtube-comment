// Playwright e2e: load the PWA in mock mode (no network, no YouTube) and assert
// the danmaku canvas actually renders — by sampling non-transparent pixels.
// Run: node web/test/e2e.mjs   (needs: npm i -D playwright + npx playwright install chromium)

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOT = new URL("../../web/", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = join(ROOT, rel === "/" ? "index.html" : rel);
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" });
await page.waitForSelector("canvas.syc-danmaku-canvas", { timeout: 8000 });
await page.waitForTimeout(2500); // let the mock feed + rAF render several frames

const result = await page.evaluate(() => {
  const c = document.querySelector("canvas.syc-danmaku-canvas");
  if (!c || !c.width) return { ok: false, reason: "no canvas" };
  const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
  return { ok: lit > 0, litPixels: lit, stats: globalThis.SYCApp?.overlay?.stats?.() ?? null };
});

await browser.close();
server.close();

console.log("pageerrors:", errors.length ? errors : "none");
console.log("canvas:", JSON.stringify(result));
const pass = result.ok && result.litPixels > 1000 && errors.length === 0;
console.log(pass ? "RESULT: ✅ danmaku renders in headless Chromium (mock mode)" : "RESULT: ❌ FAIL");
process.exit(pass ? 0 : 1);
