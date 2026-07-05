// Direct extension settings/filter tests. These guard the storage split:
// display/runtime settings prefer chrome.storage.sync, while block lists stay
// local-only.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

const makeArea = () => {
  const data = new Map()
  return {
    data,
    async get(key) {
      return { [key]: data.get(key) }
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data.set(key, value)
    },
  }
}

const loadScripts = () => {
  const sync = makeArea()
  const local = makeArea()
  const sandbox = {
    globalThis: null,
    chrome: {
      storage: {
        sync,
        local,
        onChanged: { addListener() {} },
      },
    },
    devicePixelRatio: 1,
  }
  sandbox.globalThis = sandbox

  for (const file of ["extension/settings.js", "extension/filter.js"]) {
    runInNewContext(readFileSync(resolve(file), "utf8"), sandbox, { filename: file })
  }

  return { sandbox, sync, local }
}

const { sandbox, sync, local } = loadScripts()
const settings = sandbox.globalThis.SYCSettings
const filter = sandbox.globalThis.SYCFilter

await settings.save({
  enabled: "false",
  opacity: 999,
  textColor: "#ABCDEF",
  fontFamily: "serif",
})
assert.equal(sync.data.has(settings.STORAGE_KEY), true)
assert.equal(local.data.has(settings.STORAGE_KEY), false)
assert.equal((await settings.load()).enabled, false)
assert.equal((await settings.load()).opacity, 100)
assert.equal((await settings.load()).textColor, "#abcdef")

await filter.save({
  users: " Alice \nALICE\nBob ",
  words: "Spam\n spam \n草草草草",
})
assert.equal(local.data.has(filter.STORAGE_KEY), true)
assert.equal(sync.data.has(filter.STORAGE_KEY), false)
assert.deepEqual(Array.from(filter.lists.users), ["alice", "bob"])
assert.deepEqual(Array.from(filter.lists.words), ["spam", "草草草草"])
assert.equal(filter.shouldDrop("ALICE", "hello"), true)
assert.equal(filter.shouldDrop("carol", "buy spam now"), true)
assert.equal(filter.shouldDrop("carol", "hello"), false)

console.log("settings-filter ok (13 assertions)")
