import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

const readMessages = locale =>
  JSON.parse(readFileSync(resolve("extension/_locales", locale, "messages.json"), "utf8"))

const en = readMessages("en")
const ja = readMessages("ja")
const enKeys = Object.keys(en).sort()
const jaKeys = Object.keys(ja).sort()

assert.deepEqual(jaKeys, enKeys)

const sandbox = {
  globalThis: null,
  chrome: { storage: null },
  devicePixelRatio: 1,
}
sandbox.globalThis = sandbox

for (const file of ["settings.js", "filter.js"]) {
  runInNewContext(readFileSync(resolve("extension", file), "utf8"), sandbox, {
    filename: `extension/${file}`,
  })
}

const hasKey = key => {
  assert.ok(en[key], `missing en ${key}`)
  assert.ok(ja[key], `missing ja ${key}`)
}

for (const spec of sandbox.globalThis.SYCSettings.SCHEMA) {
  hasKey(`s_${spec.key}`)
  hasKey(`g_${String(spec.group).toLowerCase()}`)
  if (spec.note) hasKey(`sn_${spec.key}`)
}

for (const key of Object.keys(sandbox.globalThis.SYCSettings.SPEED_PRESETS)) {
  hasKey(`sp_${key}`)
}

for (const key of Object.keys(sandbox.globalThis.SYCFilter.PRESETS)) {
  hasKey(`fp_${key.replace(/[^a-zA-Z0-9_]/g, "_")}`)
}

for (const key of [
  "opt_export",
  "opt_import",
  "opt_exported",
  "opt_imported",
  "opt_export_failed",
  "opt_import_failed",
  "opt_reset_done",
  "opt_open_settings",
  "f_channels",
]) {
  hasKey(key)
}

// Every __MSG_name__ in the manifest (name, description, action title,
// shortcut descriptions) resolves in both locales.
const manifest = readFileSync(resolve("extension/manifest.json"), "utf8")
const manifestKeys = [...manifest.matchAll(/__MSG_(\w+)__/g)].map(match => match[1])
assert.ok(manifestKeys.includes("cmd_toggle_overlay"), "shortcut descriptions are localized")
for (const key of manifestKeys) hasKey(key)

console.log("i18n ok (locale keys + schema/preset coverage + manifest messages)")
