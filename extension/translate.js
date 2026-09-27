(() => {
  "use strict";

  // On-device translation via the browser's built-in Translator / LanguageDetector
  // APIs (Chrome, experimental). Everything runs locally: no chat text is sent to
  // the developer or to any external service. When the API or a language pack is
  // unavailable this degrades to the original text.
  //
  // Classic script (export-free) so Chrome can load it as a content script;
  // consumers read globalThis.SYCTranslate.

  const MAX_CACHE = 400;
  const cache = new Map(); // `${target}\u0000${source}` -> translated text
  let translator = null;
  let translatorKey = "";
  let creating = null; // in-flight Translator.create() promise
  let detector = null;
  let detectorLoading = null;

  const hasTranslator = () => typeof globalThis.Translator?.create === "function";
  const hasDetector = () => typeof globalThis.LanguageDetector?.create === "function";

  function cacheGet(key) {
    const value = cache.get(key);
    if (value !== undefined) {
      cache.delete(key);
      cache.set(key, value); // LRU touch
    }
    return value;
  }

  function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }

  async function detectLanguage(text) {
    if (!hasDetector()) return "";
    try {
      detectorLoading ??= globalThis.LanguageDetector.create().catch(() => null);
      detector = detector ?? (await detectorLoading);
      if (!detector) return "";
      const results = await detector.detect(text);
      return results?.[0]?.detectedLanguage || "";
    } catch {
      return "";
    }
  }

  async function ensureTranslator(from, to) {
    const key = `${from}>${to}`;
    if (translator && translatorKey === key) return translator;
    if (creating && translatorKey === key) return creating;
    translatorKey = key;
    creating = globalThis.Translator.create({ sourceLanguage: from, targetLanguage: to })
      .then((instance) => {
        translator = instance;
        creating = null;
        return instance;
      })
      .catch(() => {
        creating = null;
        return null;
      });
    return creating;
  }

  // Returns the translated text, or the original when translation is off,
  // unavailable, unnecessary, or fails. Never throws.
  async function translate(text, targetLanguage) {
    const source = String(text || "");
    if (!targetLanguage || !source.trim() || !hasTranslator()) return source;
    const key = `${targetLanguage}\u0000${source}`;
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
    const from = await detectLanguage(source);
    if (!from || from === targetLanguage) {
      cacheSet(key, source);
      return source;
    }
    const instance = await ensureTranslator(from, targetLanguage);
    if (!instance) {
      cacheSet(key, source);
      return source;
    }
    try {
      const out = await instance.translate(source);
      const value = typeof out === "string" && out ? out : source;
      cacheSet(key, value);
      return value;
    } catch {
      cacheSet(key, source);
      return source;
    }
  }

  globalThis.SYCTranslate = {
    translate,
    available: hasTranslator,
    // test helper
    reset() {
      cache.clear();
      translator = null;
      translatorKey = "";
      creating = null;
      detector = null;
      detectorLoading = null;
    }
  };
})();
