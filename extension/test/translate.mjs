// On-device translation (extension/translate.js) against fake Translator /
// LanguageDetector APIs that behave as Chrome documents them: create() needs a
// user gesture while a model is "downloadable" for this site.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

let assertions = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  assertions++
}

function loadTranslate({ detected = {}, availableSite = new Set(), detectorAvailable = false, failCreate = new Set(), detectorMissing = false, translateMs = 0, gestureExpiresOnCreate = false } = {}) {
  const log = { creates: [], destroyed: [], translateCalls: 0, detectorCreates: 0, detectCalls: 0 }
  const activation = { isActive: false }
  class FakeTranslator {
    constructor(sourceLanguage, targetLanguage) {
      this.pair = `${sourceLanguage}>${targetLanguage}`
    }
    async translate(text, { signal } = {}) {
      log.translateCalls++
      if (translateMs) {
        // a slow translation that its signal can cancel, as Chrome's can
        await new Promise((done, fail) => {
          const timer = setTimeout(done, translateMs)
          signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            fail(signal.reason)
          }, { once: true })
        })
      }
      return `[${this.pair}] ${text}`
    }
    destroy() {
      log.destroyed.push(this.pair)
    }
  }
  const sandbox = {
    globalThis: null,
    Date,
    Promise,
    navigator: { userActivation: activation },
    Translator: {
      async availability({ sourceLanguage, targetLanguage }) {
        return availableSite.has(`${sourceLanguage}>${targetLanguage}`) ? "available" : "downloadable"
      },
      async create({ sourceLanguage, targetLanguage }) {
        const pair = `${sourceLanguage}>${targetLanguage}`
        log.creates.push(pair)
        if (failCreate.has(pair)) throw new Error("NetworkError")
        if (gestureExpiresOnCreate) {
          gestureExpiresOnCreate = false // only the first time
          activation.isActive = false
        }
        if (!activation.isActive && !availableSite.has(pair)) throw new DOMException("needs a user gesture", "NotAllowedError")
        availableSite.add(pair) // created once on this site: available from now on
        return new FakeTranslator(sourceLanguage, targetLanguage)
      },
    },
    LanguageDetector: {
      async availability() {
        if (detectorMissing) return "unavailable"
        return detectorAvailable ? "available" : "downloadable"
      },
      async create() {
        log.detectorCreates++
        if (!activation.isActive && !detectorAvailable) throw new DOMException("needs a user gesture", "NotAllowedError")
        detectorAvailable = true
        return {
          async detect(text) {
            log.detectCalls++
            const hit = detected[text]
            return hit ? [{ detectedLanguage: hit[0], confidence: hit[1] }] : [{ detectedLanguage: "und", confidence: 1 }]
          },
        }
      },
    },
  }
  sandbox.globalThis = sandbox
  runInNewContext(readFileSync(resolve("extension/translate.js"), "utf8"), sandbox, { filename: "extension/translate.js" })
  return { T: sandbox.SYCTranslate, log, activation, availableSite }
}

const flush = () => new Promise(done => setTimeout(done, 0))

{
  // No gesture yet: nothing is created, the text is left as it is, and both
  // the detector and the pair wait for one.
  const { T, log, activation } = loadTranslate({ detected: { "안녕하세요": ["ko", 0.98] } })
  equal(await T.translate("안녕하세요", "ja"), "안녕하세요", "untranslated before any gesture")
  equal(log.detectorCreates, 0, "the detector is not created without a gesture")
  equal(T.waiting(), true, "the detector waits for a gesture")

  // One gesture creates the detector and, while the gesture still counts,
  // the pair of the comment that waited for it.
  activation.isActive = true
  T.activate()
  await flush()
  activation.isActive = false
  equal(log.detectorCreates, 1, "the gesture created the detector")
  equal(log.creates, ["ko>ja"], "and the waiting comment's pair")
  equal(T.waiting(), false, "nothing waits any more")
  equal(await T.translate("안녕하세요", "ja"), "[ko>ja] 안녕하세요", "translated after one gesture")
  equal(await T.translate("안녕하세요", "ja"), "[ko>ja] 안녕하세요", "repeated text is served from the cache")
  equal(log.translateCalls, 1, "the waiting comment was translated on the gesture; repeats come from the cache")
}

{
  // The gesture expired before the detector was ready: the pair waits for
  // the next one.
  const { T, log, activation } = loadTranslate({ detected: { "안녕하세요": ["ko", 0.98] } })
  await T.translate("안녕하세요", "ja")
  activation.isActive = true
  T.activate()
  activation.isActive = false
  await flush()
  equal(log.detectorCreates, 1, "the gesture created the detector")
  equal(log.creates, [], "the pair is not created without a gesture")
  equal(T.waiting(), true, "the pair waits for a gesture")
  equal(await T.translate("안녕하세요", "ja"), "안녕하세요", "still untranslated")

  activation.isActive = true
  T.activate()
  await flush()
  activation.isActive = false
  equal(log.creates, ["ko>ja"], "the next gesture created the pair's translator")
  equal(T.waiting(), false, "nothing waits any more")
  equal(await T.translate("안녕하세요", "ja"), "[ko>ja] 안녕하세요", "translated after the second gesture")
}

