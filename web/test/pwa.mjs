// Playwright PWA check: the manifest is linked + valid, and the service worker
// registers and activates (offline app shell). Runs on localhost (a secure
// context for SW). Uses ?mock=1 so no network/YouTube is needed.

import { chromium } from "playwright"
import { serveWeb } from "./_serve.mjs"

const waitFor = async (fn, timeoutMs = 5000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise(r => setTimeout(r, 25))
  }
}

let apiCalls = 0
let crossOriginCalls = 0
let swrCalls = 0
let swrVersion = 1

const { port, close } = await serveWeb({
  handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === "/api/livechat") {
      apiCalls += 1
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      res.end(JSON.stringify({ call: apiCalls, messages: [], continuation: "c", timeoutMs: 1000 }))
      return true
    }
    if (url.pathname === "/__swr.txt") {
      swrCalls += 1
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      })
      res.end(`swr-${swrVersion}`)
      return true
    }
    return false
  },
})
const crossOrigin = await serveWeb({
  handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname !== "/__cross-origin.txt") return false
    crossOriginCalls += 1
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    })
    res.end(`cross-${crossOriginCalls}`)
    return true
  },
})
const browser = await chromium.launch()
const context = await browser.newContext({ bypassCSP: true })
const page = await context.newPage()
const errors = []
page.on("pageerror", e => errors.push(e.message))

await page.goto(`http://localhost:${port}/index.html?mock=1`, { waitUntil: "load" })

const result = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]')
  const manifest = link
    ? await fetch(link.href)
        .then(r => r.json())
        .catch(() => null)
    : null
  let sw = false
  if ("serviceWorker" in navigator) {
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then(r => r),
      new Promise(r => setTimeout(() => r(null), 5000)),
    ])
    sw = !!(reg && reg.active)
    if (sw && !navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise(r =>
          navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
        ),
        new Promise(r => setTimeout(r, 5000)),
      ])
    }
  }
  return {
    manifestName: manifest?.name,
    manifestStartUrl: manifest?.start_url,
    manifestIcons: manifest?.icons?.length ?? 0,
    swActive: sw,
    swControlled: !!navigator.serviceWorker?.controller,
  }
})

const apiResult = await page.evaluate(async () => {
  const first = await fetch("/api/livechat?video=VIDEOIDXXXX").then(r => r.json())
  const second = await fetch("/api/livechat?video=VIDEOIDXXXX").then(r => r.json())
  return [first.call, second.call]
})

const crossOriginResult = await page.evaluate(
  async url => fetch(url, { mode: "no-cors" }).then(r => r.type),
  `http://localhost:${crossOrigin.port}/__cross-origin.txt`,
)

const swrFirst = await page.evaluate(() => fetch("/__swr.txt").then(r => r.text()))
swrVersion = 2
const swrSecond = await page.evaluate(() => fetch("/__swr.txt").then(r => r.text()))
await waitFor(() => swrCalls >= 2)
const swrThird = await page.evaluate(async () => {
  const deadline = Date.now() + 5000
  let text = ""
  while (Date.now() < deadline) {
    text = await fetch("/__swr.txt").then(r => r.text())
    if (text === "swr-2") return text
    await new Promise(r => setTimeout(r, 50))
  }
  return text
})

await page.context().setOffline(true)
const offlineResult = await page.evaluate(async () => {
  const get = path =>
    fetch(path)
      .then(async r => ({ ok: r.ok, status: r.status, text: await r.text() }))
      .catch(e => ({ ok: false, status: 0, text: e.message }))
  return {
    index: await get("/index.html"),
    app: await get("/app.js"),
  }
})
await page.context().setOffline(false)

await browser.close()
close()
crossOrigin.close()

const checks = [
  ["manifest linked + valid name", result.manifestName === "Smart YouTube Comment"],
  ["manifest has start_url", !!result.manifestStartUrl],
  ["manifest has icons", result.manifestIcons >= 1],
  ["service worker active", result.swActive === true],
  ["service worker controls the page", result.swControlled === true],
  ["API fetches are not cached", apiCalls === 2 && apiResult.join(",") === "1,2"],
  ["cross-origin fetch passes through", crossOriginCalls === 1 && crossOriginResult === "opaque"],
  [
    "same-origin GET uses stale-while-revalidate",
    swrFirst === "swr-1" && swrSecond === "swr-1" && swrThird === "swr-2",
  ],
  [
    "offline shell serves index.html",
    offlineResult.index.ok && offlineResult.index.text.includes("<title>Smart YouTube Comment"),
  ],
  [
    "offline shell serves app.js",
    offlineResult.app.ok && offlineResult.app.text.includes("SYCApp"),
  ],
  ["no page errors", errors.length === 0],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`)
  if (!pass) ok = false
}
if (!ok) {
  console.log(
    "detail:",
    JSON.stringify({
      result,
      apiCalls,
      apiResult,
      crossOriginCalls,
      crossOriginResult,
      swrCalls,
      swrFirst,
      swrSecond,
      swrThird,
      offlineResult,
    }),
    errors,
  )
}
console.log(ok ? "RESULT: ✅ PWA install surface verified" : "RESULT: ❌ FAIL")
process.exit(ok ? 0 : 1)
