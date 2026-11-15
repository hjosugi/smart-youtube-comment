// Content-script extraction tests. Loads content.js in a VM with startup disabled
// and exercises the internal extractor exposed only under __SYC_TEST__.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

const TEXT_NODE = 3
const ELEMENT_NODE = 1

const text = value => ({
  nodeType: TEXT_NODE,
  textContent: value,
})

const element = (tag, attrs = {}, children = []) => ({
  nodeType: ELEMENT_NODE,
  localName: tag,
  tagName: tag.toUpperCase(),
  childNodes: children,
  textContent: children.map(child => child.textContent || "").join(""),
  getAttribute(name) {
    return attrs[name] ?? null
  },
  querySelector(selector) {
    const type = selector.match(/^\[type="([^"]+)"\]$/)?.[1]
    if (type && attrs.type === type) return this
    return null
  },
})

const chatNode = message => ({
  querySelector(selector) {
    if (selector === "#message") return message
    return null
  },
})

const fallbackChatNode = body => ({
  querySelector(selector) {
    if (selector === "#message") return null
    if (selector === "#message-container, #content, #card") return body
    return null
  },
})

const makeChatRenderer = ({
  tag = "yt-live-chat-text-message-renderer",
  textValue = "hello",
  author = "Alice",
  authorType = null,
  fallbackRole = null,
  fallbackAriaLabel = null,
  officialContainer = false,
  amount = "",
  paidColor = "",
  channelId = "",
  emoji = null,
} = {}) => {
  const messageChildren = emoji
    ? [text(textValue), element("img", { src: emoji.src, alt: emoji.alt })]
    : [text(textValue)]
  const message = element("span", {}, messageChildren)
  const authorNode = element("span", {}, [text(author)])
  const amountNode = element("span", {}, [text(amount)])
  const fallbackBadge = fallbackRole
    ? element("span", { type: fallbackRole, "aria-label": fallbackAriaLabel })
    : null
  return {
    sentTag: tag,
    paidColor,
    matches(selector) {
      return selector.split(",").map(part => part.trim()).includes(tag)
    },
    closest(selector) {
      if (officialContainer && selector.includes("yt-live-chat-banner-renderer")) return {}
      if (selector.includes("#items.yt-live-chat-item-list-renderer")) return {}
      return null
    },
    hasAttribute() {
      return false
    },
    getAttribute(name) {
      if (name === "author-type") return authorType
      if (name === "author-external-channel-id") return channelId
      return null
    },
    querySelector(selector) {
      if (selector === "#message") return message
      if (selector === "#author-name") return authorNode
      if (selector === "#purchase-amount, #purchase-amount-column") return amount ? amountNode : null
      if (fallbackBadge) return fallbackBadge.querySelector(selector)
      return null
    },
  }
}

const loadHelpers = () => {
  const sandbox = {
    globalThis: null,
    chrome: {
      i18n: { getMessage: () => "" },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          sandbox.sentMessages.push(message)
          callback?.()
        },
      },
    },
    document: {},
    getComputedStyle(node) {
      return {
        getPropertyValue(name) {
          return name === "--yt-live-chat-paid-message-primary-color" ? node.paidColor : ""
        },
        backgroundColor: "",
      }
    },
    location: { pathname: "/watch" },
    sentMessages: [],
    window: {},
    URL,
  }
  sandbox.globalThis = sandbox
  sandbox.window.top = {}
  sandbox.globalThis.SYCScoring = {
    buildRenderPlan: result => ({
      tier: 1,
      durationMs: 7500,
      score: result.score ?? 0,
      emphasis: result.emphasis ?? 0,
      reasons: result.reasons ?? [],
    }),
    createFallbackScorer: () => ({ score: () => ({ score: 0.7, emphasis: 0.2, reasons: ["test"] }) }),
  }
  sandbox.globalThis.__SYC_TEST__ = true

  for (const file of ["sanitize.js", "content.js"]) {
    runInNewContext(readFileSync(resolve("extension", file), "utf8"), sandbox, {
      filename: `extension/${file}`,
    })
  }
  return { helpers: sandbox.globalThis.__SYCContentTest, sandbox }
}

