// Playwright e2e: localized chrome exposes accessible names and document lang.

import { chromium } from "playwright"
import { serveWeb } from "./_serve.mjs"

const { port, close } = await serveWeb()
const browser = await chromium.launch()
const context = await browser.newContext({ locale: "en-US" })
const page = await context.newPage()
const errors = []
page.on("pageerror", e => errors.push(e.message))

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" })
await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 8000 })

const result = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  labels: Object.fromEntries(
    ["toggle", "listToggle", "settings", "help"].map(id => {
      const button = document.getElementById(id)
      return [id, { title: button?.title, ariaLabel: button?.getAttribute("aria-label") }]
    }),
  ),
}))

await browser.close()
close()

const expected = {
  toggle: "Toggle danmaku",
  listToggle: "Toggle comment list",
  settings: "Settings",
  help: "Help",
}

const checks = [
  ["document lang follows i18n locale", result.lang === "en"],
  ...Object.entries(expected).map(([id, label]) => [
    `${id} title and aria-label localized`,
    result.labels[id]?.title === label && result.labels[id]?.ariaLabel === label,
  ]),
  ["no page errors", errors.length === 0],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`)
  if (!pass) ok = false
}
if (!ok) console.log("detail:", JSON.stringify({ result, errors }))
console.log(ok ? "RESULT: accessibility chrome verified" : "RESULT: FAIL")
process.exit(ok ? 0 : 1)
