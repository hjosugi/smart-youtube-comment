// Loads the UNPACKED extension into a real Chromium and checks it actually works:
//   1. the extension loads (service worker registers)
//   2. the options page renders the settings form
//   3. changing a setting persists to chrome.storage and survives a reload
//   4. a fake YouTube watch page gets an overlay canvas
//   5. a fake live-chat iframe is extracted and rendered into nonblank pixels
//
// MV3 extensions need a HEADED browser (or --headless=new) + the full Chromium
// build — they do NOT load in the headless-shell. So run this on your desktop:
//
//   npx playwright install chromium      # one-time: full Chromium build
//   npm run test:ext
//
// (It will not run in a display-less CI sandbox; that's expected.)

import { chromium } from "playwright"
import { fileURLToPath } from "node:url"

if (process.env.CI && process.env.SYC_REQUIRE_EXTENSION_E2E !== "1") {
  console.log("SKIP extension smoke: CI requires SYC_REQUIRE_EXTENSION_E2E=1.")
  process.exit(0)
}

const EXT = fileURLToPath(new URL("../../extension", import.meta.url))
const useHeadlessChrome =
  process.env.CI === "1" || process.env.CI === "true" || process.env.SYC_EXTENSION_HEADLESS === "1"
const FAKE_VIDEO_ID = "VIDEOIDXXXX"
const FAKE_WATCH_URL = `https://www.youtube.com/watch?v=${FAKE_VIDEO_ID}`
const realYoutubeUrl = process.env.SYC_REAL_YOUTUBE_URL || ""
const requireRealYoutube = process.env.SYC_REAL_YOUTUBE_REQUIRED === "1"
const realYoutubeTimeoutMs = Number(process.env.SYC_REAL_YOUTUBE_TIMEOUT_MS || 45000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitUntil = async (fn, timeoutMs = 5000) => {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await sleep(50)
  }
}

const watchHtml = `<!doctype html>
<html>
  <head><title>Fake YouTube Watch</title></head>
  <body style="margin:0;background:#111;color:#fff">
    <div class="html5-video-player" style="position:relative;width:640px;height:360px;background:#000">
      <div class="ytp-right-controls"></div>
    </div>
    <ytd-watch-flexy>
      <div id="chat">
        <iframe src="https://www.youtube.com/live_chat?v=${FAKE_VIDEO_ID}"></iframe>
      </div>
    </ytd-watch-flexy>
  </body>
</html>`

const chatHtml = `<!doctype html>
<html>
  <head><title>Fake Live Chat</title></head>
  <body>
    <yt-live-chat-item-list-renderer>
      <div id="items" class="yt-live-chat-item-list-renderer"></div>
    </yt-live-chat-item-list-renderer>
    <script>
      setTimeout(() => {
        const node = document.createElement("yt-live-chat-text-message-renderer");
        node.setAttribute("author-type", "member");
        const author = document.createElement("span");
        author.id = "author-name";
        author.textContent = "Alice";
        const message = document.createElement("span");
        message.id = "message";
        message.textContent = "this extension e2e comment should render clearly";
        node.append(author, message);
        document.getElementById("items").append(node);
      }, 800);
    </script>
  </body>
</html>`

