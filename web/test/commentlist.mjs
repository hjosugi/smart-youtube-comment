import { createCommentList } from "../commentlist.ts"

class FakeNode {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.parentNode = null
    this.style = {
      values: {},
      setProperty(name, value) {
        this.values[name] = value
      },
    }
    this.dataset = {}
    this.hidden = false
    this.className = ""
    this.textContent = ""
    this.clientHeight = 100
    this._scrollTop = 0
    this.scrollWrites = 0
    this.listeners = new Map()
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue
      if (node.isFragment) {
        const children = [...node.children]
        node.children.length = 0
        this.append(...children)
        continue
      }
      node.parentNode = this
      this.children.push(node)
    }
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children.length = 0
    this.append(...nodes)
  }

  remove() {
    if (!this.parentNode) return
    const i = this.parentNode.children.indexOf(this)
    if (i >= 0) this.parentNode.children.splice(i, 1)
    this.parentNode = null
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || []
    list.push(fn)
    this.listeners.set(type, list)
  }

  dispatchEvent(event) {
    event.target ??= this
    event.currentTarget = this
    event.stopPropagation ??= () => {}
    event.preventDefault ??= () => {}
    for (const fn of this.listeners.get(event.type) || []) fn(event)
    return !event.defaultPrevented
  }

  click() {
    const event = { type: "click", target: this, currentTarget: this, stopPropagation() {} }
    this.onclick?.(event)
    this.dispatchEvent(event)
  }

  get firstChild() {
    return this.children[0] ?? null
  }

  get childElementCount() {
    return this.children.length
  }

  get scrollHeight() {
    return this.children.length * 20
  }

  get scrollTop() {
    return this._scrollTop
  }

  set scrollTop(value) {
    this._scrollTop = value
    this.scrollWrites += 1
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super("#text")
    this.textContent = text
  }
}

class FakeFragment extends FakeNode {
  constructor() {
    super("#fragment")
    this.isFragment = true
  }
}

globalThis.document = {
  createElement: tag => new FakeNode(tag),
  createTextNode: text => new FakeText(text),
  createDocumentFragment: () => new FakeFragment(),
}

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })
const message = i => ({
  id: `m-${i}`,
  text: `message ${i}`,
  author: `author ${i}`,
  authorType: i % 2 ? "moderator" : "normal",
  kind: i % 5 === 0 ? "paid" : "text",
  amount: i % 5 === 0 ? "$5.00" : null,
  paidColor: i % 5 === 0 ? "#1565c0" : null,
  parts: [{ t: `message ${i}` }],
})

const root = document.createElement("section")
const list = createCommentList(root)
const node = root.children[0]

list.pushMany([message(1), message(5), { id: "bad", text: "" }])
assert("batch appends valid rows", list.count === 2, String(list.count))
assert("batch performs one sticky scroll write", node.scrollWrites === 1, String(node.scrollWrites))
assert("paid messages keep paid row class", node.children[1].className.includes("paid"))
assert("paid messages render amount badge", node.children[1].children[1].textContent === "$5.00")
assert(
  "paid messages set tier color variable",
  node.children[1].style.values["--syc-paid-color"] === "#1565c0",
)

list.push(message(3))
assert("single push delegates to batch append", list.count === 3, String(list.count))
assert(
  "single push performs one additional sticky scroll",
  node.scrollWrites === 2,
  String(node.scrollWrites),
)

node.clientHeight = 0
node._scrollTop = 0
list.pushMany([message(4), message(5)])
assert("non-sticky batch does not force scroll", node.scrollWrites === 2, String(node.scrollWrites))

list.pushMany(Array.from({ length: 205 }, (_, i) => message(i + 10)))
assert("batch pruning caps rows", list.count === 200, String(list.count))

list.setVisible(false)
list.pushMany([message(999)])
assert("hidden list is cleared and ignores pushes", list.count === 0 && list.visible === false)

{
  const calls = { users: [], words: [] }
  const actionRoot = document.createElement("section")
  const actionList = createCommentList(actionRoot, {
    onBlockUser: author => calls.users.push(author),
    onBlockWord: word => calls.words.push(word),
  })
  actionList.push(message(77))
  const row = actionRoot.children[0].children[0]
  row.dispatchEvent({ type: "contextmenu" })
  const panel = row.children[row.children.length - 1]
  panel.children[0].click()
  row.dispatchEvent({ type: "contextmenu" })
  row.children[row.children.length - 1].children[1].click()
  assert("row action blocks user", calls.users[0] === "author 77")
  assert("row action blocks word", calls.words[0] === "message 77")
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ comment list batching verified (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
