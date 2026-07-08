// Playwright e2e: the settings sheet builds from the schema, a change live-updates
// the danmaku engine config AND persists to localStorage. Mock mode (no network).

import { chromium } from "playwright"
import { readFile } from "node:fs/promises"
import { serveWeb } from "./_serve.mjs"

const { port, close } = await serveWeb()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
const errors = []
page.on("pageerror", e => errors.push(e.message))

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" })
await page.waitForSelector("#settings", { timeout: 8000 })
await page.click("#toggle")
await page.waitForFunction(() => {
  const saved = JSON.parse(localStorage.getItem("syc:settings") || "{}")
  return saved.enabled === false
})
await page.click("#settings")
await page.waitForSelector('[data-key="speedPct"]', { timeout: 4000 })

// schema-driven: several known controls exist
const controlKeys = await page.$$eval("[data-key]", els => els.map(e => e.dataset.key))
await page.evaluate(() => {
  const originalSet = chrome.storage.local.set.bind(chrome.storage.local)
  let settingsWrites = 0
  chrome.storage.local.set = async obj => {
    if (Object.prototype.hasOwnProperty.call(obj, "syc:settings")) settingsWrites += 1
    return originalSet(obj)
  }
  globalThis.__settingsWrites = () => settingsWrites
})

// Dragging a slider emits noisy input events; persistence should debounce them.
await page.$eval('[data-key="speedPct"]', el => {
  el.value = "160"
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.value = "180"
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.value = "200"
  el.dispatchEvent(new Event("input", { bubbles: true }))
})
await page.waitForTimeout(75)
const writesDuringDrag = await page.evaluate(() => globalThis.__settingsWrites())
await page.waitForTimeout(200)
const writesAfterDebounce = await page.evaluate(() => globalThis.__settingsWrites())

const after = await page.evaluate(() => ({
  durationScale: globalThis.SYCApp?.overlay?.cfg?.durationScale,
  saved: JSON.parse(localStorage.getItem("syc:settings") || "{}").speedPct,
  savedEnabled: JSON.parse(localStorage.getItem("syc:settings") || "{}").enabled,
  togglePressed: document.getElementById("toggle")?.getAttribute("aria-pressed"),
}))

// NG filter: save a word, confirm it persists
await page.$eval(".ng", el => {
  el.value = "blockme"
  el.dispatchEvent(new Event("input", { bubbles: true }))
})
await page.click(".ng-save")
await page.waitForTimeout(150)
const ngSaved = await page.evaluate(
  () => JSON.parse(localStorage.getItem("syc:filter") || "{}").users?.[0],
)

const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click('[data-action="export-backup"]'),
])
const exported = JSON.parse(await readFile(await download.path(), "utf8"))

await page.setInputFiles(".backup-file", {
  name: "syc-settings.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      app: "smart-youtube-comment",
      settings: { speedPct: 80, opacity: 55 },
      filters: { users: ["ImportedUser"], words: ["ImportedWord"], channels: ["UCImported"] },
    }),
  ),
})
await page.waitForFunction(() => {
  const settings = JSON.parse(localStorage.getItem("syc:settings") || "{}")
  const filter = JSON.parse(localStorage.getItem("syc:filter") || "{}")
  return settings.speedPct === 80 && filter.users?.[0] === "importeduser"
})
const imported = await page.evaluate(() => ({
  speedPct: JSON.parse(localStorage.getItem("syc:settings") || "{}").speedPct,
  opacity: JSON.parse(localStorage.getItem("syc:settings") || "{}").opacity,
  user: JSON.parse(localStorage.getItem("syc:filter") || "{}").users?.[0],
  word: JSON.parse(localStorage.getItem("syc:filter") || "{}").words?.[0],
  channel: JSON.parse(localStorage.getItem("syc:filter") || "{}").channels?.[0],
}))

await page.click('[data-action="reset-backup"]')
await page.waitForFunction(() => {
  const settings = JSON.parse(localStorage.getItem("syc:settings") || "{}")
  const filter = JSON.parse(localStorage.getItem("syc:filter") || "{}")
  return settings.speedPct === 100 && Array.isArray(filter.users) && filter.users.length === 0
})
const reset = await page.evaluate(() => ({
  speedPct: JSON.parse(localStorage.getItem("syc:settings") || "{}").speedPct,
  users: JSON.parse(localStorage.getItem("syc:filter") || "{}").users?.length,
  words: JSON.parse(localStorage.getItem("syc:filter") || "{}").words?.length,
  channels: JSON.parse(localStorage.getItem("syc:filter") || "{}").channels?.length,
}))

await browser.close()
close()

const checks = [
  ["schema built many controls", controlKeys.length >= 15],
  [
    "has speed + opacity + maxActive controls",
    ["speedPct", "opacity", "maxActive"].every(k => controlKeys.includes(k)),
  ],
  ["speed 200% -> durationScale 0.5 (live)", Math.abs((after.durationScale ?? 0) - 0.5) < 1e-9],
  ["range input does not persist immediately while dragging", writesDuringDrag === 0],
  ["range input coalesces to one debounced save", writesAfterDebounce === 1],
  ["speedPct persisted to localStorage", after.saved === 200],
  ["sheet save preserves top-bar overlay toggle", after.savedEnabled === false],
  ["top-bar overlay toggle stays reflected", after.togglePressed === "false"],
  ["NG list persisted", ngSaved === "blockme"],
  ["backup export has app id", exported.app === "smart-youtube-comment"],
  ["backup export includes settings", exported.settings?.speedPct === 200],
  ["backup export includes filters", exported.filters?.users?.[0] === "blockme"],
  ["backup import applies settings", imported.speedPct === 80 && imported.opacity === 55],
  [
    "backup import applies filters",
    imported.user === "importeduser" &&
      imported.word === "importedword" &&
      imported.channel === "UCImported",
  ],
  [
    "backup reset restores defaults",
    reset.speedPct === 100 && reset.users === 0 && reset.words === 0 && reset.channels === 0,
  ],
  ["no page errors", errors.length === 0],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`)
  if (!pass) ok = false
}
if (!ok)
  console.log(
    "detail:",
    JSON.stringify({ after, ngSaved, exported, imported, reset, controlKeys: controlKeys.length }),
    errors,
  )
console.log(ok ? "RESULT: ✅ settings UI verified (live preview + persistence)" : "RESULT: ❌ FAIL")
process.exit(ok ? 0 : 1)
