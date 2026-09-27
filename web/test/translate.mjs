// SYCTranslate: on-device translation wrapper. Verifies graceful degradation,
// caching, same-language skipping, and failure handling with a mocked built-in
// Translator / LanguageDetector.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const load = (globals = {}) => {
  const sandbox = { globalThis: null, ...globals }
  sandbox.globalThis = sandbox
  runInNewContext(
    readFileSync(new URL("../../extension/translate.js", import.meta.url), "utf8"),
    sandbox,
    {
      filename: "extension/translate.js",
    },
  )
  return sandbox.globalThis.SYCTranslate
}

const translating = calls => ({
  create: async ({ targetLanguage }) => {
    calls.create += 1
    return {
      translate: async text => {
        calls.translate += 1
        return `[${targetLanguage}]${text}`
      },
    }
  },
})

const detector = (lang, calls) => ({
  create: async () => {
    calls.detect += 1
    return { detect: async () => [{ detectedLanguage: lang }] }
  },
})

{
  const T = load()
  assert.equal(T.available(), false)
  assert.equal(await T.translate("hello", "ja"), "hello")
  assert.equal(await T.translate("hello", ""), "hello")
}

{
  const calls = { create: 0, translate: 0, detect: 0 }
  const T = load({
    Translator: translating(calls),
    LanguageDetector: detector("en", calls),
  })
  assert.equal(T.available(), true)
  assert.equal(await T.translate("hi", "ja"), "[ja]hi")
  assert.equal(await T.translate("hi", "ja"), "[ja]hi")
  assert.equal(calls.translate, 1, "repeat translation should be cached")
  assert.equal(calls.create, 1, "Translator.create should run once per language pair")
  assert.equal(calls.detect, 1, "language detection should be cached")
}

{
  const calls = { create: 0, translate: 0, detect: 0 }
  const T = load({
    Translator: translating(calls),
    LanguageDetector: detector("ja", calls),
  })
  assert.equal(await T.translate("こんにちは", "ja"), "こんにちは")
  assert.equal(calls.translate, 0, "same-language text should not be translated")
}

{
  const broken = {
    create: async () => {
      throw new Error("no language pack")
    },
  }
  const T = load({ Translator: broken, LanguageDetector: detector("en", { detect: 0 }) })
  assert.equal(await T.translate("hi", "ja"), "hi")
  assert.equal(await T.translate("hi", "ja"), "hi")
}

{
  const failing = {
    create: async () => ({
      translate: async () => {
        throw new Error("boom")
      },
    }),
  }
  const T = load({ Translator: failing, LanguageDetector: detector("en", { detect: 0 }) })
  assert.equal(await T.translate("hi", "ja"), "hi")
}

console.log("translate ok (14 assertions)")
