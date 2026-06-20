// Playwright PWA check: the manifest is linked + valid, and the service worker
// registers and activates (offline app shell). Runs on localhost (a secure
// context for SW). Uses ?mock=1 so no network/YouTube is needed.

import { chromium } from "playwright";
import { serveWeb } from "./_serve.mjs";

const { port, close } = await serveWeb();
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" });

const result = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  const manifest = link ? await fetch(link.href).then((r) => r.json()).catch(() => null) : null;
  let sw = false;
  if ("serviceWorker" in navigator) {
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then((r) => r),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    sw = !!(reg && reg.active);
  }
  return {
    manifestName: manifest?.name,
    manifestStartUrl: manifest?.start_url,
    manifestIcons: manifest?.icons?.length ?? 0,
    swActive: sw,
  };
});

await browser.close();
close();

const checks = [
  ["manifest linked + valid name", result.manifestName === "Smart YouTube Comment"],
  ["manifest has start_url", !!result.manifestStartUrl],
  ["manifest has icons", result.manifestIcons >= 1],
  ["service worker active", result.swActive === true],
  ["no page errors", errors.length === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
if (!ok) console.log("detail:", JSON.stringify(result), errors);
console.log(ok ? "RESULT: ✅ PWA install surface verified" : "RESULT: ❌ FAIL");
process.exit(ok ? 0 : 1);
