// Playwright e2e: if the YouTube iframe script cannot load, the launch flow must
// leave loading state and surface a retryable player error.

import { chromium } from "playwright"
import { serveWeb } from "./_serve.mjs"

const { port, close } = await serveWeb()
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on("pageerror", e => errors.push(e.message))
await page.route("https://www.youtube.com/iframe_api", route => route.abort("failed"))

await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "load" })
await page.fill("#video", "VIDEOIDXXXX")
await page.click('#launch button[type="submit"]')
await page.waitForFunction(
  () => {
    const text = document.getElementById("status")?.textContent || ""
    return text.includes("Player load failed") || text.includes("プレイヤーを読み込めません")
  },
  { timeout: 5000 },
)

const status = await page.textContent("#status")
await browser.close()
close()

const pass =
  errors.length === 0 &&
  (status === "Player load failed" || status === "プレイヤーを読み込めません")
console.log("pageerrors:", errors.length ? errors : "none")
console.log("status:", status)
console.log(pass ? "RESULT: ✅ player load failure is surfaced" : "RESULT: ❌ FAIL")
process.exit(pass ? 0 : 1)
