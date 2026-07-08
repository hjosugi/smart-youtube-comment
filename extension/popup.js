(() => {
  "use strict";

  const S = globalThis.SYCSettings;
  /** @type {HTMLInputElement} */
  const enabled = /** @type {HTMLInputElement} */ (document.getElementById("enabled"));
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

  function render(next) {
    settings = S.normalize(next);
    enabled.checked = settings.enabled;
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
    render(await S.load());
    enabled.addEventListener("change", () => save({ ...settings, enabled: enabled.checked }));
    opacity.addEventListener("input", () => scheduleSave({ ...settings, opacity: Number(opacity.value) }));
    opacity.addEventListener("change", () => save({ ...settings, opacity: Number(opacity.value) }));
    document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
    S.onChange(render);
  }

  init();
})();
