(() => {
  "use strict";

  const S = globalThis.SYCSettings;
  const general = document.getElementById("general");
  /** @type {Record<string, HTMLInputElement>} */
  const toggles = {}; // General-group booleans (enabled, hideDefaultChat, ...) by key
  /** @type {HTMLInputElement} */
  const opacity = /** @type {HTMLInputElement} */ (document.getElementById("opacity"));
  const opacityValue = document.getElementById("opacity-value");
  const status = document.getElementById("status");
  let settings = { ...S.DEFAULTS };
  let saveTimer = 0;
  let statusTimer = 0;

  const t = (name, fallback) => chrome.i18n?.getMessage(name) || fallback;

  function applyStaticI18n() {
    for (const el of document.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.getAttribute("data-i18n"), el.textContent);
    }
    document.title = t("opt_title", document.title);
  }

  function setStatus(key, fallback) {
    status.textContent = t(key, fallback);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ""; }, 900);
  }

  // The popup mirrors the options page's "General" group so the everyday
  // switches (overlay on/off, hide YouTube chat, pause with video) are one
  // click away; everything else lives behind the Settings button.
  function buildGeneral() {
    for (const spec of S.SCHEMA) {
      if (spec.group !== "General" || spec.type !== "bool") continue;
      const row = document.createElement("label");
      row.className = "row switch";
      const name = document.createElement("span");
      name.textContent = t(`s_${spec.key}`, spec.label);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = spec.key;
      input.addEventListener("change", () => save({ ...settings, [spec.key]: input.checked }));
      row.append(name, input);
      general.appendChild(row);
      toggles[spec.key] = input;
    }
  }

  function render(next) {
    settings = S.normalize(next);
    for (const key in toggles) toggles[key].checked = Boolean(settings[key]);
    opacity.value = settings.opacity;
    opacityValue.textContent = `${settings.opacity}%`;
  }

  async function save(next) {
    clearTimeout(saveTimer);
    settings = S.normalize(next);
    render(settings);
    try {
      await S.save(settings);
      setStatus("opt_saved", "Saved");
    } catch {
      setStatus("opt_save_failed", "Save failed");
    }
  }

  function scheduleSave(next) {
    render(next);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(settings); }, 150);
  }

  async function init() {
    applyStaticI18n();
    buildGeneral();
    render(await S.load());
    opacity.addEventListener("input", () => scheduleSave({ ...settings, opacity: Number(opacity.value) }));
    opacity.addEventListener("change", () => save({ ...settings, opacity: Number(opacity.value) }));
    document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
    S.onChange(render);
  }

  init();
})();