const loadLiveChatStartup = () => {
  let releaseFilter
  let filterLoaded = false
  let filterLoadStarted = false
  const blockedNode = makeChatRenderer({ textValue: "blocked word", author: "Alice" })
  const intervals = []
  const sandbox = {
    Element: function Element() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    globalThis: null,
    chrome: {
      i18n: { getMessage: () => "" },
      runtime: {
        id: "test-extension",
        lastError: null,
        sendMessage(message, callback) {
          sandbox.sentMessages.push(message)
          callback?.()
        },
      },
    },
    document: {
      documentElement: { isConnected: true },
      querySelector() {
        return null
      },
      querySelectorAll() {
        return [blockedNode]
      },
    },
    location: { pathname: "/live_chat" },
    Promise,
    sentMessages: [],
    window: {
      setInterval(callback, delay) {
        intervals.push({ callback, delay, cleared: false })
        return intervals.length
      },
      clearInterval(id) {
        intervals[id - 1].cleared = true
      },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window.top = {}
  sandbox.globalThis.SYCScoring = {
    buildRenderPlan: result => ({
      tier: 1,
      durationMs: 7500,
      score: result.score ?? 0,
      emphasis: result.emphasis ?? 0,
      reasons: result.reasons ?? [],
    }),
    createFallbackScorer: () => ({ score: () => ({ score: 0.7, emphasis: 0.2, reasons: ["test"] }) }),
  }
  const shouldDropStub = (_author, textValue) => filterLoaded && textValue.includes("blocked")
  sandbox.globalThis.SYCFilter = {
    load() {
      filterLoadStarted = true
      return new Promise(done => {
        releaseFilter = () => {
          filterLoaded = true
          done()
        }
      })
    },
    onChange() {},
    shouldDrop: shouldDropStub,
    apply(author, textValue, channelId) {
      return { drop: shouldDropStub(author, textValue, channelId), text: textValue }
    },
  }

  for (const file of ["sanitize.js", "content.js"]) {
    runInNewContext(readFileSync(resolve("extension", file), "utf8"), sandbox, {
      filename: `extension/${file}`,
    })
  }

  return {
    get filterLoadStarted() {
      return filterLoadStarted
    },
    intervals,
    releaseFilter,
    sandbox,
  }
}

const { helpers, sandbox } = loadHelpers()

{
  const message = element("span", {}, [
    text("hello "),
    element("img", { alt: ":member_wave:" }),
    text(" world"),
  ])
  assert.equal(helpers.extractMessageText(chatNode(message)), "hello :member_wave: world")
}

{
  const message = element("span", {}, [
    element("img", { alt: ":only_emoji:" }),
    element("img", { alt: ":second:" }),
  ])
  assert.equal(helpers.extractMessageText(chatNode(message)), ":only_emoji::second:")
}

{
  const body = element("div", {}, [
    text("super "),
    element("img", { "aria-label": ":sticker:" }),
    text(" chat"),
  ])
  assert.equal(helpers.extractMessageText(fallbackChatNode(body)), "super :sticker: chat")
}

assert.equal(helpers.extractAuthorType(makeChatRenderer({ authorType: "owner" })), "owner")
assert.equal(helpers.extractAuthorType(makeChatRenderer({ fallbackRole: "member", fallbackAriaLabel: "メンバー" })), "member")
assert.equal(helpers.extractAuthorType(makeChatRenderer({ fallbackAriaLabel: "Owner" })), "normal")
assert.equal(
  helpers.extractAmount(makeChatRenderer({ amount: " ¥1,000 " })),
  "¥1,000",
)
assert.equal(
  helpers.extractPaidColor(makeChatRenderer({ paidColor: "rgb(210, 144, 0)" })),
  "#d29000",
)
assert.equal(
  helpers.extractAuthorChannelId(makeChatRenderer({ channelId: "UCabc123" })),
  "UCabc123",
)
sandbox.document.querySelector = () => null
assert.equal(helpers.hasLiveChatShell(), false)
sandbox.document.querySelector = selector => selector.includes("ytd-live-chat-frame") ? {} : null
assert.equal(helpers.hasLiveChatShell(), true)
assert.equal(helpers.isOfficialChatText({ author: "YouTube", text: "hello", kind: "text" }), true)
assert.equal(
  helpers.isOfficialChatText({ author: "Team YouTube", text: "community guidelines", kind: "text" }),
  true,
)
assert.equal(helpers.isOfficialChatText({ author: "", text: "welcome to live chat", kind: "text" }), true)
assert.equal(
  helpers.isOfficialChatText({ author: "Alice", text: "welcome to live chat", kind: "text" }),
  false,
)
assert.equal(
  helpers.isOfficialChatText({ author: "Alice", text: "プライバシーの話", kind: "text" }),
  false,
)
assert.equal(helpers.isOfficialChatText({ author: "Alice", text: "normal comment", kind: "text" }), false)

helpers.resetProcessedNodes()
const firstAliceMessage = makeChatRenderer({ textValue: "hello world", author: "Alice" })
await helpers.processChatNode(firstAliceMessage)
assert.equal(sandbox.sentMessages.length, 1)
assert.equal(sandbox.sentMessages[0].payload.text, "hello world")
assert.equal(sandbox.sentMessages[0].payload.author, "Alice")
assert.equal(sandbox.sentMessages[0].payload.authorType, "normal")

await helpers.processChatNode(firstAliceMessage)
assert.equal(sandbox.sentMessages.length, 1)

await helpers.processChatNode(makeChatRenderer({ textValue: "hello world", author: "Alice" }))
assert.equal(sandbox.sentMessages.length, 2)

await helpers.processChatNode(makeChatRenderer({
  tag: "yt-live-chat-paid-message-renderer",
  textValue: "great stream",
  author: "Donor",
  amount: "$5.00",
  paidColor: "#1565c0",
}))
assert.equal(sandbox.sentMessages.length, 3)
assert.equal(sandbox.sentMessages[2].payload.kind, "paid")
assert.equal(sandbox.sentMessages[2].payload.amount, "$5.00")
assert.equal(sandbox.sentMessages[2].payload.paidColor, "#1565c0")

await helpers.processChatNode(makeChatRenderer({ textValue: "welcome to live chat", author: "Alice" }))
assert.equal(sandbox.sentMessages.length, 4)

helpers.resetProcessedNodes()
await helpers.processChatNode(makeChatRenderer({
  textValue: `  ${"x".repeat(620)}  `,
  author: "  Bob\nName  ",
}))
assert.equal(sandbox.sentMessages.length, 5)
assert.equal(sandbox.sentMessages[4].payload.text.length, 500)
assert.equal(sandbox.sentMessages[4].payload.author, "Bob Name")
assert.equal(sandbox.sentMessages[4].payload.kind, "text")

{
  helpers.resetProcessedNodes()
  await helpers.processChatNode(
    makeChatRenderer({
      textValue: "hi ",
      author: "Alice",
      emoji: { src: "https://yt3.ggpht.com/emoji=s24", alt: ":emoji:" },
    }),
  )
  const payload = sandbox.sentMessages.at(-1).payload
  assert.equal(payload.text, "hi :emoji:")
  assert.equal(payload.parts.length, 2)
  assert.equal(payload.parts[1].u, "https://yt3.ggpht.com/emoji=s24")
  assert.equal(payload.parts[1].a, ":emoji:")
  assert.equal(
    JSON.stringify(helpers.extractMessageParts(
      makeChatRenderer({ textValue: "x", emoji: { src: "https://evil.example/e.png", alt: "bad" } }),
    )),
    JSON.stringify([{ t: "x" }, { u: "https://evil.example/e.png", a: "bad" }]),
  )
}

{
  const startup = loadLiveChatStartup()
  assert.equal(startup.filterLoadStarted, true)
  assert.equal(startup.sandbox.sentMessages.length, 0)
  assert.equal(startup.intervals.length, 0)
  startup.releaseFilter()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(startup.sandbox.sentMessages.length, 0)
  assert.equal(startup.intervals.length, 1)
  assert.equal(startup.intervals[0].delay, 2500)

  // While the extension is there the periodic scan keeps going; once it has
  // been updated or removed (chrome.runtime.id is gone) the scan stops.
  startup.intervals[0].callback()
  assert.equal(startup.intervals[0].cleared, false)
  delete startup.sandbox.chrome.runtime.id
  startup.intervals[0].callback()
  assert.equal(startup.intervals[0].cleared, true)
}

{
  // Translation changes the parts the stage draws from: each text run is
  // translated and custom emoji stay where they were.
  const { helpers: tr } = loadHelpers()
  const signals = []
  const T = {
    translate: async (source, _target, { signal } = {}) => {
      signals.push(signal)
      return source.trim() === "hello" ? "こんにちは" : source
    },
  }
  const emoji = { u: "https://yt3.ggpht.com/e.png", a: ":wave:" }
  const payload = { text: "hello :wave:", parts: [{ t: "hello " }, emoji], kind: "text" }
  const controller = new AbortController()
  const out = await tr.translatePayload(T, payload, "ja", controller.signal)
  // The caller's signal reaches translate(), so a translation it stops waiting for is cancelled.
  assert.equal(signals.length === 1 && signals[0] === controller.signal, true)
  assert.equal(JSON.stringify(out.parts), JSON.stringify([{ t: "こんにちは" }, emoji]))
  assert.equal(out.text, "こんにちは:wave:")
  // Nothing translated: the payload is passed on unchanged.
  const same = { text: "8888", parts: [{ t: "8888" }], kind: "text" }
  assert.equal(await tr.translatePayload(T, same, "ja"), same)
  // A payload without parts is translated from its text.
  const plain = await tr.translatePayload(T, { text: "hello", parts: [], kind: "text" }, "ja")
  assert.equal(JSON.stringify(plain.parts), JSON.stringify([{ t: "こんにちは" }]))
}

{
  // The renderer side runs on every youtube.com page and must tell a watch
  // page from the rest, whatever shape its URL has.
  const { helpers: page } = loadHelpers()
  for (const path of ["/watch", "/live/abcdefghijk", "/@channel/live", "/channel/UCxyz/live", "/c/name/live/"]) {
    assert.equal(page.isWatchPage(path), true, `${path} is a watch page`)
  }
  for (const path of ["/", "/results", "/feed/subscriptions", "/@channel", "/@channel/streams", "/shorts/abc", "/live_chat", "/@livestream", "/live"]) {
    assert.equal(page.isWatchPage(path), false, `${path} is not a watch page`)
  }
}

{
  // A batch no bigger than live chat produces flows completely.
  const { helpers: batch, sandbox: box } = loadHelpers()
  const live = Array.from({ length: batch.LIVE_BATCH_MAX }, (_, i) => makeChatRenderer({ textValue: `live ${i}` }))
  assert.equal(batch.processChatNodes(live), batch.LIVE_BATCH_MAX)
  assert.equal(box.sentMessages.length, batch.LIVE_BATCH_MAX)

  // A bigger one is a backlog (chat history on load, a seek, a background tab
  // catching up): only its newest few are shown, and the rest never come back.
  box.sentMessages.length = 0
  const backlog = Array.from({ length: 200 }, (_, i) => makeChatRenderer({ textValue: `old ${i}` }))
  assert.equal(batch.processChatNodes(backlog), batch.BACKLOG_KEEP)
  assert.equal(box.sentMessages.length, batch.BACKLOG_KEEP)
  assert.equal(box.sentMessages[0].payload.text, `old ${200 - batch.BACKLOG_KEEP}`)
  assert.equal(box.sentMessages.at(-1).payload.text, "old 199")
  box.sentMessages.length = 0
  assert.equal(batch.processChatNodes(backlog), 0, "a rescan must not replay the skipped backlog")
  assert.equal(box.sentMessages.length, 0)

  // Already-seen nodes do not count toward the batch size.
  const next = [...backlog, makeChatRenderer({ textValue: "new one" })]
  assert.equal(batch.processChatNodes(next), 1)
  assert.equal(box.sentMessages.at(-1).payload.text, "new one")
}

console.log("content-extract ok (77 assertions)")
