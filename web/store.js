// Minimal chrome.storage shim over localStorage, so the reused extension
// settings.js / filter.js run UNCHANGED in the browser (they read
// chrome.storage.local + chrome.storage.onChanged). Installed only when there is
// no real extension context. Classic script — load before settings.js/filter.js.
(() => {
  "use strict";
  if (typeof globalThis.chrome !== "undefined" && globalThis.chrome.storage) return;

  const ls = globalThis.localStorage;
  const parse = (raw) => {
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  const listeners = [];
  const emit = (key, oldValue, newValue) =>
    listeners.forEach((cb) => cb({ [key]: { oldValue, newValue } }, "local"));

  const keysOf = (query) =>
    query == null
      ? Object.keys(ls)
      : Array.isArray(query)
        ? query
        : typeof query === "string"
          ? [query]
          : Object.keys(query);

  const local = {
    async get(query) {
      const out = {};
      for (const k of keysOf(query)) {
        const v = parse(ls.getItem(k));
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        const old = parse(ls.getItem(k));
        ls.setItem(k, JSON.stringify(v));
        emit(k, old, v);
      }
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) {
        const old = parse(ls.getItem(k));
        ls.removeItem(k);
        emit(k, old, undefined);
      }
    },
  };

  // Cross-tab updates: the native 'storage' event fires in OTHER tabs.
  globalThis.addEventListener?.("storage", (e) => {
    if (e.key) emit(e.key, parse(e.oldValue), parse(e.newValue));
  });

  globalThis.chrome = {
    storage: { local, onChanged: { addListener: (cb) => listeners.push(cb) } },
  };
})();
