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
    el.style.webkitTextStroke = ow > 0 ? `${ow}px rgba(0,0,0,${oa})` : "0";
    el.style.paintOrder = "stroke fill";
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
    if (!F || !filterInputs) return { users: [], words: [] };
    return {
      users: F.cleanList(filterInputs.users.input.value),
      words: F.cleanWordList(filterInputs.words.input.value),
      channels: F.cleanChannelList(filterInputs.channels.input.value)
    };
  }

  function applyFilterLists(lists) {
    if (!filterInputs) return;
    filterInputs.users.input.value = (lists.users || []).join("\n");
    filterInputs.words.input.value = (lists.words || []).join("\n");
    filterInputs.channels.input.value = (lists.channels || []).join("\n");
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
        channels: F ? F.cleanChannelList(data.filters?.channels || []) : []
      }
    };
  }

  async function importBackupText(text) {
    const next = parseBackup(text);
    applySettings(next.settings);
    await S.save(next.settings);
    if (globalThis.SYCFilter) {
      await globalThis.SYCFilter.save(next.filters);
      applyFilterLists(next.filters);
    }
    setStatus("opt_imported", "Imported");
  }

  async function resetAll() {
    const defaults = applySettings({ ...S.DEFAULTS });
    await S.save(defaults);
    if (globalThis.SYCFilter) {
      const empty = { users: [], words: [], channels: [] };
      await globalThis.SYCFilter.save(empty);
      applyFilterLists(empty);
    }
    setStatus("opt_reset_done", "Reset");
  }

  async function saveWithStatus(action) {
    try {
      await action();
      setStatus("opt_saved", "Saved");
    } catch {
      setStatus("opt_save_failed", "Save failed");
    }
  }

  const scheduleSettingsPersist = debounce(() => {
    const values = currentSettings();
    return saveWithStatus(() => S.save(values));
  }, SAVE_DEBOUNCE_MS);

  function scheduleSave() {
    updatePreview();
    scheduleSettingsPersist();
  }

  function makeControl(spec, value) {
    if (spec.type === "bool") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(value);
      input.addEventListener("change", scheduleSave);
      getters[spec.key] = () => input.checked;
      setters[spec.key] = (v) => { input.checked = Boolean(v); };
      return input;
    }
    if (spec.type === "color") {
      const input = document.createElement("input");
      input.type = "color";
      input.value = /^#[0-9a-f]{6}$/i.test(value || "") ? value : (spec.default || "#ffffff");
      input.addEventListener("input", scheduleSave);
      getters[spec.key] = () => input.value;
      setters[spec.key] = (v) => { if (/^#[0-9a-f]{6}$/i.test(v || "")) input.value = v; };
      return input;
    }
    if (spec.type === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "text";
      input.value = value ?? "";
      input.placeholder = spec.placeholder || "system default";
      input.addEventListener("input", scheduleSave);
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
      sel.addEventListener("change", scheduleSave);
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
    input.addEventListener("input", () => { render(); scheduleSave(); });
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
        updatePreview();
        scheduleSave();
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
    filterInputs = { users, words, channels };
    insertBeforeActions(users.field);
    insertBeforeActions(words.field);
    insertBeforeActions(channels.field);

    const save = debounce(() =>
      saveWithStatus(() =>
        F.save({
          users: users.input.value,
          words: words.input.value,
          channels: channels.input.value
        })
      ),
    SAVE_DEBOUNCE_MS);
    users.input.addEventListener("input", save);
    words.input.addEventListener("input", save);
    channels.input.addEventListener("input", save);

    if (F.PRESETS && Object.keys(F.PRESETS).length) {
      const bar = document.createElement("div");
      bar.className = "presets";
      for (const [key, preset] of Object.entries(F.PRESETS)) {
        const i18nKey = `fp_${key.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        bar.appendChild(makeButton(`+ ${t(i18nKey, preset.label)}`, () => {
          const merged = F.cleanWordList(words.input.value).concat(preset.words || []);
          words.input.value = [...new Set(merged)].join("\n");
          save();
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
      }
    }

    updatePreview();
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
