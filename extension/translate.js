(() => {
  "use strict";

  // On-device translation via the browser's built-in Translator / LanguageDetector
  // APIs (Chrome 138+). Everything runs locally: no chat text is sent to the
  // developer or to any external service. When the API or a language pack is
  // unavailable this degrades to the original text.
  //
  // Creating a translator or a language detector needs a user gesture until
  // this site has created one for that model: every language pair reports
  // "downloadable" until then. Comments arrive without a gesture, so a pair
  // that needs one is noted and created on the user's next click or key press
  // on the page (activate(), wired up in content.js). Its comments are shown
  // untranslated until then.
  //
  // Classic script (export-free) so Chrome can load it as a content script;
  // consumers read globalThis.SYCTranslate.

  const MAX_CACHE = 400;
  const MAX_TRANSLATORS = 4; // each holds a language model; the least recently used is destroyed
  const RETRY_MS = 60000; // a create() that failed is not tried again for this long
  const MIN_CONFIDENCE = 0.5; // below this a short comment's language is a guess: leave it as is
  const cache = new Map(); // `${target}\u0000${source}` -> translated text
  const translators = new Map(); // "from>to" -> { instance, creating, failedAt }, least recently used first
  const wanted = new Set(); // "from>to" pairs waiting for a user gesture
  let detector = { instance: null, creating: null, failedAt: 0, wanted: false };

  const hasTranslator = () => typeof globalThis.Translator?.create === "function";
  const hasDetector = () => typeof globalThis.LanguageDetector?.create === "function";
  const hasGesture = () => globalThis.navigator?.userActivation?.isActive === true;
  const primaryTag = (tag) => String(tag || "").toLowerCase().split("-")[0];

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

  // Whether create() can run now: "yes" with a user gesture or a model this
  // site can already use, "gesture" when it needs one, "no" when this browser
  // has no such model (Brave, for one, ships no language detection model).
  async function canCreate(api, options) {
    if (hasGesture()) return "yes";
    if (typeof api.availability !== "function") return "yes"; // no way to ask: just try
    try {
      const availability = await api.availability(options);
      return availability === "available" ? "yes" : availability === "unavailable" ? "no" : "gesture";
    } catch {
      return "no";
    }
  }

  function createDetector() {
    const state = detector;
    state.wanted = false;
    state.creating = globalThis.LanguageDetector.create()
      .then((instance) => {
        state.instance = instance;
        return instance;
      }, () => {
        state.failedAt = Date.now();
        return null;
      })
      .finally(() => {
        state.creating = null;
      });
    return state.creating;
  }

  async function getDetector() {
    const state = detector;
    if (state.instance) return state.instance;
    if (state.creating) return state.creating;
    if (!hasDetector() || state.wanted || Date.now() - state.failedAt < RETRY_MS) return null;
    const can = await canCreate(globalThis.LanguageDetector, {});
    if (can !== "yes") {
      if (can === "gesture") state.wanted = true;
      else state.failedAt = Date.now();
      return null;
    }
    return state.instance || state.creating || createDetector();
  }

  // Destroy the least recently used translators beyond MAX_TRANSLATORS. One
  // still being created is left alone.
  function evictTranslators() {
    for (const [key, entry] of translators) {
      if (translators.size <= MAX_TRANSLATORS) break;
      if (entry.creating) continue;
      translators.delete(key);
      try {
        entry.instance?.destroy?.();
      } catch {
        // Already gone.
      }
    }
  }

  function createTranslator(key) {
    const [sourceLanguage, targetLanguage] = key.split(">");
    wanted.delete(key);
    const entry = { instance: null, creating: null, failedAt: 0 };
    translators.set(key, entry);
    entry.creating = globalThis.Translator.create({ sourceLanguage, targetLanguage })
      .then((instance) => {
        entry.instance = instance;
        return instance;
      }, () => {
        entry.failedAt = Date.now();
        return null;
      })
      .finally(() => {
        entry.creating = null;
        evictTranslators();
      });
    return entry.creating;
  }

  async function getTranslator(from, to) {
    const key = `${from}>${to}`;
    const entry = translators.get(key);
    if (entry?.instance) {
      translators.delete(key);
      translators.set(key, entry); // most recently used
      return entry.instance;
    }
    if (entry?.creating) return entry.creating;
    if (wanted.has(key) || (entry && Date.now() - entry.failedAt < RETRY_MS)) return null;
    const can = await canCreate(globalThis.Translator, { sourceLanguage: from, targetLanguage: to });
    if (can !== "yes") {
      if (can === "gesture") wanted.add(key);
      else translators.set(key, { instance: null, creating: null, failedAt: Date.now() });
      return null;
    }
    const now = translators.get(key); // created meanwhile by another comment
    return now?.instance || now?.creating || createTranslator(key);
  }

  // The comment's language, "" when it cannot be told, or null when there is
  // no detector (yet).
  async function detectLanguage(text) {
    const instance = await getDetector();
    if (!instance) return null;
    try {
      const [best] = await instance.detect(text);
      const lang = best?.detectedLanguage || "";
      return lang && lang !== "und" && (best.confidence ?? 1) >= MIN_CONFIDENCE ? lang : "";
    } catch {
      return null;
    }
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
    if (from === null) return source; // no detector yet: try again next time
    if (!from || primaryTag(from) === primaryTag(targetLanguage)) {
      cacheSet(key, source);
      return source;
    }
    const instance = await getTranslator(from, targetLanguage);
    if (!instance) return source;
    try {
      const out = await instance.translate(source);
      const value = typeof out === "string" && out ? out : source;
      cacheSet(key, value);
      return value;
    } catch {
      return source;
    }
  }

  // Whether something is waiting for a user gesture.
  const waiting = () => detector.wanted || wanted.size > 0;

  // Call from a user gesture (click, key press): create what was waiting for
  // one, the most recently wanted pairs first.
  function activate() {
    if (!waiting() || !hasGesture()) return;
    if (detector.wanted && hasDetector()) createDetector();
    if (!hasTranslator()) return;
    const keys = [...wanted].slice(-MAX_TRANSLATORS);
    wanted.clear();
    for (const key of keys) {
      if (!translators.get(key)?.creating) createTranslator(key);
    }
  }

  globalThis.SYCTranslate = {
    translate,
    activate,
    waiting,
    available: hasTranslator,
    // test helper
    reset() {
      cache.clear();
      for (const entry of translators.values()) entry.instance?.destroy?.();
      translators.clear();
      wanted.clear();
      detector = { instance: null, creating: null, failedAt: 0, wanted: false };
    }
  };
})();
