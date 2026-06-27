#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"

const root = resolve(new URL("..", import.meta.url).pathname)
const outDir = resolve(root, ".release/store-assets")
const iconPath = resolve(root, "extension/icons/icon128.png")

mkdirSync(outDir, { recursive: true })

const iconData = readFileSync(iconPath).toString("base64")
const iconSrc = `data:image/png;base64,${iconData}`

function shell({ title, subtitle, body, size }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    width: ${size.width}px;
    height: ${size.height}px;
    overflow: hidden;
    background: #f7f8fb;
    color: #14171f;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  body {
    display: grid;
    grid-template-columns: 1fr 390px;
    gap: 32px;
    padding: 54px;
    background:
      linear-gradient(145deg, rgba(22, 119, 255, 0.08), transparent 34%),
      linear-gradient(315deg, rgba(19, 174, 126, 0.10), transparent 38%),
      #f7f8fb;
  }
  .hero {
    min-width: 0;
    display: grid;
    align-content: center;
    gap: 24px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .brand img {
    width: 78px;
    height: 78px;
    display: block;
  }
  h1 {
    margin: 0;
    font-size: 54px;
    line-height: 1.02;
    letter-spacing: 0;
  }
  .subtitle {
    margin: 0;
    max-width: 690px;
    font-size: 24px;
    line-height: 1.35;
    color: #4b5565;
  }
  .video {
    position: relative;
    min-height: 390px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #cbd3df;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.12), transparent 35%),
      linear-gradient(135deg, #171d29, #0b0f17 62%, #05070b);
    box-shadow: 0 26px 60px rgba(21, 32, 52, 0.20);
  }
  .video::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 24% 18%, rgba(58, 134, 255, .32), transparent 26%),
      radial-gradient(circle at 70% 32%, rgba(19, 174, 126, .25), transparent 32%);
  }
  .comment {
    position: absolute;
    left: 22px;
    right: auto;
    white-space: nowrap;
    color: white;
    font-weight: 800;
    text-shadow: 0 2px 0 #000, 0 0 8px rgba(0,0,0,.80);
  }
  .c1 { top: 64px; font-size: 31px; left: 290px; }
  .c2 { top: 132px; font-size: 25px; left: 120px; color: #9ee7ff; }
  .c3 { top: 210px; font-size: 28px; left: 420px; color: #fff2a8; }
  .c4 { top: 284px; font-size: 23px; left: 70px; }
  .player {
    position: absolute;
    left: 24px;
    right: 24px;
    bottom: 20px;
    height: 38px;
    display: flex;
    align-items: center;
    gap: 13px;
    color: rgba(255,255,255,.86);
  }
  .play {
    width: 0;
    height: 0;
    border-left: 16px solid currentColor;
    border-top: 10px solid transparent;
    border-bottom: 10px solid transparent;
  }
  .bar {
    flex: 1;
    height: 6px;
    border-radius: 99px;
    background: rgba(255,255,255,.28);
    overflow: hidden;
  }
  .bar span {
    display: block;
    width: 42%;
    height: 100%;
    background: #ff3158;
  }
  .panel {
    align-self: center;
    display: grid;
    gap: 16px;
    padding: 24px;
    border: 1px solid #d4dbe7;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.76);
  }
  .setting {
    display: grid;
    gap: 6px;
    font-size: 15px;
    color: #5a6575;
  }
  .track {
    height: 8px;
    border-radius: 99px;
    background: #dde4ee;
    overflow: hidden;
  }
  .track span {
    display: block;
    height: 100%;
    background: #2563eb;
  }
  .body { margin: 0; font-size: 18px; line-height: 1.45; color: #4b5565; }
</style>
</head>
<body>
  <section class="hero">
    <div class="brand">
      <img src="${iconSrc}" alt="">
      <h1>${title}</h1>
    </div>
    <p class="subtitle">${subtitle}</p>
    <div class="video">
      <div class="comment c1">Great explanation!</div>
      <div class="comment c2">コメントが動画に流れる</div>
      <div class="comment c3">Nice timing ✨</div>
      <div class="comment c4">Locally scored overlay</div>
      <div class="player"><div class="play"></div><div class="bar"><span></span></div><span>LIVE</span></div>
    </div>
  </section>
  <aside class="panel">
    <p class="body">${body}</p>
    <div class="setting"><span>Opacity</span><div class="track"><span style="width:86%"></span></div></div>
    <div class="setting"><span>Scroll speed</span><div class="track"><span style="width:64%"></span></div></div>
    <div class="setting"><span>Max comments</span><div class="track"><span style="width:72%"></span></div></div>
  </aside>
</body>
</html>`
}

function tile({ title, subtitle, size }) {
  const compact = size.width < 600
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    width: ${size.width}px;
    height: ${size.height}px;
    overflow: hidden;
    background: #f7f8fb;
    color: #14171f;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  body {
    display: grid;
    grid-template-columns: ${compact ? "1fr" : "1fr 1.08fr"};
    align-items: center;
    gap: ${compact ? "10px" : "48px"};
    padding: ${compact ? "24px" : "56px 72px"};
    background:
      linear-gradient(145deg, rgba(37, 99, 235, 0.12), transparent 38%),
      linear-gradient(315deg, rgba(20, 184, 166, 0.16), transparent 42%),
      #f7f8fb;
  }
  .copy { display: grid; gap: ${compact ? "10px" : "18px"}; }
  .brand { display: flex; align-items: center; gap: ${compact ? "10px" : "16px"}; }
  img { width: ${compact ? "52px" : "96px"}; height: ${compact ? "52px" : "96px"}; }
  h1 {
    margin: 0;
    font-size: ${compact ? "30px" : "82px"};
    line-height: ${compact ? "1.02" : ".94"};
    letter-spacing: 0;
  }
  p {
    margin: 0;
    max-width: 620px;
    color: #4b5565;
    font-size: ${compact ? "16px" : "30px"};
    line-height: 1.28;
  }
  .video {
    position: relative;
    display: ${compact ? "none" : "block"};
    height: 360px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #cbd3df;
    background: linear-gradient(135deg, #171d29, #070a10);
    box-shadow: 0 24px 54px rgba(21, 32, 52, 0.20);
  }
  .comment {
    position: absolute;
    white-space: nowrap;
    color: white;
    font-weight: 800;
    text-shadow: 0 2px 0 #000, 0 0 8px rgba(0,0,0,.80);
  }
  .c1 { top: 70px; left: 130px; font-size: 31px; }
  .c2 { top: 150px; left: 44px; font-size: 25px; color: #9ee7ff; }
  .c3 { top: 238px; left: 230px; font-size: 28px; color: #fff2a8; }
</style>
</head>
<body>
  <section class="copy">
    <div class="brand"><img src="${iconSrc}" alt=""><h1>${title}</h1></div>
    <p>${subtitle}</p>
  </section>
  <section class="video">
    <div class="comment c1">Great explanation!</div>
    <div class="comment c2">コメントが動画に流れる</div>
    <div class="comment c3">Locally scored ✨</div>
  </section>
</body>
</html>`
}

async function screenshot(page, html, name, width, height) {
  await page.setViewportSize({ width, height })
  await page.setContent(html, { waitUntil: "load" })
  await page.screenshot({
    path: resolve(outDir, name),
    fullPage: false,
    omitBackground: false,
  })
}

const browser = await chromium.launch()
const page = await browser.newPage({
  deviceScaleFactor: 1,
  viewport: { width: 1280, height: 800 },
})

await screenshot(
  page,
  shell({
    size: { width: 1280, height: 800 },
    title: "Smart YouTube Comment Overlay",
    subtitle: "Nico-style YouTube live chat overlay with local, on-device scoring.",
    body: "Tune display, speed, filtering, and performance without sending chat text to an external server.",
  }),
  "screenshot-overlay-1280x800.png",
  1280,
  800,
)

await screenshot(
  page,
  shell({
    size: { width: 640, height: 400 },
    title: "Comment Overlay",
    subtitle: "YouTube live chat, rendered over the video.",
    body: "Settings are saved locally through Chrome extension storage.",
  }),
  "screenshot-overlay-640x400.png",
  640,
  400,
)

await screenshot(
  page,
  tile({
    size: { width: 440, height: 280 },
    title: "Smart YouTube Comment Overlay",
    subtitle: "Live chat over the video.",
  }),
  "promo-small-440x280.png",
  440,
  280,
)

await screenshot(
  page,
  tile({
    size: { width: 1400, height: 560 },
    title: "Smart YouTube Comment Overlay",
    subtitle: "A local, tunable Nico-style overlay for YouTube live chat.",
  }),
  "promo-marquee-1400x560.png",
  1400,
  560,
)

await screenshot(
  page,
  `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 128px; height: 128px; background: #f7f8fb; overflow: hidden; }
body { display: grid; place-items: center; }
img { width: 128px; height: 128px; display: block; }
</style></head><body><img src="${iconSrc}" alt=""></body></html>`,
  "store-icon-128.png",
  128,
  128,
)

await browser.close()

console.log(`Store assets written to ${outDir}`)
