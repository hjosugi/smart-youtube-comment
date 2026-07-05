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
    if (selector === '[type="owner"], [aria-label*="Owner"], [aria-label*="owner"]') {
      return attrs.role === "owner" ? this : null
    }
    if (selector === '[type="moderator"], [aria-label*="Moderator"], [aria-label*="moderator"]') {
      return attrs.role === "moderator" ? this : null
    }
    if (selector === '[type="member"], [aria-label*="Member"], [aria-label*="member"]') {
      return attrs.role === "member" ? this : null
    }
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
  officialContainer = false,
} = {}) => {
  const message = element("span", {}, [text(textValue)])
  const authorNode = element("span", {}, [text(author)])
  return {
    sentTag: tag,
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
      return null
    },
    querySelector(selector) {
      if (selector === "#message") return message
      if (selector === "#author-name") return authorNode
      if (selector.includes("owner") && fallbackRole === "owner") return element("span", { role: fallbackRole })
      if (selector.includes("moderator") && fallbackRole === "moderator") {
        return element("span", { role: fallbackRole })
      }
      if (selector.includes("member") && fallbackRole === "member") return element("span", { role: fallbackRole })
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

  runInNewContext(readFileSync(resolve("extension/content.js"), "utf8"), sandbox, {
    filename: "extension/content.js",
  })
  return { helpers: sandbox.globalThis.__SYCContentTest, sandbox }
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
assert.equal(helpers.extractAuthorType(makeChatRenderer({ fallbackRole: "member" })), "member")
assert.equal(helpers.isOfficialChatText({ author: "YouTube", text: "hello", kind: "text" }), true)
assert.equal(helpers.isOfficialChatText({ author: "Alice", text: "welcome to live chat", kind: "text" }), true)
assert.equal(helpers.isOfficialChatText({ author: "Alice", text: "normal comment", kind: "text" }), false)

helpers.resetSeenKeys()
await helpers.processChatNode(makeChatRenderer({ textValue: "hello world", author: "Alice" }))
assert.equal(sandbox.sentMessages.length, 1)
assert.equal(sandbox.sentMessages[0].payload.text, "hello world")
assert.equal(sandbox.sentMessages[0].payload.author, "Alice")
assert.equal(sandbox.sentMessages[0].payload.authorType, "normal")

await helpers.processChatNode(makeChatRenderer({ textValue: "hello world", author: "Alice" }))
assert.equal(sandbox.sentMessages.length, 1)

await helpers.processChatNode(makeChatRenderer({ textValue: "welcome to live chat", author: "Alice" }))
assert.equal(sandbox.sentMessages.length, 1)

console.log("content-extract ok (14 assertions)")
