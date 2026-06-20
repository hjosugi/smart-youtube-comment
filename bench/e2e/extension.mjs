// Loads the UNPACKED extension into a real Chromium and checks it actually works:
//   1. the extension loads (service worker registers)
//   2. the options page renders the settings form
//   3. changing a setting persists to chrome.storage and survives a reload
//
// MV3 extensions need a HEADED browser (or --headless=new) + the full Chromium
// build — they do NOT load in the headless-shell. So run this on your desktop:
//
//   npx playwright install chromium      # one-time: full Chromium build
//   npm run test:ext
//
// (It will not run in a display-less CI sandbox; that's expected.)

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../extension", import.meta.url));

const getOpacityRow = () => {
  const rows = [...document.querySelectorAll(".row")];
  const row = rows.find((r) => r.querySelector(".name")?.textContent === "Opacity");
  return row?.querySelector("input[type=range]");
};

async function main() {
  const context = await chromium.launchPersistentContext("", {
    headless: false, // extensions require headed / --headless=new
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox"
    ]
  });

  // 1. extension loaded → its service worker is registered
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  console.log(`extension loaded: id=${extId}`);

  // 2. options page renders
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForSelector("#settings .row");
  const controls = await page.$$eval("#settings .row", (r) => r.length);
  console.log(`options page rendered: ${controls} controls`);

  // 3. change Opacity -> 40, let it autosave, read back from chrome.storage
  await page.evaluate((fn) => {
    const input = new Function(`return (${fn})`)()();
    input.value = "40";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, getOpacityRow.toString());
  await page.waitForTimeout(500); // debounce + write

  const stored = await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("syc:settings");
    return got["syc:settings"] ?? null;
  });
  console.log(`stored:`, stored);

  // reload → persisted value should render
  await page.reload();
  await page.waitForSelector("#settings .row");
  const shown = await page.evaluate((fn) => new Function(`return (${fn})`)()().value, getOpacityRow.toString());

  await context.close();

  const ok = stored?.opacity === 40 && shown === "40";
  console.log(ok
    ? `PASS ✅  extension loads + settings persist in real Chrome (opacity=${shown})`
    : `FAIL ❌  expected opacity 40, stored=${stored?.opacity}, shown=${shown}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