async function main() {
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      ...(useHeadlessChrome ? ["--headless=new"] : []),
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox",
    ],
  })

  await context.route(`${FAKE_WATCH_URL}*`, route =>
    route.fulfill({ status: 200, contentType: "text/html", body: watchHtml }),
  )
  await context.route(`https://www.youtube.com/live_chat?v=${FAKE_VIDEO_ID}*`, route =>
    route.fulfill({ status: 200, contentType: "text/html", body: chatHtml }),
  )

  // 1. extension loaded → its service worker is registered
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 })
  const extId = new URL(sw.url()).host
  console.log(`extension loaded: id=${extId}`)

  // 2. options page renders
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.waitForSelector("#settings .row")
  const controls = await page.$$eval("#settings .row", r => r.length)
  console.log(`options page rendered: ${controls} controls`)

  // 3. change Opacity -> 40, let it autosave, read back from chrome.storage
  const opacityInput = page.locator('.row[data-key="opacity"] input[type=range]')
  await opacityInput.evaluate(input => {
    input.value = "40"
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await waitUntil(async () => {
    const value = await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("syc:settings")
      return got["syc:settings"]?.opacity
    })
    return value === 40
  })

  const stored = await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("syc:settings")
    return got["syc:settings"] ?? null
  })
  console.log(`stored:`, stored)

  // reload → persisted value should render
  await page.reload()
  await page.waitForSelector("#settings .row")
  const shown = await page.locator('.row[data-key="opacity"] input[type=range]').inputValue()

  // 4/5. Fake YouTube page: content scripts should attach the canvas in the top
  // frame, extract chat from the iframe, route through the background worker, and
  // paint at least one danmaku sprite.
  const watch = await context.newPage()
  await watch.goto(FAKE_WATCH_URL, { waitUntil: "load" })
  await watch.waitForSelector(".syc-danmaku-canvas", { timeout: 10000 })
  const painted = await watch.waitForFunction(
    () => {
      const canvas = document.querySelector(".syc-danmaku-canvas")
      if (!canvas || canvas.width <= 1 || canvas.height <= 1) return false
      const ctx = canvas.getContext("2d")
      const { width, height } = canvas
      const data = ctx.getImageData(0, 0, width, height).data
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true
      }
      return false
    },
    null,
    { timeout: 10000 },
  ).then(() => true, () => false)
  const renderDebug = painted
    ? null
    : {
        top: await watch.evaluate(() => {
          const canvas = document.querySelector(".syc-danmaku-canvas")
          return {
            iframes: [...document.querySelectorAll("iframe")].map(frame => frame.src),
            hasChatShell: Boolean(
              document.querySelector("ytd-live-chat-frame, #chat iframe[src*='live_chat'], ytd-watch-flexy #chat"),
            ),
            canvas: canvas
              ? {
                  width: canvas.width,
                  height: canvas.height,
                  connected: canvas.isConnected,
                }
              : null,
          }
        }),
        frames: await Promise.all(
          watch.frames().map(async frame => ({
            url: frame.url(),
            chatNodes: await frame
              .evaluate(
                () =>
                  document.querySelectorAll(
                    "yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer",
                  ).length,
              )
              .catch(() => -1),
          })),
        ),
      }

  let realPainted = !requireRealYoutube
  if (realYoutubeUrl) {
    const real = await context.newPage()
    realPainted = await (async () => {
      try {
        await real.goto(realYoutubeUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
        await real.waitForSelector(".syc-danmaku-canvas", { timeout: 30000 })
        return await real
          .waitForFunction(
            () => {
              const canvas = document.querySelector(".syc-danmaku-canvas")
              if (!canvas || canvas.width <= 1 || canvas.height <= 1) return false
              const ctx = canvas.getContext("2d")
              const { width, height } = canvas
              const data = ctx.getImageData(0, 0, width, height).data
              for (let i = 3; i < data.length; i += 4) {
                if (data[i] > 0) return true
              }
              return false
            },
            null,
            { timeout: Math.max(1000, realYoutubeTimeoutMs) },
          )
          .then(() => true, () => false)
      } catch {
        return false
      }
    })()
    console.log(
      realPainted
        ? `real YouTube smoke painted overlay: ${realYoutubeUrl}`
        : `real YouTube smoke did not paint before timeout: ${realYoutubeUrl}`,
    )
  } else if (requireRealYoutube) {
    console.log("real YouTube smoke required but SYC_REAL_YOUTUBE_URL is not set")
  }

  await context.close()

  const ok = stored?.opacity === 40 && shown === "40" && painted && realPainted
  console.log(
    ok
      ? `PASS ✅  extension loads + settings persist + overlay/chat render (opacity=${shown})`
      : `FAIL ❌  expected opacity 40 and painted overlay, stored=${stored?.opacity}, shown=${shown}, painted=${painted}, debug=${JSON.stringify(renderDebug)}`,
  )
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})