{
  // create() refused because the gesture ran out between the check and the
  // call: the pair waits for the next gesture instead of counting as failed.
  const { T, log, activation } = loadTranslate({
    detected: { "hello there": ["en", 0.9] },
    detectorAvailable: true,
    gestureExpiresOnCreate: true,
  })
  activation.isActive = true
  equal(await T.translate("hello there", "ja"), "hello there", "a refused create() leaves the text as it is")
  await flush()
  equal(log.creates, ["en>ja"], "create() was tried once")
  equal(T.waiting(), true, "and the pair waits for a gesture")
  equal(await T.translate("hello there", "ja"), "hello there", "it is not tried again without one")
  equal(log.creates, ["en>ja"], "still one create()")
  activation.isActive = true
  T.activate()
  await flush()
  activation.isActive = false
  equal(await T.translate("hello there", "ja"), "[en>ja] hello there", "the next gesture created it")
}

{
  // A model this site already created needs no gesture.
  const { T, log } = loadTranslate({
    detected: { "hello there": ["en", 0.9] },
    availableSite: new Set(["en>ja"]),
    detectorAvailable: true,
  })
  equal(await T.translate("hello there", "ja"), "[en>ja] hello there", "an available pair is created without a gesture")
  equal(log.creates, ["en>ja"], "one translator")
}

{
  // Same language (by primary subtag), low confidence and undetermined text are left alone.
  const { T, log } = loadTranslate({
    detected: { "你好": ["zh", 0.9], "lol": ["en", 0.2] },
    availableSite: new Set(["zh>zh-Hans", "en>ja"]),
    detectorAvailable: true,
  })
  equal(await T.translate("你好", "zh-Hans"), "你好", "zh into zh-Hans is the same language")
  equal(await T.translate("lol", "ja"), "lol", "a low-confidence guess is not translated")
  equal(await T.translate("8888", "ja"), "8888", "undetermined text is not translated")
  equal(log.creates, [], "no translator was needed")
}

{
  // Concurrent comments of two languages each get their own translator: a
  // late create() of one pair never serves the other.
  const { T, log } = loadTranslate({
    detected: { "hello there": ["en", 0.9], "안녕하세요": ["ko", 0.95] },
    availableSite: new Set(["en>ja", "ko>ja"]),
    detectorAvailable: true,
  })
  const [en, ko, en2] = await Promise.all([
    T.translate("hello there", "ja"),
    T.translate("안녕하세요", "ja"),
    T.translate("hello there", "ja"),
  ])
  equal([en, ko, en2], ["[en>ja] hello there", "[ko>ja] 안녕하세요", "[en>ja] hello there"], "each comment used its own pair")
  equal(log.creates.sort(), ["en>ja", "ko>ja"], "one create() per pair, even for concurrent comments")
}

{
  // At most four translators are kept; the least recently used is destroyed.
  const langs = ["en", "ko", "fr", "de", "es"]
  const detected = Object.fromEntries(langs.map(lang => [`text ${lang}`, [lang, 0.9]]))
  const { T, log } = loadTranslate({
    detected,
    availableSite: new Set(langs.map(lang => `${lang}>ja`)),
    detectorAvailable: true,
  })
  for (const lang of langs) await T.translate(`text ${lang}`, "ja")
  await flush()
  equal(log.destroyed, ["en>ja"], "the oldest translator was destroyed")
}

{
  // A create() that fails (the model cannot be loaded) is not retried for
  // every comment that follows.
  const { T, log } = loadTranslate({
    detected: { "hallo": ["de", 0.9], "guten tag": ["de", 0.9] },
    availableSite: new Set(["de>ja"]),
    detectorAvailable: true,
    failCreate: new Set(["de>ja"]),
  })
  equal(await T.translate("hallo", "ja"), "hallo", "a failed create() leaves the text as it is")
  equal(await T.translate("guten tag", "ja"), "guten tag", "and so does the next comment")
  equal(log.creates, ["de>ja"], "without a second create()")
}

{
  // A browser without the model (Brave ships no language detection model):
  // nothing waits for a gesture that could not help.
  const { T, log, activation } = loadTranslate({ detected: { "hello there": ["en", 0.9] }, detectorMissing: true })
  equal(await T.translate("hello there", "ja"), "hello there", "no detector model: left as it is")
  equal(T.waiting(), false, "nothing waits for a gesture")
  activation.isActive = true
  T.activate()
  equal(log.detectorCreates, 0, "and a gesture does not try to create it")
}

{
  // A caller that stopped waiting (the comment was already shown as it is):
  // the original comes back, the queued translation is cancelled, and nothing
  // is cached, so the next copy of the text is translated.
  const { T, log } = loadTranslate({
    detected: { "hello there": ["en", 0.9] },
    availableSite: new Set(["en>ja"]),
    detectorAvailable: true,
    translateMs: 1000,
  })
  const controller = new AbortController()
  const started = Date.now()
  const pending = T.translate("hello there", "ja", { signal: controller.signal })
  while (log.translateCalls === 0) await flush()
  controller.abort()
  equal(await pending, "hello there", "a cancelled translation leaves the text as it is")
  equal(Date.now() - started < 500, true, "without waiting for the translation to finish")

  equal(await T.translate("hello there", "ja", { signal: AbortSignal.abort() }), "hello there", "already given up: left as it is")
  equal(log.detectCalls, 1, "and no work is started for it")
  equal(log.translateCalls, 1, "not even a translation")
}

console.log(`translate ok (${assertions} assertions)`)
