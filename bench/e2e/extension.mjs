// Loads the UNPACKED extension into a real Chromium and checks it actually works:
//   1. the extension loads (service worker registers)
//   2. the options page renders the settings form
//   3. changing a setting persists to chrome.storage and survives a reload
//   4. a fake YouTube watch page gets the overlay stage frame
//   5. a fake live-chat iframe is extracted and rendered as a comment on the
//      stage (an element with the default compositor renderer), and the stage
//      frame stays transparent
//   6. the right-click menu pins a comment, dragging moves it, and "hide user"
//      removes the author's comments and saves them to the NG list (input is
//      forwarded from the player to the stage, which takes no pointer events)
//   7. picture-in-picture moves the video and a stage into the PiP window,
//      and closing it puts both back
//   8. the "canvas" renderer setting swaps the stage to the canvas engine and
//      paints nonblank pixels
//   9. the overlay starts after an in-page (SPA) navigation from a page that
//      is not a watch page, the way YouTube opens a stream from its home page
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
const FAKE_HOME_URL = "https://www.youtube.com/"
const realYoutubeUrl = process.env.SYC_REAL_YOUTUBE_URL || ""
const requireRealYoutube = process.env.SYC_REAL_YOUTUBE_REQUIRED === "1"
const realYoutubeTimeoutMs = Number(process.env.SYC_REAL_YOUTUBE_TIMEOUT_MS || 45000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Comments are drawn in the extension's stage frame laid over the player: as
// elements on a layer (compositor renderer, the default) or as canvas pixels.
const stagePainted = async (page, timeout) => {
  await waitUntil(async () => page.frames().some(frame => frame.url().includes("/stage.html")), timeout)
  const stage = page.frames().find(frame => frame.url().includes("/stage.html"))
  return stage
    .waitForFunction(
      () => {
        const comment = document.querySelector(".syc-danmaku-layer > .syc-c")
        if (comment) {
          const box = comment.getBoundingClientRect()
          return comment.textContent.length > 0 && box.width > 1 && box.height > 1
        }
        const canvas = document.querySelector("canvas.syc-danmaku-canvas")
        if (!canvas || canvas.width <= 1 || canvas.height <= 1) return false
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0) return true
        }
        return false
      },
      null,
      { timeout },
    )
    .then(
      () => true,
      () => false,
    )
}

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
    executablePath: process.env.SYC_BROWSER || undefined, // another Chromium, e.g. Brave
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
  await context.route(FAKE_HOME_URL, route =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><head><title>Fake YouTube Home</title></head><body style=\"margin:0;background:#111\"></body></html>",
    }),
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

  // 4/5. Fake YouTube page: content scripts should lay the stage frame over the
  // player, extract chat from the iframe, route through the background worker and
  // the stage, and paint at least one danmaku sprite.
  const watch = await context.newPage()
  await watch.goto(FAKE_WATCH_URL, { waitUntil: "load" })
  await watch.waitForSelector(".syc-danmaku-canvas", { timeout: 10000 })
  const painted = await stagePainted(watch, 10000).catch(() => false)
  const renderDebug = painted
    ? null
    : {
        top: await watch.evaluate(() => {
          const layer = document.querySelector(".syc-danmaku-canvas")
          return {
            iframes: [...document.querySelectorAll("iframe")].map(frame => frame.src),
            layer: layer?.tagName,
            hasChatShell: Boolean(
              document.querySelector("ytd-live-chat-frame, #chat iframe[src*='live_chat'], ytd-watch-flexy #chat"),
            ),
            connected: layer?.isConnected ?? false,
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

  // 5b/6. The stage must not cover the video, and the forwarded pin/drag must work.
  const stageFrame = watch.frames().find(frame => frame.url().includes("/stage.html"))
  const playerBox = await watch.locator(".html5-video-player").boundingBox()
  const sprite = () =>
    stageFrame.evaluate(() => {
      const overlay = globalThis.__sycOverlay
      const a = overlay.active[0]
      // The compositor renderer moves comments off the main thread; ask it where one is.
      return a ? { x: overlay._spriteX ? overlay._spriteX(a) : a.x, y: a.y, w: a.w, pinned: Boolean(a.pinned) } : null
    })
  let transparent = false
  let pinned = false
  let dragged = false
  let hidden = false
  let pip = false
  let canvasPainted = false
  let spaStarted = false
  const defaultRenderer = await stageFrame?.evaluate(() => globalThis.__sycOverlay?.stats().renderer).catch(() => "")
  if (painted && playerBox) {
    // The fake player is black; an opaque stage backdrop would show as white.
    const shot = await watch.screenshot({ clip: { x: playerBox.x + 2, y: playerBox.y + playerBox.height - 4, width: 1, height: 1 } })
    transparent = shot.length > 0 && (await watch.evaluate(async b64 => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement("canvas")
      c.width = c.height = 1
      const g = c.getContext("2d")
      g.drawImage(img, 0, 0)
      const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
      return r + gr + b < 30
    }, shot.toString("base64")))

    // Aim inside both the player and the comment (it moves right to left).
    const at = s => [playerBox.x + s.x + 120, playerBox.y + s.y]
    await waitUntil(async () => (await sprite())?.x < playerBox.width / 2, 8000).catch(() => {})
    let target = await sprite()
    const menuItem = async index => {
      await watch.waitForSelector(".syc-danmaku-menu button", { timeout: 3000 })
      await watch.locator(".syc-danmaku-menu button").nth(index).click()
      await sleep(150)
    }
    if (target) {
      await watch.mouse.move(...at(target))
      await sleep(250) // the stage reports what is under the cursor
      await watch.mouse.click(...at(await sprite()), { button: "right" })
      await menuItem(0) // "Pin this comment"
      pinned = (await sprite())?.pinned === true
    }
    if (pinned) {
      target = await sprite()
      await watch.mouse.move(...at(target))
      await sleep(250)
      await watch.mouse.down()
      await watch.mouse.move(at(target)[0], at(target)[1] + 40, { steps: 4 })
      await watch.mouse.up()
      await sleep(150)
      dragged = Math.abs((await sprite()).y - target.y - 40) < 2
    }
    if (dragged) {
      target = await sprite()
      await watch.mouse.move(...at(target))
      await sleep(250)
      await watch.mouse.click(...at(target), { button: "right" })
      await menuItem(1) // "Hide comments from Alice"
      const saved = await stageFrame.evaluate(async () => (await chrome.storage.local.get("syc:filter"))["syc:filter"])
      hidden = (await sprite()) === null && saved?.users?.includes("alice")
    }
    console.log(`stage transparent=${transparent} pinned=${pinned} dragged=${dragged} hidden=${hidden}`)

    // 7. Picture-in-picture (only where the browser has Document PiP).
    const hasPip = await watch.evaluate(() => "documentPictureInPicture" in window)
    if (!hasPip) {
      pip = true
      console.log("picture-in-picture: not available here, skipped")
    } else {
      // A video for the window to take (added late: a paused video would pause the comments).
      await watch.evaluate(() => {
        const video = document.createElement("video")
        video.muted = true
        document.querySelector(".html5-video-player").prepend(video)
      })
      await watch.locator(".syc-pip-button").click({ force: true })
      await waitUntil(() => watch.evaluate(() => Boolean(documentPictureInPicture.window)), 5000).catch(() => {})
      const inside = await watch.evaluate(() => {
        const w = documentPictureInPicture.window
        return Boolean(w?.document.querySelector("#syc-pip video") && w.document.querySelector("#syc-pip .syc-danmaku-canvas"))
      })
      await watch.evaluate(() => documentPictureInPicture.window?.close())
      await waitUntil(() => watch.evaluate(() => !documentPictureInPicture.window), 5000).catch(() => {})
      const back = await watch.evaluate(
        () => Boolean(document.querySelector(".html5-video-player > video") && document.querySelector(".html5-video-player > .syc-danmaku-canvas")),
      )
      pip = inside && back
      console.log(`picture-in-picture opened=${inside} restored=${back}`)
    }

    // 8. Switch to the canvas renderer: the stage rebuilds itself in place.
    await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("syc:settings")
      await chrome.storage.sync.set({ "syc:settings": { ...got["syc:settings"], renderer: "canvas" } })
    })
    const stageNow = () => watch.frames().find(frame => frame.url().includes("/stage.html"))
    await waitUntil(
      () => stageNow().evaluate(() => Boolean(document.querySelector("canvas.syc-danmaku-canvas"))).catch(() => false),
      5000,
    ).catch(() => {})
    await stageNow()
      .evaluate(() => {
        const text = "canvas renderer e2e comment"
        globalThis.__sycOverlay.start() // step 7 left a paused video, which pauses the comments
        globalThis.__sycOverlay.push({ text, parts: [{ t: text }], tier: 1, durationMs: 5000, score: 0.3, emphasis: 0.2, authorType: "normal", kind: "text" })
      })
      .catch(() => {})
    canvasPainted = await stagePainted(watch, 5000).catch(() => false)
    await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("syc:settings")
      await chrome.storage.sync.set({ "syc:settings": { ...got["syc:settings"], renderer: "compositor" } })
    })
    console.log(`canvas renderer painted=${canvasPainted}`)
  }

  // 9. YouTube opens a stream from its home page without loading a document.
  // The content script was injected into the home page, so it has to notice the
  // navigation and start there.
  {
    // Step 6 put the fake chat's only author on the NG list.
    await page.evaluate(() => chrome.storage.local.remove("syc:filter"))
    const home = await context.newPage()
    await home.goto(FAKE_HOME_URL, { waitUntil: "load" })
    await sleep(600)
    const idleOnHome = await home.evaluate(() => !document.querySelector(".syc-danmaku-canvas"))
    await home.evaluate(
      ({ id }) => {
        history.pushState({}, "", `/watch?v=${id}`)
        const player = document.createElement("div")
        player.className = "html5-video-player"
        player.style.cssText = "position:relative;width:640px;height:360px;background:#000"
        const buttons = document.createElement("div")
        buttons.className = "ytp-right-controls"
        player.append(buttons)
        const flexy = document.createElement("ytd-watch-flexy")
        const chat = document.createElement("div")
        chat.id = "chat"
        const frame = document.createElement("iframe")
        frame.src = `https://www.youtube.com/live_chat?v=${id}`
        chat.append(frame)
        flexy.append(chat)
        document.body.append(player, flexy)
        document.dispatchEvent(new CustomEvent("yt-navigate-finish", { bubbles: true }))
      },
      { id: FAKE_VIDEO_ID },
    )
    const attached = await home.waitForSelector(".syc-danmaku-canvas", { timeout: 10000 }).then(
      () => true,
      () => false,
    )
    spaStarted = idleOnHome && attached && (await stagePainted(home, 10000).catch(() => false))
    console.log(`in-page navigation from home: idle before=${idleOnHome} stage attached=${attached} painted=${spaStarted}`)
    await home.close()
  }

  let realPainted = !requireRealYoutube
  if (realYoutubeUrl) {
    const real = await context.newPage()
    realPainted = await (async () => {
      try {
        await real.goto(realYoutubeUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
        await real.waitForSelector(".syc-danmaku-canvas", { timeout: 30000 })
        return await stagePainted(real, Math.max(1000, realYoutubeTimeoutMs))
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

  const ok =
    stored?.opacity === 40 &&
    shown === "40" &&
    painted &&
    transparent &&
    pinned &&
    dragged &&
    hidden &&
    pip &&
    defaultRenderer === "compositor" &&
    canvasPainted &&
    spaStarted &&
    realPainted
  console.log(
    ok
      ? `PASS ✅  extension loads + settings persist + overlay/chat render (opacity=${shown})`
      : `FAIL ❌  expected opacity 40, painted transparent overlay, pin, drag and hide; stored=${stored?.opacity}, shown=${shown}, painted=${painted}, transparent=${transparent}, pinned=${pinned}, dragged=${dragged}, hidden=${hidden}, pip=${pip}, renderer=${defaultRenderer}, canvasPainted=${canvasPainted}, spaStarted=${spaStarted}, debug=${JSON.stringify(renderDebug)}`,
  )
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})
