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

const loadHelpers = () => {
  const sandbox = {
    globalThis: null,
    chrome: { i18n: { getMessage: () => "" }, runtime: { sendMessage() {} } },
    document: {},
    location: { pathname: "/watch" },
    window: {},
  }
  sandbox.globalThis = sandbox
  sandbox.window.top = {}
  sandbox.globalThis.SYCScoring = {
    buildRenderPlan: () => null,
    createFallbackScorer: () => ({ score: () => ({}) }),
  }
  sandbox.globalThis.__SYC_TEST__ = true

  runInNewContext(readFileSync(resolve("extension/content.js"), "utf8"), sandbox, {
    filename: "extension/content.js",
  })
  return sandbox.globalThis.__SYCContentTest
}

const helpers = loadHelpers()

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

console.log("content-extract ok (3 assertions)")
