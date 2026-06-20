(() => {
  "use strict";

  // Builds the options form from SYCSettings.SCHEMA and autosaves on change.
  // Labels are localized via chrome.i18n (message names: s_<key>, g_<group>,
  // opt_*), falling back to the schema's English strings.
  const S = globalThis.SYCSettings;
  const root = document.getElementById("settings");
  const getters = {};
  const setters = {};
  let saveTimer = 0;

  const t = (name, fallback) => {
    const msg = (typeof chrome !== "undefined" && chrome.i18n) ? chrome.i18n.getMessage(name) : "";
    return msg || fallback;
  };

  function setStatus(key, fallback) {
    const el = document.getElementById("status");
    el.textContent = t(key, fallback);
    clearTimeout(setStatus.timer);
    setStatus.timer = setTimeout(() => { el.textContent = ""; }, 1200);
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

  function scheduleSave() {
    updatePreview();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const values = {};
      for (const key in getters) values[key] = getters[key]();
      try {
        await S.save(values);
        setStatus("opt_saved", "Saved");
      } catch {
        setStatus("opt_save_failed", "Save failed");
      }
    }, 150);
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
      el.textContent = t(el.dataset.i18n, el.textContent);
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

  function currentSettingValues() {
    const v = {};
    for (const key in getters) v[key] = getters[key]();
    return v;
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
        const { label, ...vals } = preset;
        for (const [k, v] of Object.entries(vals)) setters[k]?.(v);
        updatePreview();
        scheduleSave();
        setStatus("opt_saved", "Saved");
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

    const lists = await F.load();
    const users = makeFilterField("f_users", "Blocked users (one per line)", lists.users.join("\n"));
    const words = makeFilterField("f_words", "Blocked words (one per line)", lists.words.join("\n"));
    insertBeforeActions(users.field);
    insertBeforeActions(words.field);

    const save = debounce(async () => {
      try {
        await F.save({ users: users.input.value, words: words.input.value });
        setStatus("opt_saved", "Saved");
      } catch { setStatus("opt_save_failed", "Save failed"); }
    }, 250);
    users.input.addEventListener("input", save);
    words.input.addEventListener("input", save);

    if (F.PRESETS && Object.keys(F.PRESETS).length) {
      const bar = document.createElement("div");
      bar.className = "presets";
      for (const preset of Object.values(F.PRESETS)) {
        bar.appendChild(makeButton(`+ ${preset.label}`, () => {
          const merged = F.cleanList(words.input.value).concat(preset.words || []);
          words.input.value = [...new Set(merged)].join("\n");
          save();
        }));
      }
      insertBeforeActions(bar);
    }
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

    document.getElementById("reset").addEventListener("click", async () => {
      await S.save({ ...S.DEFAULTS });
      location.reload();
    });
  }

  init();
})();
