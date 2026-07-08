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
} = {}) => {
  const message = element("span", {}, [text(textValue)])
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
        intervals.push({ callback, delay })
        return intervals.length
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
    shouldDrop(_author, textValue) {
      return filterLoaded && textValue.includes("blocked")
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
}

console.log("content-extract ok (41 assertions)")
