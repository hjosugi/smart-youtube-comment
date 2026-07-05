import { clamp } from "./math.js";

(() => {
  "use strict";

  // Single source of truth for user settings: the schema drives the options UI
  // and the runtime mapping onto the danmaku engine. Consumers read
  // globalThis.SYCSettings. (Same pattern as scoring.js.)

  const PROFILE = Object.freeze({
    surface: "web",
    target: "mobile PWA",
    rationale: "Mobile browsers get lower density and render-scale defaults; extension/ keeps the desktop profile."
  });

  // Mobile PWA profile. Keep intentional differences from extension/settings.js
  // in sync with ARCHITECTURE.md §7.3 and the settings tests.
  const SCHEMA = [
    { key: "enabled",      group: "General",     label: "Danmaku (overlay)",      type: "bool",                                   default: true },
    { key: "listEnabled",  group: "General",     label: "Comment list",           type: "bool",                                   default: true },
    { key: "hideDefaultChat", group: "General",  label: "Hide YouTube chat while overlay is on", type: "bool",                     default: false },
    { key: "opacity",      group: "Display",     label: "Opacity",                type: "range", min: 20,  max: 100,  step: 5, unit: "%",  default: 100 },
    { key: "fontPx",       group: "Display",     label: "Font size",              type: "range", min: 14,  max: 48,   step: 1, unit: "px", default: 18 },
    { key: "fontFamily",   group: "Display",     label: "Font family",            type: "select",  default: "",
      options: [
        { value: "", label: "System default" },
        { value: "sans-serif", label: "Sans-serif" },
        { value: "serif", label: "Serif" },
        { value: "monospace", label: "Monospace" },
        { value: "'Yu Gothic','Hiragino Sans',sans-serif", label: "Gothic (JP)" },
        { value: "'Noto Sans JP','Noto Sans KR',sans-serif", label: "Noto Sans" },
        { value: "'Meiryo',sans-serif", label: "Meiryo" },
        { value: "'MS Gothic',monospace", label: "MS Gothic" },
        { value: "Arial,Helvetica,sans-serif", label: "Arial" },
        { value: "'Comic Sans MS',cursive", label: "Comic Sans" },
        { value: "Impact,sans-serif", label: "Impact" }
      ] },
    { key: "textColor",    group: "Display",     label: "Comment color",          type: "color",                                  default: "#ffffff" },
    { key: "roleColors",   group: "Display",     label: "Color by author role",   type: "bool",                                   default: true },
    { key: "fontWeight",   group: "Display",     label: "Font weight",            type: "range", min: 100, max: 900,  step: 100,           default: 700 },
    { key: "outlineWidth", group: "Display",     label: "Outline width",          type: "range", min: 0,   max: 8,    step: 1, unit: "px", default: 3 },
    { key: "outlineOpacity", group: "Display",   label: "Outline opacity",        type: "range", min: 0,   max: 100,  step: 5, unit: "%", default: 85 },
    { key: "speedPct",     group: "Speed",       label: "Scroll speed",           type: "range", min: 50,  max: 200,  step: 10, unit: "%", default: 100 },
    { key: "fastMs",       group: "Speed",       label: "Fast tier time",         type: "range", min: 2000, max: 12000, step: 250, unit: "ms", default: 6000 },
    { key: "normalMs",     group: "Speed",       label: "Normal tier time",       type: "range", min: 3000, max: 16000, step: 250, unit: "ms", default: 7500 },
    { key: "slowMs",       group: "Speed",       label: "Slow tier time",         type: "range", min: 4000, max: 20000, step: 250, unit: "ms", default: 10000 },
    { key: "maxActive",    group: "Performance", label: "Max comments on screen", type: "range", min: 100, max: 2000, step: 50,            default: 250 },
    { key: "maxQueue",     group: "Performance", label: "Pending comment queue",  type: "range", min: 100, max: 5000, step: 100,           default: 1000 },
    { key: "spawnPerFrame", group: "Performance", label: "Comments prepared per frame", type: "range", min: 1, max: 24, step: 1,          default: 6 },
    { key: "renderScalePct", group: "Performance", label: "Render resolution",    type: "range", min: 50,  max: 150,  step: 5, unit: "%",  default: 60 },
    { key: "maxTextChars", group: "Performance", label: "Max comment length",     type: "range", min: 80,  max: 500,  step: 20,            default: 260 },
    { key: "lineHeight",   group: "Layout",      label: "Lane height",            type: "range", min: 20,  max: 48,   step: 1, unit: "px", default: 24 },
    { key: "topPct",       group: "Layout",      label: "Top clear zone",         type: "range", min: 0,   max: 40,   step: 1, unit: "%",  default: 8 },
    { key: "bottomPct",    group: "Layout",      label: "Bottom clear zone",      type: "range", min: 0,   max: 40,   step: 1, unit: "%",  default: 14 },
    { key: "lengthSpread", group: "Behavior",    label: "Vary speed by length",   type: "bool",                                   default: true },
    { key: "spreadStrength", group: "Behavior",  label: "Length speed strength",  type: "range", min: 0,   max: 100,  step: 5, unit: "%", default: 35 },
    { key: "dedup",        group: "Behavior",    label: "Drop near-duplicates",   type: "bool",                                   default: true },
    { key: "dedupThreshold", group: "Behavior",  label: "Duplicate strictness",   type: "range", min: 1,   max: 8,    step: 1,            default: 3 }
  ];

  const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.default]));
  const STORAGE_KEY = "syc:settings";

  function area() {
    // chrome.storage.sync can be disabled; fall back to local. null when there is
    // no extension context at all (e.g. opened as a plain file for testing).
    if (typeof chrome === "undefined" || !chrome.storage) return null;
    return chrome.storage.sync ?? chrome.storage.local;
  }

  async function load() {
    const store = area();
    if (!store) return { ...DEFAULTS };
    try {
      const got = await store.get(STORAGE_KEY);
      return normalize(got?.[STORAGE_KEY]);
    } catch {
      return { ...DEFAULTS };
    }
  }

  async function save(values) {
    const store = area();
    if (!store) throw new Error("no storage available");
    await store.set({ [STORAGE_KEY]: normalize(values) });
  }

  function onChange(callback) {
    if (typeof chrome === "undefined" || !chrome.storage) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if ((areaName === "sync" || areaName === "local") && changes[STORAGE_KEY]) {
        callback(normalize(changes[STORAGE_KEY].newValue));
      }
    });
  }

  function normalizeBool(value, fallback) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1" || value === 1) return true;
    if (value === "false" || value === "0" || value === 0) return false;
    return fallback;
  }

  function normalizeRange(spec, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return spec.default;
    const bounded = clamp(spec.min, spec.max, n);
    if (!spec.step) return bounded;
    return clamp(spec.min, spec.max, spec.min + Math.round((bounded - spec.min) / spec.step) * spec.step);
  }

  function normalizeColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())
      ? value.trim().toLowerCase()
      : fallback;
  }

  function normalize(values) {
    const input = values && typeof values === "object" ? values : {};
    const clean = {};
    for (const spec of SCHEMA) {
      const value = input[spec.key];
      if (spec.type === "bool") clean[spec.key] = normalizeBool(value, spec.default);
      else if (spec.type === "range") clean[spec.key] = normalizeRange(spec, value);
      else if (spec.type === "color") clean[spec.key] = normalizeColor(value, spec.default);
      else if (spec.type === "select") clean[spec.key] = (spec.options || []).some((o) => o.value === value) ? value : spec.default;
      else clean[spec.key] = spec.default;
    }
    return clean;
  }

  // Map user-facing settings onto the danmaku engine's config keys.
  function toEngineConfig(s) {
    const safe = normalize(s);
    return {
      opacity: safe.opacity / 100,
      fontPx: safe.fontPx,
      fontFamily: safe.fontFamily,
      textColor: safe.textColor,
      roleColors: safe.roleColors,
      fontWeight: safe.fontWeight,
      outlineWidth: safe.outlineWidth,
      outlineAlpha: safe.outlineOpacity / 100,
      durationScale: 100 / safe.speedPct, // higher speed% => shorter on-screen time
      tierDurations: [safe.fastMs, safe.normalMs, safe.slowMs],
      maxActive: safe.maxActive,
      maxQueue: safe.maxQueue,
      spawnPerFrame: safe.spawnPerFrame,
      dpr: Math.max(0.5, Math.min(2, (globalThis.devicePixelRatio || 1) * safe.renderScalePct / 100)),
      maxTextChars: safe.maxTextChars,
      lineHeight: safe.lineHeight,
      topPct: safe.topPct / 100,
      bottomPct: safe.bottomPct / 100,
      lengthSpread: safe.lengthSpread,
      spreadStrength: safe.spreadStrength / 100,
      dedup: safe.dedup,
      simThreshold: safe.dedupThreshold
    };
  }

  const SPEED_PRESETS = {
    default:  { label: "Default",            speedPct: 100, fastMs: 6000, normalMs: 7500,  slowMs: 10000, spreadStrength: 35 },
    niconico: { label: "Niconico (fast)",    speedPct: 120, fastMs: 3500, normalMs: 4000,  slowMs: 5000,  spreadStrength: 20 },
    relaxed:  { label: "Relaxed (readable)", speedPct: 80,  fastMs: 7000, normalMs: 9000,  slowMs: 12000, spreadStrength: 45 }
  };

  globalThis.SYCSettings = { PROFILE, SCHEMA, DEFAULTS, SPEED_PRESETS, STORAGE_KEY, load, save, onChange, normalize, toEngineConfig };
})();
