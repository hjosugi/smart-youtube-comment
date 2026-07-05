// Options page behavior tests. Loads the real options script into a tiny DOM
// harness so autosave status changes are checked without a browser dependency.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.eventListeners = new Map()
    this.dataset = {}
    this.style = {}
    this.textContent = ""
    this.className = ""
    this.id = ""
    this.value = ""
    this.checked = false
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  append(...children) {
    for (const child of children) this.appendChild(child)
  }

  insertBefore(child, reference) {
    child.parentNode = this
    const index = this.children.indexOf(reference)
    if (index === -1) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  addEventListener(type, listener) {
    const listeners = this.eventListeners.get(type) || []
    listeners.push(listener)
    this.eventListeners.set(type, listeners)
  }

  dispatchEvent(type) {
    for (const listener of this.eventListeners.get(type) || []) listener({ target: this })
  }

  click() {
    for (const listener of this.eventListeners.get("click") || []) listener({ target: this })
  }
}

class TestDocument {
  constructor() {
    this.title = "Options"
    this.body = new Element("body")
  }

  createElement(tagName) {
    return new Element(tagName)
  }

  getElementById(id) {
    return this.find((el) => el.id === id)
  }

  querySelector(selector) {
    return this.find((el) => matches(el, selector))
  }

  querySelectorAll(selector) {
    const results = []
    walk(this.body, (el) => {
      if (matches(el, selector)) results.push(el)
    })
    return results
  }

  find(predicate) {
    let found = null
    walk(this.body, (el) => {
      if (!found && predicate(el)) found = el
    })
    return found
  }
}

function walk(root, visit) {
  visit(root)
  for (const child of root.children) walk(child, visit)
}

function matches(el, selector) {
  if (selector.startsWith("#")) return el.id === selector.slice(1)
  if (selector.startsWith(".")) return el.className.split(/\s+/).includes(selector.slice(1))
  if (selector === "[data-i18n]") return Object.hasOwn(el.dataset, "i18n")
  return el.tagName.toLowerCase() === selector
}

function buildDocument() {
  const document = new TestDocument()
  const wrap = document.createElement("div")
  wrap.className = "wrap"
  const status = document.createElement("span")
  status.id = "status"
  const previewText = document.createElement("span")
  previewText.id = "preview-text"
  const settings = document.createElement("div")
  settings.id = "settings"
  const actions = document.createElement("div")
  actions.className = "actions"
  const reset = document.createElement("button")
  reset.id = "reset"

  document.body.appendChild(wrap)
  wrap.append(status, previewText, settings, actions)
  actions.appendChild(reset)
  return document
}

const schema = [
  { key: "speedPct", group: "Speed", label: "Scroll speed", type: "range", min: 50, max: 200, step: 10, default: 100 },
  { key: "fastMs", group: "Speed", label: "Fast tier time", type: "range", min: 2000, max: 12000, step: 250, default: 6000 },
  { key: "normalMs", group: "Speed", label: "Normal tier time", type: "range", min: 3000, max: 16000, step: 250, default: 7500 },
  { key: "slowMs", group: "Speed", label: "Slow tier time", type: "range", min: 4000, max: 20000, step: 250, default: 10000 },
  { key: "spreadStrength", group: "Behavior", label: "Length speed strength", type: "range", min: 0, max: 100, step: 5, default: 35 },
]
const defaults = Object.fromEntries(schema.map((spec) => [spec.key, spec.default]))
const saves = []
const document = buildDocument()
const sandbox = {
  clearTimeout,
  console,
  document,
  globalThis: null,
  location: { reload() {} },
  setTimeout,
  chrome: { i18n: { getMessage() { return "" } } },
}
sandbox.globalThis = sandbox
sandbox.globalThis.SYCSettings = {
  SCHEMA: schema,
  DEFAULTS: defaults,
  SPEED_PRESETS: {
    default: { label: "Default", ...defaults },
    niconico: { label: "Niconico (fast)", speedPct: 120, fastMs: 3500, normalMs: 4000, slowMs: 5000, spreadStrength: 20 },
  },
  async load() {
    return { ...defaults }
  },
  async save(values) {
    saves.push(values)
  },
}

runInNewContext(readFileSync(resolve("extension/options.js"), "utf8"), sandbox, {
  filename: "extension/options.js",
})

await wait()

const preset = document.querySelectorAll("button").find((button) => button.textContent === "Niconico (fast)")
assert.ok(preset)

preset.click()
assert.equal(document.getElementById("status").textContent, "")
assert.equal(saves.length, 0)

await wait(500)

assert.equal(saves.length, 0)

await wait(300)

assert.equal(saves.length, 1)
assert.equal(saves[0].speedPct, 120)
assert.equal(saves[0].fastMs, 3500)
assert.equal(saves[0].normalMs, 4000)
assert.equal(saves[0].slowMs, 5000)
assert.equal(document.getElementById("status").textContent, "Saved")

const speed = document.querySelectorAll("input").find((input) => input.type === "range")
assert.ok(speed)

speed.value = 130
speed.dispatchEvent("input")
await wait(300)
speed.value = 140
speed.dispatchEvent("input")
await wait(300)
speed.value = 150
speed.dispatchEvent("input")
await wait(500)

assert.equal(saves.length, 1)

await wait(300)

assert.equal(saves.length, 2)
assert.equal(saves[1].speedPct, 150)

console.log("options ok (12 assertions)")
