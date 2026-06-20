// Touch settings sheet: schema-driven danmaku controls + speed presets + NG
// filter editor. Drives SYCSettings.save / SYCFilter.save; the app subscribes to
// onChange for live preview. Kept small by delegating control creation to
// controls.js. See ARCHITECTURE.md §8 (touch UI).

import { buildControl, groupBy, el } from "./controls.js";

const section = (title) => el("h3", { className: "sheet-h", textContent: title });

const labelled = (label, control) =>
  el("label", { className: "ctl ctl-col" }, [el("span", { className: "ctl-label", textContent: label }), control]);

const settingsSection = async (settings, sheet) => {
  const draft = { ...(await settings.load()) };
  const onInput = (key, v) => {
    draft[key] = v;
    settings.save(draft);
  };

  const body = el("div", { className: "ctls" });
  const rebuild = () => {
    body.replaceChildren();
    for (const [group, specs] of groupBy(settings.SCHEMA, "group")) {
      body.append(section(group));
      for (const spec of specs) body.append(buildControl(spec, draft[spec.key], onInput));
    }
  };

  const presets = el("div", { className: "presets" });
  for (const p of Object.values(settings.SPEED_PRESETS)) {
    const b = el("button", { type: "button", textContent: p.label });
    b.addEventListener("click", () => {
      Object.assign(draft, { speedPct: p.speedPct, fastMs: p.fastMs, normalMs: p.normalMs, slowMs: p.slowMs, spreadStrength: p.spreadStrength });
      settings.save(draft);
      rebuild();
    });
    presets.append(b);
  }

  rebuild();
  sheet.append(section("プリセット"), presets, body);
};

const filterSection = async (filter, sheet) => {
  const lists = await filter.load();
  const users = el("textarea", { className: "ng", value: lists.users.join("\n"), placeholder: "1行1件", rows: 3 });
  const words = el("textarea", { className: "ng", value: lists.words.join("\n"), placeholder: "1行1件", rows: 3 });
  const save = el("button", { type: "button", className: "ng-save", textContent: "NG リスト保存" });
  save.addEventListener("click", () => filter.save({ users: users.value, words: words.value }));
  sheet.append(section("NG フィルタ"), labelled("NG ユーザー", users), labelled("NG ワード", words), save);
};

// `button` is the existing trigger in the top bar; the sheet attaches to `root`.
export const mountSettings = ({ settings, filter, button, root = document.body }) => {
  const sheet = el("aside", { className: "sheet", hidden: true });
  sheet.append(
    el("div", { className: "sheet-head" }, [
      el("strong", { textContent: "設定" }),
      el("button", { type: "button", className: "sheet-close", textContent: "閉じる", onclick: () => (sheet.hidden = true) }),
    ])
  );

  button.addEventListener("click", () => (sheet.hidden = !sheet.hidden));

  settingsSection(settings, sheet);
  filterSection(filter, sheet);
  root.append(sheet);

  return { open: () => (sheet.hidden = false), close: () => (sheet.hidden = true) };
};
