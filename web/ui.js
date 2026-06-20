// Touch sheets: schema-driven settings (controls + presets + NG editor) and a
// help panel. Localized via i18n. Drives SYCSettings.save / SYCFilter.save; the
// app subscribes to onChange for live preview. See ARCHITECTURE.md §8.

import { buildControl, groupBy, el } from "./controls.js";
import { T, groupName, settingLabel } from "./i18n.js";

const section = (title) => el("h3", { className: "sheet-h", textContent: title });

const labelled = (label, control) =>
  el("label", { className: "ctl ctl-col" }, [el("span", { className: "ctl-label", textContent: label }), control]);

const sheetWith = (button, root, title) => {
  const sheet = el("aside", { className: "sheet", hidden: true });
  sheet.append(
    el("div", { className: "sheet-head" }, [
      el("strong", { textContent: title }),
      el("button", { type: "button", className: "sheet-close", textContent: T.close, onclick: () => (sheet.hidden = true) }),
    ])
  );
  button.addEventListener("click", () => (sheet.hidden = !sheet.hidden));
  root.append(sheet);
  return sheet;
};

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
      body.append(section(groupName(group)));
      for (const spec of specs) {
        body.append(buildControl({ ...spec, label: settingLabel(spec.key, spec.label) }, draft[spec.key], onInput));
      }
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
  sheet.append(section(T.presets), presets, body);
};

const filterSection = async (filter, sheet) => {
  const lists = await filter.load();
  const users = el("textarea", { className: "ng", value: lists.users.join("\n"), placeholder: "1行1件 / one per line", rows: 3 });
  const words = el("textarea", { className: "ng", value: lists.words.join("\n"), placeholder: "1行1件 / one per line", rows: 3 });
  const save = el("button", { type: "button", className: "ng-save", textContent: T.ngSave });
  save.addEventListener("click", () => filter.save({ users: users.value, words: words.value }));
  sheet.append(section(T.ngFilter), labelled(T.ngUsers, users), labelled(T.ngWords, words), save);
};

// `button` is the existing trigger in the top bar; the sheet attaches to `root`.
export const mountSettings = ({ settings, filter, button, root = document.body }) => {
  const sheet = sheetWith(button, root, T.settings);
  settingsSection(settings, sheet);
  filterSection(filter, sheet);
  return { open: () => (sheet.hidden = false), close: () => (sheet.hidden = true) };
};

export const mountHelp = ({ button, root = document.body }) => {
  const sheet = sheetWith(button, root, T.help);
  for (const [title, body] of T.helpItems) {
    sheet.append(
      el("div", { className: "help-item" }, [
        el("strong", { className: "help-title", textContent: title }),
        el("p", { className: "help-body", textContent: body }),
      ])
    );
  }
  return { open: () => (sheet.hidden = false), close: () => (sheet.hidden = true) };
};
