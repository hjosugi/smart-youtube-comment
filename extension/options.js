(() => {
  "use strict";

  // Builds the options form from SYCSettings.SCHEMA and autosaves on change.
  // Labels are localized via chrome.i18n (message names: s_<key>, g_<group>,
  // opt_*), falling back to the schema's English strings.
  const S = globalThis.SYCSettings;
  const root = document.getElementById("settings");
  const getters = {};
  const setters = {};
  const SAVE_DEBOUNCE_MS = 750;
  const BACKUP_APP = "smart-youtube-comment";
  const BACKUP_VERSION = 1;
  let filterInputs = null;
  let statusTimer = 0;
  // What the user changed on this page since it was last saved: setting keys,
  // and filter fields (users, words, channels, mode, replacement). A save
  // writes only these over what is stored now. Settings also change elsewhere
  // while this page is open (the player button, the popup, the shortcut,
  // "hide this user"), and those changes update the other controls here
  // instead of being overwritten with this page's stale copy.
  const dirtySettings = new Set();
  const dirtyFilters = new Set();

  const t = (name, fallback) => {
    const msg = (typeof chrome !== "undefined" && chrome.i18n) ? chrome.i18n.getMessage(name) : "";
    return msg || fallback;
  };

  function setStatus(key, fallback) {
    const el = document.getElementById("status");
    el.textContent = t(key, fallback);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ""; }, 1200);
  }

  function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }

  function updatePreview() {
    const el = document.getElementById("preview-text");
    if (!el) return;
    const g = (k, d) => (getters[k] ? getters[k]() : d);
    el.style.fontFamily = g("fontFamily", "") || 'system-ui, -apple-system, "Segoe UI", sans-serif';
    el.style.fontWeight = g("fontWeight", 700);
    el.style.fontSize = g("fontPx", 24) + "px";
    el.style.color = g("textColor", "#ffffff");
    el.style.opacity = String(g("opacity", 100) / 100);
    const ow = g("outlineWidth", 3), oa = g("outlineOpacity", 85) / 100;
    const oc = g("outlineColor", "#000000"), blur = g("outlineBlur", 0);
    el.style.webkitTextStroke = ow > 0 ? `${ow}px ${hexToRgba(oc, oa)}` : "0";
    el.style.paintOrder = "stroke fill";
    el.style.textShadow = blur > 0 ? `0 0 ${blur}px ${hexToRgba(oc, oa)}` : "";
  }

  function currentSettings() {
    const values = {};
    for (const key in getters) values[key] = getters[key]();
    return S.normalize ? S.normalize(values) : values;
  }

  function applySettings(values) {
    const next = S.normalize ? S.normalize(values) : values;
    for (const [key, value] of Object.entries(next)) setters[key]?.(value);
    updatePreview();
    return next;
  }

  function currentFilters() {
    const F = globalThis.SYCFilter;
    if (!F || !filterInputs) return { users: [], words: [], channels: [], mode: "drop", replacement: "" };
    return {
      users: F.cleanList(filterInputs.users.input.value),
      words: F.cleanWordList(filterInputs.words.input.value),
      channels: F.cleanChannelList(filterInputs.channels.input.value),
      mode: filterInputs.mode.select.value,
      replacement: filterInputs.replacement.input.value
    };
  }

  function applyFilterLists(lists) {
    if (!filterInputs) return;
    filterInputs.users.input.value = (lists.users || []).join("\n");
    filterInputs.words.input.value = (lists.words || []).join("\n");
    filterInputs.channels.input.value = (lists.channels || []).join("\n");
    if (lists.mode) filterInputs.mode.select.value = lists.mode;
    if (typeof lists.replacement === "string") filterInputs.replacement.input.value = lists.replacement;
  }

  async function buildBackupData() {
    const F = globalThis.SYCFilter;
    const filters = filterInputs ? currentFilters() : F ? await F.load() : { users: [], words: [] };
    return {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      surface: S.PROFILE?.surface || "extension",
      exportedAt: new Date().toISOString(),
      settings: currentSettings(),
      filters
    };
  }

  async function exportBackup() {
    const data = await buildBackupData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `smart-youtube-comment-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus("opt_exported", "Exported");
  }

  function parseBackup(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("invalid backup");
    if (data.app && data.app !== BACKUP_APP) throw new Error("wrong backup app");
    const F = globalThis.SYCFilter;
    return {
      settings: S.normalize ? S.normalize(data.settings) : (data.settings || {}),
      filters: {
        users: F ? F.cleanList(data.filters?.users || []) : [],
        words: F ? F.cleanWordList(data.filters?.words || []) : [],
        channels: F ? F.cleanChannelList(data.filters?.channels || []) : [],
        mode: data.filters?.mode,
        replacement: data.filters?.replacement
      }
    };
  }

  // Import and reset replace everything, so nothing is left to merge.
  async function importBackupText(text) {
    const next = parseBackup(text);
    dirtySettings.clear();
    applySettings(next.settings);
    await S.save(next.settings);
    if (globalThis.SYCFilter) {
      dirtyFilters.clear();
      await globalThis.SYCFilter.save(next.filters);
      applyFilterLists(next.filters);
    }
    setStatus("opt_imported", "Imported");
  }

  async function resetAll() {
    dirtySettings.clear();
    const defaults = applySettings({ ...S.DEFAULTS });
    await S.save(defaults);
    if (globalThis.SYCFilter) {
      dirtyFilters.clear();
      const empty = { users: [], words: [], channels: [] };
      await globalThis.SYCFilter.save(empty);
      applyFilterLists(empty);
    }
    setStatus("opt_reset_done", "Reset");
  }

  // Take the dirty keys for one save; put them back if the save fails.
  async function saveDirty(dirty, write) {
    const keys = [...dirty];
    dirty.clear();
    if (!keys.length) return;
    try {
      await write(keys);
    } catch (error) {
      for (const key of keys) dirty.add(key);
      throw error;
    }
  }

  async function saveWithStatus(action) {
    try {
      await action();
      setStatus("opt_saved", "Saved");
    } catch {
      setStatus("opt_save_failed", "Save failed");
    }
  }

  const scheduleSettingsPersist = debounce(() => saveWithStatus(() => saveDirty(dirtySettings, async (keys) => {
    const changed = {};
    for (const key of keys) changed[key] = getters[key]();
    await S.save({ ...(await S.load()), ...changed });
  })), SAVE_DEBOUNCE_MS);

  function scheduleSave(...keys) {
    for (const key of keys) dirtySettings.add(key);
    updatePreview();
    scheduleSettingsPersist();
  }

  // A change saved elsewhere (or this page's own save coming back).
  function onStoredSettings(next) {
    for (const [key, value] of Object.entries(next)) {
      if (!dirtySettings.has(key) && getters[key] && getters[key]() !== value) setters[key](value);
    }
    updatePreview();
  }

  function makeControl(spec, value) {
    if (spec.type === "bool") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(value);
      input.addEventListener("change", () => scheduleSave(spec.key));
      getters[spec.key] = () => input.checked;
      setters[spec.key] = (v) => { input.checked = Boolean(v); };
      return input;
    }
    if (spec.type === "color") {
      const input = document.createElement("input");
      input.type = "color";
      input.value = /^#[0-9a-f]{6}$/i.test(value || "") ? value : (spec.default || "#ffffff");
      input.addEventListener("input", () => scheduleSave(spec.key));
      getters[spec.key] = () => input.value;
      setters[spec.key] = (v) => { if (/^#[0-9a-f]{6}$/i.test(v || "")) input.value = v; };
      return input;
    }
    if (spec.type === "text") {
      const input = document.createElement("textarea");
      input.rows = 3;
      input.spellcheck = false;
      input.className = "text";
      input.value = value ?? "";
      input.placeholder = spec.placeholder || "system default";
      input.addEventListener("input", () => scheduleSave(spec.key));
      getters[spec.key] = () => input.value;
      setters[spec.key] = (v) => { input.value = v ?? ""; };
      return input;
    }
    if (spec.type === "select") {
      const sel = document.createElement("select");
      for (const opt of spec.options || []) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      sel.value = value ?? spec.default;
      sel.addEventListener("change", () => scheduleSave(spec.key));
      getters[spec.key] = () => sel.value;
      setters[spec.key] = (v) => { sel.value = v; };
      return sel;
    }
    // range
    const wrap = document.createElement("span");
    wrap.className = "rangewrap";
    const input = document.createElement("input");
    input.type = "range";
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
    input.value = value;
    const out = document.createElement("span");
    out.className = "val";
    const render = () => { out.textContent = `${input.value}${spec.unit || ""}`; };
    render();
    input.addEventListener("input", () => { render(); scheduleSave(spec.key); });
    getters[spec.key] = () => Number(input.value);
    setters[spec.key] = (v) => { input.value = v; render(); };
    wrap.append(input, out);
    return wrap;
  }

  function applyStaticI18n() {
    for (const el of document.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.getAttribute("data-i18n"), el.textContent);
    }
    if (document.title) document.title = t("opt_title", document.title);
  }

  function makeButton(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function debounce(fn, ms) {
    let timer = 0;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  function insertBeforeActions(node) {
    document.querySelector(".wrap").insertBefore(node, document.querySelector(".actions"));
  }

  function buildSpeedPresets() {
    if (!S.SPEED_PRESETS) return;
    const heading = document.createElement("h2");
    heading.textContent = t("g_speed_presets", "Speed presets");
    insertBeforeActions(heading);
    const bar = document.createElement("div");
    bar.className = "presets";
    for (const [key, preset] of Object.entries(S.SPEED_PRESETS)) {
      bar.appendChild(makeButton(t(`sp_${key}`, preset.label), () => {
        const { label: _label, ...vals } = preset;
        for (const [k, v] of Object.entries(vals)) setters[k]?.(v);
        scheduleSave(...Object.keys(vals).filter((k) => setters[k]));
      }));
    }
    insertBeforeActions(bar);
  }

  function makeFilterField(i18nKey, fallback, value) {
    const field = document.createElement("label");
    field.className = "fcol";
    const span = document.createElement("span");
    span.textContent = t(i18nKey, fallback);
    const input = document.createElement("textarea");
    input.rows = 4;
    input.spellcheck = false;
    input.value = value;
    field.append(span, input);
    return { field, input };
  }

  async function buildFilters() {
    const F = globalThis.SYCFilter;
    if (!F) return;
    const heading = document.createElement("h2");
    heading.textContent = t("g_filters", "Filters");
    insertBeforeActions(heading);
    const note = document.createElement("p");
    note.className = "filter-note";
    note.textContent = t(
      "f_local_note",
      "Blocked users and words are saved only on this device and are not synced."
    );
    insertBeforeActions(note);

    const lists = await F.load();
    const users = makeFilterField("f_users", "Blocked users (one per line)", lists.users.join("\n"));
    const words = makeFilterField("f_words", "Blocked words (one per line)", lists.words.join("\n"));
    const channels = makeFilterField(
      "f_channels",
      "Blocked channel IDs (one per line)",
      (lists.channels || []).join("\n")
    );

    const modeSelect = document.createElement("select");
    for (const value of F.MODES || ["drop"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(`f_mode_${value}`, value);
      modeSelect.appendChild(option);
    }
    // load() returns the lists; the mode and replacement are read from the filter.
    modeSelect.value = F.mode ?? lists.mode ?? "drop";
    const modeField = document.createElement("label");
    modeField.className = "fcol";
    const modeSpan = document.createElement("span");
    modeSpan.textContent = t("f_mode", "Blocked-word action");
    modeField.append(modeSpan, modeSelect);

    const replacement = makeFilterField("f_replacement", "Replacement text", F.replacement ?? lists.replacement ?? "");
    replacement.input.rows = 1;
    replacement.input.placeholder = F.replacement;
    filterInputs = {
      users, words, channels,
      mode: { select: modeSelect },
      replacement: { input: replacement.input }
    };
    insertBeforeActions(users.field);
    insertBeforeActions(words.field);
    insertBeforeActions(channels.field);
    insertBeforeActions(modeField);
    insertBeforeActions(replacement.field);

    const persist = debounce(() => saveWithStatus(() => saveDirty(dirtyFilters, async (keys) => {
      const mine = currentFilters();
      const stored = await F.load();
      const next = { ...stored, mode: F.mode ?? stored.mode, replacement: F.replacement ?? stored.replacement };
      for (const key of keys) next[key] = mine[key];
      await F.save(next);
    })), SAVE_DEBOUNCE_MS);
    const save = (key) => {
      dirtyFilters.add(key);
      persist();
    };
    users.input.addEventListener("input", () => save("users"));
    words.input.addEventListener("input", () => save("words"));
    channels.input.addEventListener("input", () => save("channels"));
    modeSelect.addEventListener("change", () => save("mode"));
    replacement.input.addEventListener("input", () => save("replacement"));

    // Lists changed elsewhere ("hide this user" on a comment) or this page's
    // own save coming back. A field is only rewritten when its entries
    // differ, so a field being typed in keeps its caret and its blank line.
    F.onChange?.((next) => {
      const sync = (key, input, clean) => {
        if (dirtyFilters.has(key)) return;
        const want = (next[key] || []).join("\n");
        if (clean(input.value).join("\n") !== want) input.value = want;
      };
      sync("users", users.input, F.cleanList);
      sync("words", words.input, F.cleanWordList);
      sync("channels", channels.input, F.cleanChannelList);
      if (!dirtyFilters.has("mode") && F.mode) modeSelect.value = F.mode;
      // An empty field means the default replacement: leave it empty.
      const shown = replacement.input.value;
      if (!dirtyFilters.has("replacement") && F.replacement != null && shown && shown !== F.replacement) {
        replacement.input.value = F.replacement;
      }
    });

    if (F.PRESETS && Object.keys(F.PRESETS).length) {
      const bar = document.createElement("div");
      bar.className = "presets";
      for (const [key, preset] of Object.entries(F.PRESETS)) {
        const i18nKey = `fp_${key.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        bar.appendChild(makeButton(`+ ${t(i18nKey, preset.label)}`, () => {
          const merged = F.cleanWordList(words.input.value).concat(preset.words || []);
          words.input.value = [...new Set(merged)].join("\n");
          save("words");
        }));
      }
      insertBeforeActions(bar);
    }
  }

  function buildBackupActions() {
    const bar = document.createElement("div");
    bar.className = "presets";
    bar.appendChild(makeButton(t("opt_export", "Export JSON"), () => {
      exportBackup().catch(() => setStatus("opt_export_failed", "Export failed"));
    }));
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.hidden = true;
    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        await importBackupText(await selected.text());
      } catch {
        setStatus("opt_import_failed", "Import failed");
      } finally {
        file.value = "";
      }
    });
    bar.appendChild(makeButton(t("opt_import", "Import JSON"), () => file.click()));
    bar.appendChild(file);
    insertBeforeActions(bar);
  }

  async function init() {
    applyStaticI18n();
    const values = await S.load();
    const groups = {};
    for (const spec of S.SCHEMA) (groups[spec.group || "Settings"] ||= []).push(spec);

    for (const groupName of Object.keys(groups)) {
      const heading = document.createElement("h2");
      heading.textContent = t(`g_${groupName.toLowerCase()}`, groupName);
      root.appendChild(heading);
      for (const spec of groups[groupName]) {
        const row = document.createElement("label");
        row.className = "row";
        row.dataset.key = spec.key;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = t(`s_${spec.key}`, spec.label);
        row.append(name, makeControl(spec, values[spec.key]));
        root.appendChild(row);
        if (spec.note) {
          const note = document.createElement("p");
          note.className = "setting-note";
          note.textContent = t(`sn_${spec.key}`, spec.note);
          root.appendChild(note);
        }
      }
    }

    updatePreview();
    S.onChange?.(onStoredSettings);
    buildSpeedPresets();
    await buildFilters();
    buildBackupActions();

    document.getElementById("reset").addEventListener("click", async () => {
      try {
        await resetAll();
      } catch {
        setStatus("opt_save_failed", "Save failed");
      }
    });
  }

  if (globalThis.__SYC_TEST__) {
    globalThis.__SYCOptionsTest = {
      buildBackupData,
      importBackupText,
      parseBackup,
      resetAll
    };
  }

  init();
})();
